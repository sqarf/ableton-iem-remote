/*
 * Ableton IEM Remote - Max `js` Live API controller.
 *
 * This file intentionally uses ES5-era syntax so it can run in Max's legacy
 * `js` object.  It is editable source, not a generated or packaged .amxd.
 *
 * Inlet:
 *   iem.command <one JSON object>
 *
 * Outlet 0:
 *   iem.event <one JSON object>
 *
 * Configured IDs remain the protocol identity. Ableton list indexes are used
 * only after an all-or-nothing exact-name scan of the current Live Set.
 */

autowatch = 1;
inlets = 1;
outlets = 1;

var PROTOCOL = "iem-remote";
var PROTOCOL_VERSION = 1;
var MAX_MESSAGE_LENGTH = 65536;
var MAX_SOURCES = 128;
var MAX_MIXES = 64;
var EPSILON = 0.000001;
var READBACK_DELAY_MS = 40;

var generationCounter = 0;
var activeMapping = null;
var candidateMapping = null;
var pendingWrites = {};
var topologyCheckTask = null;

function ControllerError(code, message) {
  this.name = "ControllerError";
  this.code = code;
  this.message = message;
}

ControllerError.prototype = new Error();
ControllerError.prototype.constructor = ControllerError;

function fail(code, message) {
  throw new ControllerError(code, message);
}

function isArray(value) {
  return Object.prototype.toString.call(value) === "[object Array]";
}

function isObject(value) {
  return value !== null && typeof value === "object" && !isArray(value);
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function isFiniteNumber(value) {
  return typeof value === "number" && isFinite(value);
}

function nearlyEqual(left, right) {
  return Math.abs(left - right) <= EPSILON;
}

function dictionaryKey(value) {
  return "$" + value;
}

function safeCancel(task) {
  if (task && typeof task.cancel === "function") {
    try {
      task.cancel();
    } catch (ignored) {
      // A completed Max Task may already be detached.
    }
  }
  if (task && typeof task.freepeer === "function") {
    try {
      task.freepeer();
    } catch (ignoredFree) {
      // Max may already have released the peer after execution.
    }
  }
}

function scheduleTask(callback, delay) {
  var task;
  task = new Task(function () {
    try {
      callback();
    } finally {
      if (task && typeof task.freepeer === "function") {
        try {
          task.freepeer();
        } catch (ignoredFree) {
          // The callback may have detached its own task during cleanup.
        }
      }
    }
  }, this);
  task.schedule(delay || 0);
  return task;
}

function copyFields(target, fields) {
  var key;
  if (!fields) return target;
  for (key in fields) {
    if (hasOwn(fields, key) && typeof fields[key] !== "undefined") {
      target[key] = fields[key];
    }
  }
  return target;
}

function emitEvent(type, fields) {
  var event = {
    protocol: PROTOCOL,
    version: PROTOCOL_VERSION,
    type: type
  };
  copyFields(event, fields);
  outlet(0, "iem.event", JSON.stringify(event));
  return event;
}

function emitStatus(state, connected, message, generation) {
  var fields = {
    state: state,
    connected: connected === true
  };
  if (message) fields.message = message;
  if (generation > 0) fields.generation = generation;
  emitEvent("status", fields);
}

function normalizeError(error, fallbackCode, fallbackMessage) {
  if (error && error.name === "ControllerError") {
    return { code: error.code, message: error.message };
  }
  return {
    code: fallbackCode || "LIVE_API_FAILURE",
    message: fallbackMessage || "The Live API operation failed"
  };
}

function emitError(error, requestId, generation, fallbackCode, fallbackMessage) {
  var normalized = normalizeError(error, fallbackCode, fallbackMessage);
  var fields = {
    code: normalized.code,
    message: normalized.message
  };
  if (requestId) fields.requestId = requestId;
  if (generation > 0) fields.generation = generation;
  emitEvent("error", fields);
}

function requireString(value, label, maximumLength) {
  if (typeof value !== "string" || value.length === 0) {
    fail("INVALID_REQUEST", label + " must be a non-empty string");
  }
  if (value.length > maximumLength) {
    fail("INVALID_REQUEST", label + " is too long");
  }
  if (/\u0000|[\u0001-\u001f]|\u007f/.test(value)) {
    fail("INVALID_REQUEST", label + " contains control characters");
  }
  return value;
}

function requireId(value, label) {
  var id = requireString(value, label, 64);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) {
    fail("INVALID_REQUEST", label + " is not a valid configured ID");
  }
  return id;
}

function requireRequestId(message) {
  return requireString(message.requestId, "requestId", 128);
}

function validateEnvelope(message) {
  if (!isObject(message)) {
    fail("INVALID_MESSAGE", "Command JSON must contain an object");
  }
  if (message.protocol !== PROTOCOL || message.version !== PROTOCOL_VERSION) {
    fail("UNSUPPORTED_PROTOCOL", "Expected iem-remote protocol version 1");
  }
  return requireString(message.type, "type", 40);
}

function validateNamedRecords(records, label, maximum) {
  var validated = [];
  var ids = {};
  var names = [];
  var index;
  var record;
  var id;
  var name;
  var earlier;

  if (!isArray(records) || records.length === 0 || records.length > maximum) {
    fail("INVALID_REQUEST", label + " must be a non-empty bounded array");
  }

  for (index = 0; index < records.length; index += 1) {
    record = records[index];
    if (!isObject(record)) {
      fail("INVALID_REQUEST", label + " entries must be objects");
    }
    id = requireId(record.id, label + "[" + index + "].id");
    name = requireString(
      record.abletonTrack,
      label + "[" + index + "].abletonTrack",
      255
    );
    if (hasOwn(ids, dictionaryKey(id))) {
      fail("INVALID_REQUEST", label + " contains duplicate ID " + id);
    }
    for (earlier = 0; earlier < names.length; earlier += 1) {
      if (names[earlier] === name) {
        fail("INVALID_REQUEST", label + " contains duplicate Ableton name " + name);
      }
    }
    ids[dictionaryKey(id)] = true;
    names.push(name);
    validated.push({ id: id, abletonTrack: name });
  }
  return validated;
}

function validateResolve(message) {
  var requestId = requireRequestId(message);
  var sources = validateNamedRecords(message.sources, "sources", MAX_SOURCES);
  var mixes = validateNamedRecords(message.mixes, "mixes", MAX_MIXES);
  var levels = message.levels;
  var minimum;
  var maximum;

  if (!isObject(levels)) {
    fail("INVALID_REQUEST", "levels must be an object");
  }
  minimum = levels.minimum;
  maximum = levels.maximum;
  if (!isFiniteNumber(minimum) || !isFiniteNumber(maximum)) {
    fail("INVALID_REQUEST", "levels minimum and maximum must be finite numbers");
  }
  if (minimum < 0 || maximum > 1 || minimum >= maximum) {
    fail("INVALID_REQUEST", "levels must satisfy 0 <= minimum < maximum <= 1");
  }
  return {
    requestId: requestId,
    sources: sources,
    mixes: mixes,
    levels: { minimum: minimum, maximum: maximum }
  };
}

function invalidLiveId(id) {
  var text = String(id);
  return text === "0" || text === "id 0" || text.length === 0;
}

function noopLiveCallback() {
  // Non-observing LiveAPI instances still require a callback in older Max builds.
}

function makeLiveApi(path, callback, description) {
  var api;
  try {
    api = new LiveAPI(callback || noopLiveCallback, path);
  } catch (ignored) {
    fail("LIVE_OBJECT_UNAVAILABLE", description + " is unavailable");
  }
  if (!api || invalidLiveId(api.id)) {
    fail("LIVE_OBJECT_UNAVAILABLE", description + " is unavailable");
  }
  return api;
}

function unwrapProperty(raw, property) {
  if (isArray(raw)) {
    if (raw.length > 1 && raw[0] === property) return raw[1];
    if (raw.length === 1) return raw[0];
  }
  return raw;
}

function readProperty(api, property, code, message) {
  var raw;
  try {
    raw = api.get(property);
  } catch (ignored) {
    fail(code, message);
  }
  return unwrapProperty(raw, property);
}

function readTrackName(api, description) {
  var value = readProperty(
    api,
    "name",
    "TRACK_NAME_UNAVAILABLE",
    description + " name is unavailable"
  );
  if (typeof value !== "string") {
    fail("TRACK_NAME_UNAVAILABLE", description + " name is unavailable");
  }
  return value;
}

function readBooleanProperty(api, property, description) {
  var value = readProperty(
    api,
    property,
    "LIVE_OBJECT_UNAVAILABLE",
    description + " is unavailable"
  );
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  fail("LIVE_OBJECT_UNAVAILABLE", description + " returned an invalid value");
}

function readCount(api, child, description) {
  var count;
  try {
    count = api.getcount(child);
  } catch (ignored) {
    fail("LIVE_OBJECT_UNAVAILABLE", description + " is unavailable");
  }
  count = unwrapProperty(count, child);
  if (!isFiniteNumber(count) || Math.floor(count) !== count || count < 0) {
    fail("LIVE_OBJECT_UNAVAILABLE", description + " returned an invalid count");
  }
  return count;
}

function enumerateTrackList(child, description) {
  var song = makeLiveApi("live_set", noopLiveCallback, "Live Set");
  var count = readCount(song, child, description);
  var tracks = [];
  var index;
  var path;
  var api;

  for (index = 0; index < count; index += 1) {
    path = "live_set " + child + " " + index;
    api = makeLiveApi(path, noopLiveCallback, description + " entry");
    if (String(api.type) !== "Track") {
      fail("TRACK_TYPE_INVALID", description + " contains a non-Track object");
    }
    tracks.push({
      index: index,
      id: String(api.id),
      name: readTrackName(api, description + " entry"),
      isGroup: child === "tracks"
        ? readBooleanProperty(api, "is_foldable", description + " group flag")
        : false,
      path: path
    });
  }
  return tracks;
}

function captureTopology() {
  var tracks = enumerateTrackList("tracks", "Track list");
  var returns = enumerateTrackList("return_tracks", "Return-track list");
  var signatureParts = [];
  var index;

  for (index = 0; index < tracks.length; index += 1) {
    signatureParts.push([
      "track",
      tracks[index].id,
      tracks[index].name,
      tracks[index].isGroup
    ]);
  }
  for (index = 0; index < returns.length; index += 1) {
    signatureParts.push(["return", returns[index].id, returns[index].name]);
  }
  return {
    tracks: tracks,
    returns: returns,
    signature: JSON.stringify(signatureParts)
  };
}

function findExactTrack(entries, name, missingCode, ambiguousCode, label, excludeGroups) {
  var match = null;
  var matches = 0;
  var excludedGroupMatch = false;
  var index;
  for (index = 0; index < entries.length; index += 1) {
    if (entries[index].name === name) {
      if (excludeGroups && entries[index].isGroup) {
        excludedGroupMatch = true;
        continue;
      }
      matches += 1;
      match = entries[index];
    }
  }
  if (matches === 0 && excludedGroupMatch) {
    fail("SOURCE_NOT_NORMAL_TRACK", "Configured source is a Group Track: " + name);
  }
  if (matches === 0) fail(missingCode, label + " not found: " + name);
  if (matches > 1) fail(ambiguousCode, label + " is ambiguous: " + name);
  return match;
}

function readParameterRange(api, description) {
  var minimum;
  var maximum;
  if (invalidLiveId(api.id) || String(api.type) !== "DeviceParameter") {
    fail("PARAMETER_TYPE_INVALID", description + " is not a DeviceParameter");
  }
  if (!readBooleanProperty(api, "is_enabled", description + " enabled flag")) {
    fail("PARAMETER_DISABLED", description + " is disabled");
  }
  minimum = readProperty(
    api,
    "min",
    "PARAMETER_RANGE_INVALID",
    description + " minimum is unavailable"
  );
  maximum = readProperty(
    api,
    "max",
    "PARAMETER_RANGE_INVALID",
    description + " maximum is unavailable"
  );
  if (!isFiniteNumber(minimum) || !isFiniteNumber(maximum) || maximum <= minimum) {
    fail("PARAMETER_RANGE_INVALID", description + " has an invalid range");
  }
  return { minimum: minimum, maximum: maximum };
}

function normalizedFromLive(record, liveValue) {
  var normalized;
  var configured = record.mapping.spec.levels;
  if (!isFiniteNumber(liveValue)) {
    fail("PARAMETER_VALUE_INVALID", "A send returned a non-finite value");
  }
  if (
    liveValue < record.parameterMinimum - EPSILON ||
    liveValue > record.parameterMaximum + EPSILON
  ) {
    fail("PARAMETER_VALUE_INVALID", "A send returned a value outside its range");
  }
  normalized = (liveValue - record.parameterMinimum) /
    (record.parameterMaximum - record.parameterMinimum);
  if (normalized < 0 && normalized >= -EPSILON) normalized = 0;
  if (normalized > 1 && normalized <= 1 + EPSILON) normalized = 1;
  if (
    normalized < configured.minimum - EPSILON ||
    normalized > configured.maximum + EPSILON
  ) {
    fail(
      "LEVEL_OUT_OF_RANGE",
      "A send is outside the configured normalized safety range"
    );
  }
  if (normalized < configured.minimum) normalized = configured.minimum;
  if (normalized > configured.maximum) normalized = configured.maximum;
  return normalized;
}

function liveFromNormalized(record, normalized) {
  return record.parameterMinimum +
    normalized * (record.parameterMaximum - record.parameterMinimum);
}

function readParameter(record) {
  var range;
  var value;
  if (invalidLiveId(record.api.id) || String(record.api.type) !== "DeviceParameter") {
    fail("LIVE_OBJECT_UNAVAILABLE", "A mapped send is unavailable");
  }
  if (String(record.api.id) !== record.liveObjectId) {
    fail("MAPPING_INVALIDATED", "A mapped send object changed");
  }
  range = readParameterRange(record.api, "Mapped send");
  if (
    !nearlyEqual(range.minimum, record.parameterMinimum) ||
    !nearlyEqual(range.maximum, record.parameterMaximum)
  ) {
    fail("MAPPING_INVALIDATED", "A mapped send range changed");
  }
  value = readProperty(
    record.api,
    "value",
    "PARAMETER_VALUE_INVALID",
    "A mapped send value is unavailable"
  );
  return normalizedFromLive(record, value);
}

function revalidateControlMapping(record) {
  var topology = captureTopology();
  var sourceTrack;
  var returnTrack;
  var mixer;
  var sendCount;
  var currentSend;

  if (
    !activeMapping ||
    record.mapping !== activeMapping ||
    topology.signature !== activeMapping.topologySignature
  ) {
    fail("MAPPING_INVALIDATED", "Track or return topology changed");
  }

  sourceTrack = findExactTrack(
    topology.tracks,
    record.sourceAbletonTrack,
    "SOURCE_MISSING",
    "SOURCE_AMBIGUOUS",
    "Configured source",
    true
  );
  returnTrack = findExactTrack(
    topology.returns,
    record.mixAbletonTrack,
    "MIX_MISSING",
    "MIX_AMBIGUOUS",
    "Configured return",
    false
  );

  if (
    sourceTrack.id !== record.sourceTrackId ||
    sourceTrack.path !== record.sourceTrackPath ||
    returnTrack.id !== record.returnTrackId ||
    returnTrack.path !== record.returnTrackPath ||
    returnTrack.index !== record.returnTrackIndex
  ) {
    fail("MAPPING_INVALIDATED", "A configured track or return changed");
  }

  mixer = makeLiveApi(
    sourceTrack.path + " mixer_device",
    noopLiveCallback,
    "Mapped source mixer"
  );
  sendCount = readCount(mixer, "sends", "Mapped source sends");
  if (returnTrack.index >= sendCount) {
    fail("MAPPING_INVALIDATED", "A mapped send is unavailable");
  }
  currentSend = makeLiveApi(
    sourceTrack.path + " mixer_device sends " + returnTrack.index,
    noopLiveCallback,
    "Mapped send"
  );
  if (String(currentSend.id) !== record.liveObjectId) {
    fail("MAPPING_INVALIDATED", "A mapped send object changed");
  }
}

function callbackValue(args, property) {
  var values = args;
  if (!isArray(values)) values = [values];
  if (values.length === 1 && isArray(values[0])) values = values[0];
  if (values.length > 1 && values[0] === property) return values[1];
  if (values.length === 1) return values[0];
  return null;
}

function observerCallbackFor(record) {
  return function (args) {
    var rawValue = callbackValue(args, "value");
    if (!record.active) return;
    record.queuedObservedValue = rawValue;
    safeCancel(record.observerTask);
    record.observerTask = scheduleTask(function () {
      var value = record.queuedObservedValue;
      record.observerTask = null;
      record.queuedObservedValue = null;
      processObservedValue(record, value);
    }, 0);
  };
}

function makeSendRecord(mapping, source, mix, sourceTrack, returnTrack) {
  var mixer;
  var sendCount;
  var path;
  var record;
  var range;

  mixer = makeLiveApi(
    sourceTrack.path + " mixer_device",
    noopLiveCallback,
    "Mixer for source " + source.id
  );
  sendCount = readCount(mixer, "sends", "Sends for source " + source.id);
  if (returnTrack.index >= sendCount) {
    fail(
      "SEND_UNAVAILABLE",
      "Send " + source.id + " -> " + mix.id + " is unavailable"
    );
  }
  path = sourceTrack.path + " mixer_device sends " + returnTrack.index;
  record = {
    mapping: mapping,
    sourceId: source.id,
    mixId: mix.id,
    sourceAbletonTrack: source.abletonTrack,
    mixAbletonTrack: mix.abletonTrack,
    sourceTrackId: sourceTrack.id,
    sourceTrackPath: sourceTrack.path,
    returnTrackId: returnTrack.id,
    returnTrackPath: returnTrack.path,
    returnTrackIndex: returnTrack.index,
    api: null,
    liveObjectId: null,
    parameterMinimum: 0,
    parameterMaximum: 0,
    lastNormalized: null,
    active: false,
    observerTask: null,
    queuedObservedValue: null
  };
  record.api = makeLiveApi(path, observerCallbackFor(record), "Configured send");
  range = readParameterRange(record.api, "Configured send");
  record.liveObjectId = String(record.api.id);
  record.parameterMinimum = range.minimum;
  record.parameterMaximum = range.maximum;
  try {
    record.api.property = "value";
  } catch (ignored) {
    fail("OBSERVER_UNAVAILABLE", "A send value observer could not be installed");
  }
  mapping.sendRecords.push(record);
  return record;
}

function topologyObserverCallback() {
  scheduleTopologyCheck();
}

function addTopologyObserver(mapping, path, property, description) {
  var api = makeLiveApi(path, topologyObserverCallback, description);
  try {
    api.property = property;
  } catch (ignored) {
    fail("OBSERVER_UNAVAILABLE", description + " observer could not be installed");
  }
  mapping.topologyObservers.push(api);
}

function installTopologyObservers(mapping, topology) {
  var index;
  addTopologyObserver(mapping, "live_set", "tracks", "Track-list");
  addTopologyObserver(mapping, "live_set", "return_tracks", "Return-track-list");
  for (index = 0; index < topology.tracks.length; index += 1) {
    addTopologyObserver(
      mapping,
      topology.tracks[index].path,
      "name",
      "Track-name"
    );
  }
  for (index = 0; index < topology.returns.length; index += 1) {
    addTopologyObserver(
      mapping,
      topology.returns[index].path,
      "name",
      "Return-track-name"
    );
  }
}

function detachMapping(mapping) {
  var index;
  if (!mapping) return;
  mapping.active = false;
  for (index = 0; index < mapping.sendRecords.length; index += 1) {
    mapping.sendRecords[index].active = false;
    safeCancel(mapping.sendRecords[index].observerTask);
    mapping.sendRecords[index].observerTask = null;
    try {
      mapping.sendRecords[index].api.property = "";
    } catch (ignoredSendObserver) {
      // The underlying Live object may already have disappeared.
    }
  }
  for (index = 0; index < mapping.topologyObservers.length; index += 1) {
    try {
      mapping.topologyObservers[index].property = "";
    } catch (ignoredTopologyObserver) {
      // The underlying Live object may already have disappeared.
    }
  }
  mapping.sendRecords = [];
  mapping.topologyObservers = [];
}

function nextGeneration() {
  generationCounter += 1;
  if (generationCounter > 2147483647) generationCounter = 1;
  return generationCounter;
}

function putControl(mapping, mixId, sourceId, record) {
  var mixKey = dictionaryKey(mixId);
  if (!hasOwn(mapping.controls, mixKey)) mapping.controls[mixKey] = {};
  mapping.controls[mixKey][dictionaryKey(sourceId)] = record;
}

function getControl(mapping, mixId, sourceId) {
  var mixKey = dictionaryKey(mixId);
  var sourceKey = dictionaryKey(sourceId);
  if (!mapping || !hasOwn(mapping.controls, mixKey)) return null;
  if (!hasOwn(mapping.controls[mixKey], sourceKey)) return null;
  return mapping.controls[mixKey][sourceKey];
}

function buildMapping(spec, generation) {
  var initialTopology = captureTopology();
  var mapping = {
    spec: spec,
    generation: generation,
    active: false,
    topologySignature: initialTopology.signature,
    controls: {},
    sendRecords: [],
    topologyObservers: []
  };
  var sourceTracks = {};
  var returnTracks = {};
  var source;
  var mix;
  var sourceIndex;
  var mixIndex;
  var record;
  var finalTopology;

  candidateMapping = mapping;
  for (sourceIndex = 0; sourceIndex < spec.sources.length; sourceIndex += 1) {
    source = spec.sources[sourceIndex];
    sourceTracks[dictionaryKey(source.id)] = findExactTrack(
      initialTopology.tracks,
      source.abletonTrack,
      "SOURCE_MISSING",
      "SOURCE_AMBIGUOUS",
      "Configured source",
      true
    );
  }
  for (mixIndex = 0; mixIndex < spec.mixes.length; mixIndex += 1) {
    mix = spec.mixes[mixIndex];
    returnTracks[dictionaryKey(mix.id)] = findExactTrack(
      initialTopology.returns,
      mix.abletonTrack,
      "MIX_MISSING",
      "MIX_AMBIGUOUS",
      "Configured return",
      false
    );
  }

  for (mixIndex = 0; mixIndex < spec.mixes.length; mixIndex += 1) {
    mix = spec.mixes[mixIndex];
    for (sourceIndex = 0; sourceIndex < spec.sources.length; sourceIndex += 1) {
      source = spec.sources[sourceIndex];
      record = makeSendRecord(
        mapping,
        source,
        mix,
        sourceTracks[dictionaryKey(source.id)],
        returnTracks[dictionaryKey(mix.id)]
      );
      putControl(mapping, mix.id, source.id, record);
    }
  }

  installTopologyObservers(mapping, initialTopology);

  // Observers now exist for every control; only now read the initial snapshot.
  for (mixIndex = 0; mixIndex < spec.mixes.length; mixIndex += 1) {
    mix = spec.mixes[mixIndex];
    for (sourceIndex = 0; sourceIndex < spec.sources.length; sourceIndex += 1) {
      source = spec.sources[sourceIndex];
      record = getControl(mapping, mix.id, source.id);
      record.lastNormalized = readParameter(record);
    }
  }

  // A rename/reorder during resolution invalidates the complete transaction.
  finalTopology = captureTopology();
  if (finalTopology.signature !== initialTopology.signature) {
    fail("TOPOLOGY_CHANGED", "The Live Set changed during mapping");
  }
  mapping.topologySignature = finalTopology.signature;
  candidateMapping = null;
  return mapping;
}

function snapshotFromMapping(mapping, refresh) {
  var levels = {};
  var mixIndex;
  var sourceIndex;
  var mix;
  var source;
  var record;
  var value;
  for (mixIndex = 0; mixIndex < mapping.spec.mixes.length; mixIndex += 1) {
    mix = mapping.spec.mixes[mixIndex];
    levels[mix.id] = {};
    for (sourceIndex = 0; sourceIndex < mapping.spec.sources.length; sourceIndex += 1) {
      source = mapping.spec.sources[sourceIndex];
      record = getControl(mapping, mix.id, source.id);
      value = refresh ? readParameter(record) : record.lastNormalized;
      record.lastNormalized = value;
      levels[mix.id][source.id] = value;
    }
  }
  return levels;
}

function failPendingWrites(code, message, generation) {
  var key;
  var pending;
  for (key in pendingWrites) {
    if (hasOwn(pendingWrites, key)) {
      pending = pendingWrites[key];
      safeCancel(pending.readbackTask);
      delete pendingWrites[key];
      emitError(
        new ControllerError(code, message),
        pending.requestId,
        generation
      );
    }
  }
}

function clearActiveMapping(code, message, emitPendingErrors) {
  var previous = activeMapping;
  safeCancel(topologyCheckTask);
  topologyCheckTask = null;
  if (previous) {
    activeMapping = null;
    detachMapping(previous);
    if (emitPendingErrors) {
      failPendingWrites(code, message, previous.generation);
    }
  }
  return previous;
}

function performResolve(spec, requestId) {
  var generation;
  var mapping;
  var levels;
  var fields;
  var normalized;

  clearActiveMapping("MAPPING_REPLACED", "The mapping was replaced", true);
  generation = nextGeneration();
  emitStatus("connecting", false, "Resolving configured Ableton sends", generation);

  try {
    mapping = buildMapping(spec, generation);
    activeMapping = mapping;
    mapping.active = true;
    for (var index = 0; index < mapping.sendRecords.length; index += 1) {
      mapping.sendRecords[index].active = true;
    }
    levels = snapshotFromMapping(mapping, false);
    fields = { generation: generation, levels: levels };
    if (requestId) fields.requestId = requestId;
    emitEvent("resolved", fields);
    emitStatus("connected", true, "Ableton sends resolved", generation);
    return true;
  } catch (error) {
    if (candidateMapping) {
      detachMapping(candidateMapping);
      candidateMapping = null;
    }
    if (mapping) detachMapping(mapping);
    activeMapping = null;
    normalized = normalizeError(error);
    emitError(error, requestId, generation);
    emitStatus("error", false, normalized.message, generation);
    return false;
  }
}

function handleResolve(message) {
  var spec = validateResolve(message);
  performResolve(spec, spec.requestId);
}

function requireActiveGeneration(message) {
  var requestId = requireRequestId(message);
  var generation = message.generation;
  if (!isFiniteNumber(generation) || Math.floor(generation) !== generation || generation <= 0) {
    fail("INVALID_REQUEST", "generation must be a positive integer");
  }
  if (!activeMapping) {
    fail("MAPPING_UNAVAILABLE", "No complete Ableton mapping is active");
  }
  if (generation !== activeMapping.generation) {
    fail("STALE_GENERATION", "The command uses a stale mapping generation");
  }
  return requestId;
}

function writeKey(mixId, sourceId) {
  return dictionaryKey(mixId) + "\u0000" + dictionaryKey(sourceId);
}

function removePendingWrite(pending) {
  var key = writeKey(pending.mixId, pending.sourceId);
  if (pendingWrites[key] === pending) delete pendingWrites[key];
  safeCancel(pending.readbackTask);
  pending.readbackTask = null;
}

function emitConfirmedLevel(record, normalized, requestId) {
  var fields = {
    generation: record.mapping.generation,
    mixId: record.mixId,
    sourceId: record.sourceId,
    value: normalized
  };
  if (requestId) fields.requestId = requestId;
  record.lastNormalized = normalized;
  emitEvent("level", fields);
}

function processObservedValue(record, rawValue) {
  var normalized;
  var key;
  var pending;
  if (!activeMapping || !record.active || record.mapping !== activeMapping) return;
  try {
    normalized = normalizedFromLive(record, rawValue);
  } catch (error) {
    invalidateMapping(error, null);
    return;
  }
  key = writeKey(record.mixId, record.sourceId);
  pending = pendingWrites[key];
  if (pending && pending.generation === activeMapping.generation) {
    removePendingWrite(pending);
    emitConfirmedLevel(record, normalized, pending.requestId);
    return;
  }
  if (record.lastNormalized !== null && nearlyEqual(record.lastNormalized, normalized)) return;
  emitConfirmedLevel(record, normalized, null);
}

function scheduleReadback(record, pending) {
  pending.readbackTask = scheduleTask(function () {
    var key = writeKey(pending.mixId, pending.sourceId);
    var normalized;
    pending.readbackTask = null;
    if (pendingWrites[key] !== pending) return;
    if (!activeMapping || pending.generation !== activeMapping.generation) return;
    try {
      normalized = readParameter(record);
      removePendingWrite(pending);
      emitConfirmedLevel(record, normalized, pending.requestId);
    } catch (error) {
      invalidateMapping(error, pending.requestId);
    }
  }, READBACK_DELAY_MS);
}

function handleSetLevel(message) {
  var requestId = requireActiveGeneration(message);
  var mixId = requireId(message.mixId, "mixId");
  var sourceId = requireId(message.sourceId, "sourceId");
  var value = message.value;
  var record = getControl(activeMapping, mixId, sourceId);
  var key = writeKey(mixId, sourceId);
  var pending;
  var liveValue;

  if (!record) fail("CONTROL_NOT_FOUND", "The configured send pair is unknown");
  if (!isFiniteNumber(value)) fail("INVALID_LEVEL", "value must be a finite number");
  if (
    value < activeMapping.spec.levels.minimum ||
    value > activeMapping.spec.levels.maximum
  ) {
    fail("LEVEL_OUT_OF_RANGE", "value is outside the configured safety range");
  }
  if (hasOwn(pendingWrites, key)) {
    fail("WRITE_IN_PROGRESS", "A write for this send is already pending");
  }

  // Observer callbacks are deferred by Live. Re-scan the exact mappings in
  // this command turn so a rename/reorder cannot receive one stale write.
  try {
    revalidateControlMapping(record);
    readParameter(record);
  } catch (preflightError) {
    invalidateMapping(preflightError, requestId);
    return;
  }

  pending = {
    requestId: requestId,
    generation: activeMapping.generation,
    mixId: mixId,
    sourceId: sourceId,
    requestedValue: value,
    readbackTask: null
  };
  pendingWrites[key] = pending;
  liveValue = liveFromNormalized(record, value);
  try {
    record.api.set("value", liveValue);
  } catch (ignored) {
    invalidateMapping(
      new ControllerError("WRITE_FAILED", "Ableton rejected the send write"),
      requestId
    );
    return;
  }
  if (pendingWrites[key] === pending) scheduleReadback(record, pending);
}

function handleGetSnapshot(message) {
  var requestId = requireActiveGeneration(message);
  var levels;
  try {
    levels = snapshotFromMapping(activeMapping, true);
  } catch (error) {
    invalidateMapping(error, requestId);
    return;
  }
  emitEvent("snapshot", {
    requestId: requestId,
    generation: activeMapping.generation,
    levels: levels
  });
}

function handlePing(message) {
  var requestId = requireRequestId(message);
  var fields = {
    requestId: requestId,
    connected: activeMapping !== null
  };
  if (activeMapping) fields.generation = activeMapping.generation;
  emitEvent("pong", fields);
}

function handleStop(message) {
  var requestId = requireRequestId(message);
  var previous;
  previous = clearActiveMapping("CONTROLLER_STOPPED", "The controller stopped", true);
  emitEvent("stopped", {
    requestId: requestId,
    generation: previous ? previous.generation : generationCounter
  });
}

function invalidateMapping(error, requestId) {
  var previous;
  var normalized = normalizeError(error, "MAPPING_INVALIDATED", "The mapping became invalid");
  var hadCorrelatedPending = false;
  var key;
  var pending;

  previous = activeMapping;
  if (!previous) {
    if (requestId) emitError(error, requestId, generationCounter);
    return;
  }
  activeMapping = null;
  safeCancel(topologyCheckTask);
  topologyCheckTask = null;
  detachMapping(previous);
  for (key in pendingWrites) {
    if (hasOwn(pendingWrites, key)) {
      pending = pendingWrites[key];
      if (pending.requestId === requestId) hadCorrelatedPending = true;
      safeCancel(pending.readbackTask);
      delete pendingWrites[key];
      emitError(
        new ControllerError(normalized.code, normalized.message),
        pending.requestId,
        previous.generation
      );
    }
  }
  if (requestId && !hadCorrelatedPending) {
    emitError(error, requestId, previous.generation);
  } else if (!requestId) {
    emitError(error, null, previous.generation);
  }
  emitStatus("disconnected", false, normalized.message, previous.generation);
  // Node-for-Max owns recovery so every rebuild is a correlated resolve and
  // MixerService can atomically replace its complete authoritative snapshot.
}

function scheduleTopologyCheck() {
  if (!activeMapping || topologyCheckTask) return;
  topologyCheckTask = scheduleTask(function () {
    var topology;
    topologyCheckTask = null;
    if (!activeMapping) return;
    try {
      topology = captureTopology();
      if (topology.signature !== activeMapping.topologySignature) {
        invalidateMapping(
          new ControllerError(
            "MAPPING_INVALIDATED",
            "Track or return topology changed"
          ),
          null
        );
      }
    } catch (error) {
      invalidateMapping(error, null);
    }
  }, 0);
}

function dispatchCommand(message) {
  var type = validateEnvelope(message);
  if (type === "resolve") return handleResolve(message);
  if (type === "set-level") return handleSetLevel(message);
  if (type === "get-snapshot") return handleGetSnapshot(message);
  if (type === "ping") return handlePing(message);
  if (type === "stop") return handleStop(message);
  fail("UNSUPPORTED_COMMAND", "Unsupported command type: " + type);
}

function processCommandText(text) {
  var message;
  var requestId = null;
  var generation = activeMapping ? activeMapping.generation : generationCounter;
  if (typeof text !== "string" || text.length === 0 || text.length > MAX_MESSAGE_LENGTH) {
    emitError(
      new ControllerError("INVALID_MESSAGE", "Command JSON is empty or too large"),
      null,
      generation
    );
    return;
  }
  try {
    message = JSON.parse(text);
    if (isObject(message) && typeof message.requestId === "string") {
      requestId = message.requestId;
    }
    dispatchCommand(message);
  } catch (error) {
    emitError(error, requestId, generation, "INVALID_MESSAGE", "Command JSON is invalid");
  }
}

function deferCommandAtoms(atoms) {
  var parts = [];
  var index;
  var text;
  for (index = 0; index < atoms.length; index += 1) {
    parts.push(String(atoms[index]));
  }
  text = parts.join(" ");
  scheduleTask(function () {
    processCommandText(text);
  }, 0);
}

function anything() {
  var selector = String(messagename);
  var atoms = arrayfromargs(arguments);
  if (selector !== "iem.command") {
    emitError(
      new ControllerError("INVALID_SELECTOR", "Expected the iem.command selector"),
      null,
      activeMapping ? activeMapping.generation : generationCounter
    );
    return;
  }
  deferCommandAtoms(atoms);
}

// Useful when testing the script directly from Max without a dotted selector.
function iem_command() {
  deferCommandAtoms(arrayfromargs(arguments));
}

function bang() {
  emitStatus(
    activeMapping ? "connected" : "disconnected",
    activeMapping !== null,
    activeMapping ? "Ableton sends resolved" : "Live API controller ready",
    activeMapping ? activeMapping.generation : 0
  );
}

function notifydeleted() {
  clearActiveMapping("CONTROLLER_STOPPED", "The controller was removed", false);
  failPendingWrites("CONTROLLER_STOPPED", "The controller was removed", generationCounter);
}
