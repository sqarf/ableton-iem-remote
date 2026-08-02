import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const controllerSource = await readFile(
  new URL('../ableton/live-api-controller.js', import.meta.url),
  'utf8',
);

function makeParameter(id, normalized, minimum = -60, maximum = 6) {
  return {
    id,
    type: 'DeviceParameter',
    min: minimum,
    max: maximum,
    value: minimum + normalized * (maximum - minimum),
    is_enabled: 1,
    watchers: new Map(),
  };
}

function makeTrack(id, name, sends = []) {
  return {
    id,
    type: 'Track',
    name,
    is_foldable: 0,
    sends,
    watchers: new Map(),
  };
}

function makeModel({
  duplicateSource = false,
  duplicateMix = false,
  groupSource = false,
  disabledSend = false,
} = {}) {
  const targetSend = makeParameter(301, 0.6);
  const model = {
    song: {
      id: 1,
      type: 'Song',
      watchers: new Map(),
    },
    tracks: [
      makeTrack(101, 'IEM SRC - Vocal', [makeParameter(300, 0.1), targetSend]),
      makeTrack(102, duplicateSource ? 'IEM SRC - Vocal' : 'Unrelated Source', [
        makeParameter(302, 0.2),
        makeParameter(303, 0.3),
      ]),
    ],
    returns: [
      makeTrack(201, 'Unrelated Return'),
      makeTrack(202, 'IEM MIX - Vocal'),
    ],
    targetSend,
  };

  if (duplicateMix) model.returns[0].name = 'IEM MIX - Vocal';
  if (groupSource) model.tracks[0].is_foldable = 1;
  if (disabledSend) model.targetSend.is_enabled = 0;
  return model;
}

function createHarness(options) {
  const model = makeModel(options);
  const events = [];
  const tasks = [];
  let clock = 0;
  let sequence = 0;

  function notify(object, property, value = object[property]) {
    const callbacks = object.watchers.get(property);
    if (!callbacks) return;
    for (const callback of [...callbacks]) callback([property, value]);
  }

  function resolvePath(path) {
    const atoms = String(path).split(/\s+/);
    if (atoms[0] !== 'live_set') return null;
    if (atoms.length === 1) return model.song;

    let current;
    let cursor;
    if (atoms[1] === 'tracks') {
      current = model.tracks[Number(atoms[2])];
      cursor = 3;
    } else if (atoms[1] === 'return_tracks') {
      current = model.returns[Number(atoms[2])];
      cursor = 3;
    } else {
      return null;
    }

    if (atoms[cursor] === 'mixer_device') {
      current = {
        id: 10_000 + current.id,
        type: 'MixerDevice',
        sends: current.sends,
        watchers: new Map(),
      };
      cursor += 1;
    }
    if (atoms[cursor] === 'sends') current = current.sends[Number(atoms[cursor + 1])];
    return current ?? null;
  }

  function FakeLiveAPI(callback, path) {
    this.callback = typeof callback === 'function' ? callback : () => {};
    this.object = resolvePath(path);
    this.observedProperty = '';
  }

  Object.defineProperties(FakeLiveAPI.prototype, {
    id: {
      get() {
        return this.object ? `id ${this.object.id}` : 'id 0';
      },
    },
    type: {
      get() {
        return this.object?.type ?? '';
      },
    },
    property: {
      get() {
        return this.observedProperty;
      },
      set(property) {
        if (this.object && this.observedProperty) {
          this.object.watchers.get(this.observedProperty)?.delete(this.callback);
        }
        this.observedProperty = String(property || '');
        if (this.object && this.observedProperty) {
          let callbacks = this.object.watchers.get(this.observedProperty);
          if (!callbacks) {
            callbacks = new Set();
            this.object.watchers.set(this.observedProperty, callbacks);
          }
          callbacks.add(this.callback);
        }
      },
    },
  });

  FakeLiveAPI.prototype.get = function get(property) {
    if (!this.object) throw new Error('missing object');
    return [this.object[property]];
  };

  FakeLiveAPI.prototype.getcount = function getcount(child) {
    if (this.object === model.song && child === 'tracks') return model.tracks.length;
    if (this.object === model.song && child === 'return_tracks') return model.returns.length;
    if (this.object.type === 'MixerDevice' && child === 'sends') return this.object.sends.length;
    throw new Error('unknown child');
  };

  FakeLiveAPI.prototype.set = function set(property, value) {
    if (!this.object) throw new Error('missing object');
    const changed = !Object.is(this.object[property], value);
    this.object[property] = value;
    if (changed) notify(this.object, property, value);
  };

  function FakeTask(callback, context) {
    this.callback = callback.bind(context);
    this.cancelled = false;
    this.id = ++sequence;
  }

  FakeTask.prototype.schedule = function schedule(delay = 0) {
    tasks.push({ task: this, due: clock + delay, id: this.id });
  };

  FakeTask.prototype.cancel = function cancel() {
    this.cancelled = true;
  };

  const context = vm.createContext({
    JSON,
    Math,
    Object,
    String,
    RegExp,
    Error,
    isFinite,
    LiveAPI: FakeLiveAPI,
    Task: FakeTask,
    arrayfromargs: (args) => Array.from(args),
    outlet: (index, selector, json) => {
      assert.equal(index, 0);
      assert.equal(selector, 'iem.event');
      events.push(JSON.parse(json));
    },
  });
  vm.runInContext(controllerSource, context, { filename: 'live-api-controller.js' });

  function runTasks(limit = 2_000) {
    let count = 0;
    while (tasks.length > 0) {
      tasks.sort((left, right) => left.due - right.due || left.id - right.id);
      const next = tasks.shift();
      clock = next.due;
      if (!next.task.cancelled) next.task.callback();
      count += 1;
      if (count > limit) throw new Error('controller task loop did not settle');
    }
  }

  function send(message) {
    context.messagename = 'iem.command';
    context.anything(JSON.stringify({
      protocol: 'iem-remote',
      version: 1,
      ...message,
    }));
    runTasks();
  }

  function resolve(requestId = 'resolve-1') {
    send({
      type: 'resolve',
      requestId,
      sources: [{ id: 'vocal', abletonTrack: 'IEM SRC - Vocal' }],
      mixes: [{ id: 'vocalist', abletonTrack: 'IEM MIX - Vocal' }],
      levels: { minimum: 0, maximum: 1 },
    });
    return events.findLast((event) => event.type === 'resolved');
  }

  function clearEvents() {
    events.length = 0;
  }

  function setTargetNormalized(normalized, shouldNotify = true) {
    const parameter = model.targetSend;
    const value = parameter.min + normalized * (parameter.max - parameter.min);
    const changed = !Object.is(parameter.value, value);
    parameter.value = value;
    if (shouldNotify && changed) notify(parameter, 'value', value);
    runTasks();
  }

  function renameTrack(index, name) {
    const track = model.tracks[index];
    track.name = name;
    notify(track, 'name', name);
    runTasks();
  }

  return {
    model,
    events,
    send,
    resolve,
    clearEvents,
    setTargetNormalized,
    renameTrack,
  };
}

test('resolve maps exact source and return names and publishes a normalized snapshot', () => {
  const harness = createHarness();
  const resolved = harness.resolve();

  assert.deepEqual(
    resolved,
    {
      protocol: 'iem-remote',
      version: 1,
      type: 'resolved',
      generation: 1,
      levels: { vocalist: { vocal: 0.6 } },
      requestId: 'resolve-1',
    },
  );
  assert.equal(harness.events.at(-1).type, 'status');
  assert.equal(harness.events.at(-1).connected, true);
});

test('resolve rejects an ambiguous exact source without publishing a partial mapping', () => {
  const harness = createHarness({ duplicateSource: true });
  const resolved = harness.resolve();

  assert.equal(resolved, undefined);
  assert.equal(harness.events.find((event) => event.type === 'error')?.code, 'SOURCE_AMBIGUOUS');
  assert.equal(harness.events.at(-1).state, 'error');
  assert.equal(harness.events.at(-1).connected, false);
});

test('resolve rejects an ambiguous exact return without choosing an index', () => {
  const harness = createHarness({ duplicateMix: true });
  harness.resolve();

  assert.equal(harness.events.find((event) => event.type === 'error')?.code, 'MIX_AMBIGUOUS');
  assert.equal(harness.events.some((event) => event.type === 'resolved'), false);
});

test('resolve never substitutes a same-named Group Track for a source track', () => {
  const harness = createHarness({ groupSource: true });
  harness.resolve();

  assert.equal(
    harness.events.find((event) => event.type === 'error')?.code,
    'SOURCE_NOT_NORMAL_TRACK',
  );
  assert.equal(harness.events.some((event) => event.type === 'resolved'), false);
});

test('resolve rejects a disabled send parameter before publishing any mapping', () => {
  const harness = createHarness({ disabledSend: true });
  harness.resolve();

  assert.equal(
    harness.events.find((event) => event.type === 'error')?.code,
    'PARAMETER_DISABLED',
  );
  assert.equal(harness.events.some((event) => event.type === 'resolved'), false);
});

test('set-level converts normalized values and only confirms the observed Live value', () => {
  const harness = createHarness();
  const generation = harness.resolve().generation;
  harness.clearEvents();

  harness.send({
    type: 'set-level',
    requestId: 'write-1',
    generation,
    mixId: 'vocalist',
    sourceId: 'vocal',
    value: 0.75,
  });

  assert.equal(harness.model.targetSend.value, -10.5);
  assert.deepEqual(harness.events, [{
    protocol: 'iem-remote',
    version: 1,
    type: 'level',
    generation,
    mixId: 'vocalist',
    sourceId: 'vocal',
    value: 0.75,
    requestId: 'write-1',
  }]);
});

test('an unchanged set-level is confirmed by explicit readback', () => {
  const harness = createHarness();
  const generation = harness.resolve().generation;
  harness.clearEvents();

  harness.send({
    type: 'set-level',
    requestId: 'write-same',
    generation,
    mixId: 'vocalist',
    sourceId: 'vocal',
    value: 0.6,
  });

  assert.equal(harness.events.length, 1);
  assert.equal(harness.events[0].type, 'level');
  assert.equal(harness.events[0].requestId, 'write-same');
  assert.equal(harness.events[0].value, 0.6);
});

test('stale generations are rejected before touching Live', () => {
  const harness = createHarness();
  const generation = harness.resolve().generation;
  const before = harness.model.targetSend.value;
  harness.clearEvents();

  harness.send({
    type: 'set-level',
    requestId: 'write-stale',
    generation: generation + 1,
    mixId: 'vocalist',
    sourceId: 'vocal',
    value: 0.2,
  });

  assert.equal(harness.model.targetSend.value, before);
  assert.equal(harness.events[0].type, 'error');
  assert.equal(harness.events[0].code, 'STALE_GENERATION');
});

test('a write synchronously rejects a rename before its observer callback arrives', () => {
  const harness = createHarness();
  const generation = harness.resolve().generation;
  const before = harness.model.targetSend.value;
  harness.clearEvents();

  // LiveAPI topology observers are deferred in Max. Mutate the model without
  // notifying the observer to reproduce a command arriving in that window.
  harness.model.tracks[0].name = 'Renamed Before Observer';
  harness.send({
    type: 'set-level',
    requestId: 'write-during-rename',
    generation,
    mixId: 'vocalist',
    sourceId: 'vocal',
    value: 0.2,
  });

  assert.equal(harness.model.targetSend.value, before);
  assert.equal(
    harness.events.some(
      (event) => event.type === 'error'
        && event.code === 'MAPPING_INVALIDATED'
        && event.requestId === 'write-during-rename',
    ),
    true,
  );
  assert.equal(
    harness.events.some((event) => event.type === 'status' && event.state === 'disconnected'),
    true,
  );
});

test('direct Ableton edits emit authoritative levels and get-snapshot refreshes values', () => {
  const harness = createHarness();
  const generation = harness.resolve().generation;
  harness.clearEvents();

  harness.setTargetNormalized(0.4);
  assert.equal(harness.events.length, 1);
  assert.deepEqual({ ...harness.events[0], value: 0.4 }, {
    protocol: 'iem-remote',
    version: 1,
    type: 'level',
    generation,
    mixId: 'vocalist',
    sourceId: 'vocal',
    value: 0.4,
  });
  assert.ok(Math.abs(harness.events[0].value - 0.4) < 1e-9);

  harness.clearEvents();
  harness.send({ type: 'get-snapshot', requestId: 'snapshot-1', generation });
  assert.deepEqual({
    ...harness.events[0],
    levels: { vocalist: { vocal: 0.4 } },
  }, {
    protocol: 'iem-remote',
    version: 1,
    type: 'snapshot',
    requestId: 'snapshot-1',
    generation,
    levels: { vocalist: { vocal: 0.4 } },
  });
  assert.ok(Math.abs(harness.events[0].levels.vocalist.vocal - 0.4) < 1e-9);
});

test('a track rename invalidates the generation for a correlated Node rescan', () => {
  const harness = createHarness();
  const generation = harness.resolve().generation;
  harness.clearEvents();

  harness.renameTrack(0, 'Renamed Source');

  assert.equal(
    harness.events.some((event) => event.type === 'status' && event.state === 'disconnected'),
    true,
  );
  assert.equal(
    harness.events.some(
      (event) => event.type === 'error' && event.code === 'MAPPING_INVALIDATED',
    ),
    true,
  );
  assert.equal(harness.events.some((event) => event.type === 'resolved'), false);

  harness.clearEvents();
  harness.send({
    type: 'set-level',
    requestId: 'write-after-rename',
    generation,
    mixId: 'vocalist',
    sourceId: 'vocal',
    value: 0.5,
  });
  assert.equal(harness.events[0].code, 'MAPPING_UNAVAILABLE');

  harness.renameTrack(0, 'IEM SRC - Vocal');
  harness.clearEvents();
  const recovered = harness.resolve('resolve-2');
  assert.equal(recovered.requestId, 'resolve-2');
  assert.ok(recovered.generation > generation);
});
