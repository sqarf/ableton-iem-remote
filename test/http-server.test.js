import assert from 'node:assert/strict';
import test from 'node:test';

import { MockBridge } from '../server/bridges/mock-bridge.js';
import { validateConfig } from '../server/config.js';
import { createHttpServer } from '../server/http-server.js';
import { MixerService } from '../server/mixer-service.js';
import { exampleConfig } from './helpers.js';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function close(server) {
  return new Promise((resolve) => {
    if (!server.listening) return resolve();
    server.closeAllConnections?.();
    server.close(resolve);
  });
}

async function createRunningServer() {
  const raw = await exampleConfig();
  raw.server.writeCoalesceMs = 0;
  const config = validateConfig(raw);
  const bridge = new MockBridge(config);
  const service = new MixerService({ config, bridge });
  await service.start();
  const server = createHttpServer({ config, service });
  await listen(server);
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    bridge,
    config,
    server,
    service,
    async stop() {
      await close(server);
      await service.stop();
    },
  };
}

async function json(response) {
  const value = await response.json();
  return { response, value };
}

function createSseReader(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  async function nextEvent() {
    for (;;) {
      const boundary = buffer.indexOf('\n\n');
      if (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const lines = frame.split('\n');
        const event = lines.find((line) => line.startsWith('event:'))?.slice(6).trim();
        const data = lines
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (data) return { event: event || 'message', data: JSON.parse(data) };
        continue;
      }

      let timeout;
      const { done, value } = await Promise.race([
        reader.read(),
        new Promise((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error('Timed out waiting for the expected SSE event')),
            2_000,
          );
        }),
      ]).finally(() => clearTimeout(timeout));
      if (done) throw new Error('SSE stream ended before the expected event');
      buffer += decoder.decode(value, { stream: true }).replaceAll('\r\n', '\n');
    }
  }

  return { nextEvent, reader };
}

test('server exposes health, public config, and static phone assets', async (t) => {
  const app = await createRunningServer();
  t.after(() => app.stop());

  const health = await json(await fetch(`${app.baseUrl}/api/health`));
  assert.equal(health.response.status, 200);
  assert.equal(health.value.ok, true);
  assert.equal(health.value.bridge.connected, true);

  const publicConfig = await json(await fetch(`${app.baseUrl}/api/config`));
  assert.equal(publicConfig.response.status, 200);
  assert.equal(publicConfig.value.members.length, 5);
  assert.equal(publicConfig.value.sources.length, 9);
  assert.equal(JSON.stringify(publicConfig.value).includes('abletonTrack'), false);

  const page = await fetch(`${app.baseUrl}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /^text\/html/);
  assert.match(await page.text(), /Ableton|IEM/i);

  const traversal = await fetch(`${app.baseUrl}/%2e%2e%2fAGENTS.md`);
  assert.notEqual(traversal.status, 200);
});

test('HTTP writes clamp values and reject cross-mix permissions', async (t) => {
  const app = await createRunningServer();
  t.after(() => app.stop());
  const original = app.service.getState('drummer', 'drummer').levels.click;

  const forbidden = await json(await fetch(
    `${app.baseUrl}/api/members/vocalist/mixes/drummer/sources/click`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: 0.25 }),
    },
  ));
  assert.equal(forbidden.response.status, 403);
  assert.equal(forbidden.value.error.code, 'MIX_FORBIDDEN');
  assert.equal(app.service.getState('drummer', 'drummer').levels.click, original);

  const forbiddenEvents = await json(await fetch(
    `${app.baseUrl}/api/events?memberId=vocalist&mixId=drummer`,
  ));
  assert.equal(forbiddenEvents.response.status, 403);
  assert.equal(forbiddenEvents.value.error.code, 'MIX_FORBIDDEN');

  const clamped = await json(await fetch(
    `${app.baseUrl}/api/members/vocalist/mixes/vocalist/sources/click`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: 99 }),
    },
  ));
  assert.equal(clamped.response.status, 200);
  assert.equal(clamped.value.value, app.config.levels.maximum);
});

test('HTTP API reports malformed and invalid requests without mutating state', async (t) => {
  const app = await createRunningServer();
  t.after(() => app.stop());
  const endpoint = `${app.baseUrl}/api/members/vocalist/mixes/vocalist/sources/vocal-1`;
  const original = app.service.getState('vocalist', 'vocalist').levels['vocal-1'];

  const cases = [
    {
      expected: 415,
      options: { method: 'PUT', body: JSON.stringify({ value: 0.2 }) },
    },
    {
      expected: 400,
      options: {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: '{broken',
      },
    },
    {
      expected: 400,
      options: {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ value: '0.2' }),
      },
    },
    {
      expected: 400,
      options: {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ value: 0.2, mixId: 'drummer' }),
      },
    },
  ];

  for (const testCase of cases) {
    const response = await fetch(endpoint, testCase.options);
    assert.equal(response.status, testCase.expected);
    assert.equal(typeof (await response.json()).error.code, 'string');
  }
  assert.equal(app.service.getState('vocalist', 'vocalist').levels['vocal-1'], original);

  const unknownSource = await fetch(
    `${app.baseUrl}/api/members/vocalist/mixes/vocalist/sources/not-a-source`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: 0.2 }),
    },
  );
  assert.equal(unknownSource.status, 404);
});

test('two SSE clients receive the same authoritative level update', async (t) => {
  const app = await createRunningServer();
  t.after(() => app.stop());
  const eventsUrl = `${app.baseUrl}/api/events?memberId=vocalist&mixId=vocalist`;
  const abortA = new AbortController();
  const abortB = new AbortController();
  t.after(() => abortA.abort());
  t.after(() => abortB.abort());

  const [responseA, responseB] = await Promise.all([
    fetch(eventsUrl, { signal: abortA.signal }),
    fetch(eventsUrl, { signal: abortB.signal }),
  ]);
  assert.equal(responseA.status, 200);
  assert.equal(responseB.status, 200);
  const streamA = createSseReader(responseA);
  const streamB = createSseReader(responseB);
  const [snapshotA, snapshotB] = await Promise.all([streamA.nextEvent(), streamB.nextEvent()]);
  assert.equal(snapshotA.event, 'snapshot');
  assert.equal(snapshotB.event, 'snapshot');

  const write = await fetch(
    `${app.baseUrl}/api/members/vocalist/mixes/vocalist/sources/vocal-2`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: 0.63 }),
    },
  );
  assert.equal(write.status, 200);

  const [levelA, levelB] = await Promise.all([streamA.nextEvent(), streamB.nextEvent()]);
  for (const event of [levelA, levelB]) {
    assert.equal(event.event, 'level');
    assert.equal(event.data.memberId, 'vocalist');
    assert.equal(event.data.mixId, 'vocalist');
    assert.equal(event.data.sourceId, 'vocal-2');
    assert.equal(event.data.value, 0.63);
  }
});

test('reset endpoint restores configured starting values for one mix', async (t) => {
  const app = await createRunningServer();
  t.after(() => app.stop());
  const prefix = `${app.baseUrl}/api/members/bassist/mixes/bassist`;

  await fetch(`${prefix}/sources/bass`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ value: 0.02 }),
  });
  const reset = await json(await fetch(`${prefix}/reset`, { method: 'POST' }));

  assert.equal(reset.response.status, 200);
  const source = app.config.sources.find(({ id }) => id === 'bass');
  assert.equal(reset.value.levels.bass, source.startingLevels.bassist);

  const bodyRejected = await json(await fetch(`${prefix}/reset`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ unexpected: true }),
  }));
  assert.equal(bodyRejected.response.status, 400);
  assert.equal(bodyRejected.value.error.code, 'INVALID_REQUEST');
});

test('external bridge changes and bridge loss propagate through SSE and health', async (t) => {
  const app = await createRunningServer();
  t.after(() => app.stop());
  const abort = new AbortController();
  t.after(() => abort.abort());
  const response = await fetch(
    `${app.baseUrl}/api/events?memberId=vocalist&mixId=vocalist`,
    { signal: abort.signal },
  );
  const stream = createSseReader(response);
  assert.equal((await stream.nextEvent()).event, 'snapshot');

  app.bridge.simulateExternalChange('vocalist', 'vocal-1', 0.29);
  const external = await stream.nextEvent();
  assert.equal(external.event, 'level');
  assert.equal(external.data.sourceId, 'vocal-1');
  assert.equal(external.data.value, 0.29);

  await app.bridge.stop();
  const status = await stream.nextEvent();
  assert.equal(status.event, 'status');
  assert.equal(status.data.bridge.connected, false);

  const health = await json(await fetch(`${app.baseUrl}/api/health`));
  assert.equal(health.response.status, 503);
  assert.equal(health.value.ok, false);

  const write = await json(await fetch(
    `${app.baseUrl}/api/members/vocalist/mixes/vocalist/sources/vocal-1`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: 0.4 }),
    },
  ));
  assert.equal(write.response.status, 503);
  assert.equal(write.value.error.code, 'BRIDGE_UNAVAILABLE');

  await app.service.stop();
  await app.service.start();
  let recovered;
  for (let index = 0; index < 4; index += 1) {
    const event = await stream.nextEvent();
    if (event.event === 'snapshot') {
      recovered = event;
      break;
    }
  }
  assert.equal(recovered?.event, 'snapshot');
  assert.equal(recovered.data.bridge.connected, true);
  assert.equal(recovered.data.levels['vocal-1'], 0.29);
});
