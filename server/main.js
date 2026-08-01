import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MockBridge } from './bridges/mock-bridge.js';
import { loadConfig } from './config.js';
import { createHttpServer } from './http-server.js';
import { MixerService } from './mixer-service.js';

function environmentInteger(name, fallback, minimum, maximum) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
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
    if (!server.listening) {
      resolvePromise();
      return;
    }
    server.close(() => resolvePromise());
    server.closeAllConnections?.();
  });
}

export async function main() {
  const defaultConfigPath = resolve(fileURLToPath(new URL('../config/band.json', import.meta.url)));
  const configPath = resolve(process.env.CONFIG_PATH || defaultConfigPath);
  const config = await loadConfig(configPath);
  const bridgeMode = (process.env.BRIDGE_MODE || 'mock').toLowerCase();
  if (bridgeMode !== 'mock') {
    throw new Error(
      `Unsupported BRIDGE_MODE "${bridgeMode}". Only "mock" is available; the Max for Live adapter is future work.`,
    );
  }

  const host = process.env.HOST || config.server.host;
  const port = environmentInteger('PORT', config.server.port, 1, 65_535);
  const bridge = new MockBridge(config);
  const service = new MixerService({ config, bridge });
  let shuttingDown = false;
  let bridgeStartInProgress = false;
  let bridgeRetryTimer = null;
  const startBridge = async () => {
    if (shuttingDown || bridgeStartInProgress) return false;
    bridgeStartInProgress = true;
    try {
      await service.start();
      return true;
    } catch (error) {
      console.error(`Ableton bridge unavailable: ${error.message}`);
      return false;
    } finally {
      bridgeStartInProgress = false;
    }
  };
  const bridgeReady = await startBridge();
  const server = createHttpServer({ config, service });
  try {
    await listen(server, port, host);
  } catch (error) {
    await service.stop();
    throw error;
  }

  if (!bridgeReady) {
    bridgeRetryTimer = setInterval(async () => {
      if (await startBridge()) {
        clearInterval(bridgeRetryTimer);
        bridgeRetryTimer = null;
        console.log('Ableton bridge connected after retry');
      }
    }, 2_000);
    bridgeRetryTimer.unref();
  }

  const address = server.address();
  const boundPort = typeof address === 'object' && address ? address.port : port;
  console.log(`Ableton IEM Remote (mock) listening on http://${host}:${boundPort}`);
  console.log(`Configuration: ${configPath}`);

  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Received ${signal}; shutting down`);
    if (bridgeRetryTimer) {
      clearInterval(bridgeRetryTimer);
      bridgeRetryTimer = null;
    }
    await closeServer(server);
    await service.stop();
  };
  process.once('SIGINT', () => shutdown('SIGINT').catch((error) => {
    console.error(error);
    process.exitCode = 1;
  }));
  process.once('SIGTERM', () => shutdown('SIGTERM').catch((error) => {
    console.error(error);
    process.exitCode = 1;
  }));

  return { config, bridge, service, server, shutdown, startBridge };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`Startup failed: ${error.message}`);
    process.exitCode = 1;
  });
}
