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

    return {
      inject: ['slots'],
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
      },
    };
  },
});
