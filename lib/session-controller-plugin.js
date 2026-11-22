import {realpathSync} from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';
const FALLBACK_SERVICE = 'dshSessionMemoryNativeFallback';
const REQUIRED_RELEASE = '0.2.2-rc.5';
const CONTROLLER = '@deepseek-ai/dsh-api-session-controller';
const AGENT_LOOP = '@deepseek-ai/dsh-agent-loop';

function resolveHostRequire() {
  let cliRoot;
  try {
    if (process.argv[1]) cliRoot = path.resolve(path.dirname(realpathSync(process.argv[1])), '..');
  } catch {}
  for (const root of [process.env.DSH_INSTALL_DIR, cliRoot]) {
    if (!root) continue;
    const require = createRequire(path.resolve(root, 'package.json'));
    try {
      const manifest = require('./package.json');
      if (manifest.name === '@deepseek-ai/dsh') return {require, manifest};
    } catch {}
  }
  throw new Error('DSH installation not recognized');
}

function inspectHost() {
  const {require, manifest} = resolveHostRequire();
  return {
    versions: {
      dsh: manifest.version,
      controller: require(`${CONTROLLER}/package.json`).version,
      agentLoop: require(`${AGENT_LOOP}/package.json`).version,
    },
    Base: require(CONTROLLER).SessionController,
    cordis: require('@deepseek-ai/cordis'),
    schema: require('@deepseek-ai/schemastery'),
  };
}

function assertRelease({versions}) {
  for (const component of ['dsh', 'controller', 'agentLoop']) {
    if (versions?.[component] !== REQUIRED_RELEASE) {
      throw new Error(`unsupported ${component} release ${versions?.[component] ?? '(unknown)'}; expected ${REQUIRED_RELEASE}`);
    }
  }
}

function createAdapter({Base, cordis, schema}, config) {
  return adapter.createSessionControllerAdapter(Base, cordis, {
    schemastery: schema,
    getIdleReclaimMinutes: () => config?.idleReclaimMinutes?.get?.() ?? config?.idleReclaimMinutes ?? 5,
  });
}

let host, adapter, compatibilityError, configSchema;
try {
  host = inspectHost();
  assertRelease(host);
  adapter = await import('./session-controller-adapter.js');
  createAdapter(host);
  configSchema = adapter.createSessionMemoryConfig(host.Base, host.schema);
} catch (error) {
  compatibilityError = error;
}

export const Config = configSchema;
// Pending replacement dependencies must not prevent fallback on an unknown Host.
export const inject = Config ? host.Base.inject : [];

export async function createSessionMemoryControllerPlugin(ctx, config, options = {}) {
  let child;
  let service;
  try {
    let cordis, Controller;
    if (options.loadHost) {
      const installed = await options.loadHost();
      assertRelease(installed);
      cordis = installed.cordis;
      Controller = options.createAdapter(installed.Base, cordis);
    } else {
      if (compatibilityError) throw compatibilityError;
      cordis = host.cordis;
      Controller = createAdapter(host, config);
    }
    child = ctx.plugin({
      name: 'session-memory-controller-service',
      async apply(scope) {
        service = new Controller(scope, config);
        await service[cordis.Service.init]();
      },
    }, {});
    await child;
  } catch (error) {
    // An init failure may have registered a controller or other owned effects.
    // Wait for their teardown before the native row can provide the same key.
    await child?.dispose();
    ctx.provide(FALLBACK_SERVICE, true);
    ctx.logger?.warn?.(`session memory replacement unavailable; using the native controller: ${error?.message ?? error}`);
    return;
  }

  // Cordis owns both the child and this listener. Successful teardown never
  // publishes the standby token; switching providers requires a cold start.
  ctx.on('loader/volatile-update', paths => {
    if (paths.some(path => path[0] === 'idleReclaimMinutes')) service.refreshIdleReclaim?.();
  });
}

export async function apply(ctx, config) {
  ctx.inject(['settings'], child => {
    child.effect(() => child.settings.configure({auto: false}, ctx.fiber));
  });
  await createSessionMemoryControllerPlugin(ctx, config);
}
