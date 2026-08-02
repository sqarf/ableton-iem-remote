import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(testDirectory, '..');
const adapterPath = resolve(repositoryRoot, 'ableton/node-for-max-adapter.cjs');
const fixturePath = resolve(testDirectory, 'fixtures');

function reservePort() {
  const server = createServer();
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address.port;
      server.close((error) => (error ? reject(error) : resolvePromise(port)));
    });
  });
}

function createMessageLog(child) {
  const messages = [];
  const waiters = new Set();
  child.on('message', (message) => {
    messages.push(message);
    for (const wake of waiters) wake();
  });

  async function waitFrom(startIndex, predicate, timeoutMs = 4_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const match = messages.slice(startIndex).find(predicate);
      if (match) return match;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(
          `Timed out waiting for Node-for-Max fixture output; recent messages: ${
            JSON.stringify(messages.slice(-8))
          }`,
        );
      }
      await new Promise((resolvePromise, reject) => {
        const timer = setTimeout(() => {
          waiters.delete(wake);
          reject(new Error(
            `Timed out waiting for Node-for-Max fixture output; recent messages: ${
              JSON.stringify(messages.slice(-8))
            }`,
          ));
        }, remaining);
        const wake = () => {
          clearTimeout(timer);
          waiters.delete(wake);
          resolvePromise();
        };
        waiters.add(wake);
      });
    }
  }

  return {
    get length() {
      return messages.length;
    },
    waitFrom,
  };
}

function adapterStatus(message) {
  if (message?.type !== 'outlet' || message.selector !== 'iem.adapter-status') return null;
  try {
    return JSON.parse(message.payload);
  } catch {
    return null;
  }
}

test('Node-for-Max bootstrap serves the real stack and survives a full rescan', async (t) => {
  const port = await reservePort();
  const child = fork(adapterPath, [], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      NODE_PATH: fixturePath,
      HOST: '127.0.0.1',
      PORT: String(port),
      BRIDGE_RETRY_MS: '250',
      MAX_REQUEST_TIMEOUT_MS: '500',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const log = createMessageLog(child);
  let standardError = '';
  child.stderr.on('data', (chunk) => {
    standardError += chunk;
  });
  t.after(async () => {
    if (child.exitCode !== null) return;
    child.send({ type: 'exit' });
    await Promise.race([
      once(child, 'exit'),
      new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000)),
    ]);
    if (child.exitCode === null) child.kill('SIGKILL');
  });

  let connectedMessage;
  try {
    connectedMessage = await log.waitFrom(0, (message) => {
      const status = adapterStatus(message);
      return status?.reason === 'bridge connected' && status.bridge?.connected === true;
    });
  } catch (error) {
    throw new Error(`${error.message}; child stderr: ${standardError || '(empty)'}`, {
      cause: error,
    });
  }
  const connected = adapterStatus(connectedMessage);
  assert.equal(connected.protocol, 'iem-remote');
  assert.equal(connected.version, 1);
  assert.equal(connected.port, port);
  assert.equal(standardError, '');

  const baseUrl = `http://127.0.0.1:${port}`;
  const health = await fetch(`${baseUrl}/api/health`).then((response) => response.json());
  assert.equal(health.ok, true);

  const writeResponse = await fetch(
    `${baseUrl}/api/members/vocalist/mixes/vocalist/sources/vocal-1`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: 0.61 }),
    },
  );
  assert.equal(writeResponse.status, 200);
  assert.equal((await writeResponse.json()).value, 0.61);

  const forbiddenResponse = await fetch(
    `${baseUrl}/api/members/vocalist/mixes/drummer/sources/vocal-1`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: 0.2 }),
    },
  );
  assert.equal(forbiddenResponse.status, 403);

  child.send({
    type: 'external-level',
    mixId: 'vocalist',
    sourceId: 'vocal-1',
    value: 0.58,
  });
  let observedState;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    observedState = await fetch(
      `${baseUrl}/api/members/vocalist/mixes/vocalist/state`,
    ).then((response) => response.json());
    if (observedState.levels?.['vocal-1'] === 0.58) break;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  assert.equal(observedState.levels['vocal-1'], 0.58);

  const rescanStart = log.length;
  child.send({ type: 'invoke', selector: 'iem.server.rescan' });
  const secondResolve = await log.waitFrom(rescanStart, (message) => {
    if (message?.type !== 'outlet' || message.selector !== 'iem.command') return false;
    return JSON.parse(message.payload).type === 'resolve';
  });
  assert.equal(JSON.parse(secondResolve.payload).protocol, 'iem-remote');
  await log.waitFrom(rescanStart, (message) => {
    const status = adapterStatus(message);
    return status?.reason === 'rescan completed' && status.bridge?.connected === true;
  });

  const recoveredState = await fetch(
    `${baseUrl}/api/members/vocalist/mixes/vocalist/state`,
  ).then((response) => response.json());
  assert.equal(recoveredState.levels['vocal-1'], 0.58);

  const automaticRecoveryStart = log.length;
  child.send({ type: 'disconnect' });
  await log.waitFrom(automaticRecoveryStart, (message) => {
    if (message?.type !== 'outlet' || message.selector !== 'iem.command') return false;
    return JSON.parse(message.payload).type === 'resolve';
  });
  await log.waitFrom(automaticRecoveryStart, (message) => {
    const status = adapterStatus(message);
    return status?.reason === 'bridge connected' && status.bridge?.connected === true;
  });
  const automaticallyRecovered = await fetch(
    `${baseUrl}/api/members/vocalist/mixes/vocalist/state`,
  ).then((response) => response.json());
  assert.equal(automaticallyRecovered.levels['vocal-1'], 0.58);
});
