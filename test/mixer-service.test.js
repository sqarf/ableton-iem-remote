import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';

import { MockBridge } from '../server/bridges/mock-bridge.js';
import { validateConfig } from '../server/config.js';
import { MixerService } from '../server/mixer-service.js';
import { delay, exampleConfig } from './helpers.js';

class CountingMockBridge extends MockBridge {
  calls = [];

  async setLevel(mixId, sourceId, value) {
    this.calls.push({ mixId, sourceId, value });
    return super.setLevel(mixId, sourceId, value);
  }
}

class VariableLatencyMockBridge extends MockBridge {
  activeWrites = 0;
  maximumConcurrentWrites = 0;

  async setLevel(mixId, sourceId, value) {
    this.activeWrites += 1;
    this.maximumConcurrentWrites = Math.max(this.maximumConcurrentWrites, this.activeWrites);
    try {
      if (value === 0.2) await delay(30);
      return await super.setLevel(mixId, sourceId, value);
    } finally {
      this.activeWrites -= 1;
    }
  }
}

class InvalidConfirmationMockBridge extends MockBridge {
  confirmation;

  constructor(config, confirmation) {
    super(config);
    this.confirmation = confirmation;
  }

  async setLevel() {
    return this.confirmation;
  }
}

class SnapshotRaceMockBridge extends MockBridge {
  changed = false;

  getSnapshot(mixId) {
    const staleSnapshot = super.getSnapshot(mixId);
    if (mixId === 'vocalist' && !this.changed) {
      this.changed = true;
      this.simulateExternalChange('vocalist', 'vocal-1', 0.91);
    }
    return staleSnapshot;
  }
}

class FlakyStartMockBridge extends MockBridge {
  attempts = 0;

  async start() {
    this.attempts += 1;
    if (this.attempts === 1) throw new Error('simulated startup failure');
    return super.start();
  }
}

async function createService({ coalesceMs = 5, latencyMs = 0 } = {}) {
  const raw = await exampleConfig();
  raw.server.writeCoalesceMs = coalesceMs;
  const config = validateConfig(raw);
  const bridge = new CountingMockBridge(config, { latencyMs });
  const service = new MixerService({ config, bridge });
  await service.start();
  return { bridge, config, service };
}

test('mixer service exposes only a member own configured mix', async (t) => {
  const { service } = await createService();
  t.after(() => service.stop());

  const state = service.getState('vocalist', 'vocalist');
  assert.equal(Object.keys(state.levels).length, 9);

  assert.throws(
    () => service.getState('vocalist', 'drummer'),
    (error) => error.code === 'MIX_FORBIDDEN' && error.statusCode === 403,
  );
  await assert.rejects(
    service.setLevel('missing', 'vocalist', 'vocal-1', 0.5),
    (error) => error.code === 'MEMBER_NOT_FOUND' && error.statusCode === 404,
  );
  await assert.rejects(
    service.setLevel('vocalist', 'vocalist', 'missing-source', 0.5),
    (error) => error.code === 'SOURCE_NOT_FOUND' && error.statusCode === 404,
  );
});

test('mixer service clamps finite writes to configured safety limits', async (t) => {
  const { service } = await createService({ coalesceMs: 0 });
  t.after(() => service.stop());

  const below = await service.setLevel('vocalist', 'vocalist', 'vocal-1', -10);
  const above = await service.setLevel('vocalist', 'vocalist', 'vocal-1', 10);

  assert.equal(below.value, 0);
  assert.equal(above.value, 1);
  assert.equal(service.getState('vocalist', 'vocalist').levels['vocal-1'], 1);
});

test('mixer service rejects malformed non-numeric levels', async (t) => {
  const { service } = await createService();
  t.after(() => service.stop());

  for (const value of ['0.5', null, Number.NaN, Number.POSITIVE_INFINITY]) {
    await assert.rejects(
      service.setLevel('vocalist', 'vocalist', 'vocal-1', value),
      (error) => error.code === 'INVALID_LEVEL' && error.statusCode === 400,
    );
  }
});

test('rapid writes for one send are coalesced to the newest value', async (t) => {
  const { bridge, service } = await createService({ coalesceMs: 20 });
  t.after(() => service.stop());

  const writes = [0.2, 0.4, 0.61].map((value) => (
    service.setLevel('guitarist-1', 'guitarist-1', 'guitar-1', value)
  ));
  const results = await Promise.all(writes);

  assert.deepEqual(bridge.calls, [
    { mixId: 'guitarist-1', sourceId: 'guitar-1', value: 0.61 },
  ]);
  assert.deepEqual(results.map(({ value }) => value), [0.61, 0.61, 0.61]);
  assert.equal(service.getState('guitarist-1', 'guitarist-1').levels['guitar-1'], 0.61);
});

test('writes for one send remain ordered when a newer value arrives in flight', async (t) => {
  const raw = await exampleConfig();
  raw.server.writeCoalesceMs = 0;
  const config = validateConfig(raw);
  const bridge = new VariableLatencyMockBridge(config);
  const service = new MixerService({ config, bridge });
  await service.start();
  t.after(() => service.stop());

  const slowFirstWrite = service.setLevel('vocalist', 'vocalist', 'vocal-1', 0.2);
  await delay(2);
  const newerWrite = service.setLevel('vocalist', 'vocalist', 'vocal-1', 0.8);
  await Promise.all([slowFirstWrite, newerWrite]);

  assert.equal(bridge.maximumConcurrentWrites, 1);
  assert.equal(service.getState('vocalist', 'vocalist').levels['vocal-1'], 0.8);
});

test('a bridge write must return a matching authoritative confirmation', async () => {
  const raw = await exampleConfig();
  raw.server.writeCoalesceMs = 0;
  const config = validateConfig(raw);

  for (const confirmation of [
    undefined,
    { mixId: 'drummer', sourceId: 'vocal-1', value: 0.4 },
    { mixId: 'vocalist', sourceId: 'vocal-1', value: Number.NaN },
  ]) {
    const bridge = new InvalidConfirmationMockBridge(config, confirmation);
    const service = new MixerService({ config, bridge });
    await service.start();
    await assert.rejects(
      service.setLevel('vocalist', 'vocalist', 'vocal-1', 0.4),
      (error) => error.code === 'BRIDGE_UNAVAILABLE' && error.statusCode === 503,
    );
    assert.equal(service.getState('vocalist', 'vocalist').levels['vocal-1'], 0.72);
    await service.stop();
  }
});

test('an authoritative startup event is not overwritten by an older snapshot', async (t) => {
  const config = validateConfig(await exampleConfig());
  const bridge = new SnapshotRaceMockBridge(config);
  const service = new MixerService({ config, bridge });
  await service.start();
  t.after(() => service.stop());

  const state = service.getState('vocalist', 'vocalist');
  assert.equal(state.levels['vocal-1'], 0.91);
  assert.equal(state.revision, 1);
});

test('failed bridge startup reports an error and can be retried safely', async (t) => {
  const config = validateConfig(await exampleConfig());
  const bridge = new FlakyStartMockBridge(config);
  const service = new MixerService({ config, bridge });
  t.after(() => service.stop());

  await assert.rejects(service.start(), /simulated startup failure/i);
  assert.equal(service.getStatus().state, 'error');
  assert.equal(service.getStatus().connected, false);
  assert.throws(
    () => service.getState('vocalist', 'vocalist'),
    (error) => error.code === 'SERVICE_UNAVAILABLE',
  );

  const retryA = service.start();
  const retryB = service.start();
  assert.equal(retryA, retryB);
  await retryA;
  assert.equal(service.getState('vocalist', 'vocalist').levels['vocal-1'], 0.72);
});

test('service announces readiness only after every authoritative snapshot is available', async (t) => {
  const config = validateConfig(await exampleConfig());
  const bridge = new MockBridge(config);
  const service = new MixerService({ config, bridge });
  t.after(() => service.stop());

  const ready = once(service, 'ready');
  await service.start();
  await ready;

  for (const member of config.members) {
    const state = service.getState(member.id, member.mixId);
    assert.deepEqual(Object.keys(state.levels), config.sources.map(({ id }) => id));
  }
});

test('authoritative external bridge changes update state and subscribers', async (t) => {
  const { bridge, service } = await createService();
  t.after(() => service.stop());

  const eventPromise = once(service, 'level');
  bridge.simulateExternalChange('drummer', 'click', 0.81);
  const [event] = await eventPromise;

  assert.deepEqual(event, {
    memberId: 'drummer',
    mixId: 'drummer',
    sourceId: 'click',
    value: 0.81,
    revision: 1,
  });
  assert.equal(service.getState('drummer', 'drummer').levels.click, 0.81);
});

test('reset restores only the selected member configured starting mix', async (t) => {
  const { config, service } = await createService({ coalesceMs: 0 });
  t.after(() => service.stop());

  const drummerBefore = service.getState('drummer', 'drummer').levels.click;
  await service.setLevel('vocalist', 'vocalist', 'click', 0.99);
  const reset = await service.resetMix('vocalist', 'vocalist');

  const click = config.sources.find(({ id }) => id === 'click');
  assert.equal(reset.levels.click, click.startingLevels.vocalist);
  assert.equal(service.getState('drummer', 'drummer').levels.click, drummerBefore);
});
