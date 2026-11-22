/* Browser module: no private Client UI imports. The read-row replacement
 * contract was verified on DSH 0.2.2-rc.5 and must be checked on each fresh
 * native snapshot build. tool.call.toolview replaces the whole read row and
 * does not pass renderFallback through to entries, so unmarked root reads use
 * this lightweight disclosure (path-open, status and inspect; no native syntax
 * highlighting/context menu). Ordinary result text is materialized only when
 * the user expands its row.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-ptc-disk-history',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const NS = 'ptc-disk-history';
    const MAX_BYTES = 65536;
    const PAGE_LINES = 100;
    const MAX_PREVIOUS = 100;
    const dictionaries = {
      zh: {
        read: '读取', preparing: '准备中', running: '读取中', done: '已完成', failed: '读取失败', stopped: '已中止',
        expand: '展开读取结果', collapse: '收起读取结果', inspect: '检查调用', openFile: '打开文件',
        preview: '磁盘预览 · 此处仅为摘要，不是完整原文', summary: '{lines} 行 · 原始 {bytes} 字节',
        load: '从原会话日志读取详情', loading: '正在读取当前页…', close: '收起详情并释放内存',
        previous: '上一页', next: '下一页', page: '原文第 {first}–{last} 行',
        fragment: '续行片段 · 首行字符偏移 {offset}', continued: '末行尚未结束，请点下一页继续',
        rawPage: '当前页原文（可选择并复制）', copyHint: '仅保留当前页；上一页将从日志重新读取。可选择下方原文复制。',
        historyLimit: '仅保留最近 100 页的返回游标。', retry: '重新读取第一页', unavailable: '磁盘详情标记无效，无法读取。',
        invalidPage: '详情页格式或游标无效，已丢弃。', tooLarge: '详情响应超过 64 KiB，已丢弃。',
        stale: '原日志版本已改变，请收起后重新打开会话。', denied: '当前账户无权读取此会话详情。',
        network: '无法读取详情，请检查连接后重试。',
      },
      en: {
        read: 'Read', preparing: 'Preparing', running: 'Reading', done: 'Completed', failed: 'Read failed', stopped: 'Stopped',
        expand: 'Expand read result', collapse: 'Collapse read result', inspect: 'Inspect call', openFile: 'Open file',
        preview: 'Disk preview · summary only, not the complete source', summary: '{lines} lines · {bytes} original bytes',
        load: 'Read details from the original session log', loading: 'Reading current page…', close: 'Close details and release memory',
        previous: 'Previous page', next: 'Next page', page: 'Source lines {first}–{last}',
        fragment: 'Line fragment · first-line character offset {offset}', continued: 'Last line continues on the next page',
        rawPage: 'Current page source (select and copy)', copyHint: 'Only this page is retained. Previous pages are read again from the log. Select the source below to copy.',
        historyLimit: 'Only the last 100 return cursors are retained.', retry: 'Read again from the first page', unavailable: 'The disk detail marker is invalid.',
        invalidPage: 'Invalid detail page or cursor; the response was discarded.', tooLarge: 'Detail response exceeded 64 KiB and was discarded.',
        stale: 'The source log revision changed. Close and reopen the session.', denied: 'Your account cannot read details for this session.',
        network: 'Details could not be read. Check the connection and retry.',
      },
    };
    const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
    const count = value => Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
    function failure(code) { const error = new Error(code); error.code = code; return error; }
    function validLocator(value) {
      return object(value) && value.version === 1 && count(value.seq)
        && typeof value.token === 'string' && value.token.length > 0 && value.token.length <= 4096
        && count(value.lineCount) && value.lineCount > 0 && count(value.originalBytes);
    }
    function checkAbort(signal) {
      if (signal.aborted) { const error = new Error('aborted'); error.name = 'AbortError'; throw error; }
    }
    // Read the actual decompressed wire bytes with a hard cap, BEFORE parsing.
    // Native fetch exposes a stream; an absent stream fails closed instead of
    // calling response.json()/text(), which could allocate an unbounded body.
    async function readJsonPage(response, signal) {
      if (!response.ok) {
        await response.body?.cancel();
        throw failure(response.status === 401 || response.status === 403 ? 'denied'
          : response.status === 409 || response.status === 410 ? 'stale' : 'network');
      }
      if (!response.body?.getReader) throw failure('invalidPage');
      if (Number(response.headers.get('content-length')) > MAX_BYTES) {
        await response.body.cancel(); throw failure('tooLarge');
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8', { fatal: true });
      const decode = (chunk, options) => {
        try { return decoder.decode(chunk, options); } catch { throw failure('invalidPage'); }
      };
      let bytes = 0, text = '', completed = false;
      try {
        for (;;) {
          checkAbort(signal);
          const chunk = await reader.read();
          checkAbort(signal);
          if (chunk.done) { completed = true; break; }
          bytes += chunk.value.byteLength;
          if (bytes > MAX_BYTES) throw failure('tooLarge');
          text += decode(chunk.value, { stream: true });
        }
        text += decode();
        try { return JSON.parse(text); } catch { throw failure('invalidPage'); }
      } finally {
        if (!completed) await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    }
    function validatePage(value, locator, cursor, revision) {
      if (!object(value) || value.seq !== locator.seq || typeof value.revision !== 'string' || !value.revision.length
        || value.revision.length > 512 || !Array.isArray(value.lines) || !value.lines.length || value.lines.length > PAGE_LINES
        || !count(value.nextOffset) || value.nextOffset > locator.lineCount || !count(value.nextTextOffset)
        || typeof value.hasMore !== 'boolean' || value.hasMore !== (value.nextOffset < locator.lineCount)) throw failure('invalidPage');
      if (revision !== null && value.revision !== revision) throw failure('stale');
      let offset = cursor.offset, at = cursor.textOffset, previousNumber = 0;
      const lines = [];
      for (let i = 0; i < value.lines.length; i++) {
        const line = value.lines[i];
        if (!object(line) || !count(line.number) || line.number < 1 || line.number <= previousNumber
          || typeof line.text !== 'string' || !count(line.textOffset) || line.textOffset !== at
          || typeof line.continued !== 'boolean' || offset >= locator.lineCount
          || (line.continued && (line.text.length === 0 || i !== value.lines.length - 1))) throw failure('invalidPage');
        previousNumber = line.number;
        lines.push({ number: line.number, text: line.text, textOffset: line.textOffset, continued: line.continued });
        if (line.continued) {
          at += line.text.length;
          if (!count(at) || at > locator.originalBytes) throw failure('invalidPage');
        } else { offset++; at = 0; }
      }
      if (value.nextOffset !== offset || value.nextTextOffset !== at
        || (offset === cursor.offset && at <= cursor.textOffset)) throw failure('invalidPage');
      // Retain only the declared schema, never arbitrary extra JSON payload.
      return { seq: value.seq, revision: value.revision, lines, nextOffset: offset, nextTextOffset: at, hasMore: value.hasMore };
    }
    async function loadPage(sessionId, locator, cursor, signal, revision = null) {
      if (typeof sessionId !== 'string' || !sessionId.length || !validLocator(locator)
        || !count(cursor.offset) || cursor.offset >= locator.lineCount || !count(cursor.textOffset)
        || cursor.textOffset > locator.originalBytes) throw failure('invalidPage');
      checkAbort(signal);
      const response = await fetch('/api/ptc-disk-history/lines', {
        method: 'POST', credentials: 'same-origin', signal,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ sessionId, seq: locator.seq, token: locator.token, offset: cursor.offset,
          textOffset: cursor.textOffset, limit: PAGE_LINES, maxBytes: MAX_BYTES }),
      });
      checkAbort(signal);
      const value = await readJsonPage(response, signal);
      checkAbort(signal);
      return validatePage(value, locator, cursor, revision);
    }
    // Only current-page payload + up to 100 numeric return cursors live here.
    // The callback signals a render; React state never stores page history.
    function createPageController(sessionId, locator, changed = () => {}) {
      let state = { open: false, loading: false, page: null, previous: [], error: null, historyLimited: false };
      let cursor = { offset: 0, textOffset: 0 }, revision = null, pending = null, generation = 0;
      const publish = patch => { state = { ...state, ...patch }; changed(); };
      async function request(target, previous, limited = state.historyLimited) {
        if (state.loading) return;
        const id = ++generation, abort = new AbortController(); pending = abort;
        publish({ open: true, loading: true, page: null, error: null });
        try {
          const page = await loadPage(sessionId, locator, target, abort.signal, revision);
          if (id !== generation || abort.signal.aborted) return;
          cursor = target; revision = page.revision;
          publish({ page, previous, historyLimited: limited });
        } catch (error) {
          if (id !== generation || abort.signal.aborted) return;
          const code = ['invalidPage', 'tooLarge', 'stale', 'denied'].includes(error.code) ? error.code : 'network';
          publish({ page: null, error: code });
        } finally {
          if (id === generation) { pending = null; publish({ loading: false }); }
        }
      }
      return {
        getSnapshot: () => state,
        open() {
          if (state.loading) return Promise.resolve();
          revision = null;
          return request({ offset: 0, textOffset: 0 }, [], false);
        },
        next() {
          if (state.loading || !state.page?.hasMore) return Promise.resolve();
          const target = { offset: state.page.nextOffset, textOffset: state.page.nextTextOffset };
          const previous = [...state.previous, { ...cursor }];
          const limited = state.historyLimited || previous.length > MAX_PREVIOUS;
          if (previous.length > MAX_PREVIOUS) previous.shift();
          return request(target, previous, limited);
        },
        prev() {
          if (state.loading || !state.previous.length) return Promise.resolve();
          const previous = state.previous.slice();
          return request(previous.pop(), previous);
        },
        close() {
          generation++; pending?.abort(); pending = null; revision = null;
          cursor = { offset: 0, textOffset: 0 };
          publish({ open: false, loading: false, page: null, previous: [], error: null, historyLimited: false });
        },
      };
    }
    const controlStyle = { font: 'inherit', fontSize: 12, color: 'var(--dsw-alias-label-secondary)', background: 'var(--dsw-alias-bg-base)', border: '0.5px solid var(--dsw-alias-border-l1)', borderRadius: 6, padding: '5px 9px', cursor: 'pointer' };
    const noteStyle = { fontSize: 12, color: 'var(--dsw-alias-label-caption)', margin: '6px 0' };
    const panelStyle = { border: '0.5px solid var(--dsw-alias-border-l1)', borderRadius: 8, padding: 12, marginTop: 8, minWidth: 0, background: 'var(--dsw-alias-markdown-code-block)' };
    const sourceStyle = { margin: '6px 0', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 300, overflow: 'auto', fontFamily: 'monospace', fontSize: 12, color: 'var(--dsw-alias-label-secondary)' };
    function action(id, label, click, disabled = false, extra = {}) {
      return h('button', { type: 'button', 'data-action': id, style: { ...controlStyle, opacity: disabled ? 0.5 : 1 }, disabled, onClick: click, ...extra }, label);
    }
    function parsedArgs(block, phase) {
      if (phase === 'preparing') return {};
      try { const args = JSON.parse((phase === 'result' ? block.call : block)?.argsRaw ?? '{}'); return object(args) ? args : {}; }
      catch { return {}; }
    }
    function ReadRow(props) {
      const { block, phase, sessionId, t, useDisclosure } = props;
      const { expanded, toggle } = useDisclosure();
      const [, repaint] = React.useState(0);
      const mounted = React.useRef(false);
      const marker = phase === 'result' && object(block.meta) ? block.meta.__dshDiskPtc : undefined;
      const disk = validLocator(marker);
      const controller = React.useMemo(() => disk ? createPageController(sessionId, marker, () => {
        if (mounted.current) repaint(value => value + 1);
      }) : null, [sessionId, disk, marker?.seq, marker?.token, marker?.lineCount, marker?.originalBytes]);
      React.useEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; controller?.close(); };
      }, [controller]);
      // Includes host enclosing-Turn disclosure resets, not just our button.
      React.useEffect(() => { if (!expanded) controller?.close(); }, [expanded, controller]);
      const args = parsedArgs(block, phase);
      const path = typeof block.meta?.path === 'string' ? block.meta.path : typeof args.file_path === 'string' ? args.file_path : '';
      const status = phase === 'preparing' ? 'preparing' : phase === 'start' ? 'running'
        : block.error?.code === 'interrupted' ? 'stopped' : block.isError || block.meta?.stopped ? 'failed' : 'done';
      const snapshot = controller?.getSnapshot();
      const page = snapshot?.page;
      const controls = h('div', { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 } },
        action('toggle', `${expanded ? '▾' : '▸'} ${t('read')}`, () => { if (expanded) controller?.close(); toggle(); }, phase === 'preparing', { 'aria-expanded': expanded, 'aria-label': t(expanded ? 'collapse' : 'expand') }),
        path && props.openFile ? h('button', { type: 'button', title: t('openFile'), onClick: () => props.openFile(path, count(args.offset) && args.offset > 0 ? { line: args.offset } : undefined), style: { ...controlStyle, border: 0, padding: 0, background: 'transparent', overflowWrap: 'anywhere', textAlign: 'left' } }, path) : null,
        h('span', { style: noteStyle }, t(status)),
        props.inspect ? action('inspect', t('inspect'), props.inspect) : null);
      let body = null;
      if (expanded) {
        if (marker !== undefined) {
          // Marker content is presentation-only. Never pass it off as original
          // source and never fall back to the result's potentially large text.
          const preview = Array.isArray(block.meta.lines) ? block.meta.lines
            .filter(line => object(line) && typeof line.text === 'string').map(line => line.text).join('\n') : '';
          body = h('section', { style: panelStyle },
            h('p', { style: noteStyle, 'data-preview': true }, t('preview')),
            h('pre', { style: sourceStyle }, preview),
            disk ? h('p', { style: noteStyle }, t('summary', { lines: marker.lineCount, bytes: marker.originalBytes })) : null,
            !controller ? h('p', { role: 'alert', style: noteStyle }, t('unavailable')) : !snapshot.open
              ? action('load', t('load'), () => { void controller.open(); })
              : h('div', { 'aria-busy': snapshot.loading },
                h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 } },
                  action('previous', t('previous'), () => { void controller.prev(); }, snapshot.loading || !snapshot.previous.length),
                  action('next', t('next'), () => { void controller.next(); }, snapshot.loading || !page?.hasMore),
                  action('close', t('close'), () => controller.close())),
                snapshot.loading ? h('p', { role: 'status', style: noteStyle }, t('loading')) : null,
                snapshot.error ? h('div', { role: 'alert' }, h('p', { style: noteStyle }, t(snapshot.error)),
                  snapshot.error !== 'stale' ? action('retry', t('retry'), () => { void controller.open(); }) : null) : null,
                page ? h('div', null,
                  h('p', { style: noteStyle }, t('page', { first: page.lines[0].number, last: page.lines[page.lines.length - 1].number })),
                  page.lines[0].textOffset > 0 ? h('p', { style: noteStyle }, t('fragment', { offset: page.lines[0].textOffset })) : null,
                  h('textarea', { readOnly: true, spellCheck: false, wrap: 'off', 'aria-label': t('rawPage'), value: page.lines.map(line => line.text).join('\n'),
                    rows: Math.max(3, Math.min(18, page.lines.length + 1)), style: { ...sourceStyle, display: 'block', boxSizing: 'border-box', width: '100%', resize: 'vertical', padding: 8, border: '0.5px solid var(--dsw-alias-border-l1)', borderRadius: 6, background: 'var(--dsw-alias-bg-base)' } }),
                  page.lines[page.lines.length - 1].continued ? h('p', { style: noteStyle }, t('continued')) : null,
                  h('p', { style: noteStyle }, t('copyHint'))) : null,
                snapshot.historyLimited ? h('p', { style: noteStyle }, t('historyLimit')) : null));
        } else if (phase === 'result') {
          const text = Array.isArray(block.content) ? block.content.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n') : '';
          body = h('pre', { style: { ...sourceStyle, ...panelStyle } }, text);
        }
      }
      return h('div', { style: { minWidth: 0, color: 'var(--dsw-alias-label-primary)', fontSize: 13 } }, controls, body);
    }
    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, dictionaries));
        ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
          name: 'tool.call.toolview', key: 'read', locale: NS,
        }, ReadRow));
      },
      // Named exports from the loader factory enable VM behavior tests without
      // importing a second React or installing any browser testing framework.
      ReadRow, createPageController, loadPage,
    };
  },
});
