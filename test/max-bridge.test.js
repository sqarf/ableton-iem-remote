import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import {
  MAX_BRIDGE_PROTOCOL,
  MAX_BRIDGE_PROTOCOL_VERSION,
  MaxBridge,
} from '../server/bridges/max-bridge.js';
import { validateConfig } from '../server/config.js';
import { exampleConfig } from './helpers.js';

class FakeTransport extends EventEmitter {
  commands = [];
  sendError = null;

  send(command) {
    if (this.sendError) throw this.sendError;
    this.commands.push(structuredClone(command));
  }

  reply(message, { json = false } = {}) {
    this.emit('message', json ? JSON.stringify(message) : message);
  }
}

function event(type, fields = {}) {
  return {
    protocol: MAX_BRIDGE_PROTOCOL,
    version: MAX_BRIDGE_PROTOCOL_VERSION,
    type,
    ...fields,
  };
}

function configuredLevels(config) {
  return Object.fromEntries(config.mixes.map((mix) => [
    mix.id,
    Object.fromEntries(config.sources.map((source) => [
      source.id,
      source.startingLevels[mix.id],
    ])),
  ]));
}

async function makeHarness(options = {}) {
  const config = validateConfig(await exampleConfig());
  const transport = new FakeTransport();
  const bridge = new MaxBridge({
    config,
    transport,
    requestTimeoutMs: options.requestTimeoutMs ?? 100,
  });
  return { bridge, config, transport };
}

async function startResolved(harness, generation = 1, { json = false } = {}) {
  const { bridge, config, transport } = harness;
  const starting = bridge.start();
  const command = transport.commands.at(-1);
  assert.equal(command.type, 'resolve');
  transport.reply(event('resolved', {
    requestId: command.requestId,
    generation,
    levels: configuredLevels(config),
  }), { json });
  await starting;
  return command;
}

test('MaxBridge resolves exact configured names and serves its authoritative cache', async (t) => {
  const harness = await makeHarness();
  const { bridge, config, transport } = harness;
  t.after(() => bridge.stop());

  const resolveCommand = await startResolved(harness, 7, { json: true });

  assert.equal(resolveCommand.protocol, 'iem-remote');
  assert.equal(resolveCommand.version, 1);
  assert.deepEqual(
    resolveCommand.sources,
    config.sources.map(({ id, abletonTrack }) => ({ id, abletonTrack })),
  );
  assert.deepEqual(
    resolveCommand.mixes,
    config.mixes.map(({ id, abletonTrack }) => ({ id, abletonTrack })),
  );
  assert.deepEqual(resolveCommand.levels, config.levels);
  assert.equal(bridge.generation, 7);
  assert.equal(bridge.status.connected, true);

  const commandCount = transport.commands.length;
  const snapshot = await bridge.getSnapshot('vocalist');
  assert.equal(snapshot['vocal-1'], config.sources[0].startingLevels.vocalist);
  assert.equal(transport.commands.length, commandCount, 'complete cached snapshot avoids a round trip');
  assert.equal(Object.isFrozen(snapshot), true);
});

test('an observer level delivered synchronously after resolved updates the starting snapshot', async (t) => {
  const harness = await makeHarness();
  const { bridge, config, transport } = harness;
  t.after(() => bridge.stop());

  const updates = [];
  bridge.on('level', (update) => updates.push(update));
  const starting = bridge.start();
  const command = transport.commands.at(-1);
  transport.reply(event('resolved', {
    requestId: command.requestId,
    generation: 11,
    levels: configuredLevels(config),
  }));
  transport.reply(event('level', {
    generation: 11,
    mixId: 'vocalist',
    sourceId: 'vocal-1',
    value: 0.91,
  }));

  assert.equal(bridge.generation, 11, 'resolution activates before the start promise resumes');
  assert.deepEqual(updates, [{ mixId: 'vocalist', sourceId: 'vocal-1', value: 0.91 }]);
  await starting;
  assert.equal((await bridge.getSnapshot('vocalist'))['vocal-1'], 0.91);
  assert.equal(bridge.status.connected, true);
});

test('setLevel resolves only from its matching authoritative confirmation and emits once', async (t) => {
  const harness = await makeHarness();
  const { bridge, transport } = harness;
  t.after(() => bridge.stop());
  await startResolved(harness, 2);

  const updates = [];
  bridge.on('level', (update) => updates.push(update));
  const write = bridge.setLevel('vocalist', 'vocal-1', 0.333);
  const command = transport.commands.at(-1);
  assert.deepEqual(command, event('set-level', {
    requestId: command.requestId,
    generation: 2,
    mixId: 'vocalist',
    sourceId: 'vocal-1',
    value: 0.333,
  }));

  const confirmation = event('level', {
    requestId: command.requestId,
    generation: 2,
    mixId: 'vocalist',
    sourceId: 'vocal-1',
    value: 0.3329,
  });
  transport.reply(confirmation);
  const result = await write;
  transport.reply(confirmation);

  assert.deepEqual(result, { mixId: 'vocalist', sourceId: 'vocal-1', value: 0.3329 });
  assert.deepEqual(updates, [result], 'a duplicate correlated response is ignored');
  assert.equal((await bridge.getSnapshot('vocalist'))['vocal-1'], 0.3329);
});

test('current-generation observed changes update the cache while stale events are ignored', async (t) => {
  const harness = await makeHarness();
  const { bridge, transport } = harness;
  t.after(() => bridge.stop());
  await startResolved(harness, 4);

  const updates = [];
  bridge.on('level', (update) => updates.push(update));
  transport.reply(event('level', {
    generation: 3,
    mixId: 'drummer',
    sourceId: 'click',
    value: 0.12,
  }));
  transport.reply(event('level', {
    generation: 4,
    mixId: 'drummer',
    sourceId: 'click',
    value: 0.81,
  }));

  assert.deepEqual(updates, [{ mixId: 'drummer', sourceId: 'click', value: 0.81 }]);
  assert.equal((await bridge.getSnapshot('drummer')).click, 0.81);
  assert.equal(bridge.status.connected, true);
});

test('invalid resolution data fails closed and never exposes a partial mapping', async (t) => {
  const harness = await makeHarness();
  const { bridge, config, transport } = harness;
  t.after(() => bridge.stop());

  const starting = bridge.start();
  const command = transport.commands.at(-1);
  const levels = configuredLevels(config);
  delete levels.vocalist['vocal-1'];
  transport.reply(event('resolved', {
    requestId: command.requestId,
    generation: 1,
    levels,
  }));

  await assert.rejects(
    starting,
    (error) => (
      error.code === 'BRIDGE_PROTOCOL_ERROR'
      && /invalid bridge data/i.test(error.message)
      && /every configured source/i.test(error.cause?.message)
    ),
  );
  assert.equal(bridge.status.state, 'error');
  assert.equal(bridge.generation, null);
  await assert.rejects(bridge.getSnapshot('vocalist'), { code: 'BRIDGE_UNAVAILABLE' });
});

test('a mismatched write confirmation invalidates the connection', async (t) => {
  const harness = await makeHarness();
  const { bridge, transport } = harness;
  t.after(() => bridge.stop());
  await startResolved(harness, 3);

  const write = bridge.setLevel('vocalist', 'vocal-1', 0.4);
  const command = transport.commands.at(-1);
  transport.reply(event('level', {
    requestId: command.requestId,
    generation: 3,
    mixId: 'vocalist',
    sourceId: 'vocal-2',
    value: 0.4,
  }));

  await assert.rejects(write, { code: 'BRIDGE_PROTOCOL_ERROR' });
  assert.equal(bridge.status.state, 'error');
  assert.equal(bridge.status.connected, false);
  await assert.rejects(
    bridge.setLevel('vocalist', 'vocal-1', 0.4),
    { code: 'BRIDGE_UNAVAILABLE' },
  );
});

test('a newer unsolicited generation disconnects until a fresh resolve', async (t) => {
  const harness = await makeHarness();
  const { bridge, transport } = harness;
  t.after(() => bridge.stop());
  await startResolved(harness, 2);

  transport.reply(event('level', {
    generation: 3,
    mixId: 'vocalist',
    sourceId: 'vocal-1',
    value: 0.4,
  }));

  assert.equal(bridge.status.state, 'disconnected');
  assert.equal(bridge.generation, null);
  assert.match(bridge.status.message, /rescan/i);
});

test('timeouts clean up correlation so startup can be retried safely', async (t) => {
  const harness = await makeHarness({ requestTimeoutMs: 20 });
  const { bridge, config, transport } = harness;
  t.after(() => bridge.stop());

  const firstStart = bridge.start();
  const firstCommand = transport.commands.at(-1);
  await assert.rejects(firstStart, { code: 'BRIDGE_TIMEOUT' });
  assert.equal(bridge.status.state, 'error');

  transport.reply(event('resolved', {
    requestId: firstCommand.requestId,
    generation: 1,
    levels: configuredLevels(config),
  }));
  assert.equal(bridge.status.connected, false, 'a late timed-out response is ignored');

  const secondStart = bridge.start();
  const secondCommand = transport.commands.at(-1);
  assert.notEqual(secondCommand.requestId, firstCommand.requestId);
  transport.reply(event('resolved', {
    requestId: secondCommand.requestId,
    generation: 2,
    levels: configuredLevels(config),
  }));
  await secondStart;
  assert.equal(bridge.generation, 2);
});

test('disconnect and request-scoped adapter errors reject pending writes appropriately', async (t) => {
  const harness = await makeHarness();
  const { bridge, transport } = harness;
  t.after(() => bridge.stop());
  await startResolved(harness, 5);

  const rejectedWrite = bridge.setLevel('vocalist', 'vocal-1', 0.4);
  const rejectedCommand = transport.commands.at(-1);
  transport.reply(event('error', {
    requestId: rejectedCommand.requestId,
    code: 'ABLETON_WRITE_FAILED',
    message: 'Live rejected the write',
  }));
  await assert.rejects(
    rejectedWrite,
    (error) => (
      error.code === 'ABLETON_WRITE_FAILED'
      && error.message === 'Max for Live rejected the level change'
      && error.cause?.message === 'Live rejected the write'
    ),
  );
  assert.equal(bridge.status.connected, true, 'a scoped write failure does not discard the mapping');

  const disconnectedWrite = bridge.setLevel('vocalist', 'vocal-1', 0.5);
  transport.reply(event('status', {
    state: 'disconnected',
    message: 'Live set closed while resolving IEM SRC - Vocal 1',
  }));
  await assert.rejects(disconnectedWrite, { code: 'BRIDGE_UNAVAILABLE' });
  assert.equal(bridge.status.state, 'disconnected');
  assert.equal(bridge.generation, null);
  assert.equal(bridge.status.message, 'Max for Live adapter disconnected');
  assert.doesNotMatch(bridge.status.message, /IEM SRC/);
});

test('adapter connecting status invalidates an active generation before rebuild', async (t) => {
  const harness = await makeHarness();
  const { bridge, transport } = harness;
  t.after(() => bridge.stop());
  await startResolved(harness, 8);

  const statuses = [];
  bridge.on('status', (status) => statuses.push(status));
  transport.reply(event('status', { state: 'connecting' }));

  assert.equal(bridge.generation, null);
  assert.equal(bridge.status.state, 'connecting');
  assert.equal(bridge.status.connected, false);
  assert.ok(statuses.some(({ state }) => state === 'disconnected'));
  await assert.rejects(
    bridge.setLevel('vocalist', 'vocal-1', 0.4),
    { code: 'BRIDGE_UNAVAILABLE' },
  );
});

test('stop rejects in-flight work, sends stop, and removes the transport listener', async () => {
  const harness = await makeHarness();
  const { bridge, transport } = harness;
  await startResolved(harness, 1);

  const write = bridge.setLevel('vocalist', 'vocal-1', 0.5);
  const stopping = bridge.stop();
  await assert.rejects(write, { code: 'BRIDGE_STOPPED' });
  const stopCommand = transport.commands.at(-1);
  assert.equal(stopCommand.type, 'stop');
  transport.reply(event('stopped', { requestId: stopCommand.requestId }));
  await stopping;

  assert.equal(transport.listenerCount('message'), 0);
  assert.equal(bridge.status.state, 'stopped');
});

test('a late stop acknowledgement cannot tear down the next mapping generation', async (t) => {
  const harness = await makeHarness({ requestTimeoutMs: 20 });
  const { bridge, config, transport } = harness;
  t.after(() => bridge.stop());
  await startResolved(harness, 1);

  await bridge.stop();
  const oldStop = transport.commands.at(-1);
  const restarting = bridge.start();
  const resolveCommand = transport.commands.at(-1);
  transport.reply(event('stopped', { requestId: oldStop.requestId }));
  assert.equal(bridge.status.state, 'connecting');
  transport.reply(event('resolved', {
    requestId: resolveCommand.requestId,
    generation: 2,
    levels: configuredLevels(config),
  }));

  await restarting;
  assert.equal(bridge.status.connected, true);
  assert.equal(bridge.generation, 2);
});

test('transport send failures and invalid local writes are rejected before authority changes', async (t) => {
  const harness = await makeHarness();
  const { bridge, transport } = harness;
  t.after(() => bridge.stop());

  transport.sendError = new Error('outlet is unavailable');
  await assert.rejects(bridge.start(), { code: 'BRIDGE_UNAVAILABLE' });
  transport.sendError = null;
  await startResolved(harness, 1);

  const commandCount = transport.commands.length;
  await assert.rejects(bridge.setLevel('missing', 'vocal-1', 0.5), { code: 'UNKNOWN_MIX' });
  await assert.rejects(bridge.setLevel('vocalist', 'missing', 0.5), { code: 'UNKNOWN_SOURCE' });
  await assert.rejects(bridge.setLevel('vocalist', 'vocal-1', Number.NaN), {
    code: 'INVALID_LEVEL',
  });
  await assert.rejects(bridge.setLevel('vocalist', 'vocal-1', 2), { code: 'INVALID_LEVEL' });
  assert.equal(transport.commands.length, commandCount);
});
