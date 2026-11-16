/**
 * Host half of the dsh-ghost-download bundle.
 *
 * Drives Ghost Downloader through its official command line tool (`ghd.exe`):
 * add / tasks / task / pause / start / remove / wait. The CLI is Ghost's
 * documented integration surface; the aria2-compatible RPC only implements
 * addUri + getVersion, which cannot answer "is this download finished".
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, openSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Schema from '@deepseek-ai/schemastery';

/**
 * Build an identified user message.
 *
 * Inlined because a linked plugin cannot resolve `@deepseek-ai/dsh-llm`. This is
 * a lightweight equivalent of the harness helper, not a copy of it: the content
 * is detached with `structuredClone` and frozen one level deep, where the
 * harness deep-freezes the whole graph. Enough for a one-shot follow-up.
 */
function createUserMessage(content, source) {
  const detached = structuredClone(content);
  for (const block of detached) {
    if (block !== null && typeof block === 'object') Object.freeze(block);
  }
  Object.freeze(detached);
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: detached,
    source,
  });
}

/** Cordis plugin name. */
export const name = 'ghost-download';

/** Tools only; everything else comes from the CLI. */
export const inject = ['tools'];

/**
 * Row configuration.
 *
 * A linked plugin cannot resolve `@deepseek-ai/schemastery` from the dsh install,
 * so the package is vendored into this bundle's node_modules. The Settings form
 * projects this schema, and cordis validates the row's config with it on activation.
 */
export const Config = Schema.object({
  ghdPath: Schema.string().default('').description('ghd.exe path; empty auto-detects the standard install.'),
  pollIntervalMs: Schema.natural().default(5000).description('Background completion poll interval in milliseconds.'),
  blockShellDownloads: Schema.boolean().default(true).description('Deny curl -o / curl -O / wget and redirect them to ghost_download.'),
});

const MAX_OUTPUT = 20000;
/** A failed call shows its captured output far shorter than a success value. */
const MAX_ERROR_RAW = 2000;
const DEFAULT_WAIT_LIMIT_SECONDS = 3600;
/**
 * Statuses that mean "this task will not change again on its own".
 *
 * Shared by the watcher, the wait-timeout verdict and the queue renderer so the
 * three cannot drift apart — the same string set written three times is exactly
 * how "empty status" ends up meaning "finished" in one place and "unknown" in
 * another. An unknown status is NEVER terminal: a download that could not be
 * read is still running.
 */
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'error', 'complete', 'done']);
/** A watcher is not a subscription: stop polling even if the task never ends. */
const WATCH_MAX_MS = 30 * 60 * 1000;
/** A session that stopped accepting follow-ups is gone; polling it is pointless. */
const WATCH_MAX_WAKE_FAILURES = 3;
/** Windows caps one command line at 32K characters; stay well clear of it. */
const MAX_URLS = 50;
const ADD_TIMEOUT_MS = 120000;
const TASK_TIMEOUT_MS = 60000;
const CONTROL_TIMEOUT_MS = 120000;
const SNAPSHOT_TIMEOUT_MS = 15000;
const SNAPSHOT_TTL_MS = 3000;
const PROBE_TTL_MS = 5 * 60 * 1000;
const PROBE_CACHE_LIMIT = 200;
/** Stop background watching after this many consecutive CLI failures. */
const WATCH_MAX_FAILURES = 10;
/** A killed ghd that never exits settles the call from the log it already wrote. */
const KILL_GRACE_MS = 2000;

/** Shared result shape for every tool in this bundle. */
const TOOL_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    command: { type: 'string' },
    exitCode: { type: 'integer' },
    timedOut: { type: 'boolean' },
    taskId: { type: 'string' },
    taskIds: { type: 'array', items: { type: 'string' } },
    statuses: { type: 'array', items: { type: 'string' } },
    warning: { type: 'string' },
    filePath: { type: 'string' },
    stillRunning: { type: 'boolean' },
    cached: { type: 'boolean' },
    waited: {},
    detail: {},
    result: {},
    error: {},
    raw: { type: 'string' },
  },
  required: ['ok', 'raw'],
};

/** Resolve ghd.exe: explicit config, environment, then the standard installs. */
function resolveGhdPath(configured) {
  const candidates = [];
  if (typeof configured === 'string' && configured.trim() !== '') candidates.push(configured.trim());
  const fromEnv = process.env.GHOST_GHD;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') candidates.push(fromEnv.trim());
  for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']]) {
    if (base) candidates.push(path.join(base, 'Ghost Downloader', 'bin', 'ghd.exe'));
  }
  for (const candidate of candidates) {
    if (path.isAbsolute(candidate) && existsSync(candidate)) return candidate;
  }
  // Last resort: let the OS resolve `ghd` from PATH (the installer adds the bin directory).
  return 'ghd.exe';
}

function decode(buffer) {
  if (!buffer || buffer.length === 0) return '';
  const utf8 = new TextDecoder('utf-8').decode(buffer);
  if (!utf8.includes('\uFFFD')) return utf8;
  try {
    return new TextDecoder('gbk').decode(buffer);
  } catch {
    return utf8;
  }
}

/**
 * Run ghd with closed stdin and file-backed output capture.
 * A throwaway temp file is used instead of pipes because the Harness host may run
 * under a sandbox that denies pipe creation between processes.
 */
function runGhd(executable, args, { cwd, timeoutMs = ADD_TIMEOUT_MS, signal } = {}) {
  return new Promise((resolve, reject) => {
    const logPath = path.join(
      os.tmpdir(),
      `dsh-ghd-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.log`,
    );
    let fd;
    let child;
    const cleanup = () => {
      try {
        if (fd !== undefined) closeSync(fd);
      } catch {
        // already closed
      }
      try {
        unlinkSync(logPath);
      } catch {
        // best effort
      }
    };
    try {
      fd = openSync(logPath, 'w');
      child = spawn(executable, args, { cwd, windowsHide: true, stdio: ['ignore', fd, fd], signal });
    } catch (error) {
      cleanup();
      reject(error);
      return;
    }
    let settled = false;
    let timedOut = false;
    let timer;
    let graceTimer;
    const settle = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      let output = '';
      try {
        output = decode(readFileSync(logPath));
      } catch {
        output = '';
      }
      cleanup();
      resolve({ code: typeof code === 'number' ? code : -1, output, timedOut });
    };
    timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      child.kill();
      // A process that ignores the kill would otherwise keep this promise — and
      // the tool call — alive forever, so settle from the log already written.
      graceTimer = setTimeout(() => settle(-1), KILL_GRACE_MS);
      graceTimer.unref?.();
    }, Math.max(1000, timeoutMs));
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      cleanup();
      // A bare `spawn ghd.exe ENOENT` tells the user nothing actionable.
      if (error && error.code === 'ENOENT') {
        reject(new Error(
          `ghd 未找到（${executable}）。请在 Ghost Downloader 的「设置 → 命令行工具」安装 ghd，`
            + '或在本插件配置里用 ghdPath 指定可执行文件路径。',
        ));
        return;
      }
      reject(error);
    });
    child.on('close', (code) => settle(code));
  });
}

/**
 * ghd prints one JSON object; tolerate leading/trailing noise.
 *
 * A plain first-`{`..last-`}` slice breaks as soon as a warning line follows the
 * JSON and happens to contain `}`, so fall back to the first balanced object.
 */
function parsePayload(text) {
  const trimmed = String(text || '').trim();
  if (trimmed === '') return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through: ghd may have logged around the object
  }
  for (let start = trimmed.indexOf('{'); start >= 0; start = trimmed.indexOf('{', start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < trimmed.length; index += 1) {
      const char = trimmed[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === '{') depth += 1;
      else if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          try {
            return JSON.parse(trimmed.slice(start, index + 1));
          } catch {
            break;
          }
        }
      }
    }
  }
  return undefined;
}

/** Normalize `{result}` / `{error}` envelopes. */
function unwrap(payload) {
  if (payload && typeof payload === 'object') {
    if ('error' in payload) return { ok: false, error: payload.error };
    if ('result' in payload) return { ok: true, result: payload.result };
  }
  return { ok: false, error: { code: 'unexpectedOutput', message: 'ghd did not return a JSON envelope' } };
}

/**
 * Pull every task id out of whatever shape `ghd add` returns.
 *
 * `ghd add url1 url2` creates one task per link, so taking only the first id
 * would leave the rest of the batch unwatched and unwaited.
 */
/** A real task id: the tsk_ prefix plus an identifier-ish tail. */
const TASK_ID = /^tsk_[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Collect task ids from a ghd payload.
 *
 * Only the fields that actually CARRY an id are read. A blanket sweep of every
 * string value turns a file name (`tsk_notes.pdf`) or an error message into a
 * phantom id, and the caller then waits on / watches a task that does not exist.
 */
function findTaskIds(value, out = []) {
  if (typeof value === 'string') {
    if (TASK_ID.test(value) && !out.includes(value)) out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) findTaskIds(item, out);
    return out;
  }
  if (value && typeof value === 'object') {
    for (const key of ['taskId', 'task_id', 'taskIds', 'ids']) findTaskIds(value[key], out);
    if (Array.isArray(value.tasks)) {
      for (const item of value.tasks) {
        if (item && typeof item === 'object') {
          for (const key of ['taskId', 'task_id', 'id']) findTaskIds(item[key], out);
        }
      }
    }
  }
  return out;
}

/** Header values carry cookies and tokens, so they never reach a result field. */
function maskArgv(argv) {
  const out = [];
  for (let index = 0; index < argv.length; index += 1) {
    out.push(argv[index]);
    if (argv[index] === '-H' || argv[index] === '--header') {
      out.push('<redacted>');
      index += 1;
    }
  }
  return out.join(' ');
}

function bounded(text, limit = MAX_OUTPUT) {
  const value = String(text || '');
  return value.length <= limit ? value : `${value.slice(0, limit)}\n[... truncated ${value.length} chars]`;
}

/**
 * Register the Ghost Downloader tools.
 * @param ctx - tool registry.
 * @param config - optional `{ ghdPath }` row configuration.
 */
export function apply(ctx, config) {
  const pluginConfig = config && typeof config === 'object' ? config : {};
  let executable;
  /** How often the background watcher asks ghd about a task (config `pollIntervalMs`). */
  const pollIntervalMs = Number.isInteger(pluginConfig.pollIntervalMs) && pluginConfig.pollIntervalMs >= 1000
    ? pluginConfig.pollIntervalMs
    : 5000;
  /** Set `blockShellDownloads: false` to keep curl/wget downloads allowed. */
  const blockShellDownloads = pluginConfig.blockShellDownloads !== false;
  /** `<agent key>:<taskId>` -> interval handle for background completion watching. */
  const watchers = new Map();
  /** Stable identity per agent, so the watcher key can include it. */
  const agentKeys = new WeakMap();
  let nextAgentKey = 0;
  const agentKeyOf = (agent) => {
    if (agent === null || (typeof agent !== 'object' && typeof agent !== 'function')) return 'none';
    let key = agentKeys.get(agent);
    if (key === undefined) {
      nextAgentKey += 1;
      key = `a${nextAgentKey}`;
      agentKeys.set(agent, key);
    }
    return key;
  };
  /** url+headers -> probe result, so repeated previews do not re-parse a torrent. */
  const probeCache = new Map();
  /** Shell commands that would bypass Ghost: curl outputting to a file, and wget. */
  const CURL_FILE_OUTPUT = /(?:^|\s)(?:-[a-zA-Z]*o[a-zA-Z]*\b|--output\b|--remote-name\b|-O\b)/;
  /** Output explicitly discarded (`-o -`, `/dev/null`, `NUL`, `--output=NUL`). */
  const CURL_DISCARD_OUTPUT = /(?:-o|--output)(?:=|\s+)(?:-|\/dev\/null|NUL|nul)(?=\s|$)/;

  // cordis has no public `dispose` event (only `internal/*`), so cleanup belongs
  // to an effect disposer — the pattern every other DSH plugin uses.
  ctx.effect(() => () => {
    for (const timer of watchers.values()) clearInterval(timer);
    watchers.clear();
    probeCache.clear();
  }, 'ghost-download:watchers');

  /**
   * Resolve where a task actually landed.
   *
   * `ghd task` reports `fileSize: 0` and `files: []` for finished tasks, and the
   * reported `name` may not be the final file name (Ghost renames on conflict as
   * `name (2).ext`). The filesystem is the only trustworthy source, so verify the
   * exact name first and fall back to the newest matching file in the folder.
   */
  function resolveLandingPath(task) {
    const folder = typeof task?.outputFolder === 'string' ? task.outputFolder : '';
    const name = typeof task?.name === 'string' ? task.name : '';
    if (folder === '' || name === '') return undefined;
    const exact = path.join(folder, name);
    try {
      const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const ext = path.extname(name);
      const base = path.basename(name, ext);
      const pattern = new RegExp(`^${escape(base)}(?: ?\\(\\d+\\))?${escape(ext)}$`);
      let best;
      const consider = (full) => {
        try {
          const stat = statSync(full);
          if (!stat.isFile()) return;
          if (best === undefined || stat.mtimeMs > best.mtime) best = { path: full, mtime: stat.mtimeMs };
        } catch {
          // unreadable entry: ignore
        }
      };
      // A name conflict leaves the requested name in place for the OLD file and
      // writes the new one as `name (2).ext`; the newest match is the real one.
      consider(exact);
      for (const entry of readdirSync(folder)) {
        if (pattern.test(entry)) consider(path.join(folder, entry));
      }
      // Only a file that exists is reported: a guessed `exact` path would be a
      // file the caller cannot open.
      return best === undefined ? undefined : best.path;
    } catch {
      return existsSync(exact) ? exact : undefined;
    }
  }

  /** Return the offending shell segment when a command downloads a URL to a file itself. */
  function shellDownloadOf(command) {
    if (typeof command !== 'string' || command === '') return undefined;
    for (const line of command.split(/\r?\n/)) {
      for (const segment of line.split(/&&|\|\||;|\|/)) {
        const s = segment.trim();
        if (s === '') continue;
        const isCurl = /\bcurl\b/i.test(s);
        const isWget = /\bwget\b/i.test(s);
        if (!isCurl && !isWget) continue;
        if (!/\b(?:https?|ftp):\/\//i.test(s)) continue;
        // `curl URL` writes to stdout and is harmless; `-o`/`-O` writes files.
        if (isCurl && !CURL_FILE_OUTPUT.test(s)) continue;
        // Discarding output is diagnostics, not a download.
        if (isCurl && CURL_DISCARD_OUTPUT.test(s)) continue;
        return s;
      }
    }
    return undefined;
  }

  /**
   * Poll ghd until the task stops running, then wake the agent that started it.
   *
   * The watcher is keyed by agent + task: one agent never doubles a poller, while
   * a second session watching the same task still gets its own notice.
   */
  function watchTask(agent, taskId) {
    if (!agent || typeof agent.followup !== 'function') return;
    const key = `${agentKeyOf(agent)}:${taskId}`;
    if (watchers.has(key)) return;
    let inFlight = false;
    let settled = false;
    let failures = 0;
    let wakeFailures = 0;
    /** A paused task can wait overnight; without a deadline this polls forever. */
    const deadline = Date.now() + WATCH_MAX_MS;
    let timer;
    let release;
    const stop = () => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearInterval(timer);
      watchers.delete(key);
      try {
        release?.();
      } catch {
        // already released with the plugin
      }
    };
    /** Returns false when the session no longer accepts follow-ups. */
    const wake = (text) => {
      try {
        // format v4 refuses the retired `plugin` wrapper kind; a local plugin must
        // identify itself as `plugin:<name>` (its own producer-owned source kind).
        agent.followup(createUserMessage([{ type: 'text', text }], { kind: 'plugin:ghost-download' }));
        return true;
      } catch {
        // the agent may already be disposed; a missed notice is not worth a retry
        return false;
      }
    };
    /**
     * Deliver a notice, and stop watching once the session has clearly gone.
     *
     * A disposed session swallows every follow-up, so without this counter the
     * watcher would keep spawning `ghd` every interval for a listener that no
     * longer exists — the query itself keeps succeeding, so `failures` never
     * rises and nothing else catches it.
     */
    const notify = (text) => {
      if (wake(text)) return;
      wakeFailures += 1;
      if (wakeFailures >= WATCH_MAX_WAKE_FAILURES) stop();
    };
    const giveUp = (reason) => {
      stop();
      notify(`[Ghost Downloader] 无法继续监视任务 ${taskId}：${reason}\n可以用 ghost_task 手动查看状态。`);
    };
    const check = async () => {
      if (inFlight || settled) return;
      if (Date.now() > deadline) {
        // A paused task can sit there for days; the watcher is not a subscription.
        giveUp('已监视 30 分钟仍未结束');
        return;
      }
      inFlight = true;
      try {
        const result = await runGhd(ghd(), ['task', taskId], { timeoutMs: TASK_TIMEOUT_MS });
        const envelope = unwrap(parsePayload(result.output));
        if (!envelope.ok) {
          // A removed task never comes back; polling it forever would leak a
          // process per interval.
          if (String(envelope.error?.code ?? '') === 'taskNotFound') {
            stop();
            notify(`[Ghost Downloader] 任务已从队列移除：${taskId}`);
            return;
          }
          failures += 1;
          if (failures >= WATCH_MAX_FAILURES) giveUp(String(envelope.error?.message ?? 'ghd 查询失败'));
          return;
        }
        failures = 0;
        const task = envelope.result && typeof envelope.result === 'object' ? envelope.result : {};
        const status = String(task.status || '').toLowerCase();
        if (status === '') {
          // No state means the payload shape changed under us; count it instead of
          // polling garbage forever.
          failures += 1;
          if (failures >= WATCH_MAX_FAILURES) giveUp('ghd 未返回任务状态');
          return;
        }
        // Anything not known to be terminal is still in flight — `paused` included:
        // only a user resumes it, but it is not an outcome either.
        if (!TERMINAL_STATUSES.has(status)) return;
        stop();
        const file = resolveLandingPath(task);
        const headline = status === 'completed' ? '下载结束' : '下载中止';
        const text = [
          `[Ghost Downloader] ${headline}：${task.name || taskId}`,
          `状态：${status}`,
          file ? `文件：${file}` : '',
          task.error ? `错误：${JSON.stringify(task.error)}` : '',
        ].filter((line) => line !== '').join('\n');
        notify(text);
      } catch (error) {
        // transient CLI failure: keep watching, but do not spin forever
        failures += 1;
        if (failures >= WATCH_MAX_FAILURES) giveUp(String(error?.message ?? error));
      } finally {
        inFlight = false;
      }
    };
    timer = setInterval(check, pollIntervalMs);
    watchers.set(key, timer);
    // The timer is owned by the plugin scope, so an unload stops polling too.
    release = ctx.effect(() => () => clearInterval(timer), `ghost-download:watch(${taskId})`);
    // Check immediately: a short download may already be finished.
    check();
  }

  function ghd() {
    if (executable === undefined) executable = resolveGhdPath(pluginConfig.ghdPath);
    return executable;
  }

  /** Shared execution helper: run, parse, and shape a tool result. */
  async function call(args, options) {
    const result = await runGhd(ghd(), args, options);
    const payload = parsePayload(result.output);
    const envelope = unwrap(payload);
    // `ghd add` reports per-item failures inside the result array, so a successful
    // envelope does not mean every URL was accepted.
    const items = envelope.ok && Array.isArray(envelope.result) ? envelope.result : [];
    const failedItems = items.filter((item) => item && typeof item === 'object' && item.error);
    const itemFailure = failedItems.length > 0
      ? {
        code: 'itemFailed',
        message: `${failedItems.length} of ${items.length} link(s) failed`,
        items: failedItems,
      }
      : undefined;
    const ok = envelope.ok && !result.timedOut && result.code === 0 && itemFailure === undefined;
    return {
      ok,
      command: maskArgv(args),
      exitCode: result.code,
      timedOut: result.timedOut,
      ...(envelope.ok ? { result: envelope.result } : { error: envelope.error }),
      ...(itemFailure ? { error: itemFailure } : {}),
      raw: bounded(result.output),
    };
  }

  /** Shared renderer for the plain JSON tools: the result, else the error. */
  const jsonRender = (_args, value) => [{
    type: 'text',
    text: bounded(JSON.stringify(value?.ok ? value.result : value?.error ?? value, null, 2)),
  }];

  ctx.tools.register({
    name: 'ghost_download',
    description:
      'Submit downloads to Ghost Downloader (the single download engine) through its official ghd CLI. '
      + 'Accepts any protocol Ghost supports: HTTP/HTTPS, FTP, BitTorrent/magnet, HLS, DASH, eD2k. '
      + 'By default the call returns as soon as Ghost accepted the tasks. '
      + 'Set waitSeconds to block until the downloads finish, then report their final state. '
      + 'Use ghost_tasks / ghost_task / ghost_control for queue inspection and control.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        urls: {
          type: 'array',
          items: { type: 'string' },
          description: 'One or more links to download: http(s), ftp, magnet:, ed2k:, .torrent URL, or an HLS/DASH manifest URL.',
        },
        dir: {
          type: 'string',
          description: 'Destination folder for this task (ghd -o). Defaults to Ghost\'s configured download folder.',
        },
        select: {
          type: 'string',
          description: 'For torrents: comma-separated file indexes to download, for example "0,3". Only with a single URL.',
        },
        name: {
          type: 'string',
          description: 'Rename the downloaded file (ghd --name). Only with a single URL.',
        },
        headers: {
          type: 'array',
          items: { type: 'string' },
          description: 'Extra request headers as "Name: value" (ghd -H); repeatable.',
        },
        conflict: {
          type: 'string',
          enum: ['keep', 'overwrite'],
          description: 'When the target name already exists: keep both (default) or overwrite (ghd --conflict).',
        },
        waitSeconds: {
          type: 'integer',
          description:
            '0 or omitted: return immediately with the task ids. '
            + 'Positive: wait up to this many seconds for completion, then report the final task state.',
        },
      },
      required: ['urls'],
    },
    output: {
      schema: TOOL_OUTPUT_SCHEMA,
      render: (_args, value) => {
        const v = value && typeof value === 'object' ? value : {};
        const lines = [];
        const timedOut = Boolean(v.timedOut || v.waited?.timedOut);
        const ids = Array.isArray(v.taskIds) && v.taskIds.length > 0 ? v.taskIds : (v.taskId ? [v.taskId] : []);
        const statuses = Array.isArray(v.statuses) ? v.statuses : [];
        const statusText = statuses.length > 0 ? `（状态：${statuses.join(', ')}）` : '';
        if (v.ok) {
          lines.push(`ghd ${v.command}`);
          lines.push(JSON.stringify(v.result ?? null, null, 2));
          if (v.filePath) lines.push(`file: ${v.filePath}`);
          if (v.waited) lines.push(`wait: ${JSON.stringify(v.waited.result ?? v.waited.error ?? null)}`);
        } else if (v.stillRunning) {
          lines.push(`等待超时，任务仍在后台下载：${ids.join(', ')}${statusText}`);
          lines.push('完成后会自动通知本会话；也可以先用 ghost_task 查看进度，或用 ghost_wait 继续等。');
          if (v.filePath) lines.push(`预计文件：${v.filePath}`);
        } else {
          // The task state is the verdict, not the exit code: a failed or paused
          // download must never read as success.
          lines.push(`下载未成功${timedOut ? '（等待超时）' : ''}${statusText}`);
          lines.push(`ghd ${v.command}`);
          lines.push(JSON.stringify(v.error ?? null, null, 2));
          if (v.raw) lines.push(bounded(v.raw, MAX_ERROR_RAW));
        }
        return [{ type: 'text', text: bounded(lines.join('\n')) }];
      },
    },
    // Header values carry cookies and tokens; the card gets a summary only.
    presentCall: (args) => ({
      card: 'generic',
      kind: 'execute',
      title: `Ghost: ${Array.isArray(args?.urls) ? args.urls.length : 0} 个下载`,
      rawInput: { urls: Array.isArray(args?.urls) ? args.urls.slice(0, 5) : [], dir: args?.dir },
    }),
    // A single call may legitimately wait the full hour plus the surrounding ghd
    // calls; the budget only exists so a wedged ghd cannot hang the turn forever.
    // Worst case is NOT just the wait: the add call and one detail read per task
    // come on top, and a 50-link batch would otherwise be cut off by the host
    // long after the hour it just spent waiting.
    timeoutMs: (ADD_TIMEOUT_MS + DEFAULT_WAIT_LIMIT_SECONDS * 1000
      + MAX_URLS * TASK_TIMEOUT_MS + CONTROL_TIMEOUT_MS) + 60_000,
    async execute(args, exec) {
      const urls = Array.isArray(args?.urls) ? args.urls.filter((u) => typeof u === 'string' && u.trim() !== '') : [];
      if (urls.length === 0) throw new Error('ghost_download requires at least one URL.');
      if (urls.length > MAX_URLS) throw new Error(`ghost_download accepts at most ${MAX_URLS} links per call.`);
      const select = typeof args.select === 'string' && args.select.trim() !== '' ? args.select.trim() : undefined;
      const name = typeof args.name === 'string' && args.name.trim() !== '' ? args.name.trim() : undefined;
      // ghd answers a multi-URL --select/--name with a bare usage error; say it here.
      if (urls.length > 1 && (select !== undefined || name !== undefined)) {
        throw new Error('ghd --select and --name only apply to a single URL.');
      }
      const argv = ['add', ...urls];
      if (select !== undefined) argv.push('--select', select);
      if (name !== undefined) argv.push('--name', name);
      if (typeof args.dir === 'string' && args.dir.trim() !== '') argv.push('-o', args.dir.trim());
      if (args.conflict === 'overwrite') argv.push('--conflict', 'overwrite');
      const extraHeaders = Array.isArray(args.headers) ? args.headers : [];
      for (const header of extraHeaders) {
        if (typeof header !== 'string' || header.trim() === '') continue;
        if (!header.includes(':')) throw new Error(`Header "${header}" is not in "Name: value" form.`);
        argv.push('-H', header.trim());
      }

      const submitted = await call(argv, { timeoutMs: ADD_TIMEOUT_MS, signal: exec.signal });
      // `ghd add` reports per-item failures inside a successful envelope, so a
      // partial batch still has tasks that are really downloading. Deriving ids
      // from the whole payload used to drop them all when any one item failed.
      const accepted = submitted.ok && Array.isArray(submitted.result)
        ? submitted.result.filter((item) => item === null || typeof item !== 'object' || !item.error)
        : submitted.result;
      const taskIds = submitted.ok ? findTaskIds(accepted) : [];
      const waitSeconds = Number.isInteger(args.waitSeconds) ? args.waitSeconds : 0;

      if (!submitted.ok || waitSeconds <= 0 || taskIds.length === 0) {
        // Fire-and-forget: keep watching in the background and wake this session
        // when each task leaves the running state.
        for (const id of taskIds) watchTask(exec.agent, id);
        const warning = submitted.ok && waitSeconds > 0
          ? { warning: 'ghd 未返回任务 id，因此没有等待任何任务。' }
          : {};
        return { ...submitted, ...(taskIds.length > 0 ? { taskIds, taskId: taskIds[0] } : {}), ...warning };
      }

      const waited = await call(['wait', ...taskIds], {
        timeoutMs: Math.min(waitSeconds, DEFAULT_WAIT_LIMIT_SECONDS) * 1000,
        signal: exec.signal,
      });
      // `ghd wait` covers the whole set, but each task's verdict has to be read back.
      const detailResults = await Promise.all(taskIds.map((id) => call(['task', id], {
        timeoutMs: TASK_TIMEOUT_MS,
        signal: exec.signal,
      })));
      const statuses = detailResults.map((result) => {
        const detail = result.ok ? result.result : undefined;
        return String(detail?.status ?? '').toLowerCase();
      });
      const allCompleted = statuses.length === taskIds.length && statuses.every((status) => status === 'completed');
      // The `ghd wait` process is killed at the deadline. Everything that cannot
      // be PROVEN terminal goes to the background watcher: an unreadable detail
      // (empty status) is not evidence that the download stopped, and reporting
      // it as finished leaves the session believing a live download died.
      const stillRunning = waited.timedOut && statuses.some((status) => !TERMINAL_STATUSES.has(status));
      for (let index = 0; index < taskIds.length; index += 1) {
        if (waited.timedOut && !TERMINAL_STATUSES.has(statuses[index])) {
          watchTask(exec.agent, taskIds[index]);
        }
      }
      // `ghd task` reports fileSize 0 and an empty files[] for finished tasks,
      // so the landing path is resolved against the folder contents.
      const landing = detailResults
        .map((result) => (result.ok ? resolveLandingPath(result.result) : undefined))
        .find((value) => value !== undefined);
      const detailValue = detailResults.length === 1
        ? (detailResults[0].result ?? detailResults[0].error)
        : detailResults.map((result) => (result.ok ? result.result : { error: result.error }));
      // `ghd wait` exits 0 only when every task completed, so both halves matter.
      const ok = waited.ok && !waited.timedOut && allCompleted && detailResults.every((result) => result.ok);
      // An explicit verdict keeps the failure renderer from printing `null`.
      const failure = ok ? undefined : {
        code: waited.timedOut ? 'waitTimedOut' : 'notCompleted',
        message: waited.timedOut
          ? `waited ${Math.min(waitSeconds, DEFAULT_WAIT_LIMIT_SECONDS)}s and the tasks were still active`
          : `downloads did not all complete (${statuses.join(', ') || 'no status reported'})`,
        statuses,
      };
      return {
        ...submitted,
        taskId: taskIds[0],
        taskIds,
        waited: { ok: waited.ok, timedOut: waited.timedOut, result: waited.result ?? waited.error },
        detail: detailValue,
        statuses,
        stillRunning,
        ...(landing !== undefined ? { filePath: landing } : {}),
        ...(failure !== undefined ? { error: failure } : {}),
        ok,
      };
    },
  });

  ctx.tools.register({
    name: 'ghost_probe',
    description:
      'Preview a link with Ghost Downloader without adding a task (ghd probe). '
      + 'Returns the resolved name, size and file list — for torrents this is how you learn the file indexes for ghost_download select. '
      + 'Also useful to check whether Ghost recognizes a protocol (magnet, ed2k, HLS/DASH manifest) before downloading.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        url: {
          type: 'string',
          description: 'Link to inspect: http(s), ftp, magnet:, ed2k:, a .torrent URL, or an HLS/DASH manifest URL.',
        },
        headers: {
          type: 'array',
          items: { type: 'string' },
          description: 'Extra request headers as "Name: value" (ghd -H); repeatable.',
        },
      },
      required: ['url'],
    },
    output: {
      schema: TOOL_OUTPUT_SCHEMA,
      render: (_args, value) => {
        const v = value && typeof value === 'object' ? value : {};
        const prefix = v.cached ? '[cached] ' : '';
        return [{ type: 'text', text: bounded(prefix + JSON.stringify(v.ok ? v.result : v.error ?? v, null, 2)) }];
      },
    },
    isConcurrencySafe: () => true,
    timeoutMs: ADD_TIMEOUT_MS + 10000,
    async execute(args, exec) {
      const url = typeof args?.url === 'string' ? args.url.trim() : '';
      if (url === '') throw new Error('ghost_probe requires a url.');
      const argv = ['probe', url];
      const headers = Array.isArray(args.headers) ? args.headers : [];
      for (const header of headers) {
        if (typeof header !== 'string' || header.trim() === '') continue;
        if (!header.includes(':')) throw new Error(`Header "${header}" is not in "Name: value" form.`);
        argv.push('-H', header.trim());
      }
      const cacheKey = `${url}\u0000${JSON.stringify(headers)}`;
      const hit = probeCache.get(cacheKey);
      if (hit !== undefined) {
        if (Date.now() - hit.at < PROBE_TTL_MS) return { ...hit.value, cached: true };
        probeCache.delete(cacheKey);
      }
      const result = await call(argv, { timeoutMs: ADD_TIMEOUT_MS, signal: exec.signal });
      if (result.ok) {
        probeCache.set(cacheKey, { at: Date.now(), value: result });
        // Insertion-ordered eviction, so a long session cannot grow the map forever.
        while (probeCache.size > PROBE_CACHE_LIMIT) {
          const oldest = probeCache.keys().next().value;
          if (oldest === undefined) break;
          probeCache.delete(oldest);
        }
      }
      return result;
    },
  });

  ctx.tools.register({
    name: 'ghost_tasks',
    description: 'List the tasks currently known to Ghost Downloader (ghd tasks), including their state and progress.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        status: {
          type: 'string',
          description: 'Only list tasks in this state (ghd -s), for example waiting, running, paused, completed, failed.',
        },
      },
    },
    output: {
      schema: TOOL_OUTPUT_SCHEMA,
      render: (_args, value) => {
        const v = value && typeof value === 'object' ? value : {};
        if (!v.ok) return [{ type: 'text', text: bounded(JSON.stringify(v.error ?? null, null, 2)) }];
        const list = Array.isArray(v.result) ? v.result : [];
        const running = [];
        const completed = [];
        const paused = [];
        const failed = [];
        const other = [];
        for (const task of list) {
          // ghd reports lower-case states; normalize anyway so a casing change
          // upstream cannot silently dump everything into "other".
          const status = String(task?.status ?? '').toLowerCase();
          if (status === 'running' || status === 'waiting') running.push(task);
          else if (status === 'completed') completed.push(task);
          else if (status === 'paused') paused.push(task);
          else if (status === 'failed') failed.push(task);
          else other.push(task);
        }
        const lines = [
          `共 ${list.length} 个任务：运行中 ${running.length} / 已完成 ${completed.length}`
          + ` / 已暂停 ${paused.length} / 失败 ${failed.length} / 其他 ${other.length}`,
        ];
        const block = (label, items) => {
          if (items.length === 0) return;
          lines.push('', `[${label}]`);
          for (const task of items) {
            const progress = typeof task.progress === 'number' ? ` ${task.progress}%` : '';
            const error = task.error ? `  ${JSON.stringify(task.error)}` : '';
            lines.push(`- ${task.taskId}  ${task.name ?? ''}${progress}${error}`);
          }
        };
        block('运行中', running);
        block('已完成', completed);
        block('已暂停', paused);
        block('失败', failed);
        block('其他', other);
        return [{ type: 'text', text: bounded(lines.join('\n')) }];
      },
    },
    isConcurrencySafe: () => true,
    timeoutMs: TASK_TIMEOUT_MS + 10000,
    async execute(args, exec) {
      const argv = ['tasks'];
      if (typeof args?.status === 'string' && args.status.trim() !== '') argv.push('-s', args.status.trim());
      return call(argv, { timeoutMs: TASK_TIMEOUT_MS, signal: exec.signal });
    },
  });

  ctx.tools.register({
    name: 'ghost_task',
    description: 'Show one Ghost Downloader task in detail (ghd task <taskId>): state, progress, files, and errors.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { taskId: { type: 'string', description: 'Task id, for example tsk_0123.' } },
      required: ['taskId'],
    },
    output: {
      schema: TOOL_OUTPUT_SCHEMA,
      render: jsonRender,
    },
    isConcurrencySafe: () => true,
    timeoutMs: TASK_TIMEOUT_MS + 10000,
    async execute(args, exec) {
      const taskId = typeof args?.taskId === 'string' ? args.taskId.trim() : '';
      if (!taskId) throw new Error('ghost_task requires taskId.');
      return call(['task', taskId], { timeoutMs: TASK_TIMEOUT_MS, signal: exec.signal });
    },
  });

  ctx.tools.register({
    name: 'ghost_control',
    description:
      'Control Ghost Downloader tasks: pause (ghd pause), start or resume (ghd start), remove (ghd remove). '
      + 'remove also deletes the unfinished files of those tasks.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['pause', 'start', 'remove'], description: 'Operation to perform.' },
        taskIds: { type: 'array', items: { type: 'string' }, description: 'One or more task ids, for example ["tsk_0123"].' },
      },
      required: ['action', 'taskIds'],
    },
    output: {
      schema: TOOL_OUTPUT_SCHEMA,
      render: jsonRender,
    },
    timeoutMs: CONTROL_TIMEOUT_MS + 10000,
    async execute(args, exec) {
      const action = args?.action;
      if (!['pause', 'start', 'remove'].includes(action)) throw new Error(`Unsupported action "${String(action)}".`);
      const ids = Array.isArray(args?.taskIds) ? args.taskIds.filter((id) => typeof id === 'string' && id.trim() !== '') : [];
      if (ids.length === 0) throw new Error('ghost_control requires at least one task id.');
      return call([action, ...ids], { timeoutMs: CONTROL_TIMEOUT_MS, signal: exec.signal });
    },
  });

  ctx.tools.register({
    name: 'ghost_wait',
    description:
      'Block until the given Ghost Downloader tasks stop running (ghd wait), then report their final state. '
      + 'Use it on tasks submitted earlier with ghost_download; it returns once every task is completed, failed, paused or removed.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        taskIds: { type: 'array', items: { type: 'string' }, description: 'Task ids to wait for, for example ["tsk_0123"].' },
        timeoutSeconds: {
          type: 'integer',
          description: 'Maximum seconds to block (default 600, capped at 3600). On timeout the result carries timedOut: true.',
        },
      },
      required: ['taskIds'],
    },
    output: {
      schema: TOOL_OUTPUT_SCHEMA,
      render: jsonRender,
    },
    timeoutMs: (DEFAULT_WAIT_LIMIT_SECONDS + 120) * 1000,
    async execute(args, exec) {
      const ids = Array.isArray(args?.taskIds) ? args.taskIds.filter((id) => typeof id === 'string' && id.trim() !== '') : [];
      if (ids.length === 0) throw new Error('ghost_wait requires at least one task id.');
      const limit = Number.isInteger(args.timeoutSeconds)
        ? Math.min(Math.max(args.timeoutSeconds, 1), DEFAULT_WAIT_LIMIT_SECONDS)
        : 600;
      return call(['wait', ...ids], { timeoutMs: limit * 1000, signal: exec.signal });
    },
  });

  // Read-only queue snapshot for the composer-dock card. It answers any local
  // process, so it exposes only labels and progress — never URLs, paths or headers.
  const webServer = ctx.get('webServer');
  if (webServer) {
    let snapshot = { at: 0, payload: { ok: false, tasks: [] } };
    /** One ghd spawn shared by every poller inside the TTL window. */
    let inFlight;
    const readQueue = async () => {
      if (inFlight === undefined) {
        inFlight = (async () => {
          try {
            const result = await runGhd(ghd(), ['tasks'], { timeoutMs: SNAPSHOT_TIMEOUT_MS });
            const envelope = unwrap(parsePayload(result.output));
            const tasks = envelope.ok && Array.isArray(envelope.result)
              ? envelope.result.map((task) => ({
                id: task.taskId,
                name: task.name,
                status: task.status,
                progress: task.progress,
              }))
              : [];
            snapshot = { at: Date.now(), payload: { ok: envelope.ok, tasks } };
          } catch (error) {
            snapshot = { at: Date.now(), payload: { ok: false, tasks: [], error: String(error) } };
          } finally {
            inFlight = undefined;
          }
        })();
      }
      await inFlight;
    };
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/plugin/ghost-download/tasks',
      resource: async () => {
        if (Date.now() - snapshot.at > SNAPSHOT_TTL_MS) await readQueue();
        return new Response(JSON.stringify(snapshot.payload), {
          status: 200,
          headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
        });
      },
    }), 'ghost-download:snapshot-route');
  }

  // Force every download through Ghost: deny shell downloads that write files themselves.
  // This is a guardrail for well-behaved calls, not a security boundary: reading a
  // script file's contents is out of scope here.
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (!blockShellDownloads) return next();
    const name = String(exec?.name || '');
    if (!/bash|shell|pwsh|powershell|exec|terminal/i.test(name)) return next();
    const args = exec?.arguments;
    // `ops_bash` separates an inline command from a prepared script path.
    const candidates = [args?.command, args?.script, args?.script_path];
    for (const candidate of candidates) {
      const blocked = shellDownloadOf(candidate);
      if (!blocked) continue;
      return {
        kind: 'deny',
        reason:
          `Shell download blocked: "${blocked.slice(0, 120)}". `
          + 'Downloads must go through Ghost Downloader — call ghost_download with these URLs instead. '
          + 'It shares the same queue as the desktop app and can wait for completion.',
        info: { name: 'ghost-download', code: 'shell_download_blocked' },
      };
    }
    return next();
  });
}
