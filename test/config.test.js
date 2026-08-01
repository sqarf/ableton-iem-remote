import assert from 'node:assert/strict';
import test from 'node:test';

import { loadConfig, validateConfig } from '../server/config.js';
import { exampleConfig } from './helpers.js';

test('the example band configuration loads and validates', async () => {
  const loaded = await loadConfig(new URL('../config/band.json', import.meta.url));

  assert.equal(loaded.version, 1);
  assert.equal(loaded.members.length, 5);
  assert.equal(loaded.mixes.length, 5);
  assert.equal(loaded.sources.length, 9);
});

test('configuration rejects duplicate stable IDs', async () => {
  const raw = await exampleConfig();
  raw.sources[1].id = raw.sources[0].id;

  assert.throws(() => validateConfig(raw), /duplicate.*source|source.*duplicate/i);
});

test('configuration rejects ambiguous Ableton names', async () => {
  const raw = await exampleConfig();
  raw.mixes[1].abletonTrack = raw.mixes[0].abletonTrack;

  assert.throws(() => validateConfig(raw), /duplicate|unique|ambiguous/i);
});

test('configuration rejects a member mapped to an unknown mix', async () => {
  const raw = await exampleConfig();
  raw.members[0].mixId = 'missing-mix';

  assert.throws(() => validateConfig(raw), /mix|member/i);
});

test('configuration requires one dedicated mix per member', async () => {
  const raw = await exampleConfig();
  raw.members[1].mixId = raw.members[0].mixId;

  assert.throws(() => validateConfig(raw), /mix|member|duplicate/i);
});

test('configuration requires exactly one starting value per configured mix', async () => {
  const raw = await exampleConfig();
  delete raw.sources[0].startingLevels.vocalist;

  assert.throws(() => validateConfig(raw), /starting|vocalist|mix/i);
});

test('configuration rejects values outside normalized configured limits', async () => {
  const raw = await exampleConfig();
  raw.sources[0].startingLevels.vocalist = 1.01;

  assert.throws(() => validateConfig(raw), /starting|range|maximum|level/i);
});

test('configuration rejects inverted global limits', async () => {
  const raw = await exampleConfig();
  raw.levels.minimum = 0.8;
  raw.levels.maximum = 0.2;

  assert.throws(() => validateConfig(raw), /minimum|maximum|range/i);
});
