window.__ModuleLoader__.load({
  id: '@local/dsh-ghost-download',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useEffect, useState } = React;

    /** One id for the better-sidebar descriptor, the native kind and the slot key. */
    const TAB_ID = 'ghost-downloads';
    /**
     * Poll cadence. The host caches this route for 3 s (`SNAPSHOT_TTL_MS` in
     * index.js) and every cache miss spawns `ghd tasks`, so the period must stay
     * comfortably ABOVE that TTL — otherwise each tick shells out.
     */
    const POLL_MS = 5000;
    const TAB_ORDER = 30;
    /** Completed downloads are history, not the queue: show the newest few. */
    const COMPLETED_LIMIT = 5;

    /**
     * The locale/*.json files carry only the plugin-page title and description,
     * so the pane's own strings live here. Moving them to ctx.locale would need
     * the locale client package declared and its dictionary shape pinned first —
     * deliberately not part of this pass, so the strings stay Chinese for now.
     */
    const STR = {
      tabTitle: 'Ghost 下载队列',
      tabDescription: '查看下载进度与状态',
      running: '下载中',
      failed: '失败',
      other: '其他',
      completed: '已完成',
      loading: '读取中…',
      empty: '暂无下载任务',
      idle: '队列空闲',
      moreCompleted: (count) => '另有 ' + count + ' 个更早的已完成任务',
      unreachable: 'Ghost 未响应',
      crashed: '下载队列面板渲染失败。',
      retry: '重试',
    };

    const theme = {
      text: 'var(--dsw-alias-label-primary)',
      dim: 'var(--dsw-alias-label-secondary)',
      border: 'var(--dsw-alias-border-l1)',
      brand: 'var(--dsw-alias-brand-primary)',
      error: 'var(--dsw-alias-state-error-primary)',
      success: 'var(--dsw-alias-state-success-primary)',
      track: 'var(--dsw-alias-bg-layer-2)',
    };

    /**
     * Every cordis registration hands back either a function or a disposable
     * object depending on the API it came from; normalise so one cleanup path
     * covers both.
     */
    function toDisposer(value) {
      if (typeof value === 'function') return value;
      if (value !== null && typeof value === 'object' && typeof value.dispose === 'function') {
        return () => value.dispose();
      }
      return () => {};
    }

    function messageOf(error) {
      if (error !== null && typeof error === 'object' && typeof error.message === 'string') return error.message;
      return String(error);
    }

    /** The host may hand us a malformed list; a non-object row would throw on `task.status`. */
    function isTaskRow(value) {
      return value !== null && typeof value === 'object';
    }

    /**
     * Whether this document is on screen. A hidden window keeps a React tree
     * mounted, so without this the interval keeps spawning `ghd` in the tray.
     */
    function useDocumentVisible() {
      const [visible, setVisible] = useState(
        () => !(typeof document !== 'undefined' && document.hidden),
      );
      useEffect(() => {
        if (typeof document === 'undefined') return undefined;
        const update = () => setVisible(!document.hidden);
        document.addEventListener('visibilitychange', update);
        return () => document.removeEventListener('visibilitychange', update);
      }, []);
      return visible;
    }

    /**
     * Poll the host's queue snapshot.
     *
     * `tasks === null` means "never loaded" (first paint); `error` keeps the last
     * snapshot on screen instead of blanking the pane, because a closed Ghost and
     * an empty queue are different things.
     */
    function useTasks(enabled) {
      const [state, setState] = useState({ tasks: null, error: null });
      useEffect(() => {
        if (!enabled) return undefined;
        let alive = true;
        let flying = false;
        const load = async () => {
          // A slow `ghd` must not stack requests/child processes behind the timer.
          if (flying) return;
          flying = true;
          try {
            const response = await fetch('/plugin/ghost-download/tasks', { credentials: 'same-origin' });
            if (!response.ok) throw new Error('HTTP ' + response.status);
            const data = await response.json();
            if (!alive) return;
            if (data !== null && typeof data === 'object' && data.ok === false) {
              // The host reports a failed `ghd` call as 200 + { ok: false, error }.
              setState((previous) => ({ tasks: previous.tasks, error: data.error || STR.unreachable }));
            } else {
              const tasks = data !== null && typeof data === 'object' && Array.isArray(data.tasks)
                ? data.tasks.filter(isTaskRow)
                : [];
              setState({ tasks, error: null });
            }
          } catch (error) {
            if (alive) setState((previous) => ({ tasks: previous.tasks, error: messageOf(error) }));
          } finally {
            flying = false;
          }
        };
        load();
        const timer = setInterval(load, POLL_MS);
        return () => {
          alive = false;
          clearInterval(timer);
        };
      }, [enabled]);
      return state;
    }

    function DownloadIcon(props) {
      return h('svg', {
        width: props.size || 18,
        height: props.size || 18,
        viewBox: '0 0 24 24',
        fill: 'none',
        'aria-hidden': true,
        style: { display: 'block' },
      }, [
        h('path', { key: 'a', d: 'M12 4v9', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' }),
        h('path', { key: 'b', d: 'M8 10.5l4 4 4-4', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' }),
        h('path', { key: 'c', d: 'M5 19h14', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' }),
      ]);
    }

    function TaskRow(props) {
      const task = props.task;
      const progress = typeof task.progress === 'number' && Number.isFinite(task.progress)
        ? Math.max(0, Math.min(100, task.progress))
        : 0;
      const name = task.name || task.id || '—';
      return h('div', {
        role: 'listitem',
        // The first row needs no rule: the group heading already separates it.
        style: { padding: '7px 0', borderTop: props.first ? 'none' : '1px solid ' + theme.border },
      }, [
        h('div', { key: 'head', style: { display: 'flex', alignItems: 'baseline', gap: 8 } }, [
          h('span', {
            key: 'name',
            title: name, // the tail is ellipsised, so a tooltip carries the whole name
            'aria-label': name,
            tabIndex: 0, // keyboard users can focus the row to read the full name
            style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
          }, name),
          h('span', { key: 'pct', style: { flexShrink: 0, color: theme.dim, fontVariantNumeric: 'tabular-nums' } }, progress + '%'),
        ]),
        h('div', {
          key: 'track',
          role: 'progressbar',
          'aria-label': name,
          'aria-valuemin': 0,
          'aria-valuemax': 100,
          'aria-valuenow': progress,
          style: { height: 3, marginTop: 5, borderRadius: 2, background: theme.track },
        }, [
          h('div', {
            key: 'fill',
            style: { width: progress + '%', height: '100%', borderRadius: 2, background: props.color },
          }),
        ]),
      ]);
    }

    /**
     * Status buckets. Unknown statuses fall into "other" instead of vanishing:
     * the host passes the CLI's status through untouched, so a `paused` task (or
     * one a future ghd invents) must still be visible.
     */
    const KIND_BY_STATUS = {
      running: 'running',
      waiting: 'running',
      downloading: 'running',
      failed: 'failed',
      error: 'failed',
      completed: 'completed',
      complete: 'completed',
      done: 'completed',
    };

    function groupTasks(tasks) {
      const groups = { running: [], failed: [], completed: [], other: [] };
      for (const task of tasks) {
        const status = String(task.status || '').toLowerCase();
        groups[KIND_BY_STATUS[status] || 'other'].push(task);
      }
      return groups;
    }

    function summaryText(groups) {
      let text = '运行 ' + groups.running.length + ' · 完成 ' + groups.completed.length;
      if (groups.failed.length > 0) text += ' · 失败 ' + groups.failed.length;
      if (groups.other.length > 0) text += ' · 其他 ' + groups.other.length;
      return text;
    }

    /** A task id is the stable key; fall back to the position, never to undefined. */
    function taskKey(task, index) {
      return task.id ? String(task.id) : 'anonymous:' + index;
    }

    function QueuePane(props) {
      const visible = !props || props.visible !== false;
      const documentVisible = useDocumentVisible();
      const { tasks, error } = useTasks(visible && documentVisible);

      const groups = groupTasks(Array.isArray(tasks) ? tasks : []);
      const total = Array.isArray(tasks) ? tasks.length : 0;
      const loading = tasks === null && error === null;

      const group = (key, title, items, color, limit) => {
        if (items.length === 0) return null;
        const shown = limit === undefined ? items : items.slice(0, limit);
        return h('div', {
          key,
          role: 'group',
          'aria-label': title + ' ' + items.length,
          style: { marginTop: 14 },
        }, [
          h('div', { key: 'head', style: { fontSize: 11, color: theme.dim, marginBottom: 2 } }, title + ' ' + items.length),
          h('div', { key: 'list', role: 'list' },
            shown.map((task, index) => h(TaskRow, {
              key: taskKey(task, index),
              task,
              color,
              first: index === 0,
            }))),
          limit !== undefined && items.length > limit
            ? h('div', { key: 'more', style: { fontSize: 11, color: theme.dim } }, STR.moreCompleted(items.length - limit))
            : null,
        ]);
      };

      const children = [
        h('div', {
          key: 'stats',
          // The list refresh is silent otherwise: announce the change instead.
          'aria-live': 'polite',
          style: { fontSize: 12, color: theme.dim },
        }, summaryText(groups)),
      ];

      if (error !== null) {
        children.push(h('div', {
          key: 'error',
          role: 'alert',
          style: {
            marginTop: 10,
            padding: '6px 8px',
            borderRadius: 6,
            fontSize: 12,
            color: theme.error,
            background: theme.track,
          },
        }, STR.unreachable + '：' + error));
      }

      if (loading) {
        children.push(h('div', { key: 'loading', style: { marginTop: 18, color: theme.dim } }, STR.loading));
      } else if (total === 0) {
        if (error === null) children.push(h('div', { key: 'empty', style: { marginTop: 18, color: theme.dim } }, STR.empty));
      } else {
        children.push(group('running', STR.running, groups.running, theme.brand));
        children.push(group('failed', STR.failed, groups.failed, theme.error));
        children.push(group('other', STR.other, groups.other, theme.dim));
        children.push(group('completed', STR.completed, groups.completed, theme.success, COMPLETED_LIMIT));
        if (groups.running.length === 0 && groups.failed.length === 0 && groups.other.length === 0) {
          children.push(h('div', { key: 'idle', style: { marginTop: 18, color: theme.dim } }, STR.idle));
        }
      }

      return h('div', {
        'aria-busy': loading,
        style: {
          height: '100%',
          overflowY: 'auto',
          padding: '14px 16px',
          fontSize: 13,
          lineHeight: 1.5,
          color: theme.text,
        },
      }, children.filter(Boolean));
    }

    /**
     * The host renders this component straight into its own tree, so a throw in
     * QueuePane would take down whatever boundary (if any) sits above it — or
     * none at all on the native channel. Own the failure here.
     */
    class PaneBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { failed: false };
        this.reset = () => this.setState({ failed: false });
      }

      static getDerivedStateFromError() {
        return { failed: true };
      }

      componentDidCatch(error, info) {
        console.error('[ghost-download] pane render failed:', error, info && info.componentStack);
      }

      render() {
        if (!this.state.failed) return this.props.children;
        return h('div', { role: 'alert', style: { padding: '14px 16px', fontSize: 13, color: theme.text } }, [
          h('div', { key: 'text' }, STR.crashed),
          h('button', {
            key: 'retry',
            type: 'button',
            onClick: this.reset,
            style: {
              marginTop: 8,
              font: 'inherit',
              fontSize: 12,
              color: theme.brand,
              background: 'transparent',
              border: '1px solid ' + theme.border,
              borderRadius: 6,
              padding: '2px 10px',
              cursor: 'pointer',
            },
          }, STR.retry),
        ]);
      }
    }

    function Pane(props) {
      return h(PaneBoundary, null, h(QueuePane, { visible: props && props.visible }));
    }

    /**
     * Register the tab on DSH's own right-sidebar registry (no better-sidebar
     * present). Type first, slot second: a type without its body shows the host's
     * "nothing can view this" face forever, so a slot failure rolls the type back.
     */
    function registerNative(ctx, tabs) {
      const disposers = [];
      const dispose = () => {
        while (disposers.length > 0) {
          const off = disposers.pop();
          try {
            off();
          } catch (error) {
            console.warn('[ghost-download] native tab cleanup failed:', error);
          }
        }
      };
      try {
        disposers.push(toDisposer(tabs.register({
          id: TAB_ID,
          kind: TAB_ID,
          multiple: false,
          // A third-party page never outranks a built-in one.
          priority: 'extension',
          title: () => STR.tabTitle,
          guide: [{
            id: TAB_ID,
            order: TAB_ORDER,
            title: () => STR.tabTitle,
            description: () => STR.tabDescription,
            // The host calls icon({ size }); DownloadIcon reads props.size.
            icon: (iconProps) => h(DownloadIcon, { size: (iconProps && iconProps.size) || 18 }),
          }],
        })));
        disposers.push(toDisposer(ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab',
          key: TAB_ID,
          // Keyed slot bodies receive service props; this pane needs none.
          inject: () => ({}),
        }, Pane))));
      } catch (error) {
        console.warn('[ghost-download] native tab registration failed:', error);
        dispose();
        return undefined;
      }
      return dispose;
    }

    // ── settings card (plugins.row.config) ────────────────────────────────
    // Master switch first, then execution, then behaviour — the order a reader
    // needs to decide whether any of the rest applies.
    const EASE_OUT = 'cubic-bezier(0.23, 1, 0.32, 1)';
    const C = {
      text: 'var(--dsw-alias-label-primary)',
      dim: 'var(--dsw-alias-label-secondary)',
      border: 'var(--dsw-alias-border-l1)',
      brand: 'var(--dsw-alias-brand-primary)',
      error: 'var(--dsw-alias-state-error-primary)',
      field: 'var(--dsw-alias-bg-layer-2)',
    };
    const CARD = { border: `1px solid ${C.border}`, borderRadius: 12, padding: '18px 20px', marginBottom: 14 };
    const CARD_TITLE = { fontSize: 15, fontWeight: 600, margin: '0 0 6px', color: C.text };
    const CARD_DESC = { fontSize: 13, lineHeight: 1.55, color: C.dim, margin: '0 0 14px' };
    const ROWS = { background: C.field, border: `1px solid ${C.border}`, borderRadius: 10, overflow: 'hidden' };
    const ROW = { padding: '14px 16px' };
    const ROW_TITLE = { fontSize: 13.5, fontWeight: 600, color: C.text, margin: 0 };
    const ROW_DESC = { fontSize: 12.5, lineHeight: 1.5, color: C.dim, margin: '4px 0 0' };
    const FIELD = {
      width: '100%', boxSizing: 'border-box', padding: '8px 10px',
      fontSize: 13, lineHeight: 1.4, color: C.text, background: 'var(--dsw-alias-bg-base, transparent)',
      border: `1px solid ${C.border}`, borderRadius: 8, outline: 'none',
      fontFamily: 'inherit', transition: `border-color 140ms ${EASE_OUT}`,
    };
    const press = (extra) => ({
      ...extra,
      onPointerDown: (event) => { event.currentTarget.style.transform = 'scale(0.97)'; },
      onPointerUp: (event) => { event.currentTarget.style.transform = 'scale(1)'; },
      onPointerLeave: (event) => { event.currentTarget.style.transform = 'scale(1)'; },
    });

    function GSwitch(props) {
      const on = props.value === true;
      return h('label', {
        style: { position: 'relative', display: 'inline-flex', flexShrink: 0, cursor: 'pointer', paddingTop: 2 },
      }, [
        h('span', {
          key: 'track', 'aria-hidden': true,
          style: {
            position: 'relative', width: 44, height: 24, borderRadius: 999,
            background: on ? C.text : C.border,
            transition: `background-color 160ms ${EASE_OUT}`,
          },
        }, [
          h('span', {
            key: 'knob',
            style: {
              position: 'absolute', top: 3, left: on ? 23 : 3, width: 18, height: 18, borderRadius: '50%',
              background: on ? 'var(--dsw-alias-bg-base, #111)' : 'var(--dsw-alias-label-secondary)',
              transition: `left 160ms ${EASE_OUT}, background-color 160ms ${EASE_OUT}`,
            },
          }),
        ]),
        h('input', {
          key: 'cb', type: 'checkbox', checked: on,
          onChange: (event) => props.onChange(event.target.checked),
          style: { position: 'absolute', opacity: 0, width: 0, height: 0 },
        }),
      ]);
    }

    const num = (value, fallback) => (Number.isFinite(value) ? value : fallback);

    /** Every editable Config field, in card order. */
    const FIELDS = [
      'enabled',
      'ghdPath',
      'pollIntervalMs',
      'blockShellDownloads',
      'maxUrlsPerCall',
      'waitLimitSeconds',
      'watchLimitMinutes',
      'maxOutputChars',
      'maxErrorChars',
      'defaultDownloadDir',
      'defaultConflict',
      'defaultHeaders',
      'allowedUrlSchemes',
      'controlRemoveEnabled',
      'waitToolDefaultSeconds',
      'noticeIncludePath',
    ];

    /** Array fields compare by content, so a re-created but equal list is not "dirty". */
    function sameValue(a, b) {
      if (Array.isArray(a) || Array.isArray(b)) {
        const left = Array.isArray(a) ? a : [];
        const right = Array.isArray(b) ? b : [];
        return left.length === right.length && left.every((item, index) => item === right[index]);
      }
      return a === b;
    }

    /** One "Name: value" per line, blank lines and duplicates dropped. */
    function linesToHeaders(text) {
      const out = [];
      const seen = new Set();
      for (const raw of String(text ?? '').split(/\r?\n/)) {
        const line = raw.trim();
        if (line === '') continue;
        const colon = line.indexOf(':');
        const name = colon > 0 ? line.slice(0, colon).trim().toLowerCase() : '';
        if (name === '' || seen.has(name)) continue;
        seen.add(name);
        out.push(line);
      }
      return out;
    }

    /** One scheme per line or comma, lower-cased and deduplicated. */
    function textToSchemes(text) {
      const out = [];
      for (const raw of String(text ?? '').split(/[\r\n,]/)) {
        const scheme = raw.trim().toLowerCase().replace(/:$/, '');
        if (scheme !== '' && !out.includes(scheme)) out.push(scheme);
      }
      return out;
    }

    /**
     * A cleared number input must clear the field, not write `0`.
     *
     * `Number('')` is 0, which every `.min()` in the row schema rejects — the save
     * would fail with a confusing Host error. An empty box therefore maps to
     * `undefined`, which the writer turns into `unset` so the default applies.
     */
    function numOf(value) {
      if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
      const text = String(value ?? '').trim();
      if (text === '') return undefined;
      const parsed = Number(text);
      return Number.isFinite(parsed) ? parsed : undefined;
    }

    function SettingsCard(props) {
      const form = props.ownerForm;
      const view = props.view ?? 'page';
      /**
       * The controller's snapshot is the single source of truth: it is a stable
       * reference that the Host replaces on every accepted write, so `served`
       * doubles as the saved baseline. A local baseline copy would go stale the
       * moment the Host accepted a write, pinning the Save button on forever.
       */
      const [snap, setSnap] = useState(null);
      const [draft, setDraft] = useState(null);
      /** Set after a successful save so the buttons react even if the Host does not re-push. */
      const [confirmed, setConfirmed] = useState(null);
      const [status, setStatus] = useState({ kind: 'idle', error: null });

      useEffect(() => {
        if (!form || typeof form.getSnapshot !== 'function') return undefined;
        const read = () => {
          try {
            setSnap(form.getSnapshot());
          } catch (error) {
            setSnap({ status: 'error', error: messageOf(error) });
          }
        };
        read();
        if (typeof form.subscribe === 'function') return form.subscribe(read);
        return undefined;
      }, [form]);

      const loading = snap === null || snap?.status === 'loading';
      // `unavailable` means the Host does not serve this entry's namespace: there
      // is nothing to edit, and rendering defaults would invite a write that the
      // Host can only refuse.
      const unavailable = snap?.status === 'unavailable';
      const readFailed = snap?.status === 'error';
      const writable = snap?.writable !== false;

      /** The last state the Host confirmed (or the live snapshot). */
      const served = confirmed ?? snap?.value ?? null;
      useEffect(() => {
        // Any new snapshot is authoritative: drop the optimistic baseline and the
        // draft along with it, so a Host-side change is picked up.
        if (snap?.value === undefined) return;
        setConfirmed(null);
        setDraft(snap.value);
      }, [snap]);

      if (view === 'summary') {
        const value = served;
        const path = typeof value?.ghdPath === 'string' ? value.ghdPath : '';
        const poll = num(value?.pollIntervalMs, 5000);
        return h('span', { style: { fontSize: 12.5, color: C.dim } },
          loading ? '读取中…' : unavailable ? '不可配置' : `${path === '' ? 'ghd 自动探测' : path} · ${poll}ms`);
      }

      if (!form) {
        return h('p', { style: { fontSize: 13, color: C.dim, margin: '12px 0' } }, '没有可配置项：未找到本行的配置控制器。');
      }
      if (readFailed) {
        return h('p', { style: { fontSize: 13, color: C.error, margin: '12px 0' } }, `读取配置失败：${snap.error}`);
      }
      if (unavailable) {
        return h('p', { style: { fontSize: 13, color: C.dim, margin: '12px 0' } }, '没有可配置项：当前 profile 未提供本插件的配置。');
      }
      if (loading || draft === null) {
        return h('p', { style: { fontSize: 13, color: C.dim, margin: '12px 0' } }, '读取配置中…');
      }

      const ghdPath = typeof draft.ghdPath === 'string' ? draft.ghdPath : '';
      const poll = num(draft.pollIntervalMs, 5000);
      const dirty = FIELDS.some((field) => !sameValue(draft[field], served?.[field]));
      const saving = status.kind === 'saving';
      const editable = writable && !saving;
      const update = (patch) => setDraft({ ...draft, ...patch });

      /**
       * Write only the fields that actually changed.
       *
       * `ConfigForm.set`/`unset` return `Promise<boolean>` — `true` for Host
       * acceptance, `false` for a refusal or a skipped write. Treating the
       * promise as an object (the old `'revision' in answer` check) reported
       * "已保存" for writes the Host had rejected, and a whole-document write
       * would additionally pin every field as a user override, so a later
       * default change could never reach them again.
       */
      const commit = async (next) => {
        setStatus({ kind: 'saving', error: null });
        try {
          let rejected = 0;
          for (const field of FIELDS) {
            const before = served?.[field];
            const after = next[field];
            if (sameValue(after, before)) continue;
            const accepted = after === undefined
              ? await form.unset(field)
              : await form.set(field, after);
            if (accepted !== true) rejected += 1;
          }
          if (rejected > 0) {
            setStatus({
              kind: 'error',
              error: `保存被拒绝：Host 未接受 ${rejected} 项写入（配置可能只读，或已被其他窗口改动）。`,
            });
            return;
          }
          setConfirmed(next);
          setDraft(next);
          setStatus({ kind: 'saved', error: null });
        } catch (error) {
          setStatus({ kind: 'error', error: messageOf(error) });
        }
      };

      const textRow = (label, hint, value, onChange, extra = {}) => h('div', {
        style: { ...ROW, borderTop: extra.first ? 'none' : `1px solid ${C.border}` },
      }, [
        h('p', { key: 'l', style: { ...ROW_TITLE, marginBottom: 8 } }, label),
        h('input', {
          key: 'i', ...FIELD, value,
          onChange: (event) => onChange(event.target.value),
          onFocus: (event) => { event.currentTarget.style.borderColor = C.brand; },
          onBlur: (event) => { event.currentTarget.style.borderColor = C.border; },
          ...extra.input,
        }),
        hint ? h('p', { key: 'h', style: { ...ROW_DESC, marginTop: 8 } }, hint) : null,
      ]);

      const switchRow = (key, label, hint, value, onChange, first) => h('div', {
        key,
        style: {
          ...ROW, display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
          gap: 18, borderTop: first ? 'none' : `1px solid ${C.border}`,
        },
      }, [
        h('div', { key: 'c', style: { minWidth: 0 } }, [
          h('p', { key: 't', style: ROW_TITLE }, label),
          h('p', { key: 'd', style: ROW_DESC }, hint),
        ]),
        h(GSwitch, { key: 's', value, onChange }),
      ]);

      /** A multi-line text area, for lists that read better one item per line. */
      const areaRow = (label, hint, value, onChange, extra = {}) => h('div', {
        style: { ...ROW, borderTop: extra.first ? 'none' : `1px solid ${C.border}` },
      }, [
        h('p', { key: 'l', style: { ...ROW_TITLE, marginBottom: 8 } }, label),
        h('textarea', {
          key: 'i', ...FIELD, value, rows: extra.rows ?? 4,
          spellCheck: false,
          style: { ...FIELD, resize: 'vertical', fontFamily: 'ui-monospace, monospace', lineHeight: 1.5 },
          onChange: (event) => onChange(event.target.value),
          onFocus: (event) => { event.currentTarget.style.borderColor = C.brand; },
          onBlur: (event) => { event.currentTarget.style.borderColor = C.border; },
          ...extra.input,
        }),
        hint ? h('p', { key: 'h', style: { ...ROW_DESC, marginTop: 8 } }, hint) : null,
      ]);

      /**
       * A two-option segmented control.
       *
       * A radio group is the honest control for `keep`/`overwrite`: the risk of
       * `overwrite` has to be visible next to the choice, not hidden behind a
       * generic select.
       */
      const choiceRow = (label, hint, value, options, onChange, first) => h('div', {
        style: { ...ROW, borderTop: first ? 'none' : `1px solid ${C.border}` },
      }, [
        h('p', { key: 'l', style: { ...ROW_TITLE, marginBottom: 10 } }, label),
        h('div', { key: 'g', role: 'radiogroup', 'aria-label': label, style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
          options.map((option) => {
            const on = value === option.value;
            return h('label', {
              key: option.value,
              style: {
                display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer',
                padding: '7px 12px', borderRadius: 8, fontSize: 12.5,
                border: `1px solid ${on ? C.brand : C.border}`,
                background: on ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
                color: on ? C.text : C.dim,
              },
            }, [
              h('input', {
                key: 'r', type: 'radio', name: label, checked: on,
                onChange: () => onChange(option.value),
                style: { margin: 0, accentColor: 'currentColor' },
              }),
              option.label,
            ]);
          })),
        hint ? h('p', { key: 'h', style: { ...ROW_DESC, marginTop: 10 } }, hint) : null,
      ]);

      return h('div', { style: { fontSize: 13, color: C.text, maxWidth: 760 } }, [
        h('section', { key: 'master', style: CARD }, [
          h('p', { key: 't', style: CARD_TITLE }, '总开关'),
          h('p', { key: 'd', style: CARD_DESC }, '关闭后 6 个 ghost_* 工具不再注册，下面的设置保留。'),
          h('div', { key: 'box', style: ROWS },
            switchRow('enabled', '启用 Ghost Downloader 工具',
              '把下载交给本机 Ghost 队列，并允许智能体提交、查询、控制任务。',
              draft.enabled !== false, (value) => update({ enabled: value }), true)),
        ]),

        h('section', { key: 'cli', style: CARD }, [
          h('p', { key: 't', style: CARD_TITLE }, '执行器'),
          h('p', { key: 'd', style: CARD_DESC }, 'ghd 的位置与调用节奏。留空路径时使用 PATH 中的 ghd。'),
          h('div', { key: 'box', style: ROWS }, [
            textRow('ghd.exe 路径', '也可用环境变量 GHOST_GHD（兼容 GHD_PATH）指定。', ghdPath,
              (value) => update({ ghdPath: value }),
              { first: true, input: { placeholder: 'C:\\Program Files\\Ghost Downloader\\bin\\ghd.exe' } }),
            textRow('后台轮询间隔（毫秒）', '下载完成后多久检查一次状态。越小越及时，也越费资源。', poll,
              (value) => update({ pollIntervalMs: numOf(value) }),
              { input: { type: 'number', min: 1000, step: 500 } }),
            textRow('后台监视时限（分钟）', '单个任务最多被监视多久，超过后停止轮询并通知会话。',
              num(draft.watchLimitMinutes, 30),
              (value) => update({ watchLimitMinutes: numOf(value) }),
              { input: { type: 'number', min: 1, step: 5 } }),
          ]),
        ]),

        h('section', { key: 'limits', style: CARD }, [
          h('p', { key: 't', style: CARD_TITLE }, '限制'),
          h('p', { key: 'd', style: CARD_DESC }, '控制一次调用能提交多少、能等多久、能返回多少内容。'),
          h('div', { key: 'box', style: ROWS }, [
            textRow('单次最多链接数', '一次 ghost_download 接受的链接上限。', num(draft.maxUrlsPerCall, 50),
              (value) => update({ maxUrlsPerCall: numOf(value) }),
              { first: true, input: { type: 'number', min: 1, step: 10 } }),
            textRow('同步等待上限（秒）', 'ghost_download / ghost_wait 最长阻塞时间。', num(draft.waitLimitSeconds, 3600),
              (value) => update({ waitLimitSeconds: numOf(value) }),
              { input: { type: 'number', min: 10, step: 60 } }),
            textRow('成功输出上限（字符）', '回传给模型的正文上限。', num(draft.maxOutputChars, 20000),
              (value) => update({ maxOutputChars: numOf(value) }),
              { input: { type: 'number', min: 500, step: 1000 } }),
            textRow('失败输出上限（字符）', '调用失败时附带原始输出的上限。', num(draft.maxErrorChars, 2000),
              (value) => update({ maxErrorChars: numOf(value) }),
              { input: { type: 'number', min: 200, step: 200 } }),
          ]),
        ]),

        h('section', { key: 'defaults', style: CARD }, [
          h('p', { key: 't', style: CARD_TITLE }, '下载默认值'),
          h('p', { key: 'd', style: CARD_DESC },
            '调用时没有显式指定这些参数，就按这里的取值执行。'),
          h('div', { key: 'box', style: ROWS }, [
            textRow('默认下载目录', '留空表示交给 Ghost 自己的下载目录（当前为 C:\\Users\\a_mol\\Downloads）。'
              + '填绝对路径后，智能体不传 dir 时文件就落到这里——想让文件落在会话工作区，填工作区下的子目录即可。',
            typeof draft.defaultDownloadDir === 'string' ? draft.defaultDownloadDir : '',
            (value) => update({ defaultDownloadDir: value }),
            { first: true, input: { placeholder: '例如 D:\\Downloads 或 <工作区>\\downloads' } }),
            choiceRow('同名文件处理',
              'overwrite 会静默覆盖同名的已有文件，属于破坏性行为；keep 会在重名时保留两者。',
              draft.defaultConflict === 'overwrite' ? 'overwrite' : 'keep',
              [{ value: 'keep', label: '保留两者' }, { value: 'overwrite', label: '覆盖' }],
              (value) => update({ defaultConflict: value })),
            textRow('ghost_wait 默认等待（秒）', '不传 timeoutSeconds 时阻塞多久。上限受上面的「同步等待上限」约束。',
              num(draft.waitToolDefaultSeconds, 600),
              (value) => update({ waitToolDefaultSeconds: numOf(value) }),
              { input: { type: 'number', min: 10, step: 60 } }),
            switchRow('notice', '完成通知里带文件路径',
              '关闭后智能体只知道文件名，需要再查一次任务才能拿到落盘位置。',
              draft.noticeIncludePath !== false,
              (value) => update({ noticeIncludePath: value })),
          ]),
        ]),

        h('section', { key: 'security', style: CARD }, [
          h('p', { key: 't', style: CARD_TITLE }, '安全'),
          h('p', { key: 'd', style: CARD_DESC },
            '这是把下载收敛到 Ghost 之后的限权面：限制能提交什么、能删什么、带什么请求头。'),
          h('div', { key: 'box', style: ROWS }, [
            areaRow('允许的协议', '一行一个。不在列表里的链接会被直接拒绝，ghost_probe 同样受限。',
              (Array.isArray(draft.allowedUrlSchemes) && draft.allowedUrlSchemes.length > 0
                ? draft.allowedUrlSchemes
                : ['http', 'https', 'ftp', 'magnet', 'ed2k']).join('\n'),
              (value) => update({
                allowedUrlSchemes: String(value)
                  .split(/\r?\n/)
                  .map((line) => line.trim().toLowerCase())
                  .filter((line) => line !== ''),
              }),
              { first: true, rows: 5 }),
            switchRow('remove', '允许删除任务',
              '关闭后 ghost_control 的 remove 会从工具的参数枚举里消失。'
              + '注意 remove 会连同该任务尚未完成的文件一起删除。',
              draft.controlRemoveEnabled !== false,
              (value) => update({ controlRemoveEnabled: value })),
            areaRow('默认请求头', '一行一个 "Name: value"，会叠加到每次提交。'
              + '请求头会进入 ghd 的命令行参数，本机其它进程可以在进程列表里看到。',
              (Array.isArray(draft.defaultHeaders) ? draft.defaultHeaders : []).join('\n'),
              (value) => update({ defaultHeaders: linesToHeaders(value) }),
              { rows: 4 }),
          ]),
        ]),

        h('section', { key: 'behaviour', style: CARD }, [
          h('p', { key: 't', style: CARD_TITLE }, '行为'),
          h('p', { key: 'd', style: CARD_DESC }, '决定是否拦截其他下载方式。'),
          h('div', { key: 'box', style: ROWS },
            switchRow('block', '拦截 curl -o / wget',
              '把这些 shell 下载改道到 ghost_download，避免绕过队列。',
              draft.blockShellDownloads !== false,
              (value) => update({ blockShellDownloads: value }), true)),
        ]),

        h('div', { key: 'footer', style: { display: 'flex', alignItems: 'center', gap: 10, marginTop: 18 } }, [
          h('button', {
            key: 'save', type: 'button',
            ...press({
              disabled: !dirty || !editable,
              onClick: () => { void commit({ ...draft, ghdPath: ghdPath.trim() }); },
              style: {
                padding: '8px 18px', fontSize: 13, fontWeight: 500, lineHeight: 1.2,
                borderRadius: 8, border: '1px solid transparent',
                background: C.text, color: 'var(--dsw-alias-bg-base, #111)',
                cursor: dirty ? 'pointer' : 'default', opacity: dirty ? 1 : 0.45,
                transition: `transform 140ms ${EASE_OUT}, opacity 140ms ${EASE_OUT}`, fontFamily: 'inherit',
              },
            }),
          }, status.kind === 'saving' ? '保存中…' : '保存'),
          h('button', {
            key: 'reset', type: 'button',
            ...press({
              disabled: !dirty || saving,
              onClick: () => { setDraft(served ?? null); setStatus({ kind: 'idle', error: null }); },
              style: {
                padding: '8px 14px', fontSize: 13, lineHeight: 1.2, borderRadius: 8,
                border: '1px solid transparent', background: 'transparent',
                color: C.dim, cursor: dirty ? 'pointer' : 'default', opacity: dirty ? 1 : 0.5,
                transition: `transform 140ms ${EASE_OUT}`, fontFamily: 'inherit',
              },
            }),
          }, '重置'),
          h('span', {
            key: 'status', role: 'status',
            style: {
              marginLeft: 'auto', fontSize: 12.5,
              color: status.kind === 'error' ? C.error : C.dim,
              minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            },
          }, status.kind === 'error'
            ? (status.error ?? '保存失败')
            : status.kind === 'saved' ? '已保存' : writable ? '' : '当前档位只读'),
        ]),
      ]);
    }

    return {
      inject: ['slots', 'configForms'],
      apply(ctx) {
        // Two channels can host this pane: dsh-better-sidebar's registry
        // (preferred) and DSH's own tab registry. Exactly ONE may own it —
        // registerTab already mirrors a native type + guide entry for every
        // descriptor, so registering both would show the page twice and collide
        // on the same id.
        let channel = null; // 'better' | 'native' | null
        let disposeChannel = null;
        // The betterSidebar instance whose registerTab already threw. Without
        // this, every later `sidebarRightTabs` change would tear the native tab
        // down just to retry a registration that keeps failing.
        let betterRejected = null;

        const teardown = () => {
          const off = disposeChannel;
          disposeChannel = null;
          channel = null;
          if (off === null) return;
          try {
            off();
          } catch (error) {
            console.warn('[ghost-download] tab teardown failed:', error);
          }
        };

        /** Pick a channel from what the context currently offers; idempotent. */
        const sync = (scope) => {
          const get = (name) => {
            try {
              return scope.get(name);
            } catch {
              return undefined;
            }
          };
          const better = get('betterSidebar');
          const tabs = get('sidebarRightTabs');
          // A rejected instance is not retried; a NEW one (plugin reload) is.
          const wanted = better !== betterRejected && typeof better?.registerTab === 'function'
            ? 'better'
            : typeof tabs?.register === 'function' ? 'native' : null;
          if (wanted === null || channel === wanted) return;
          teardown();
          if (wanted === 'better') {
            try {
              disposeChannel = toDisposer(scope.effect(() => better.registerTab({
                id: TAB_ID,
                title: () => STR.tabTitle,
                description: () => STR.tabDescription,
                icon: (size) => h(DownloadIcon, { size: size || 18 }),
                order: TAB_ORDER,
                // Required: the tab body is rendered as createElement(component),
                // so a missing component is exactly React error #130.
                component: Pane,
              }), 'ghost-download: better-sidebar tab'));
              channel = 'better';
            } catch (error) {
              // A duplicate id (stale registry after a reload) must not take the
              // whole client down: remember the failure and fall through to the
              // native channel instead.
              console.warn('[ghost-download] betterSidebar.registerTab failed:', error);
              betterRejected = better;
              disposeChannel = null;
              channel = null;
            }
          }
          if (channel === null && typeof tabs?.register === 'function') {
            disposeChannel = registerNative(ctx, tabs) || null;
            channel = disposeChannel === null ? null : 'native';
          }
        };

        // `betterSidebar` is optional (third-party service), so the native
        // registry injection is the one that must resolve; the better-sidebar one
        // only exists to notice a LATE arrival and hand the tab over.
        let tabsScope = null;
        ctx.inject(['sidebarRightTabs'], (scope) => {
          tabsScope = scope;
          sync(scope);
          return () => {
            tabsScope = null;
            if (channel === 'native') teardown();
          };
        });
        ctx.inject(['betterSidebar'], (scope) => {
          sync(scope);
          return () => {
            if (channel !== 'better') return;
            teardown();
            // better-sidebar unloaded: fall back to the native channel instead of
            // leaving the pane gone until the next reload.
            if (tabsScope !== null) sync(tabsScope);
          };
        });

        // ── settings card ───────────────────────────────────────────────────
        // `settings.describe` keys every form by the LOADER ENTRY's
        // `options.id` (`ns: entry.options.id` in the Host projection), which for
        // a patch row is its patch id — `ghost-download`, not `include:...`.
        // `configForms.get()` NEVER returns undefined: it creates a controller for
        // whatever id it is given, so the old `include:`-then-bare probe loop
        // always stopped at the FIRST candidate and bound the card to a namespace
        // the Host does not serve — the form then read `unavailable` forever.
        const ROW_ID = 'ghost-download';
        const NS = ROW_ID;
        let ownerForm;
        try {
          if (typeof ctx.configForms?.get === 'function') ownerForm = ctx.configForms.get(NS);
        } catch {
          ownerForm = undefined;
        }
        if (ownerForm !== undefined && typeof ctx.slots?.inject === 'function') {
          ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
            name: 'plugins.row.config',
            key: '@local/dsh-ghost-download#' + ROW_ID,
            locale: '@local/dsh-ghost-download',
          }, (props) => h(SettingsCard, { ...props, ownerForm })));
        }
      },
    };
  },
});
