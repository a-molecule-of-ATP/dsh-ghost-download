/**
 * Host half of the dsh-ghost-download bundle.
 *
 * Drives Ghost Downloader through its official command line tool (`ghd.exe`):
 * add / tasks / task / pause / start / remove / wait. The CLI is Ghost's
 * documented integration surface; the aria2-compatible RPC only implements
 * addUri + getVersion, which cannot answer "is this download finished".
 */
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import * as nodeZlib from 'node:zlib';
import { closeSync, createReadStream, existsSync, mkdirSync, openSync, readdirSync, readFileSync, statfsSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
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

/**
 * Package name, as the Loader records it on this row's entry (`options.name`).
 *
 * `readRowConfig` matches the row by THIS, never by a hard-coded row id: the
 * profile may rename the row (`ghost-download` here), and matching by name is
 * what the official plugins do for the same lookup.
 */
const PACKAGE_NAME = '@local/dsh-ghost-download';

/** Tools only; everything else comes from the CLI. */
export const inject = ['tools', 'configEditor', 'workingDirectory'];

/**
 * Row configuration.
 *
 * A linked plugin cannot resolve `@deepseek-ai/schemastery` from the dsh install,
 * so the package is vendored into this bundle's node_modules. The Settings form
 * projects this schema, and cordis validates the row's config with it on activation.
 */
export const Config = Schema.object({
  // Every editable field is `.volatile()`: a save from the plugin page writes the
  // value in place instead of restarting the plugin, so `apply` never re-runs and
  // the module keeps serving while the new value is picked up per call. A
  // volatile field resolves to a `{ get() }` reference at runtime, never to the
  // bare value — `readRowConfig`/`plain` unwrap it.
  enabled: Schema.boolean().default(true).volatile()
    .description('关闭后不注册任何 ghost_* 工具；其余设置保留。'),
  ghdPath: Schema.string().default('').volatile()
    .description('ghd.exe path; empty auto-detects the standard install.'),
  pollIntervalMs: Schema.natural().default(5000).min(1000).volatile()
    .description('Background completion poll interval in milliseconds.'),
  blockShellDownloads: Schema.boolean().default(true).volatile()
    .description('Deny curl -o / curl -O / wget and redirect them to ghost_download.'),
  // The bounds match the clamps in `readRowConfig`, so an out-of-range save is
  // rejected by the Host instead of being silently replaced by a default.
  maxUrlsPerCall: Schema.natural().default(50).min(1).volatile()
    .description('一次 ghost_download 最多接受多少个链接。'),
  waitLimitSeconds: Schema.natural().default(3600).min(10).max(7200).volatile()
    .description('ghost_download / ghost_wait 同步等待的上限秒数。'),
  watchLimitMinutes: Schema.natural().default(30).min(1).volatile()
    .description('后台监视单个任务的时限（分钟）。超过后停止轮询并通知会话。'),
  maxOutputChars: Schema.natural().default(20000).min(500).volatile()
    .description('成功结果回传给模型的上限（字符）。'),
  maxErrorChars: Schema.natural().default(2000).min(200).volatile()
    .description('失败时附带原始输出的上限（字符）。'),
  allowedUrlSchemes: Schema.array(Schema.string()).min(1)
    .default(['http', 'https', 'ftp', 'magnet', 'ed2k']).volatile()
    .description('允许提交的协议白名单；不在列表里的链接会被直接拒绝。'),
  controlRemoveEnabled: Schema.boolean().default(true).volatile()
    .description('是否允许 ghost_control 的 remove。关闭后 remove 会从工具的参数枚举里消失。remove 会删除该任务尚未完成的文件。'),
  noticeIncludePath: Schema.boolean().default(true).volatile()
    .description('后台完成通知里是否附带下载文件的绝对路径。'),
});

const MAX_OUTPUT = 20000;
/** A failed call shows its captured output far shorter than a success value. */
const MAX_ERROR_RAW = 2000;
const DEFAULT_WAIT_LIMIT_SECONDS = 3600;
/**
 * The schema's own ceiling for `waitLimitSeconds`. The registered tool budget is
 * derived from it, so a raised setting can never outlive the deadline the host
 * enforces; `execute` additionally clamps the wait to what is actually left.
 */
const MAX_WAIT_LIMIT_SECONDS = 7200;
/** `ghost_wait`'s fallback when neither the call nor the row names a timeout. */
const DEFAULT_WAIT_TOOL_SECONDS = 600;
/**
 * The schemes a link may use out of the box.
 *
 * Kept as one list so the schema default, the validator and the error message
 * cannot disagree about what "the supported protocols" means.
 */
const DEFAULT_URL_SCHEMES = ['http', 'https', 'ftp', 'magnet', 'ed2k'];
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
/**
 * Timeout for the throwaway `ghd probe` a precheck / doctor runs before doing
 * anything else. Short on purpose: it must not stall the real download for more
 * than a few seconds when Ghost happens to be offline.
 */
const PRECHECK_PROBE_TIMEOUT_MS = 20000;
/** Stop background watching after this many consecutive CLI failures. */
const WATCH_MAX_FAILURES = 10;
/** A killed ghd that never exits settles the call from the log it already wrote. */
const KILL_GRACE_MS = 2000;
/**
 * Registered deadline for one `ghost_download` call, and the ceiling its wait is
 * clamped against (see the registration comment). Derived from the schema
 * MAXIMUM, never from the live setting: `timeoutMs` is fixed at registration,
 * so a value read per call would let the wait outlive the host deadline — and
 * the kill would also skip the background watchers `execute` registers after it.
 */
const DOWNLOAD_BUDGET_MS = ADD_TIMEOUT_MS + MAX_WAIT_LIMIT_SECONDS * 1000
  + MAX_URLS * TASK_TIMEOUT_MS + CONTROL_TIMEOUT_MS + 60_000;

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
    /** Untrimmed count when a `limit` shortened `result`; declared because the
     *  schema forbids extra properties, so omitting it rejects the whole output. */
    total: { type: 'integer' },
    /** Result of a `checksum` request on ghost_wait. */
    checksum: {},
    precheck: {},
    attribution: {},
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
  // `GHOST_GHD` is the documented name; `GHD_PATH` is accepted too because the
  // settings card used to advertise it, and a user who followed that hint must
  // not end up with a silently ignored variable.
  for (const key of ['GHOST_GHD', 'GHD_PATH']) {
    const fromEnv = process.env[key];
    if (typeof fromEnv === 'string' && fromEnv.trim() !== '') candidates.push(fromEnv.trim());
  }
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

/** Mask header values that ghd may echo back in error output. */
function maskSecrets(text) {
  return String(text)
    .replace(/(-H|--header)\s+("[^"]*"|'[^']*'|\S+)/g, '$1 <redacted>')
    .replace(/((?:Authorization|Cookie|Set-Cookie|X-Api-Key)\s*:\s*)[^\r\n]+/gi, '$1<redacted>');
}

/**
 * Cap one model-facing string.
 *
 * The caller passes the cap explicitly: every limit now lives on the row's live
 * Config, and a module-level default would be a second, silently frozen copy of
 * the same number. The truncation marker is charged against the cap so the
 * returned string never exceeds what the setting promises.
 */
function bounded(text, cap) {
  const value = String(text || '');
  const limit = Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : MAX_OUTPUT;
  if (value.length <= limit) return value;
  const marker = `\n[... truncated ${value.length} chars]`;
  const keep = Math.max(0, limit - marker.length);
  return `${value.slice(0, keep)}${marker}`;
}

/** A volatile field resolves to `{ get() }`; an ordinary one to the bare value. */
function plain(value) {
  if (value !== null && typeof value === 'object' && typeof value.get === 'function') {
    try {
      return value.get();
    } catch {
      return undefined;
    }
  }
  return value;
}

/**
 * Read Ghost Downloader's own settings (read-only) for the doctor's cross-check.
 * Returns `{ downloadFolder, proxyServer, source }` or `{ error }` when missing.
 * The path is固定的官方位置：%LOCALAPPDATA%\GhostDownloader\UserConfig.json。
 */
function readGhostUserConfig() {
  const base = process.env.LOCALAPPDATA;
  if (!base) return { error: '未找到环境变量 LOCALAPPDATA（非 Windows 或环境异常）。' };
  const file = path.join(base, 'GhostDownloader', 'UserConfig.json');
  try {
    if (!existsSync(file)) return { error: `未找到 ${file}（Ghost 可能尚未保存过设置）。`, path: file };
    const raw = readFileSync(file, 'utf8');
    const json = JSON.parse(raw);
    const general = json?.GeneralDownload ?? json?.generalDownload ?? {};
    const downloadFolder = typeof general.DownloadFolder === 'string' ? general.DownloadFolder : undefined;
    const proxyServer = typeof json?.ProxyServer === 'string'
      ? json.ProxyServer
      : (typeof general.ProxyServer === 'string' ? general.ProxyServer : undefined);
    return { downloadFolder, proxyServer, path: file };
  } catch (error) {
    return { error: `读取或解析失败：${String(error?.message ?? error)}`, path: file };
  }
}

/**
 * Turn a ghd error string into an attribution the model can act on.
 *
 * Deliberately hedged ("可能原因"): the matcher sees text, not ground truth, so
 * it must never assert the cause. Returns `{ category, hint, retryable, nextAction }`.
 */
function failureAttribution(error) {
  // ghd reports the failure in `error`, `lastError`, or sometimes a nested
  // `message`; gather every string form into one lower-cased haystack.
  const parts = [];
  const collect = (value) => {
    if (typeof value === 'string') parts.push(value);
    else if (value && typeof value === 'object') {
      for (const key of ['message', 'code', 'error', 'lastError', 'detail', 'reason']) {
        if (value[key] !== undefined) collect(value[key]);
      }
    }
  };
  collect(error);
  const text = parts.join(' ').toLowerCase();

  const match = (pattern) => pattern.test(text);
  let category = 'unknown';
  let hint = '可能原因不明；请查看原始 error 输出，或稍后重试。';
  let retryable = true;
  // A concrete next step, not a diagnosis: the point of attribution is that the
  // model has something to do afterwards instead of re-reading the same error.
  let nextAction = '先 ghost_task 看完整 error，再用 ghost_control(action:"retry") 重试一次。';

  if (match(/ssl|certificate|certificate_verify_failed|cert_verify|tls|握手/i)) {
    category = 'certificate';
    hint = '可能原因：目标站点的 SSL/TLS 证书校验失败（代理、自签名证书或系统时间异常都可能引起）。'
      + '请检查系统时间与代理证书设置；若确认可信，可在 Ghost 设置中调整证书校验。';
    nextAction = '先确认系统时间与代理设置；确认站点可信后，在 Ghost 设置里关闭证书校验再 ghost_control(action:"retry")。';
  } else if (match(/dns|11001|host not found|name resolution|getaddrinfo|enotfound/i)) {
    category = 'network.dns';
    hint = '可能原因：域名解析失败（DNS 不可达、域名不存在或网络断开）。请检查网络连接与 DNS 设置后重试。';
    nextAction = '先 ghost_doctor 看网络探测结果；网络恢复后 ghost_control(action:"retry")。';
  } else if (match(/\b403\b|\b401\b|unauthorized|forbidden|access denied/i)) {
    category = 'auth';
    hint = '可能原因：服务器拒绝了未授权的请求（403/401）。可尝试在 headers 里补上 Referer / Cookie 等鉴权信息后重试。';
    nextAction = '用 ghost_download 重新提交同一个链接，并在 headers 里带上 Referer / Cookie 等鉴权信息。';
  } else if (match(/\b404\b|not found|gone/i)) {
    category = 'gone';
    hint = '可能原因：资源不存在或已被移除（404）。该链接可能已失效，通常不建议重试。';
    retryable = false;
    nextAction = '先用 ghost_probe 复核该链接；仍然 404 就换源，不要重复重试。';
  } else if (match(/范围请求|range request|range not satisfiable|416|range|断点续传/i)) {
    category = 'noRange';
    hint = '可能原因：服务器拒绝了范围请求，无法断点续传。可尝试删除残缺文件后从头下载。';
    nextAction = 'ghost_control(action:"remove", taskIds:[…]) 清掉残缺任务，再 ghost_download 重新提交。';
  }

  return { category, hint, retryable, nextAction };
}

/**
 * The row's live configuration.
 *
 * `apply` captures the activation-time config, which is a snapshot: a save from
 * the plugin page writes a `.volatile()` field in place instead of restarting
 * the plugin, so the captured object never changes again. Two sources are
 * therefore merged on every call:
 *
 * - the volatile references on the captured config, which the Loader updates in
 *   place (`field.get()` is the freshest answer);
 * - the row entry's raw config from `configEditor`, for fields that arrived
 *   after activation.
 *
 * Without this, a saved value would only take effect after a plugin restart —
 * which is not what the settings card promises.
 */
function readRowConfig(ctx, captured) {
  const read = (field, fallback) => {
    const own = plain(captured?.[field]);
    return own === undefined ? fallback : own;
  };
  /** Read one captured field, normalized to the documented type and default. */
  const pick = (field, fallback, accept) => {
    const value = plain(captured?.[field]);
    return value !== undefined && accept(value) ? value : fallback;
  };
  const isBool = (v) => typeof v === 'boolean';
  const isText = (v) => typeof v === 'string';
  const isNum = (v) => Number.isFinite(v);
  /** A non-empty array of non-empty strings, trimmed — anything else is ignored. */
  const cleanList = (value) => {
    const list = Array.isArray(value)
      ? value
      : typeof value === 'string' ? value.split(/[\n,]/) : undefined;
    if (list === undefined) return undefined;
    const out = [];
    for (const item of list) {
      if (typeof item !== 'string') continue;
      const trimmed = item.trim();
      if (trimmed !== '' && !out.includes(trimmed)) out.push(trimmed);
    }
    return out.length > 0 ? out : undefined;
  };
  const merged = {
    enabled: pick('enabled', true, isBool),
    ghdPath: pick('ghdPath', '', isText),
    pollIntervalMs: pick('pollIntervalMs', 5000, isNum),
    blockShellDownloads: pick('blockShellDownloads', true, isBool),
    maxUrlsPerCall: pick('maxUrlsPerCall', MAX_URLS, isNum),
    waitLimitSeconds: pick('waitLimitSeconds', DEFAULT_WAIT_LIMIT_SECONDS, isNum),
    watchLimitMinutes: pick('watchLimitMinutes', 30, isNum),
    maxOutputChars: pick('maxOutputChars', MAX_OUTPUT, isNum),
    maxErrorChars: pick('maxErrorChars', MAX_ERROR_RAW, isNum),
    // An empty allow-list would reject every link, so it falls back to the
    // documented default instead of locking the plugin out of its own purpose.
    allowedUrlSchemes: cleanList(plain(captured?.allowedUrlSchemes)) ?? [...DEFAULT_URL_SCHEMES],
    controlRemoveEnabled: pick('controlRemoveEnabled', true, isBool),
    noticeIncludePath: pick('noticeIncludePath', true, isBool),
  };
  try {
    const editor = ctx.get('configEditor');
    const entry = editor?.entries?.().find((candidate) => candidate?.options?.name === PACKAGE_NAME);
    const values = entry?.options?.config;
    if (values !== null && typeof values === 'object') {
      const take = (field, accept) => {
        const value = plain(values[field]);
        if (value !== undefined && accept(value)) merged[field] = value;
      };
      take('enabled', isBool);
      take('ghdPath', isText);
      take('pollIntervalMs', isNum);
      take('blockShellDownloads', isBool);
      take('maxUrlsPerCall', isNum);
      take('waitLimitSeconds', isNum);
      take('watchLimitMinutes', isNum);
      take('maxOutputChars', isNum);
      take('maxErrorChars', isNum);
      const schemes = cleanList(plain(values.allowedUrlSchemes));
      if (schemes !== undefined) merged.allowedUrlSchemes = schemes;
      take('controlRemoveEnabled', isBool);
      take('noticeIncludePath', isBool);
    }
  } catch {
    // No configuration editor in this composition: keep the captured values.
  }
  return merged;
}

/**
 * The default landing folder: `<session working directory>/downloads`.
 *
 * Ghost's own download folder sits outside the workspace, so defaulting to it
 * hands the agent a path its file tools cannot read. An unwritable workspace
 * falls back to `''`, which makes the caller omit `-o` and let Ghost decide.
 *
 * @param ctx - plugin context supplying `workingDirectory`.
 * @param exec - the tool execution context carrying the calling agent.
 * @returns an absolute folder, or `''` to leave the destination to Ghost.
 */
function workspaceDownloads(ctx, exec) {
  let base;
  try {
    const session = exec?.agent?.session;
    base = session === undefined ? process.cwd() : ctx.workingDirectory.get(session);
  } catch {
    base = process.cwd();
  }
  const dir = path.join(base, 'downloads');
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    return '';
  }
  return dir;
}

/**
 * Register the Ghost Downloader tools.
 * @param ctx - tool registry.
 * @param config - optional `{ ghdPath }` row configuration.
 */
export function apply(ctx, config) {
  const pluginConfig = config && typeof config === 'object' ? config : {};
  /**
   * The live row settings. Read through `settings()` on every call instead of
   * being captured here: every field is `.volatile()`, so a save updates the
   * plugin in place and `apply` never runs again.
   */
  const settings = () => readRowConfig(ctx, pluginConfig);
  /**
   * Refuse to run while the row is switched off.
   *
   * `enabled` is `.volatile()`, so turning it off no longer restarts the plugin:
   * the activation-time early return cannot unregister tools that are already
   * registered. Every entry point therefore re-checks the switch, so the card
   * behaves as it promises instead of leaving live tools behind a dead toggle.
   */
  const assertEnabled = () => {
    if (settings().enabled === false) {
      throw new Error('ghost-download 已在本插件的设置中关闭：请先在插件页的「总开关」里启用，再调用 ghost_* 工具。');
    }
  };
  let executable;
  /** How often the background watcher asks ghd about a task (config `pollIntervalMs`). */
  const pollInterval = () => {
    const value = settings().pollIntervalMs;
    return Number.isInteger(value) && value >= 1000 ? value : 5000;
  };
  /** Set `blockShellDownloads: false` to keep curl/wget downloads allowed. */
  const blockShellDownloads = () => settings().blockShellDownloads !== false;
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

  /**
   * The scheme of a link, lower-cased, for the allow-list.
   *
   * `magnet:`/`ed2k:` carry no `//`; splitting on the first colon keeps them on
   * the same path as http(s)/ftp instead of needing a second rule.
   */
  const schemeOf = (url) => {
    const match = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(String(url).trim());
    return match === null ? '' : match[1].toLowerCase();
  };

  /** Reject a link whose scheme the row does not allow, naming the usable ones. */
  const assertSchemeAllowed = (url, allowed) => {
    const scheme = schemeOf(url);
    // The configured list arrives from the settings page, a hand-edited profile row,
    // or the schema default, and only the page lowercases it. Compare case-blind so
    // `["HTTP"]` in a YAML file cannot reject every https link.
    const normalized = (Array.isArray(allowed) ? allowed : []).map((entry) => String(entry).trim().toLowerCase());
    if (scheme !== '' && normalized.includes(scheme)) return;
    const shown = scheme === '' ? '无法识别的链接' : `${scheme}:`;
    throw new Error(
      `不支持的协议 ${shown}（${url}）。当前允许的协议：${normalized.join(', ')}`
        + '。可在本插件设置的「安全 → 允许的协议」里调整。',
    );
  };

  /**
   * Normalize request headers supplied by one call.
   *
   * Duplicate names collapse to the first occurrence and the comparison is
   * case-insensitive because HTTP header names are.
   */
  const mergeHeaders = (defaults, extra) => {
    const out = [];
    const seen = new Set();
    for (const header of [...extra, ...defaults]) {
      if (typeof header !== 'string') continue;
      const trimmed = header.trim();
      if (trimmed === '') continue;
      const colon = trimmed.indexOf(':');
      if (colon <= 0) continue;
      const key = trimmed.slice(0, colon).trim().toLowerCase();
      if (key === '' || seen.has(key)) continue;
      seen.add(key);
      out.push(trimmed);
    }
    return out;
  };

  /**
   * One sentence naming the protocols the row currently allows.
   *
   * The tool description used to promise "any protocol Ghost supports" while the
   * allow-list could reject most of them; the promise is now the actual rule.
   */
  const schemeSentence = () => {
    const allowed = settings().allowedUrlSchemes;
    return `Accepts only these link schemes (set in the plugin's own settings): ${allowed.join(', ')}.`;
  };

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

  /**
 * Hash algorithms we can verify locally. `ghd` has no checksum support, so the
 * plugin computes the digest itself once the file has landed.
 */
const CHECKSUM_ALGORITHMS = {
  md5: 'md5', sha1: 'sha1', sha256: 'sha256', sha512: 'sha512',
  // CRC32 is not a node:crypto digest, so it is computed here; Mister Download
  // Manager supports it and it is the one algorithm we were missing.
  crc32: 'crc32',
};
/** Digest length -> algorithm, for a bare hex string with no prefix. */
const CHECKSUM_BY_LENGTH = { 8: 'crc32', 32: 'md5', 40: 'sha1', 64: 'sha256', 128: 'sha512' };

/**
 * Parse an expected checksum in the form `sha256:<hex>` (or a bare hex digest
 * whose length identifies the algorithm).
 *
 * @param raw - user-supplied value.
 * @returns `{ algorithm, expected }` or `{ error }`.
 */
function parseChecksum(raw) {
  const text = String(raw).trim().toLowerCase();
  const prefixed = /^([a-z0-9]+)\s*:\s*([0-9a-f]+)$/.exec(text);
  if (prefixed) {
    const algorithm = CHECKSUM_ALGORITHMS[prefixed[1]];
    if (!algorithm) {
      return { error: `unsupported checksum algorithm "${prefixed[1]}" (use md5, sha1, sha256, sha512 or crc32)` };
    }
    if (CHECKSUM_BY_LENGTH[prefixed[2].length] !== algorithm) {
      return { error: `"${algorithm}" digest has the wrong length (${prefixed[2].length} chars)` };
    }
    return { algorithm, expected: prefixed[2] };
  }
  if (/^[0-9a-f]+$/.test(text) && CHECKSUM_BY_LENGTH[text.length] !== undefined) {
    return { algorithm: CHECKSUM_BY_LENGTH[text.length], expected: text };
  }
  return {
    error: 'use "<algorithm>:<hex>" such as sha256:abc… (md5 / sha1 / sha256 / sha512 / crc32), '
      + 'or a bare hex digest whose length identifies the algorithm',
  };
}

/**
 * Stream a file through CRC-32; the digest is 8 hex characters.
 *
 * `zlib.crc32` (Node >= 22.15) already implements the IEEE 802.3 variant that
 * zip uses, and accepts the previous value so a file can be hashed chunk by
 * chunk without building a hash object. Older runtimes get a clear error rather
 * than a silently different number.
 */
async function crc32File(filePath) {
  if (typeof nodeZlib.crc32 !== 'function') {
    throw new Error('CRC32 needs zlib.crc32 (Node >= 22.15); pass sha256 instead on this runtime.');
  }
  let crc = 0;
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => {
      crc = nodeZlib.crc32(chunk, crc);
    });
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return (crc >>> 0).toString(16).padStart(8, '0');
}

/**
 * Stream one file through a digest so a large download is never held in memory.
 *
 * @param filePath - file to hash.
 * @param algorithm - node:crypto algorithm name.
 * @returns hex digest.
 */
async function hashFile(filePath, algorithm) {
  const hash = createHash(algorithm);
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

/** Protocol label shown to the user for a submitted link. */
function protocolOf(url) {
  const text = String(url ?? '').trim();
  const scheme = (/^([a-z][a-z0-9+.-]*):/i.exec(text)?.[1] ?? '').toLowerCase();
  // HLS and DASH ride on http(s); saying "https" alone would misdescribe them.
  const path = text.split('?')[0].split('#')[0].toLowerCase();
  if (path.endsWith('.m3u8')) return { scheme, kind: 'HLS' };
  if (path.endsWith('.mpd')) return { scheme, kind: 'DASH' };
  return { scheme, kind: undefined };
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
    /**
     * A paused task can wait overnight; without a deadline this polls forever.
     * The budget is re-read on every tick, so raising `watchLimitMinutes` while a
     * task is already being watched extends it (and lowering it cuts it short)
     * instead of freezing the value captured when the watcher started.
     */
    const startedAt = Date.now();
    const watchLimitMs = () => {
      const minutes = settings().watchLimitMinutes;
      return Number.isFinite(minutes) && minutes >= 1 ? minutes * 60 * 1000 : WATCH_MAX_MS;
    };
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
      // Switching the row off stops the poller too: the tools are already
      // refusing calls, and a lingering watcher would keep spawning `ghd` for a
      // plugin the user believes is off.
      if (settings().enabled === false) {
        giveUp('插件已在设置中关闭，后台监视随之停止');
        return;
      }
      const limitMs = watchLimitMs();
      if (Date.now() - startedAt > limitMs) {
        // A paused task can sit there for days; the watcher is not a subscription.
        // The message quotes the limit actually in force, not a hard-coded 30.
        giveUp(`已监视 ${Math.max(1, Math.round(limitMs / 60000))} 分钟仍未结束`);
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
        // The absolute path is the useful part of the notice, but a row can keep
        // it out of the transcript; the file name still identifies the download.
        const cfg = settings();
        const shown = file === undefined
          ? ''
          : cfg.noticeIncludePath ? `文件：${file}` : `文件：${path.basename(file)}（路径已在设置中隐藏）`;
        const text = [
          `[Ghost Downloader] ${headline}：${task.name || taskId}`,
          `状态：${status}`,
          shown,
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
    timer = setInterval(check, pollInterval());
    watchers.set(key, timer);
    // The timer is owned by the plugin scope, so an unload stops polling too.
    release = ctx.effect(() => () => clearInterval(timer), `ghost-download:watch(${taskId})`);
    // Check immediately: a short download may already be finished.
    check();
  }

  /**
   * Resolve ghd.exe once per activation.
   *
   * `ghdPath` is re-read on every miss so a corrected path takes effect without
   * a restart, and a *failed* resolution is never cached — a plugin activated
   * before Ghost was installed must recover on the next call.
   */
  function ghd() {
    if (executable === undefined) executable = resolveGhdPath(settings().ghdPath);
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
      raw: bounded(result.output, settings().maxOutputChars),
    };
  }

  /** Shared renderer for the plain JSON tools: the result, else the error. */
  const jsonRender = (_args, value) => [{
    type: 'text',
    // A failure is a diagnostic tail, not a payload: it uses the error budget so
    // one refused call cannot dump `maxOutputChars` of CLI noise into the turn.
    text: bounded(
      JSON.stringify(value?.ok ? value.result : value?.error ?? value, null, 2),
      value?.ok ? settings().maxOutputChars : settings().maxErrorChars,
    ),
  }];

  /**
   * Run a lightweight `ghd probe` and return only the fields a precheck needs:
   * the resolved file name and its byte size. Never throws — a probe failure is
   * returned as `{ ok:false, reason }` so callers can report it without losing
   * the real download.
   */
  async function probeInfo(url, headers, signal) {
    const argv = ['probe', url];
    for (const header of headers) argv.push('-H', header);
    try {
      const result = await call(argv, { timeoutMs: PRECHECK_PROBE_TIMEOUT_MS, signal });
      if (!result.ok) {
        return { ok: false, reason: result.error?.message ?? 'ghd probe 未返回成功结果' };
      }
      const p = result.result && typeof result.result === 'object' ? result.result : {};
      // ghd probe reports a scalar size in bytes; tolerate a few aliases ghd has
      // used across versions. A size that cannot be read as a finite number stays
      // `undefined` so no false "insufficient space" verdict is produced.
      const rawSize = p.size ?? p.fileSize ?? p.totalSize ?? p.length;
      const size = Number.isFinite(Number(rawSize)) && rawSize !== null && rawSize !== ''
        ? Number(rawSize)
        : undefined;
      const name = typeof p.name === 'string' && p.name !== ''
        ? p.name
        : (typeof p.fileName === 'string' ? p.fileName : undefined);
      return { ok: true, name, size };
    } catch (error) {
      return { ok: false, reason: String(error?.message ?? error) };
    }
  }

  /**
   * Free bytes on the filesystem holding `folder`, via node:fs statfsSync.
   * Returns `undefined` when the path does not exist or statfs is unavailable,
   * so callers can label the check "未检查" instead of inventing a number.
   */
  function freeBytesOf(folder) {
    if (typeof folder !== 'string' || folder === '') return undefined;
    try {
      const stats = statfsSync(folder);
      if (stats && Number.isFinite(stats.bavail)) {
        return stats.bavail * stats.bsize;
      }
    } catch {
      // unavailable on this platform / path — treated as "not checked"
    }
    return undefined;
  }

  /**
   * Resolve the exact target path for a same-name check. `name` from the user
   * takes precedence; otherwise the probed file name is used. Only single-file
   * names without path separators are accepted (a bare file name, not a path).
   */
  function targetPathOf(folder, name) {
    if (typeof folder !== 'string' || folder === '' || typeof name !== 'string' || name === '') return undefined;
    if (name.includes('/') || name.includes('\\') || path.isAbsolute(name)) return undefined;
    return path.join(folder, name);
  }

  /**
   * What was submitted, and in which turn.
   *
   * The conversation card has to answer "these downloads came from this turn", and
   * the only shared coordinate between a tool call and the client's turn component
   * is the session's event sequence: `session.log` events carry `seq`, and the turn
   * card receives `turn.start.seq` / `turn.end.seq`. Recording the last seq at
   * submit time is enough to place the card exactly.
   *
   * Nothing here is persisted; a restart simply loses the cards of old turns.
   */
  const SUBMISSION_CAP = 100;
  const submissions = [];
  const recordSubmission = (exec, items) => {
    const agent = exec?.agent;
    const session = agent?.session;
    const sessionId = typeof session?.id === 'string' ? session.id : '';
    const callId = typeof exec?.callId === 'string' ? exec.callId : '';
    if (sessionId === '' || items.length === 0) return;
    const log = session?.log;
    const seq = Array.isArray(log) && log.length > 0 ? log[log.length - 1]?.seq : undefined;
    submissions.push({
      sessionId,
      ...(callId === '' ? {} : { callId }),
      ...(Number.isFinite(seq) ? { seq } : {}),
      at: Date.now(),
      items,
    });
    while (submissions.length > SUBMISSION_CAP) submissions.shift();
  };

  // Read-only queue snapshot for the sidebar pane and the composer-dock card.
  // Registered BEFORE the `enabled` early return: the browser half always mounts
  // its tab, so a disabled plugin must keep answering this route instead of
  // leaving the pane on a permanent 404. Safe to serve either way — it exposes
  // only names, statuses and progress, never URLs, paths or headers.
  const webServer = ctx.get('webServer');
  if (webServer) {
    let snapshot = { at: 0, payload: { ok: false, tasks: [] } };
    /** One ghd spawn shared by every poller inside the TTL window. */
    let inFlight;
    /**
     * Per-task history of `{ at, receivedBytes }` samples for speed estimation.
     * Bounded to 5 points (a sliding window): no extra ghd process is spawned —
     * samples are taken from the SAME `ghd tasks` snapshot already polled here.
     */
    const speedHistory = new Map();
    const SPEED_WINDOW = 5;
    /** Pick the byte counter ghd exposes, if any. `null` when unavailable. */
    const receivedOf = (task) => {
      for (const key of ['receivedBytes', 'completedLength', 'completedSize', 'downloaded', 'bytesReceived']) {
        const value = task?.[key];
        if (value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value))) {
          return Number(value);
        }
      }
      return null;
    };
    /**
     * Estimate bytes/sec from the last up-to-5 samples. Returns `null` when there
     * are fewer than 2 usable samples, no time has passed, or the file size is 0
     * (finished tasks report `fileSize: 0` — no meaningful speed can be derived).
     */
    const estimateSpeed = (id, received, fileSize) => {
      if (received === null || !(Number.isFinite(fileSize) && fileSize > 0)) return null;
      const now = Date.now();
      let history = speedHistory.get(id);
      if (!history) {
        history = [];
        speedHistory.set(id, history);
      }
      history.push({ at: now, received });
      if (history.length > SPEED_WINDOW) history.splice(0, history.length - SPEED_WINDOW);
      if (history.length < 2) return null;
      const first = history[0];
      const last = history[history.length - 1];
      const elapsed = (last.at - first.at) / 1000;
      if (elapsed <= 0) return null;
      if (last.received < first.received) {
        // A retry or a re-download restarts the byte counter. Keeping the old
        // samples would report `null` speed until they age out of the window, so
        // drop them and start a fresh measurement from this sample.
        history.length = 0;
        history.push({ at: now, received });
        return null;
      }
      return Math.max(0, Math.round((last.received - first.received) / elapsed));
    };
    const readQueue = async () => {
      if (inFlight === undefined) {
        inFlight = (async () => {
          try {
            const result = await runGhd(ghd(), ['tasks'], { timeoutMs: SNAPSHOT_TIMEOUT_MS });
            const envelope = unwrap(parsePayload(result.output));
            const list = envelope.ok && Array.isArray(envelope.result) ? envelope.result : [];
            const seen = new Set();
            const tasks = list.map((task) => {
              const id = task.taskId;
              seen.add(id);
              const received = receivedOf(task);
              const fileSize = Number.isFinite(Number(task?.fileSize)) ? Number(task.fileSize) : 0;
              const speedBps = estimateSpeed(id, received, fileSize);
              return {
                id,
                name: task.name,
                status: task.status,
                progress: task.progress,
                // A 0 fileSize means Ghost reports no size for this task; suppress
                // the speed estimate rather than inventing one.
                ...(received !== null ? { receivedBytes: received } : {}),
                ...(speedBps !== null ? { speedBps } : {}),
              };
            });
            // Drop history for tasks that disappeared from the queue, so a removed
            // task's stale samples cannot leak into a reused id later.
            for (const key of speedHistory.keys()) if (!seen.has(key)) speedHistory.delete(key);
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
    // What this session submitted, keyed by event seq, so the conversation card can
    // place itself under the turn that submitted it. Read-only; the URL is shown to
    // the user in their own browser and never travels back to the model.
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/plugin/ghost-download/submissions',
      resource: async (request) => {
        const url = new URL(request?.url ?? 'http://localhost/');
        const callId = url.searchParams.get('call') ?? '';
        const sessionId = url.searchParams.get('session') ?? '';
        const from = Number(url.searchParams.get('from'));
        const to = Number(url.searchParams.get('to'));
        const entries = callId !== ''
          // Exact: the tool view knows its own callId, so no sequence matching is
          // needed and two downloads in one turn cannot be confused.
          ? submissions.filter((entry) => entry.callId === callId)
          : sessionId === ''
            ? []
            : submissions.filter((entry) => {
              if (entry.sessionId !== sessionId) return false;
              if (!Number.isFinite(entry.seq)) return false;
              if (Number.isFinite(from) && entry.seq < from) return false;
              if (Number.isFinite(to) && entry.seq > to) return false;
              return true;
            });
        return new Response(JSON.stringify({ entries }), {
          status: 200,
          headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
        });
      },
    }), 'ghost-download:submissions-route');
  }

  // `enabled: false` keeps the row's settings but publishes no tools.
  if (settings().enabled === false) return;

  ctx.tools.register({
    name: 'ghost_download',
    description:
      'Submit downloads to Ghost Downloader (the single download engine) through its official ghd CLI. '
      + `${schemeSentence()} `
      + 'Ghost itself also speaks HLS/DASH manifests over http(s). '
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
          description: `One or more links to download: http(s), ftp, magnet:, ed2k:, .torrent URL, or an HLS/DASH manifest URL. At most ${settings().maxUrlsPerCall} per call.`,
        },
        dir: {
          type: 'string',
          description: 'Destination folder for this task (ghd -o). Omitted: a `downloads` folder inside the '
            + 'session working directory, so the files stay readable by the agent that asked for them.',
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
          description: 'Extra request headers as "Name: value" (ghd -H); repeatable. '
            + 'Header values enter the ghd argv, so the local process list shows them.',
        },
        conflict: {
          type: 'string',
          enum: ['keep', 'overwrite'],
          description: 'When the target name already exists: keep both (default) or overwrite (ghd --conflict).',
        },
        useGhostFolder: {
          type: 'boolean',
          description: 'Ignore `dir` and let Ghost choose the destination, so its own category rules apply. '
            + 'The resulting file may land outside the workspace; pass `dir` when you need to read it back.',
        },
        precheck: {
          type: 'boolean',
          description: 'Before submitting, use `ghd probe` to check free space and any same-named file in the '
            + 'target folder. Reports decision ("blocked" on insufficient space, "skip" when a file of the '
            + 'same name and size already exists, "warn" on a size mismatch) but NEVER skips the download '
            + 'on its own — the decision is advice for you to act on.',
        },
        waitSeconds: {
          type: 'integer',
          description:
            '0 or omitted: return immediately with the task ids. '
            + `Positive: wait up to this many seconds (capped at ${settings().waitLimitSeconds}) for completion, `
            + 'then report the final task state.',
        },
      },
      required: ['urls'],
    },
    output: {
      schema: TOOL_OUTPUT_SCHEMA,
      render: (_args, value) => {
        const v = value && typeof value === 'object' ? value : {};
        const lines = [];
        // A precheck is advice, never a silent gate: always surface its verdict.
        if (v.precheck) {
          const pc = v.precheck;
          lines.push(`预检（仅报告，不会自动跳过）：${pc.decision}`);
          if (pc.estimateBytes !== undefined) lines.push(`  预计字节数：${pc.estimateBytes}`);
          if (pc.freeBytes !== undefined) lines.push(`  目标目录剩余空间：${pc.freeBytes} 字节`);
          else lines.push('  目标目录剩余空间：未检查');
          for (const reason of (Array.isArray(pc.reasons) ? pc.reasons : [])) lines.push(`  - ${reason}`);
        }
        // A degraded call (e.g. "waited but no task id") must be visible to the model.
        if (v.warning) lines.push(`⚠ ${v.warning}`);
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
          if (ids.length > 0) {
            lines.push(`已提交的任务仍在后台下载：${ids.join(', ')}；完成或失败时会自动通知本会话。`);
          }
          lines.push(`ghd ${v.command}`);
          lines.push(JSON.stringify(v.error ?? null, null, 2));
          if (v.raw) lines.push(bounded(maskSecrets(v.raw), settings().maxErrorChars));
        }
        return [{ type: 'text', text: bounded(lines.join('\n'), settings().maxOutputChars) }];
      },
    },
    // Header values carry cookies and tokens; the card gets a summary only.
    presentCall: (args) => ({
      card: 'generic',
      kind: 'execute',
      title: `Ghost: ${Array.isArray(args?.urls) ? args.urls.length : 0} 个下载`,
      rawInput: { urls: Array.isArray(args?.urls) ? args.urls.slice(0, 5) : [], dir: args?.dir },
    }),
    // A single call may legitimately wait the full budget plus the surrounding ghd
    // calls; the deadline only exists so a wedged ghd cannot hang the turn forever.
    // Worst case is NOT just the wait: the add call and one detail read per task
    // come on top. The budget is derived from the SCHEMA MAXIMUM (not the current
    // setting), because `timeoutMs` is registered once and never re-evaluated —
    // deriving it from a live value would let a raised `waitLimitSeconds` wait
    // longer than the host allows, and the kill would also skip the background
    // watchers this method registers afterwards.
    timeoutMs: DOWNLOAD_BUDGET_MS,
    async execute(args, exec) {
      assertEnabled();

      const cfg = settings();
      const urls = Array.isArray(args?.urls) ? args.urls.filter((u) => typeof u === 'string' && u.trim() !== '') : [];
      if (urls.length === 0) throw new Error('ghost_download requires at least one URL.');
      if (urls.length > cfg.maxUrlsPerCall) {
        throw new Error(`ghost_download accepts at most ${cfg.maxUrlsPerCall} links per call.`);
      }
      // A leading dash would be parsed as a ghd switch, not a URL.
      for (const url of urls) {
        if (url.startsWith('-')) throw new Error(`URL must not start with "-": ${url}`);
        // The allow-list is the row's, so it is checked here and not in schema.
        assertSchemeAllowed(url, cfg.allowedUrlSchemes);
      }
      const select = typeof args.select === 'string' && args.select.trim() !== '' ? args.select.trim() : undefined;
      const name = typeof args.name === 'string' && args.name.trim() !== '' ? args.name.trim() : undefined;
      // ghd answers a multi-URL --select/--name with a bare usage error; say it here.
      if (urls.length > 1 && (select !== undefined || name !== undefined)) {
        throw new Error('ghd --select and --name only apply to a single URL.');
      }
      const argv = ['add', ...urls];
      if (select !== undefined) argv.push('--select', select);
      if (name !== undefined) argv.push('--name', name);
      // Precedence per call: an explicit argument, else a `downloads` folder in the
      // session working directory. Ghost's own folder lives outside the workspace,
      // so defaulting to it would hand the agent a file it cannot read afterwards.
      // `useGhostFolder` opts out and lets Ghost apply its own category rules.
      let dir = typeof args.dir === 'string' ? args.dir.trim() : '';
      // `useGhostFolder` is the explicit "let Ghost decide" request, so it wins
      // over a `dir` passed in the same call: honouring `dir` would silently
      // ignore the flag the caller asked for.
      if (args.useGhostFolder === true) dir = '';
      else if (dir === '') dir = workspaceDownloads(ctx, exec);
      if (dir !== '') argv.push('-o', dir);
      // A same-named existing file is kept by default; overwriting is opt-in.
      if (args.conflict === 'overwrite') argv.push('--conflict', 'overwrite');
      const callHeaders = Array.isArray(args.headers) ? args.headers : [];
      const probeHeaders = mergeHeaders([], callHeaders);
      for (const header of callHeaders) {
        if (typeof header !== 'string' || header.trim() === '') continue;
        if (!header.includes(':')) throw new Error(`Header "${header}" is not in "Name: value" form.`);
        argv.push('-H', header.trim());
      }

      // Precheck is advisory only: it never suppresses the download. We probe
      // each URL once, then compare the resolved target against the destination
      // folder and the free space on that filesystem.
      let precheckReport;
      if (args.precheck === true) {
        const reasons = [];
        // With `useGhostFolder` there is no target folder this side can name, so
        // space and same-name checks would describe the wrong destination. Say so
        // instead of reporting a check that does not apply.
        const checkDir = dir;
        const freeBytes = checkDir !== '' ? freeBytesOf(checkDir) : undefined;
        if (checkDir === '') {
          reasons.push('落点由 Ghost 决定（useGhostFolder），因此没有检查目标目录的空间与同名文件。');
        }
        const samples = [];
        for (const url of urls) {
          // A magnet:/ed2k: link may need a torrent to resolve a name/size; if the
          // probe cannot answer, say so rather than pretending the check passed.
          // eslint-disable-next-line no-await-in-loop
          const info = await probeInfo(url, probeHeaders, exec.signal);
          if (!info.ok) {
            reasons.push(`「${url}」预检探测失败：${info.reason}（未检查该链接）`);
            samples.push({ url, checked: false });
            continue;
          }
          samples.push({ url, checked: true, name: info.name, size: info.size });
          const targetName = name ?? info.name;
          const target = targetPathOf(checkDir, targetName);
          if (Number.isFinite(info.size) && info.size > 0) {
            if (freeBytes !== undefined && info.size > freeBytes) {
              reasons.push(`「${targetName ?? url}」预计需要 ${info.size} 字节，目标目录剩余空间约 ${freeBytes} 字节，可能不足。`);
            }
            if (target !== undefined && existsSync(target)) {
              try {
                const existingSize = statSync(target).size;
                if (existingSize === info.size) {
                  reasons.push(`目标已存在同名且大小相同的文件「${targetName}」（${existingSize} 字节），可能已经下载过。`);
                } else {
                  reasons.push(`目标已存在同名文件「${targetName}」，但大小不同（现有 ${existingSize} 字节，预期 ${info.size} 字节），可能残缺或被占用。`);
                }
              } catch {
                reasons.push(`目标已存在同名文件「${targetName}」，但无法读取其大小，可能残缺。`);
              }
            }
          }
        }
        if (checkDir !== '' && freeBytes === undefined) reasons.push('目标目录剩余空间未检查（无法获取 statfs 或未指定可写目录）。');
        // Decision is a report, not a gate: "blocked"/"skip"/"warn" is advisory.
        const decision = reasons.some((r) => r.includes('空间') && r.includes('不足'))
          ? 'blocked'
          : reasons.some((r) => r.includes('可能已经下载过'))
            ? 'skip'
            : (reasons.length > 0 ? 'warn' : 'ok');
        precheckReport = {
          decision,
          reasons,
          ...(samples.some((s) => Number.isFinite(s.size)) ? { estimateBytes: samples.reduce((sum, s) => sum + (Number.isFinite(s.size) ? s.size : 0), 0) } : {}),
          ...(freeBytes !== undefined ? { freeBytes } : {}),
          ...(samples.some((s) => s.checked) ? { existing: samples.filter((s) => s.checked).map((s) => ({ url: s.url, name: s.name, size: s.size })) } : {}),
        };
      }

      const submitted = await call(argv, { timeoutMs: ADD_TIMEOUT_MS, signal: exec.signal });
      // `ghd add` reports per-item failures inside one envelope: a partial batch
      // still has tasks that are really downloading, so ids are derived from the
      // accepted items regardless of the envelope-level ok flag.
      const accepted = Array.isArray(submitted.result)
        ? submitted.result.filter((item) => item === null || typeof item !== 'object' || !item.error)
        : [];
      const taskIds = findTaskIds(accepted);
      // Remember what this turn submitted, so the client can put a card under it.
      // Done before any early return: a fire-and-forget batch needs the card most.
      recordSubmission(exec, accepted
        .filter((item) => item && typeof item === 'object' && typeof item.taskId === 'string')
        .map((item) => {
          const protocol = protocolOf(item.url);
          return {
            taskId: item.taskId,
            url: typeof item.url === 'string' ? item.url : '',
            name: typeof item.name === 'string' ? item.name : '',
            scheme: protocol.scheme,
            ...(protocol.kind === undefined ? {} : { kind: protocol.kind }),
          };
        }));
      const waitSeconds = Number.isInteger(args.waitSeconds) ? args.waitSeconds : 0;

      if (!submitted.ok || waitSeconds <= 0 || taskIds.length === 0) {
        // Fire-and-forget: keep watching in the background and wake this session
        // when each task leaves the running state.
        for (const id of taskIds) watchTask(exec.agent, id);
        const warning = submitted.ok && waitSeconds > 0
          ? { warning: 'ghd 未返回任务 id，因此没有等待任何任务。' }
          : {};
        return { ...submitted, ...(precheckReport ? { precheck: precheckReport } : {}), ...(taskIds.length > 0 ? { taskIds, taskId: taskIds[0] } : {}), ...warning };
      }

      // Clamp the wait to the configured limit AND to what the registered tool
      // budget still allows: the wait is followed by one detail read per task, so
      // waiting the whole budget would let the host kill the call before those
      // reads (and the background watchers they register) ever run.
      const budgetMs = DOWNLOAD_BUDGET_MS;
      const reserveMs = taskIds.length * TASK_TIMEOUT_MS + CONTROL_TIMEOUT_MS + 10_000;
      const waitCapMs = Math.max(
        1000,
        Math.min(cfg.waitLimitSeconds * 1000, budgetMs - reserveMs - ADD_TIMEOUT_MS),
      );
      const plannedWaitMs = Math.min(waitSeconds * 1000, waitCapMs);
      const waited = await call(['wait', ...taskIds], {
        timeoutMs: plannedWaitMs,
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
      // The task states are the verdict: a deadline that killed `ghd wait` after
      // the last task finished must not read as a failure.
      const allDetailOk = detailResults.every((result) => result.ok);
      const ok = allCompleted && allDetailOk;
      // An explicit verdict keeps the failure renderer from printing `null`.
      const failure = ok ? undefined : {
        code: allCompleted ? 'detailUnavailable' : (waited.timedOut ? 'waitTimedOut' : 'notCompleted'),
        message: allCompleted
            ? `all tasks completed but a task detail could not be read (${statuses.join(', ') || 'no status reported'})`
            : waited.timedOut
              ? `waited ${Math.round(plannedWaitMs / 1000)}s and the tasks were still active`
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
        ...(precheckReport ? { precheck: precheckReport } : {}),
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
      + `${schemeSentence()} `
      + 'Also useful to check whether Ghost recognizes a protocol before downloading.',
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
        fresh: {
          type: 'boolean',
          description: 'Skip the probe cache and ask Ghost again (useful after a torrent changed on the source).',
        },
      },
      required: ['url'],
    },
    output: {
      schema: TOOL_OUTPUT_SCHEMA,
      render: (_args, value) => {
        const v = value && typeof value === 'object' ? value : {};
        const prefix = v.cached ? '[cached] ' : '';
        return [{
          type: 'text',
          text: bounded(
            prefix + JSON.stringify(v.ok ? v.result : v.error ?? v, null, 2),
            v.ok ? settings().maxOutputChars : settings().maxErrorChars,
          ),
        }];
      },
    },
    isConcurrencySafe: () => true,
    timeoutMs: ADD_TIMEOUT_MS + 10000,
    async execute(args, exec) {
      assertEnabled();

      const url = typeof args?.url === 'string' ? args.url.trim() : '';
      if (url === '') throw new Error('ghost_probe requires a url.');
      const cfg = settings();
      // Probing must answer the same question the download would ask, so the
      // allow-list applies here too.
      assertSchemeAllowed(url, cfg.allowedUrlSchemes);
      const argv = ['probe', url];
      const callHeaders = Array.isArray(args.headers) ? args.headers : [];
      for (const header of callHeaders) {
        if (typeof header !== 'string' || header.trim() === '') continue;
        if (!header.includes(':')) throw new Error(`Header "${header}" is not in "Name: value" form.`);
      }
      const headers = mergeHeaders([], callHeaders);
      for (const header of headers) argv.push('-H', header);
      // The key covers the MERGED headers: a changed row default must not hit a
      // cached probe produced with different headers.
      const cacheKey = `${url}\u0000${JSON.stringify(headers)}`;
      const hit = args.fresh === true ? undefined : probeCache.get(cacheKey);
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
        limit: {
          type: 'integer',
          description: 'Return at most this many tasks (newest first). Omit for every task Ghost knows.',
        },
      },
    },
    output: {
      schema: TOOL_OUTPUT_SCHEMA,
      render: (_args, value) => {
        const v = value && typeof value === 'object' ? value : {};
        if (!v.ok) {
          return [{
            type: 'text',
            text: bounded(JSON.stringify(v.error ?? null, null, 2), settings().maxErrorChars),
          }];
        }
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
          // `total` is the untrimmed count; without it a `limit` would report the
          // queue as shorter than it is and hide the tasks that were cut.
          v.total !== undefined && v.total !== list.length
            ? `显示 ${list.length} / 共 ${v.total} 个任务：运行中 ${running.length} / 已完成 ${completed.length}`
              + ` / 已暂停 ${paused.length} / 失败 ${failed.length} / 其他 ${other.length}`
            : `共 ${list.length} 个任务：运行中 ${running.length} / 已完成 ${completed.length}`
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
        return [{ type: 'text', text: bounded(lines.join('\n'), settings().maxOutputChars) }];
      },
    },
    isConcurrencySafe: () => true,
    timeoutMs: TASK_TIMEOUT_MS + 10000,
    async execute(args, exec) {
      assertEnabled();

      const argv = ['tasks'];
      if (typeof args?.status === 'string' && args.status.trim() !== '') argv.push('-s', args.status.trim());
      const result = await call(argv, { timeoutMs: TASK_TIMEOUT_MS, signal: exec.signal });
      // Trimming is a presentation concern: it never changes what ghd reported,
      // so `total` keeps the untrimmed count visible to the caller.
      const limit = Number.isInteger(args?.limit) && args.limit > 0 ? args.limit : 0;
      if (limit === 0 || !result.ok || !Array.isArray(result.result)) return result;
      const all = result.result;
      if (all.length <= limit) return result;
      return { ...result, result: all.slice(0, limit), total: all.length };
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
      render: (_args, value) => {
        const blocks = jsonRender(_args, value);
        if (value && value.attribution) {
          const a = value.attribution;
          blocks.push({
            type: 'text',
            text: bounded(
              `失败归因（可能原因）：${a.category}；可重试：${a.retryable ? '是' : '否'}\n${a.hint}`
                + (a.nextAction ? `\n建议动作：${a.nextAction}` : ''),
              settings().maxErrorChars,
            ),
          });
        }
        return blocks;
      },
    },
    isConcurrencySafe: () => true,
    timeoutMs: TASK_TIMEOUT_MS + 10000,
    async execute(args, exec) {
      assertEnabled();

      const taskId = typeof args?.taskId === 'string' ? args.taskId.trim() : '';
      if (!taskId) throw new Error('ghost_task requires taskId.');
      // A leading dash or unknown shape would be parsed as a ghd switch.
      if (!TASK_ID.test(taskId)) throw new Error(`Invalid task id: ${taskId}`);
      const result = await call(['task', taskId], { timeoutMs: TASK_TIMEOUT_MS, signal: exec.signal });
      // Attach a hedged attribution whenever ghd reported a task-level error.
      // The raw error stays intact — attribution is additive, never a replacement.
      const detail = result.ok && result.result && typeof result.result === 'object' ? result.result : undefined;
      const taskError = detail ? (detail.lastError ?? detail.error) : (result.error?.message ?? result.error ?? undefined);
      const attribution = taskError !== undefined && taskError !== null && taskError !== ''
        ? failureAttribution(taskError)
        : undefined;
      return { ...result, ...(attribution ? { attribution } : {}) };
    },
  });

  /**
   * The actions `ghost_control` currently offers.
   *
   * `remove` deletes unfinished files, so a row can take it away entirely. The
   * list feeds BOTH the schema enum and the runtime check, so the tool the model
   * sees and the tool that runs cannot disagree.
   */
  const controlActions = () => (settings().controlRemoveEnabled
    ? ['pause', 'start', 'retry', 'remove']
    : ['pause', 'start', 'retry']);

  ctx.tools.register({
    name: 'ghost_control',
    description:
      'Control Ghost Downloader tasks: pause (ghd pause), start or resume (ghd start), remove (ghd remove). '
      + 'remove also deletes the unfinished files of those tasks.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          // Read at registration: a `.volatile()` toggle takes effect on the next
          // plugin activation for the SCHEMA, while `execute` below enforces the
          // live value immediately.
          enum: controlActions(),
          description: `Operation to perform. One of: ${controlActions().join(', ')}.`,
        },
        taskIds: { type: 'array', items: { type: 'string' }, description: 'One or more task ids, for example ["tsk_0123"]. Omit only for retry, where omission means every failed task; pause, start and remove require at least one id.' },
        deleteFiles: {
          type: 'boolean',
          description: 'remove only: also delete the files the task already produced. '
            + 'Off by default; a removed task always loses its unfinished partial files.',
        },
      },
      required: ['action'],
    },
    output: {
      schema: TOOL_OUTPUT_SCHEMA,
      render: jsonRender,
    },
    timeoutMs: CONTROL_TIMEOUT_MS + 10000,
    async execute(args, exec) {
      assertEnabled();

      const action = args?.action;
      const allowed = controlActions();
      if (!allowed.includes(action)) throw new Error(`Unsupported action "${String(action)}".`);
      // The enum above is a registration-time snapshot; this is the live rule.
      if (action === 'remove' && !settings().controlRemoveEnabled) {
        throw new Error('remove 已被本插件的设置禁用（controlRemoveEnabled=false）。可在插件页的「安全」里重新开启。');
      }
      const givenIds = Array.isArray(args?.taskIds)
        ? args.taskIds.filter((id) => typeof id === 'string' && id.trim() !== '')
        : [];
      for (const id of givenIds) if (!TASK_ID.test(id)) throw new Error(`Invalid task id: ${id}`);

      // `retry` is sugar over "list the failed tasks, then start them": ghd start
      // already resumes a failed task, so no extra capability is invented.
      if (action === 'retry') {
        let ids = givenIds;
        if (ids.length === 0) {
          const listed = await call(['tasks', '-s', 'failed'], { timeoutMs: CONTROL_TIMEOUT_MS, signal: exec.signal });
          ids = findTaskIds(Array.isArray(listed.result) ? listed.result : []);
        }
        if (ids.length === 0) {
          return { ok: true, result: { retried: [], note: '没有处于 failed 状态的任务。' } };
        }
        const started = await call(['start', ...ids], { timeoutMs: CONTROL_TIMEOUT_MS, signal: exec.signal });
        return { ...started, result: { retried: ids, underlying: started.result } };
      }

      if (givenIds.length === 0) throw new Error('ghost_control requires at least one task id.');
      const argv = [action, ...givenIds];
      // Only remove accepts it, and only when asked: it is the one switch that
      // destroys files the user already has on disk.
      if (action === 'remove' && args?.deleteFiles === true) argv.push('--delete-files');
      return call(argv, { timeoutMs: CONTROL_TIMEOUT_MS, signal: exec.signal });
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
          description: `Maximum seconds to block (default ${DEFAULT_WAIT_TOOL_SECONDS}, capped at ${settings().waitLimitSeconds}). On timeout the result carries timedOut: true.`,
        },
        checksum: {
          type: 'string',
          description: 'Verify the downloaded file after it completes: pass "<algorithm>:<hex>" '
            + '(md5 / sha1 / sha256 / sha512 / crc32) or a bare hex digest whose length identifies the algorithm. '
            + 'Requires exactly one taskId. ghost has no checksum support of its own, so the plugin hashes '
            + 'the landed file itself; a mismatch turns the call into a failure.',
        },
      },
      required: ['taskIds'],
    },
    output: {
      schema: TOOL_OUTPUT_SCHEMA,
      render: (_args, value) => {
        const v = value && typeof value === 'object' ? value : {};
        const blocks = jsonRender(_args, value);
        const lines = [];
        if (v.filePath) lines.push(`file: ${v.filePath}`);
        if (v.checksum) {
          const c = v.checksum;
          lines.push(c.verified
            ? `校验通过：${c.algorithm} ${c.expected}`
            : `校验未通过：${c.algorithm} 期望 ${c.expected}`
              + `${c.actual ? `，实际 ${c.actual}` : ''}${c.reason ? `（${c.reason}）` : ''}`);
        }
        if (lines.length > 0) {
          blocks.push({ type: 'text', text: bounded(lines.join('\n'), settings().maxOutputChars) });
        }
        return blocks;
      },
    },
    // Derived from the schema maximum for the same reason as ghost_download:
    // `timeoutMs` is fixed at registration, while the limit is read per call.
    timeoutMs: (MAX_WAIT_LIMIT_SECONDS + 120) * 1000,
    async execute(args, exec) {
      assertEnabled();

      const ids = Array.isArray(args?.taskIds) ? args.taskIds.filter((id) => typeof id === 'string' && id.trim() !== '') : [];
      if (ids.length === 0) throw new Error('ghost_wait requires at least one task id.');
      for (const id of ids) if (!TASK_ID.test(id)) throw new Error(`Invalid task id: ${id}`);
      const cfg = settings();
      // The call decides; the plugin only caps it at the configured ceiling.
      const requested = Number.isInteger(args.timeoutSeconds)
        ? args.timeoutSeconds
        : DEFAULT_WAIT_TOOL_SECONDS;
      const limit = Math.min(Math.max(requested, 1), cfg.waitLimitSeconds);
      const result = await call(['wait', ...ids], { timeoutMs: limit * 1000, signal: exec.signal });
      // Optional integrity check. `ghd` has no checksum support at all, so the
      // digest is computed here, on the file that actually landed — which means
      // the landing path has to be resolved first, exactly as ghost_task does.
      if (typeof args?.checksum !== 'string' || args.checksum === '') return result;
      if (ids.length !== 1) throw new Error('checksum requires exactly one taskId');
      const parsed = parseChecksum(args.checksum);
      if (parsed.error !== undefined) throw new Error(parsed.error);

      const detail = await call(['task', ids[0]], { timeoutMs: TASK_TIMEOUT_MS, signal: exec.signal });
      const task = detail.ok && detail.result && typeof detail.result === 'object' ? detail.result : {};
      const landing = resolveLandingPath(task);
      if (landing === undefined) {
        return {
          ...result,
          ok: false,
          filePath: undefined,
          checksum: {
            algorithm: parsed.algorithm, expected: parsed.expected, verified: false,
            reason: 'could not resolve the landed file, so nothing was hashed',
          },
          error: { code: 'checksumNotVerified', message: 'could not resolve the landed file to hash it' },
        };
      }
      try {
        const actual = parsed.algorithm === 'crc32'
          ? await crc32File(landing)
          : await hashFile(landing, parsed.algorithm);
        const verified = actual === parsed.expected;
        const checksum = {
          algorithm: parsed.algorithm, expected: parsed.expected, actual,
          filePath: landing, verified,
          ...(verified ? {} : { reason: 'digest does not match the expected value' }),
        };
        return verified
          ? { ...result, filePath: landing, checksum }
          : {
            ...result,
            ok: false,
            filePath: landing,
            checksum,
            error: {
              code: 'checksumMismatch',
              message: `${parsed.algorithm} digest does not match: expected ${parsed.expected}, got ${actual}`,
            },
          };
      } catch (error) {
        const reason = `could not hash the file: ${error instanceof Error ? error.message : String(error)}`;
        return {
          ...result,
          ok: false,
          filePath: landing,
          checksum: { algorithm: parsed.algorithm, expected: parsed.expected, verified: false, reason },
          error: { code: 'checksumNotVerified', message: reason },
        };
      }
    },
  });

  ctx.tools.register({
    name: 'ghost_stats',
    description: 'Aggregate the tasks CURRENTLY VISIBLE in Ghost Downloader: group counts by status and '
      + 'total byte size. IMPORTANT: Ghost does not retain a download history, so this tool can only '
      + 'summarise the present queue — the `range` parameter is acknowledged but cannot filter by time '
      + 'because no per-task timestamps are kept. No separate ledger is invented.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        range: {
          type: 'string',
          enum: ['7d', '30d', 'all'],
          description: "Reporting window ('7d' | '30d' | 'all', default '7d'). Accepted for a consistent API, "
            + 'but Ghost keeps no history or timestamps, so it does not actually restrict the results.',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          note: { type: 'string' },
          range: { type: 'string' },
          rangeApplied: { type: 'boolean' },
          totalTasks: { type: 'integer' },
          byStatus: {},
          totalBytes: { type: 'integer' },
          error: {},
        },
        required: ['note', 'totalTasks', 'byStatus', 'totalBytes'],
      },
      render: (_args, value) => {
        const lines = [value?.note ?? ''];
        const byStatus = value?.byStatus && typeof value.byStatus === 'object' ? value.byStatus : {};
        lines.push(`当前可见任务共 ${value?.totalTasks ?? 0} 个，总字节数 ${value?.totalBytes ?? 0}。`);
        for (const [status, stat] of Object.entries(byStatus)) {
          lines.push(`- ${status}：${stat.count} 个，${stat.bytes} 字节`);
        }
        if (value?.rangeApplied === false) lines.push(`（range=${value.range ?? ''} 未生效：Ghost 不保留历史时间戳。）`);
        return [{ type: 'text', text: bounded(lines.filter(Boolean).join('\n'), settings().maxOutputChars) }];
      },
    },
    isConcurrencySafe: () => true,
    timeoutMs: TASK_TIMEOUT_MS + 10_000,
    async execute(args, exec) {
      assertEnabled();
      const range = ['7d', '30d', 'all'].includes(args?.range) ? args.range : '7d';
      const result = await call(['tasks'], { timeoutMs: TASK_TIMEOUT_MS, signal: exec.signal });
      if (!result.ok) {
        return {
          note: '本工具只统计当前可见任务；但本次 ghd tasks 调用失败，没有得到可统计的任务。',
          range,
          rangeApplied: false,
          totalTasks: 0,
          byStatus: {},
          totalBytes: 0,
          error: result.error,
        };
      }
      const list = Array.isArray(result.result) ? result.result : [];
      const byStatus = {};
      let totalBytes = 0;
      for (const task of list) {
        const status = String(task?.status ?? 'unknown').toLowerCase() || 'unknown';
        const raw = task?.fileSize ?? task?.totalSize ?? task?.size ?? 0;
        const size = Number.isFinite(Number(raw)) && raw !== null && raw !== '' ? Number(raw) : 0;
        totalBytes += size;
        if (!byStatus[status]) byStatus[status] = { count: 0, bytes: 0 };
        byStatus[status].count += 1;
        byStatus[status].bytes += size;
      }
      return {
        note: '本工具只统计当前可见任务（Ghost 不保留下载历史，无法给出已删除或已完成很久的任务）。',
        range,
        rangeApplied: false,
        totalTasks: list.length,
        byStatus,
        totalBytes,
      };
    },
  });

  /**
   * A tiny, stable, publicly readable file used only by the doctor's network/cert
   * probe. If Ghost cannot fetch even this, the fault is network/proxy/certificate,
   * not the specific download the user wanted.
   */
  const DOCTOR_PROBE_URL = 'https://raw.githubusercontent.com/octocat/Hello-World/master/README';

  ctx.tools.register({
    name: 'ghost_doctor',
    description: 'Run a health check of the Ghost Downloader integration: '
      + 'ghd availability, a live `ghd tasks` call, a network/certificate probe against a known small file, '
      + 'writability of the session downloads folder, and a cross-check with Ghost\'s own UserConfig.json '
      + '(download folder and proxy). Returns { checks: [{ name, ok, detail, hint }] }. '
      + 'It never touches the download queue, but it is not side-effect free: it writes and immediately '
      + 'deletes a temporary probe file in the downloads folder, and it makes one network request to a '
      + 'small public file to test connectivity.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          checks: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string' },
                ok: { type: 'boolean' },
                detail: { type: 'string' },
                hint: { type: 'string' },
              },
              required: ['name', 'ok', 'detail'],
            },
          },
        },
        required: ['checks'],
      },
      render: (_args, value) => {
        const checks = Array.isArray(value?.checks) ? value.checks : [];
        const lines = checks.map((c) => {
          const mark = c.ok ? '✓' : '✗';
          const hint = c.hint ? `\n    ↳ ${c.hint}` : '';
          return `${mark} ${c.name}：${c.detail}${hint}`;
        });
        const passed = checks.filter((c) => c.ok).length;
        lines.unshift(`体检结果：${passed}/${checks.length} 项通过`);
        return [{ type: 'text', text: bounded(lines.join('\n'), settings().maxOutputChars) }];
      },
    },
    isConcurrencySafe: () => true,
    timeoutMs: (PRECHECK_PROBE_TIMEOUT_MS + TASK_TIMEOUT_MS + CONTROL_TIMEOUT_MS) + 30_000,
    async execute(_args, exec) {
      assertEnabled();
      const checks = [];
      const add = (name, ok, detail, hint) => {
        checks.push({ name, ok, detail, ...(hint ? { hint } : {}) });
      };

      // ① ghd --version
      try {
        const result = await runGhd(ghd(), ['--version'], { timeoutMs: PRECHECK_PROBE_TIMEOUT_MS });
        const ok = result.code === 0 && !result.timedOut && result.output.trim() !== '';
        add('ghd 可执行文件', ok,
          ok ? `ghd 可用（${result.output.trim().slice(0, 120)}）` : `ghd --version 失败（exit ${result.code}${result.timedOut ? ', 超时' : ''}）`,
          ok ? undefined : '请在 Ghost Downloader 的「设置 → 命令行工具」安装 ghd，或在插件配置里设置 ghdPath。');
      } catch (error) {
        add('ghd 可执行文件', false, `无法运行 ghd：${String(error?.message ?? error)}`,
          '检查 ghdPath 配置或 GHOST_GHD 环境变量。');
      }

      // ② ghd tasks — liveness of the queue/backend
      try {
        const result = await call(['tasks'], { timeoutMs: TASK_TIMEOUT_MS, signal: exec.signal });
        add('ghd tasks（队列存活）', result.ok,
          result.ok ? `可读取队列（${Array.isArray(result.result) ? result.result.length : '?'} 个任务）`
            : `ghd tasks 失败：${String(result.error?.message ?? result.error ?? '未知错误')}`,
          result.ok ? undefined : 'Ghost 主程序可能未运行，或队列服务未就绪。');
      } catch (error) {
        add('ghd tasks（队列存活）', false, `ghd tasks 异常：${String(error?.message ?? error)}`);
      }

      // ③ ghd probe a known small file — network / certificate / proxy
      try {
        const info = await probeInfo(DOCTOR_PROBE_URL, [], exec.signal);
        add('网络 / 证书 / 代理探测', info.ok,
          info.ok ? `可探测小文件${info.size !== undefined ? `（${info.size} 字节）` : ''}`
            : `探测失败：${info.reason}`,
          info.ok ? undefined : '可能是网络不通、代理配置错误，或证书校验失败（见 failure attribution）。');
      } catch (error) {
        add('网络 / 证书 / 代理探测', false, `探测异常：${String(error?.message ?? error)}`);
      }

      // ④ session downloads folder writable
      const dir = workspaceDownloads(ctx, exec);
      if (dir === '') {
        add('下载目录可写', false, '无法在项目工作目录下创建 downloads 文件夹。', '检查会话工作目录权限。');
      } else {
        const probeFile = path.join(dir, `.ghost-doctor-${process.pid}-${Date.now()}.tmp`);
        try {
          writeFileSync(probeFile, 'ok');
          unlinkSync(probeFile);
          add('下载目录可写', true, `${dir} 可写。`);
        } catch (error) {
          try { unlinkSync(probeFile); } catch { /* best effort */ }
          add('下载目录可写', false, `${dir} 不可写：${String(error?.message ?? error)}`,
            '改用 dir 指定一个可写目录，或检查文件系统权限。');
        }
      }

      // ⑤ Ghost UserConfig.json cross-check
      const userConfig = readGhostUserConfig();
      if (userConfig.error) {
        add('Ghost 用户配置交叉检查', false, userConfig.error,
          '该项只读，失败不影响下载；可手动检查 %LOCALAPPDATA%\\GhostDownloader\\UserConfig.json。');
      } else {
        const parts = [];
        // This check answers one question — "is Ghost pointed at the same folder the
        // plugin would use?" — so a mismatch is a real finding, not a pass.
        let ok = true;
        if (userConfig.downloadFolder) {
          parts.push(`下载目录=${userConfig.downloadFolder}`);
          // If Ghost points at a different folder from our default, note the split
          // so the user is not surprised the files land outside the workspace.
          if (dir !== '' && path.resolve(userConfig.downloadFolder) !== path.resolve(dir)) {
            parts.push('与插件默认下载目录不同');
            ok = false;
          }
        } else {
          parts.push('下载目录未设置');
        }
        if (userConfig.proxyServer) parts.push(`代理=${userConfig.proxyServer}`);
        else parts.push('代理未设置');
        add('Ghost 用户配置交叉检查', ok, parts.join('；'),
          userConfig.downloadFolder && dir !== '' && path.resolve(userConfig.downloadFolder) !== path.resolve(dir)
            ? 'Ghost 会按自己的目录归档；要读回文件请用 dir 指定同一目录。'
            : undefined);
      }

      return { checks };
    },
  });

  // Force every download through Ghost: deny shell downloads that write files themselves.
  // This is a guardrail for well-behaved calls, not a security boundary: reading a
  // script file's contents is out of scope here.
  ctx.on('tools/pre-execute', async (exec, next) => {
    // A disabled plugin has no ghost_download to redirect to, so let the shell
    // call through rather than denying it with unusable advice. The switch is
    // re-read here because `.volatile()` saves never restart the plugin.
    const cfg = settings();
    if (cfg.enabled === false || cfg.blockShellDownloads === false) return next();
    const name = String(exec?.name || '');
    if (!/bash|shell|pwsh|powershell|exec|terminal|download/i.test(name)) return next();
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
