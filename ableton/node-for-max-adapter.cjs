'use strict';

/*
 * Node-for-Max application bootstrap.
 *
 * `max-api` is supplied by Max's node.script object. The normal mock server
 * never imports this file, so the repository remains dependency-free outside
 * Max. JSON messages are the only boundary between Node and the Max Live API
 * controller:
 *
 *   Node -> Max: iem.command <one JSON object>
 *   Max -> Node: iem.event   <one JSON object>
 */

const { EventEmitter } = require('node:events');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const maxApi = require('max-api');

const PROTOCOL_NAME = 'iem-remote';
const PROTOCOL_VERSION = 1;
const REPOSITORY_ROOT = path.resolve(__dirname, '..');
const DEFAULT_CONFIG_PATH = path.join(REPOSITORY_ROOT, 'config', 'band.json');
const DEFAULT_HOST = '0.0.0.0';
const DEFAULT_PORT = 3000;
const DEFAULT_REQUEST_TIMEOUT_MS = 3_000;
const DEFAULT_BRIDGE_RETRY_MS = 2_000;

let diagnosticSequence = 0;

function nextDiagnosticRequestId() {
  diagnosticSequence += 1;
  return `adapter-${diagnosticSequence}`;
}

function protocolMessage(message) {
  return {
    protocol: PROTOCOL_NAME,
    version: PROTOCOL_VERSION,
    ...message,
  };
}

function decodeMessage(atoms) {
  const text = atoms.map(String).join(' ');
  const message = JSON.parse(text);
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    throw new TypeError('Max event must decode to a JSON object');
  }
  if (message.protocol !== PROTOCOL_NAME || message.version !== PROTOCOL_VERSION) {
    throw new Error(
      `Unsupported protocol envelope ${String(message.protocol)}/${String(message.version)}`,
    );
  }
  return message;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function post(message, level = maxApi.POST_LEVELS.INFO) {
  maxApi.post(`[iem-remote] ${message}`, level);
}

function postError(context, error) {
  post(`${context}: ${errorMessage(error)}`, maxApi.POST_LEVELS.ERROR);
}

function resolveConfigPath(rawPath) {
  if (!rawPath) return DEFAULT_CONFIG_PATH;
  return path.isAbsolute(rawPath)
    ? path.normalize(rawPath)
    : path.resolve(REPOSITORY_ROOT, rawPath);
}

function environmentInteger(name, fallback, minimum, maximum) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function importRepositoryModule(relativePath) {
  return import(pathToFileURL(path.join(REPOSITORY_ROOT, relativePath)).href);
}

function listen(server, port, host) {
  return new Promise((resolvePromise, reject) => {
    const onError = (error) => reject(error);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      resolvePromise();
    });
  });
}

function closeServer(server) {
  return new Promise((resolvePromise) => {
    if (!server || !server.listening) {
      resolvePromise();
      return;
    }
    server.close(() => resolvePromise());
    server.closeAllConnections?.();
  });
}

/**
 * Transport consumed by server/bridges/max-bridge.js.
 *
 * MaxBridge calls send(command) and subscribes to the `message` event. The
 * adapter validates framing in both directions; semantic validation remains in
 * MaxBridge and the Live API controller.
 */
class MaxApiTransport extends EventEmitter {
  send(command) {
    if (!command || typeof command !== 'object' || Array.isArray(command)) {
      throw new TypeError('Max command must be an object');
    }
    maxApi.outlet('iem.command', JSON.stringify(command));
  }

  receive(atoms) {
    this.emit('message', decodeMessage(atoms));
  }
}

const transport = new MaxApiTransport();

const runtime = {
  state: 'stopped',
  desiredRunning: false,
  startPromise: null,
  stopPromise: null,
  bridgeOperationPromise: null,
  bridgeRetryTimer: null,
  bridgeRetryMs: DEFAULT_BRIDGE_RETRY_MS,
  configPath: null,
  host: null,
  port: null,
  boundPort: null,
  config: null,
  bridge: null,
  service: null,
  server: null,
  onServiceStatus: null,
  lastError: null,
};

function diagnosticPayload(reason) {
  const bridge = runtime.service?.getStatus?.()
    ?? runtime.bridge?.getStatus?.()
    ?? { state: 'stopped', connected: false };
  return protocolMessage({
    type: 'adapter-status',
    state: runtime.state,
    running: runtime.state === 'running',
    reason,
    bridge,
    retrying: runtime.bridgeRetryTimer !== null,
    ...(runtime.host ? { host: runtime.host } : {}),
    ...(runtime.boundPort ? { port: runtime.boundPort } : {}),
    ...(runtime.host && runtime.boundPort
      ? { url: `http://${runtime.host}:${runtime.boundPort}` }
      : {}),
    ...(runtime.configPath ? { configPath: runtime.configPath } : {}),
    ...(runtime.lastError ? { message: runtime.lastError } : {}),
  });
}

function emitDiagnostic(reason) {
  maxApi.outlet('iem.adapter-status', JSON.stringify(diagnosticPayload(reason)));
}

function clearBridgeRetry() {
  if (!runtime.bridgeRetryTimer) return;
  clearTimeout(runtime.bridgeRetryTimer);
  runtime.bridgeRetryTimer = null;
}

function scheduleBridgeRetry(reason) {
  if (!runtime.desiredRunning || runtime.state !== 'running' || runtime.bridgeRetryTimer) {
    return;
  }
  runtime.bridgeRetryTimer = setTimeout(() => {
    runtime.bridgeRetryTimer = null;
    void connectBridge({ forceRestart: true, reason: 'automatic retry' });
  }, runtime.bridgeRetryMs);
  runtime.bridgeRetryTimer.unref?.();
  post(`Ableton bridge unavailable; retrying in ${runtime.bridgeRetryMs} ms`, maxApi.POST_LEVELS.WARN);
  emitDiagnostic(reason);
}

async function connectBridge({ forceRestart = false, reason = 'startup' } = {}) {
  if (!runtime.desiredRunning || runtime.state !== 'running' || !runtime.service) return false;
  if (runtime.bridgeOperationPromise) return runtime.bridgeOperationPromise;

  clearBridgeRetry();
  // Defer the body one microtask so bridge status events emitted synchronously
  // by service.stop()/start() see bridgeOperationPromise and do not schedule a
  // second, overlapping recovery.
  const operation = Promise.resolve().then(async () => {
    try {
      if (forceRestart) await runtime.service.stop();
      await runtime.service.start();
      runtime.lastError = null;
      clearBridgeRetry();
      post(`Ableton bridge connected (${reason})`);
      emitDiagnostic('bridge connected');
      return true;
    } catch (error) {
      runtime.lastError = errorMessage(error);
      post(`Ableton bridge connection failed: ${runtime.lastError}`, maxApi.POST_LEVELS.WARN);
      return false;
    }
  });
  runtime.bridgeOperationPromise = operation;

  let connected = false;
  try {
    connected = await operation;
    return connected;
  } finally {
    if (runtime.bridgeOperationPromise === operation) runtime.bridgeOperationPromise = null;
    if (!connected) scheduleBridgeRetry('bridge retry scheduled');
  }
}

async function loadApplicationModules() {
  const [configModule, bridgeModule, serviceModule, httpModule] = await Promise.all([
    importRepositoryModule('server/config.js'),
    importRepositoryModule('server/bridges/max-bridge.js'),
    importRepositoryModule('server/mixer-service.js'),
    importRepositoryModule('server/http-server.js'),
  ]);
  return {
    loadConfig: configModule.loadConfig,
    MaxBridge: bridgeModule.MaxBridge,
    MixerService: serviceModule.MixerService,
    createHttpServer: httpModule.createHttpServer,
  };
}

async function startRuntime(reason = 'manual start') {
  runtime.desiredRunning = true;
  if (runtime.state === 'running') {
    emitDiagnostic('already running');
    return runtime;
  }
  if (runtime.startPromise) return runtime.startPromise;
  if (runtime.stopPromise) await runtime.stopPromise;

  runtime.startPromise = (async () => {
    runtime.state = 'starting';
    runtime.lastError = null;
    emitDiagnostic(reason);

    try {
      const { loadConfig, MaxBridge, MixerService, createHttpServer } = await loadApplicationModules();
      runtime.configPath = resolveConfigPath(process.env.CONFIG_PATH);
      runtime.bridgeRetryMs = environmentInteger(
        'BRIDGE_RETRY_MS',
        DEFAULT_BRIDGE_RETRY_MS,
        250,
        60_000,
      );
      const requestTimeoutMs = environmentInteger(
        'MAX_REQUEST_TIMEOUT_MS',
        DEFAULT_REQUEST_TIMEOUT_MS,
        250,
        60_000,
      );

      runtime.config = await loadConfig(runtime.configPath);
      runtime.host = process.env.HOST || runtime.config.server.host || DEFAULT_HOST;
      runtime.port = environmentInteger(
        'PORT',
        runtime.config.server.port || DEFAULT_PORT,
        1,
        65_535,
      );
      runtime.bridge = new MaxBridge({
        config: runtime.config,
        transport,
        requestTimeoutMs,
      });
      runtime.service = new MixerService({
        config: runtime.config,
        bridge: runtime.bridge,
      });
      runtime.onServiceStatus = (status) => {
        emitDiagnostic('bridge status changed');
        if (
          runtime.desiredRunning
          && runtime.state === 'running'
          && status?.connected !== true
          && status?.state !== 'connecting'
          && !runtime.bridgeOperationPromise
        ) {
          scheduleBridgeRetry('bridge disconnected');
        }
      };
      runtime.service.on('status', runtime.onServiceStatus);

      runtime.server = createHttpServer({
        config: runtime.config,
        service: runtime.service,
      });
      await listen(runtime.server, runtime.port, runtime.host);
      const address = runtime.server.address();
      runtime.boundPort = typeof address === 'object' && address ? address.port : runtime.port;
      runtime.state = 'running';
      post(`web server listening on http://${runtime.host}:${runtime.boundPort}`);
      post(`configuration: ${runtime.configPath}`);
      emitDiagnostic('web server started');

      // Do not hold up the web server while Live is closed, loading, or has a
      // temporarily invalid mapping. MixerService.start() is retried as a unit.
      void connectBridge({ reason: 'server startup' });
      return runtime;
    } catch (error) {
      runtime.lastError = errorMessage(error);
      runtime.state = 'error';
      if (runtime.service && runtime.onServiceStatus) {
        runtime.service.off('status', runtime.onServiceStatus);
      }
      await closeServer(runtime.server);
      try {
        await runtime.service?.stop?.();
      } catch (cleanupError) {
        postError('startup cleanup failed', cleanupError);
      }
      runtime.server = null;
      runtime.service = null;
      runtime.bridge = null;
      runtime.onServiceStatus = null;
      runtime.boundPort = null;
      emitDiagnostic('startup failed');
      throw error;
    }
  })();

  try {
    return await runtime.startPromise;
  } finally {
    runtime.startPromise = null;
  }
}

async function stopRuntime(reason = 'manual stop') {
  runtime.desiredRunning = false;
  if (runtime.stopPromise) return runtime.stopPromise;
  if (runtime.startPromise) {
    try {
      await runtime.startPromise;
    } catch {
      // The failed start already performed its own cleanup.
    }
  }
  if (runtime.state === 'stopped') {
    emitDiagnostic('already stopped');
    return;
  }

  runtime.stopPromise = (async () => {
    runtime.state = 'stopping';
    clearBridgeRetry();
    emitDiagnostic(reason);
    await closeServer(runtime.server);
    if (runtime.bridgeOperationPromise) {
      try {
        await runtime.bridgeOperationPromise;
      } catch {
        // Its error is already reported by connectBridge().
      }
    }
    try {
      await runtime.service?.stop?.();
    } finally {
      if (runtime.service && runtime.onServiceStatus) {
        runtime.service.off('status', runtime.onServiceStatus);
      }
      runtime.server = null;
      runtime.service = null;
      runtime.bridge = null;
      runtime.config = null;
      runtime.onServiceStatus = null;
      runtime.boundPort = null;
      runtime.bridgeOperationPromise = null;
      runtime.lastError = null;
      runtime.state = 'stopped';
      post(`server stopped (${reason})`);
      emitDiagnostic('server stopped');
    }
  })();

  try {
    await runtime.stopPromise;
  } finally {
    runtime.stopPromise = null;
  }
}

async function rescanRuntime() {
  if (runtime.state !== 'running') await startRuntime('rescan requested while stopped');
  if (runtime.state !== 'running') return false;
  post('rescanning Ableton mappings');
  if (runtime.bridgeOperationPromise) await runtime.bridgeOperationPromise;
  const connected = await connectBridge({ forceRestart: true, reason: 'manual rescan' });
  emitDiagnostic(connected ? 'rescan completed' : 'rescan failed');
  return connected;
}

function runHandler(context, action) {
  Promise.resolve()
    .then(action)
    .catch((error) => {
      runtime.lastError = errorMessage(error);
      postError(context, error);
      emitDiagnostic(`${context} failed`);
    });
}

maxApi.addHandler('iem.event', (...atoms) => {
  try {
    transport.receive(atoms);
  } catch (error) {
    postError('invalid iem.event', error);
  }
});

maxApi.addHandler('iem.server.start', () => {
  runHandler('server start', () => startRuntime('manual start'));
});

maxApi.addHandler('iem.server.stop', () => {
  runHandler('server stop', () => stopRuntime('manual stop'));
});

maxApi.addHandler('iem.server.rescan', () => {
  runHandler('Ableton rescan', rescanRuntime);
});

maxApi.addHandler('iem.server.status', () => emitDiagnostic('status requested'));

/* Backward-compatible wiring diagnostics retained for editable patch testing. */
maxApi.addHandler('iem.transport.ping', () => {
  transport.send({
    protocol: PROTOCOL_NAME,
    version: PROTOCOL_VERSION,
    type: 'ping',
    requestId: nextDiagnosticRequestId(),
  });
});
maxApi.addHandler('iem.transport.status', () => emitDiagnostic('transport status requested'));

function handleSignal(signal) {
  runHandler(`${signal} shutdown`, () => stopRuntime(signal));
}

process.once('SIGINT', () => handleSignal('SIGINT'));
process.once('SIGTERM', () => handleSignal('SIGTERM'));

post('Node-for-Max adapter loaded; starting web server');
runHandler('automatic server start', () => startRuntime('node.script autostart'));
