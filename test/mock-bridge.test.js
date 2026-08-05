import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';

import { MockBridge } from '../server/bridges/mock-bridge.js';
import { validateConfig } from '../server/config.js';
import { exampleConfig } from './helpers.js';

async function createBridge(options) {
  const config = validateConfig(await exampleConfig());
  return { bridge: new MockBridge(config, options), config };
}

test('mock bridge starts with configured values and persists accepted writes', async (t) => {
  const { bridge, config } = await createBridge();
  t.after(() => bridge.stop());

  await bridge.start();
  assert.equal(bridge.status.connected, true);
  assert.equal(
    bridge.getSnapshot('vocalist')['main-vocals'],
    config.sources[0].startingLevels.vocalist,
  );

  const levelEvent = once(bridge, 'level');
  const result = await bridge.setLevel('vocalist', 'main-vocals', 0.31);

  assert.deepEqual(result, { mixId: 'vocalist', sourceId: 'main-vocals', value: 0.31 });
  assert.deepEqual((await levelEvent)[0], result);
  assert.equal(bridge.getSnapshot('vocalist')['main-vocals'], 0.31);
});

test('mock bridge emits direct Ableton-style external changes', async (t) => {
  const { bridge } = await createBridge();
  t.after(() => bridge.stop());
  await bridge.start();

  const levelEvent = once(bridge, 'level');
  bridge.simulateExternalChange('drummer', 'click', 0.83);

  assert.deepEqual((await levelEvent)[0], {
    mixId: 'drummer',
    sourceId: 'click',
    value: 0.83,
  });
  assert.equal(bridge.getSnapshot('drummer').click, 0.83);
});

test('mock bridge refuses writes while disconnected and rejects invalid targets', async (t) => {
  const { bridge } = await createBridge();
  t.after(() => bridge.stop());

  await assert.rejects(
    bridge.setLevel('vocalist', 'main-vocals', 0.5),
    /not connected/i,
  );

  await bridge.start();
  await assert.rejects(
    bridge.setLevel('missing', 'main-vocals', 0.5),
    /unknown mix/i,
  );
  await assert.rejects(
    bridge.setLevel('vocalist', 'missing', 0.5),
    /unknown source/i,
  );
  await assert.rejects(
    bridge.setLevel('vocalist', 'main-vocals', Number.NaN),
    /finite number/i,
  );
});
