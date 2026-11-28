import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';

import {fileURLToPath, pathToFileURL} from 'node:url';

const supportedVersions = {dsh: '0.2.2-rc.5', controller: '0.2.2-rc.5', agentLoop: '0.2.2-rc.5'};
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(process.env.DSH_INSTALL_DIR, 'package.json'));
const yaml = require('js-yaml');
const patchSchema = yaml.DEFAULT_SCHEMA.extend([
  new yaml.Type('tag:yaml.org,2002:js', {kind: 'scalar', construct: expr => ({__jsExpr: expr})}),
]);

async function readJson(file) {
  return JSON.parse(await fs.readFile(path.join(root, file), 'utf8'));
}

async function readPatch() {
  return yaml.load(await fs.readFile(path.join(root, 'cordis.patch.yml'), 'utf8'), {schema: patchSchema});
}

test('alpha5 is a private single bundle with the renamed session controller export', async () => {
  const manifest = await readJson('package.json');
  assert.equal(manifest.name, '@local/dsh-session-memory-manager');
  assert.equal(manifest.version, '0.1.0-alpha.5');
  assert.equal(manifest.private, true);
  assert.deepEqual(manifest.repository, {
    type: 'git',
    url: 'git+https://github.com/deepmean/dsh-session-memory-manager.git',
  });
  assert.equal(manifest.exports['./session-controller'], './lib/session-controller-plugin.js');
  assert.ok(manifest.exports['./locale/*.json']);
  assert.ok(manifest.exports['./icon']);
  assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml');
  assert.ok(manifest.dsh?.client?.inject?.includes('@deepseek-ai/dsh-client-ui-plugin-manager'));
  assert.equal(manifest.dependencies?.['@deepseek-ai/dsh-client-ui-plugin-manager'], undefined);
});

test('composition keeps the native row and gates it behind the fallback provider', async () => {
  const patch = await readPatch();
  const native = patch.find(row => row.id === 'session-controller');
  assert.ok(native, 'native session-controller row must remain addressable');
  assert.notEqual(native.disabled, true, 'native row must not be disabled');
  assert.deepEqual(native.inject, ['dshSessionMemoryNativeFallback']);

  const inserted = patch.find(row => Array.isArray(row.insert));
  const replacement = inserted?.insert?.find(row => row.id === 'session-memory-controller');
  assert.ok(replacement, 'replacement row must be inserted separately');
  assert.equal(replacement.name, '@local/dsh-session-memory-manager/session-controller');
  assert.notEqual(replacement.disabled, true);
  assert.deepEqual(replacement.config, {idleReclaimMinutes: 5});
  assert.equal(inserted.insert.filter(row => row.id === 'session-memory-controller').length, 1);
});

test('the real Loader keeps the native Client artifact while the native Host row waits on the fallback token', async () => {
  const cordis = require('@deepseek-ai/cordis');
  const loaderModule = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis-plugin-loader')).href);
  const clientModule = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-client-modules')).href);
  const ctx = new cordis.Context();
  ctx.baseUrl = pathToFileURL(path.join(process.env.DSH_INSTALL_DIR, path.sep)).href;
  try {
    await ctx.plugin(loaderModule.default).await();
    const patch = await readPatch();
    const native = patch.find(row => row.id === 'session-controller');
    const id = await ctx.loader.create({...native, name: '@deepseek-ai/dsh-api-session-controller'});
    const entry = ctx.loader.resolve(id);
    assert.equal(entry.disabled, false);
    assert.equal(entry.fiber?.state, 0);
    assert.equal(ctx.get('sessionController'), undefined);
    await ctx.plugin(clientModule.default).await();
    await new Promise(resolve => setImmediate(resolve));
    assert.match(ctx.clientModules.clientPath('@deepseek-ai/dsh-api-session-controller') ?? '', /client\.js$/);
    let sidecar;
    ctx.provide('typert', {register(manifest) { sidecar = manifest; return () => {}; }});
    await ctx.plugin(require('@deepseek-ai/dsh-typert-loader'), {}).await();
    assert.deepEqual(sidecar, require('@deepseek-ai/dsh-api-session-controller/typert').TYPERT);
    assert.ok(sidecar);

    const fallback = await ctx.plugin({apply(fallbackCtx) {
      fallbackCtx.provide('dshSessionMemoryNativeFallback', true);
    }}).await();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(entry.disabled, false);
    assert.ok(entry.fiber);
    assert.match(ctx.clientModules.clientPath('@deepseek-ai/dsh-api-session-controller') ?? '', /client\.js$/);
    await fallback.dispose();
    await entry.update({disabled: true});
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(ctx.clientModules.clientPath('@deepseek-ai/dsh-api-session-controller'), undefined);
  } finally {
    await ctx.fiber.dispose();
  }
});

test('disposing a successful Loader row does not hand off to native', async () => {
  const plugin = await import('../lib/session-controller-plugin.js');
  const {SessionController} = require('@deepseek-ai/dsh-api-session-controller');
  const cordis = require('@deepseek-ai/cordis');
  const {Loader} = require('@deepseek-ai/cordis-plugin-loader');
  const clientModule = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-client-modules')).href);
  const ctx = new cordis.Context();
  ctx.baseUrl = pathToFileURL(path.join(process.env.DSH_INSTALL_DIR, path.sep)).href;
  let nativeStarts = 0;
  let sidecar;
  class Replacement extends cordis.Service {
    constructor(child) { super(child, 'sessionController'); }
    [cordis.Service.init]() {}
  }
  try {
    await ctx.plugin(Loader).await();
    await ctx.plugin(clientModule.default).await();
    ctx.loader.builtins.memory = {apply: (scope, config) => plugin.createSessionMemoryControllerPlugin(scope, config, {
      loadHost: async () => ({cordis, versions: supportedVersions}),
      createAdapter: () => Replacement,
    })};
    provideControllerDependencies(ctx, SessionController, () => nativeStarts++, manifest => {
      sidecar = manifest;
      return () => { sidecar = undefined; };
    });
    const patch = await readPatch();
    const native = patch.find(row => row.id === 'session-controller');
    const replacement = patch.flatMap(row => row.insert ?? []).find(row => row.id === 'session-memory-controller');
    await ctx.loader.create({...native, name: '@deepseek-ai/dsh-api-session-controller'});
    await ctx.loader.create({...replacement, name: 'cordis:memory'});
    const nativeRow = ctx.loader.resolve(native.id);
    const replacementRow = ctx.loader.resolve(replacement.id);
    await ctx.loader.await();
    await ctx.plugin(require('@deepseek-ai/dsh-typert-loader'), {}).await();
    const manifest = require('@deepseek-ai/dsh-api-session-controller/typert').TYPERT;
    assert.ok(ctx.get('sessionController') instanceof Replacement, JSON.stringify(ctx.logger.buffer.flatMap(({args}) => args.map(value => value?.stack ?? value))));
    assert.equal(nativeRow.fiber.state, 0);
    const nativeClient = ctx.clientModules.clientPath('@deepseek-ai/dsh-api-session-controller');
    assert.match(nativeClient ?? '', /client\.js$/);
    assert.equal(sidecar, manifest, 'native Typert manifest remains registered');

    // This is a teardown invariant, not a supported hot rollback procedure.
    await replacementRow.update({disabled: true});
    await ctx.loader.await();
    assert.equal(ctx.get('dshSessionMemoryNativeFallback', false), undefined, 'no token may outlive the row');
    assert.equal(ctx.get('sessionController', false), undefined);
    assert.equal(nativeRow.fiber.state, 0);
    assert.equal(nativeStarts, 0);
    assert.equal(ctx.clientModules.clientPath('@deepseek-ai/dsh-api-session-controller'), nativeClient);
    assert.equal(sidecar, manifest, 'native Typert manifest remains registered after replacement unload');

    await replacementRow.update({disabled: false});
    await ctx.loader.await();
    assert.ok(ctx.get('sessionController') instanceof Replacement);
    assert.equal(nativeStarts, 0);
  } finally {
    await ctx.fiber.dispose();
    assert.equal(nativeStarts, 0, 'full Host teardown does not start the standby provider');
  }
  assert.equal(ctx.get('dshSessionMemoryNativeFallback', false), undefined);
  assert.equal(ctx.get('sessionController', false), undefined);
  assert.deepEqual(ctx.logger.buffer.filter(({type}) => type === 'error').flatMap(({args}) => args), []);
});

function provideControllerDependencies(ctx, Base, onProjectionRegistered = () => {}, registerSidecar) {
  const register = () => () => {};
  const services = {
    typert: {register: registerSidecar, resources: {register}, lookups: {configure: register}, contexts: {configureHost: register}},
    fileUploads: {registerAgentResolver: register},
    sessionProjections: {register(definition) {
      if (definition.key === 'sessionListMetadata') onProjectionRegistered();
      return register();
    }, onEventChanged: register},
  };
  for (const name of Base.inject) ctx.provide(name, services[name] ?? {});
}

test('version gate admits mocked newer DSH releases above the API baseline', async () => {
  const module = await import('../lib/session-controller-plugin.js');
  const cordis = require('@deepseek-ai/cordis');
  const {SessionController} = require('@deepseek-ai/dsh-api-session-controller');
  const {Loader} = require('@deepseek-ai/cordis-plugin-loader');
  const ctx = new cordis.Context();
  ctx.baseUrl = pathToFileURL(path.join(process.env.DSH_INSTALL_DIR, path.sep)).href;
  class Replacement extends cordis.Service {
    constructor(child) { super(child, 'sessionController'); }
    [cordis.Service.init]() {}
  }
  try {
    await ctx.plugin(Loader).await();
    ctx.loader.builtins.memory = {apply: (scope, config) => module.createSessionMemoryControllerPlugin(scope, config, {
      loadHost: async () => ({cordis, Base: SessionController, versions: {
        dsh: '0.2.3-alpha.2', controller: '0.2.3-alpha.2', agentLoop: '0.2.3-alpha.2',
      }}),
      createAdapter: () => Replacement,
    })};
    provideControllerDependencies(ctx, SessionController);
    const patch = await readPatch();
    const native = patch.find(row => row.id === 'session-controller');
    const replacement = patch.flatMap(row => row.insert ?? []).find(row => row.id === 'session-memory-controller');
    await ctx.loader.create({...native, name: '@deepseek-ai/dsh-api-session-controller'});
    await ctx.loader.create({...replacement, name: 'cordis:memory'});
    await ctx.loader.await();
    assert.ok(ctx.get('sessionController') instanceof Replacement);
    assert.equal(ctx.get('dshSessionMemoryNativeFallback', false), undefined);
  } finally {
    await ctx.fiber.dispose();
  }
});
test('the CLI-relative replacement retains its service across Loader idle-setting updates', async t => {
  const installDir = process.env.DSH_INSTALL_DIR;
  const oldArg = process.argv[1];
  t.after(() => {
    process.env.DSH_INSTALL_DIR = installDir;
    process.argv[1] = oldArg;
  });
  delete process.env.DSH_INSTALL_DIR;
  process.argv[1] = path.join(installDir, require('./package.json').bin.dsh);
  const plugin = await import('../lib/session-controller-plugin.js?cli-relative-live');
  assert.equal(plugin.Config?.({}).idleReclaimMinutes.get(), 5);
  const {SessionController} = require('@deepseek-ai/dsh-api-session-controller');
  const {remoteMethods} = require('@deepseek-ai/dsh-typert-protocol');
  const {Context, symbols} = require('@deepseek-ai/cordis');
  const {Loader} = require('@deepseek-ai/cordis-plugin-loader');
  const ctx = new Context();
  let settingsRegistration;
  try {
    await ctx.plugin(Loader).await();
    ctx.loader.builtins.memory = plugin;
    ctx.loader.builtins.native = SessionController;
    provideControllerDependencies(ctx, SessionController);
    ctx.provide('settings', {configure(options, owner) {
      settingsRegistration = {options, owner};
      return () => {};
    }});
    const patch = await readPatch();
    const native = patch.find(row => row.id === 'session-controller');
    const replacement = patch.flatMap(row => row.insert ?? []).find(row => row.id === 'session-memory-controller');
    await ctx.loader.create({...native, name: 'cordis:native'});
    await ctx.loader.create({...replacement, name: 'cordis:memory', config: {idleReclaimMinutes: 1, nativeOpen: false}});
    await ctx.loader.await();
    const row = ctx.loader.resolve(replacement.id);
    const service = ctx.get('sessionController');
    assert.equal(ctx.loader.resolve(native.id).fiber.state, 0, JSON.stringify(ctx.logger.buffer.flatMap(({args}) => args.map(value => value?.stack ?? value))));
    assert.equal(ctx.get('dshSessionMemoryNativeFallback'), undefined);
    assert.ok(service instanceof SessionController);
    assert.notEqual(service.constructor, SessionController);
    assert.equal(service.canOpenWorkspacePath(), false);
    assert.equal(remoteMethods(service).length, 25);
    assert.deepEqual(settingsRegistration, {options: {auto: false}, owner: row.fiber.ctx.fiber});
    const updates = [];
    const refresh = service.refreshIdleReclaim;
    service.refreshIdleReclaim = function () { updates.push(row.fiber.effectiveConfig.idleReclaimMinutes.get()); return refresh.call(this); };
    assert.equal(row.fiber.effectiveConfig.idleReclaimMinutes.get(), 1);
    for (const minutes of [5, 15, 0]) {
      await row.update({config: {idleReclaimMinutes: minutes, nativeOpen: false}});
      assert.equal(ctx.get('sessionController')[symbols.original], service[symbols.original]);
    }
    assert.deepEqual(updates, [5, 15, 0]);
  } finally {
    await ctx.fiber.dispose();
  }
});

for (const [mode, overrides] of [
  ['failed-init', {}], ['unsupported', {agentLoop: '0.2.2-rc.4'}],
]) {
  test(`real Loader starts native exactly once on ${mode} boot`, {timeout: 5000}, async () => {
    const module = await import('../lib/session-controller-plugin.js');
    const cordis = require('@deepseek-ai/cordis');
    const {SessionController} = require('@deepseek-ai/dsh-api-session-controller');
    const {Loader} = require('@deepseek-ai/cordis-plugin-loader');
    const ctx = new cordis.Context();
    ctx.baseUrl = pathToFileURL(path.join(process.env.DSH_INSTALL_DIR, path.sep)).href;
    const observations = [];
    const disposing = Promise.withResolvers();
    const release = Promise.withResolvers();
    let adapterAttempts = 0;
    class Replacement extends cordis.Service {
      constructor(child) { super(child, 'sessionController'); }
      async [cordis.Service.init]() {
        this.ctx.effect(() => async () => {
          disposing.resolve(true);
          await release.promise;
          observations.push('replacement disposed');
        });
        throw new Error('injected mount failure');
      }
    }
    try {
      await ctx.plugin(Loader).await();
      ctx.loader.builtins.memory = {apply: (scope, config) => module.createSessionMemoryControllerPlugin(scope, config, {
        loadHost: async () => ({cordis, versions: {...supportedVersions, ...overrides}}),
        createAdapter: () => { adapterAttempts++; return Replacement; },
      })};
      provideControllerDependencies(ctx, SessionController);
      const patch = await readPatch();
      const native = patch.find(row => row.id === 'session-controller');
      const replacement = patch.flatMap(row => row.insert ?? []).find(row => row.id === 'session-memory-controller');
      await ctx.loader.create({...native, config: {nativeOpen: true}});
      await ctx.loader.create({...replacement, name: 'cordis:memory'});
      const owner = ctx.loader.resolve(replacement.id).fiber;
      const nativeEntry = ctx.loader.resolve(native.id);
      if (mode === 'failed-init') {
        assert.equal(await Promise.race([disposing.promise, owner.await().then(() => false)]), true);
        assert.equal(ctx.get('dshSessionMemoryNativeFallback', false), undefined);
        assert.equal(nativeEntry.fiber.state, 0);
        release.resolve();
      }
      await ctx.loader.await();
      assert.equal(adapterAttempts, mode === 'failed-init' ? 1 : 0);
      assert.equal(owner.state, 2, 'the replacement row owns the fallback token while active');
      assert.equal(ctx.get('dshSessionMemoryNativeFallback'), true);
      assert.equal(nativeEntry.fiber.state, 2);
      assert.equal(ctx.get('sessionController')?.[cordis.symbols.original]?.constructor, SessionController);
      assert.equal(ctx.get('sessionController').canOpenWorkspacePath(), true);
      assert.deepEqual(observations, mode === 'failed-init' ? ['replacement disposed'] : []);
    } finally {
      release.resolve();
      await ctx.fiber.dispose();
    }
    assert.equal(ctx.get('sessionController', false), undefined);
    assert.equal(ctx.get('dshSessionMemoryNativeFallback', false), undefined);
  });
}
