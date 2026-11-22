import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const sourcePath = new URL('../lib/client.js', import.meta.url);
const locator = { version: 1, seq: 7, token: 'opaque-proof', lineCount: 150, originalBytes: 90000 };
const page = (overrides = {}) => ({ seq: 7, revision: 'generation-a', lines: [{ number: 10, text: 'exact\t原文', textOffset: 0, continued: false }], nextOffset: 1, nextTextOffset: 0, hasMore: true, ...overrides });
function hooks() {
  let cells = [], cursor = 0, pending = [], cleanups = [];
  const changed = (a, b) => !a || a.length !== b.length || a.some((v, i) => v !== b[i]);
  const React = {
    createElement(type, props, ...children) { return { type, props: { ...props, children: children.flat().filter(v => v !== null && v !== false && v !== undefined) } }; },
    useId() { return `test-id-${cursor++}`; },
    useState(initial) { const i = cursor++; cells[i] ??= { value: typeof initial === 'function' ? initial() : initial }; return [cells[i].value, value => { cells[i].value = typeof value === 'function' ? value(cells[i].value) : value; }]; },
    useRef(initial) { const i = cursor++; return cells[i] ??= { current: initial }; },
    useMemo(fn, deps) { const i = cursor++; if (changed(cells[i]?.deps, deps)) cells[i] = { deps, value: fn() }; return cells[i].value; },
    useEffect(fn, deps) { const i = cursor++; if (changed(cells[i]?.deps, deps)) { cells[i] = { deps }; pending.push(() => { cleanups[i]?.(); cleanups[i] = fn(); }); } },
  };
  return { React, render(component, props) { cursor = 0; const result = component(props); const effects = pending; pending = []; effects.forEach(fn => fn()); return result; }, unmount() { cleanups.forEach(fn => fn?.()); cells = []; } };
}
async function load(fetcher = async () => Response.json(page()), React = hooks().React) {
  let registration;
  const code = await readFile(sourcePath, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
  vm.runInNewContext(code, { window: { __ModuleLoader__: { load(value) { registration = value; } } }, fetch: fetcher, AbortController, TextDecoder, TextEncoder, Uint8Array, Error, RangeError, console });
  assert.equal(registration?.id, '@local/dsh-ptc-disk-history', 'the browser artifact must register its planned package id');
  return registration.factory(name => { assert.equal(name, 'react'); return React; });
}
function nodes(node) { return !node || typeof node !== 'object' ? [] : [node, ...(node.props?.children ?? []).flatMap(nodes)]; }
function button(tree, id) { const found = nodes(tree).find(n => n.type === 'button' && n.props['data-action'] === id); assert.ok(found, `missing ${id} button`); return found; }
const flush = () => new Promise(resolve => setImmediate(resolve));
function props(React, marker = locator) {
  return { sessionId: 'session-one', phase: 'result', toolName: 'read', callId: 'call-one',
    block: { kind: 'tool-result', callId: 'call-one', parentCallId: 'parent', call: { name: 'read', argsRaw: '{"file_path":"sample.txt","offset":10}' }, meta: { path: 'C:\\sample.txt', lines: [{ number: 10, text: '[Disk-backed PTC preview] excerpt' }], ...(marker ? { __dshDiskPtc: marker } : {}) }, content: [{ type: 'text', text: 'original recorded content' }], isError: false, subCalls: [] },
    useDisclosure() { const [expanded, setExpanded] = React.useState(false); return { expanded, setExpanded, toggle: () => setExpanded(v => !v) }; },
    openFile() {}, t: key => key,
  };
}

test('real read-row clicks gate the first credentialed request and expose exact copyable page text', async () => {
  const calls = [], runtime = hooks();
  const mod = await load(async (url, options) => { calls.push({ url, options }); return Response.json(page()); }, runtime.React);
  let View, registered;
  const effects = [];
  mod.apply({ effect(fn) { effects.push(fn()); }, locale: { register() { return () => {}; } }, slots: { inject(name, fn) { if (name === 'tool.call.toolview') fn(); }, register(options, component) { registered = options; View = component; return () => {}; } } });
  assert.equal(registered.key, 'read');
  const p = props(runtime.React);
  let tree = runtime.render(View, p);
  assert.equal(calls.length, 0);
  assert.equal(button(tree, 'toggle').props['aria-expanded'], false);
  button(tree, 'toggle').props.onClick(); tree = runtime.render(View, p);
  assert.equal(button(tree, 'toggle').props['aria-expanded'], true);
  assert.equal(calls.length, 0, 'native expansion must not fetch details');
  assert.ok(nodes(tree).some(n => n.props?.['data-preview'] === true));
  button(tree, 'load').props.onClick(); await flush(); tree = runtime.render(View, p);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/ptc-disk-history/lines');
  assert.equal(calls[0].options.credentials, 'same-origin');
  assert.equal(calls[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].options.body), { sessionId: 'session-one', seq: 7, token: 'opaque-proof', offset: 0, textOffset: 0, limit: 100, maxBytes: 65536 });
  assert.equal(nodes(tree).find(n => n.type === 'textarea')?.props.value, 'exact\t原文');
  button(tree, 'close').props.onClick(); tree = runtime.render(View, p);
  assert.equal(nodes(tree).some(n => n.type === 'textarea'), false);
  runtime.unmount(); effects.forEach(fn => fn?.());
});

test('unmarked root read stays collapsed, reveals existing content on click, and never requests disk details', async () => {
  const runtime = hooks(); let requests = 0;
  const mod = await load(async () => { requests++; throw new Error('unexpected'); }, runtime.React);
  const p = props(runtime.React, null); delete p.block.parentCallId;
  let tree = runtime.render(mod.ReadRow, p);
  assert.equal(nodes(tree).some(n => n.type === 'pre'), false);
  button(tree, 'toggle').props.onClick(); tree = runtime.render(mod.ReadRow, p);
  assert.equal(nodes(tree).find(n => n.type === 'pre')?.props.children.join(''), 'original recorded content');
  assert.equal(nodes(tree).some(n => n.props?.['data-action'] === 'load'), false);
  assert.equal(requests, 0);
});

test('next replaces payload and previous re-fetches only a cursor, including textOffset continuation', async () => {
  const requests = [];
  const mod = await load(async (_url, options) => { const body = JSON.parse(options.body); requests.push(body); return Response.json(body.textOffset === 0 ? page({ lines: [{ number: 10, text: 'start', textOffset: 0, continued: true }], nextOffset: 0, nextTextOffset: 5 }) : page({ lines: [{ number: 10, text: 'end', textOffset: 5, continued: false }], nextOffset: 1 })); });
  const controller = mod.createPageController('session-one', locator);
  await controller.open(); assert.equal(controller.getSnapshot().page.lines[0].text, 'start');
  await controller.next(); assert.equal(controller.getSnapshot().page.lines[0].text, 'end');
  assert.equal(controller.getSnapshot().previous.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(controller.getSnapshot().previous)), [{ offset: 0, textOffset: 0 }]);
  await controller.prev(); assert.equal(controller.getSnapshot().page.lines[0].text, 'start');
  assert.deepEqual(requests.map(v => [v.offset, v.textOffset]), [[0, 0], [0, 5], [0, 0]]);
});

test('controller retains at most 100 previous cursors and no historical payloads', async () => {
  const mod = await load(async (_url, options) => { const { offset } = JSON.parse(options.body); return Response.json(page({ lines: [{ number: offset + 1, text: `page-${offset}`, textOffset: 0, continued: false }], nextOffset: offset + 1 })); });
  const controller = mod.createPageController('session-one', locator);
  await controller.open(); for (let i = 0; i < 110; i++) await controller.next();
  const state = controller.getSnapshot();
  assert.equal(state.previous.length, 100);
  assert.equal(state.previous[0].offset, 10);
  assert.ok(state.previous.every(v => Object.keys(v).sort().join(',') === 'offset,textOffset'));
  assert.equal(state.page.lines.length, 1); assert.equal(state.page.lines[0].text, 'page-110');
  controller.close(); assert.equal(controller.getSnapshot().page, null); assert.equal(controller.getSnapshot().previous.length, 0);
});

for (const [name, invalid] of [
  ['cursor outside line count', { nextOffset: 151 }],
  ['backward cursor', { nextOffset: 0 }],
  ['wrong seq', { seq: 8 }],
  ['false terminal cursor', { hasMore: false }],
  ['unsafe numeric cursor', { nextOffset: Number.MAX_SAFE_INTEGER + 1 }],
  ['inconsistent fragment cursor', { nextOffset: 0, nextTextOffset: 2 }],
]) test(`rejects ${name} before committing a page`, async () => {
  const mod = await load(async () => Response.json(page(invalid)));
  const controller = mod.createPageController('session-one', locator);
  await controller.open();
  assert.equal(controller.getSnapshot().page, null);
  assert.equal(controller.getSnapshot().error, 'invalidPage');
});

test('wire response over 64 KiB is cancelled before JSON parsing and not retained', async () => {
  let cancelled = false;
  const mod = await load(async () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(65537)); }, cancel() { cancelled = true; } })));
  const controller = mod.createPageController('session-one', locator);
  await controller.open();
  assert.equal(controller.getSnapshot().error, 'tooLarge'); assert.equal(controller.getSnapshot().page, null); assert.equal(cancelled, true);
});

test('close aborts pending request, clears page/cursors and prevents late response resurrection', async () => {
  let resolveFetch, signal;
  const mod = await load((_url, options) => { signal = options.signal; return new Promise(resolve => { resolveFetch = resolve; }); });
  const controller = mod.createPageController('session-one', locator);
  const opening = controller.open();
  controller.close(); assert.equal(signal.aborted, true);
  resolveFetch(Response.json(page())); await opening;
  const state = controller.getSnapshot(); assert.equal(state.open, false); assert.equal(state.page, null); assert.equal(state.previous.length, 0); assert.equal(state.error, null);
});

test('component unmount aborts a pending details request', async () => {
  const runtime = hooks(); let signal;
  const mod = await load((_url, options) => { signal = options.signal; return new Promise(() => {}); }, runtime.React);
  const p = props(runtime.React);
  let tree = runtime.render(mod.ReadRow, p); button(tree, 'toggle').props.onClick(); tree = runtime.render(mod.ReadRow, p);
  button(tree, 'load').props.onClick(); runtime.unmount(); assert.equal(signal.aborted, true);
});

test('changed source revision refuses page mixing and HTTP errors become bounded UI errors', async () => {
  let count = 0;
  const mod = await load(async () => Response.json(page({ revision: ++count === 1 ? 'generation-a' : 'generation-b', nextOffset: count, lines: [{ number: count + 9, text: 'text', textOffset: 0, continued: false }] })));
  const controller = mod.createPageController('session-one', locator); await controller.open(); await controller.next();
  assert.equal(controller.getSnapshot().page, null); assert.equal(controller.getSnapshot().error, 'stale');
  const denied = await load(async () => new Response('private server data', { status: 403 }));
  const deniedController = denied.createPageController('session-one', locator); await deniedController.open();
  assert.equal(deniedController.getSnapshot().error, 'denied');
});

test('formal slot registration binds the read key and both locale dictionaries in owned effects', async () => {
  const mod = await load(); const events = []; let renderer, effect;
  mod.apply({
    effect(fn) { effect = fn; },
    locale: { register(namespace, dicts) { events.push(['locale', namespace, Object.keys(dicts)]); return () => events.push(['locale-disposed']); } },
    slots: {
      inject(owner, fn) { if (owner === 'tool.call.toolview') { events.push(['owner', owner]); fn(); } },
      register(options, component) { events.push(['slot', options.name, options.key, options.locale]); renderer = component; return () => {}; },
    },
  });
  const dispose = effect();
  assert.equal(renderer, mod.ReadRow);
  assert.deepEqual(JSON.parse(JSON.stringify(events)), [
    ['owner', 'tool.call.toolview'], ['slot', 'tool.call.toolview', 'read', 'ptc-disk-history'], ['locale', 'ptc-disk-history', ['zh', 'en']],
  ]);
  dispose(); assert.deepEqual(events.at(-1), ['locale-disposed']);
});

test('UI next/previous buttons re-read pages and collapsing the read row drops details immediately', async () => {
  const runtime = hooks(), offsets = [];
  const mod = await load(async (_url, options) => {
    const { offset } = JSON.parse(options.body); offsets.push(offset);
    return Response.json(page({ lines: [{ number: offset + 10, text: `source ${offset}`, textOffset: 0, continued: false }], nextOffset: offset + 1 }));
  }, runtime.React);
  const p = props(runtime.React);
  let tree = runtime.render(mod.ReadRow, p); button(tree, 'toggle').props.onClick(); tree = runtime.render(mod.ReadRow, p);
  button(tree, 'load').props.onClick(); await flush(); tree = runtime.render(mod.ReadRow, p);
  button(tree, 'next').props.onClick(); await flush(); tree = runtime.render(mod.ReadRow, p);
  assert.equal(nodes(tree).find(n => n.type === 'textarea').props.value, 'source 1');
  button(tree, 'previous').props.onClick(); await flush(); tree = runtime.render(mod.ReadRow, p);
  assert.equal(nodes(tree).find(n => n.type === 'textarea').props.value, 'source 0');
  button(tree, 'toggle').props.onClick(); tree = runtime.render(mod.ReadRow, p);
  assert.equal(nodes(tree).some(n => n.type === 'textarea'), false);
  button(tree, 'toggle').props.onClick(); tree = runtime.render(mod.ReadRow, p);
  assert.ok(button(tree, 'load')); assert.deepEqual(offsets, [0, 1, 0]);
  runtime.unmount();
});

test('invalid request cursor or marker never reaches fetch', async () => {
  let calls = 0; const mod = await load(async () => { calls++; return Response.json(page()); });
  const signal = new AbortController().signal;
  for (const cursor of [{ offset: -1, textOffset: 0 }, { offset: 150, textOffset: 0 }, { offset: 0, textOffset: 100001 }, { offset: 0.5, textOffset: 0 }]) {
    await assert.rejects(mod.loadPage('session-one', locator, cursor, signal), error => error.code === 'invalidPage');
  }
  await assert.rejects(mod.loadPage('', locator, { offset: 0, textOffset: 0 }, signal), error => error.code === 'invalidPage');
  await assert.rejects(mod.loadPage('session-one', { ...locator, version: 2 }, { offset: 0, textOffset: 0 }, signal), error => error.code === 'invalidPage');
  assert.equal(calls, 0);
});



test('plugin manager row config registers idle form and saves selected value with revision', async () => {
  const runtime = hooks();
  const mod = await load(undefined, runtime.React);
  let View, registered, injectOwner;
  mod.apply({
    effect(fn) { fn(); }, locale: { register() { return () => {}; } },
    slots: { inject(owner, fn) { if (owner === 'plugins.row.config') injectOwner = owner; fn(); }, register(options, component) { if (options.name === 'plugins.row.config') { registered = options; View = component; } return () => {}; } },
  });
  assert.equal(injectOwner, 'plugins.row.config');
  assert.equal(registered.key, '@local/dsh-session-memory-manager#session-memory-controller');
  assert.equal(registered.locale, 'session-memory-controller');
  let mutation;
  const form = { state: { status: 'ready', value: { idleReclaimMinutes: 5 }, revision: 12, writable: true }, mutate(ops, revision) { mutation = { ops, revision }; return Promise.resolve(true); } };
  let tree = runtime.render(View, { view: 'summary' });
  assert.equal(nodes(tree).find(n => n.type === 'span')?.props.children.join(''), 'Idle session memory reclaim');
  tree = runtime.render(View, { view: 'page', form });
  const select = nodes(tree).find(n => n.type === 'select');
  assert.ok(select);
  assert.deepEqual(select.props.children.map(option => option.props.value), ['0', '1', '5', '15']);
  assert.equal(select.props.value, '5');
  select.props.onChange({ target: { value: '15' } });
  tree = runtime.render(View, { view: 'page', form });
  const save = nodes(tree).find(n => n.type === 'button' && n.props['data-action'] === 'save-idle-reclaim');
  save.props.onClick(); await flush();
  assert.deepEqual(JSON.parse(JSON.stringify(mutation)), { ops: [{ op: 'set', path: ['idleReclaimMinutes'], value: 15 }], revision: 12 });
  runtime.unmount();
});

test('row config refuses stale or unavailable forms without claiming saved', async () => {
  const runtime = hooks(); const mod = await load(undefined, runtime.React); let View;
  mod.apply({ effect(fn) { fn(); }, locale: { register() { return () => {}; } }, slots: { inject(_owner, fn) { fn(); }, register(options, component) { if (options.name === 'plugins.row.config') View = component; return () => {}; } } });
  let calls = 0;
  const form = { state: { status: 'ready', value: { idleReclaimMinutes: 5 }, revision: 4, writable: true }, mutate() { calls++; return Promise.resolve(false); } };
  let tree = runtime.render(View, { view: 'page', form });
  const select = nodes(tree).find(n => n.type === 'select'); select.props.onChange({ target: { value: '1' } });
  tree = runtime.render(View, { view: 'page', form }); nodes(tree).find(n => n.type === 'button' && n.props['data-action'] === 'save-idle-reclaim').props.onClick(); await flush();
  tree = runtime.render(View, { view: 'page', form });
  assert.equal(calls, 1); assert.equal(nodes(tree).some(n => n.props?.['data-status'] === 'saved'), false);
  tree = runtime.render(View, { view: 'page', form: { state: { status: 'unavailable', value: undefined, revision: undefined, writable: false }, mutate() { throw new Error('must not write'); } } });
  assert.ok(nodes(tree).some(n => n.props?.role === 'status'));
  runtime.unmount();
});
