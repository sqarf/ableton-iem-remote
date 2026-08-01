import { readFile } from 'node:fs/promises';

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

export class ConfigError extends Error {
  constructor(message, path = 'config', options = {}) {
    super(`${path}: ${message}`, options);
    this.name = 'ConfigError';
    this.code = 'CONFIG_INVALID';
    this.path = path;
  }
}

function fail(path, message) {
  throw new ConfigError(message, path);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireRecord(value, path) {
  if (!isRecord(value)) fail(path, 'must be an object');
  return value;
}

function requireExactKeys(value, allowed, required, path) {
  const keys = Object.keys(value);
  for (const key of keys) {
    if (!allowed.includes(key)) fail(`${path}.${key}`, 'is not allowed');
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) fail(`${path}.${key}`, 'is required');
  }
}

function requireArray(value, path) {
  if (!Array.isArray(value) || value.length === 0) {
    fail(path, 'must be a non-empty array');
  }
  return value;
}

function requireString(value, path, maximumLength) {
  if (typeof value !== 'string') fail(path, 'must be a string');
  if (value.length === 0) fail(path, 'must not be empty');
  if (value.length > maximumLength) {
    fail(path, `must be no longer than ${maximumLength} characters`);
  }
  if (value !== value.trim()) fail(path, 'must not have leading or trailing whitespace');
  if (CONTROL_CHARACTER_PATTERN.test(value)) fail(path, 'must not contain control characters');
  return value;
}

function requireId(value, path) {
  const id = requireString(value, path, 64);
  if (!ID_PATTERN.test(id)) {
    fail(path, 'must contain lowercase letters, digits, and single hyphens only');
  }
  return id;
}

function requireInteger(value, path, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    fail(path, `must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function requireFinite(value, path) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(path, 'must be a finite number');
  }
  return value;
}

function assertUnique(records, key, path) {
  const seen = new Map();
  for (let index = 0; index < records.length; index += 1) {
    const value = records[index][key];
    if (seen.has(value)) {
      fail(`${path}[${index}].${key}`, `duplicates ${path}[${seen.get(value)}].${key}`);
    }
    seen.set(value, index);
  }
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

/**
 * Validate untrusted JSON and return a detached, deeply frozen configuration.
 * Runtime cross-record checks intentionally supplement config/schema.json.
 */
export function validateConfig(raw) {
  const root = requireRecord(raw, 'config');
  requireExactKeys(
    root,
    ['version', 'server', 'levels', 'members', 'mixes', 'sources'],
    ['version', 'server', 'levels', 'members', 'mixes', 'sources'],
    'config',
  );

  if (root.version !== 1) fail('config.version', 'must be 1');

  const rawServer = requireRecord(root.server, 'config.server');
  requireExactKeys(
    rawServer,
    ['host', 'port', 'writeCoalesceMs', 'requestBodyLimitBytes'],
    ['host', 'port', 'writeCoalesceMs', 'requestBodyLimitBytes'],
    'config.server',
  );
  const server = {
    host: requireString(rawServer.host, 'config.server.host', 255),
    port: requireInteger(rawServer.port, 'config.server.port', 1, 65_535),
    writeCoalesceMs: requireInteger(
      rawServer.writeCoalesceMs,
      'config.server.writeCoalesceMs',
      0,
      1_000,
    ),
    requestBodyLimitBytes: requireInteger(
      rawServer.requestBodyLimitBytes,
      'config.server.requestBodyLimitBytes',
      256,
      1_048_576,
    ),
  };

  const rawLevels = requireRecord(root.levels, 'config.levels');
  requireExactKeys(rawLevels, ['minimum', 'maximum'], ['minimum', 'maximum'], 'config.levels');
  const levels = {
    minimum: requireFinite(rawLevels.minimum, 'config.levels.minimum'),
    maximum: requireFinite(rawLevels.maximum, 'config.levels.maximum'),
  };
  if (levels.minimum < 0 || levels.maximum > 1 || levels.minimum >= levels.maximum) {
    fail('config.levels', 'must satisfy 0 <= minimum < maximum <= 1');
  }

  const mixes = requireArray(root.mixes, 'config.mixes').map((entry, index) => {
    const path = `config.mixes[${index}]`;
    const record = requireRecord(entry, path);
    requireExactKeys(record, ['id', 'name', 'abletonTrack'], ['id', 'name', 'abletonTrack'], path);
    return {
      id: requireId(record.id, `${path}.id`),
      name: requireString(record.name, `${path}.name`, 100),
      abletonTrack: requireString(record.abletonTrack, `${path}.abletonTrack`, 255),
    };
  });
  assertUnique(mixes, 'id', 'config.mixes');
  assertUnique(mixes, 'name', 'config.mixes');
  assertUnique(mixes, 'abletonTrack', 'config.mixes');
  const mixIds = new Set(mixes.map(({ id }) => id));

  const members = requireArray(root.members, 'config.members').map((entry, index) => {
    const path = `config.members[${index}]`;
    const record = requireRecord(entry, path);
    requireExactKeys(record, ['id', 'name', 'mixId'], ['id', 'name', 'mixId'], path);
    const member = {
      id: requireId(record.id, `${path}.id`),
      name: requireString(record.name, `${path}.name`, 100),
      mixId: requireId(record.mixId, `${path}.mixId`),
    };
    if (!mixIds.has(member.mixId)) fail(`${path}.mixId`, `references unknown mix "${member.mixId}"`);
    return member;
  });
  assertUnique(members, 'id', 'config.members');
  assertUnique(members, 'name', 'config.members');
  assertUnique(members, 'mixId', 'config.members');
  if (members.length !== mixes.length) {
    fail('config.members', 'must assign every configured mix exactly once');
  }
  const assignedMixIds = new Set(members.map(({ mixId }) => mixId));
  for (const mix of mixes) {
    if (!assignedMixIds.has(mix.id)) {
      fail('config.members', `does not assign mix "${mix.id}"`);
    }
  }

  const sources = requireArray(root.sources, 'config.sources').map((entry, index) => {
    const path = `config.sources[${index}]`;
    const record = requireRecord(entry, path);
    requireExactKeys(
      record,
      ['id', 'name', 'abletonTrack', 'startingLevels'],
      ['id', 'name', 'abletonTrack', 'startingLevels'],
      path,
    );
    const rawStartingLevels = requireRecord(record.startingLevels, `${path}.startingLevels`);
    const startingKeys = Object.keys(rawStartingLevels);
    if (startingKeys.length !== mixes.length) {
      fail(`${path}.startingLevels`, 'must contain exactly one value for every configured mix');
    }
    const startingLevels = {};
    for (const mix of mixes) {
      if (!Object.hasOwn(rawStartingLevels, mix.id)) {
        fail(`${path}.startingLevels.${mix.id}`, 'is required');
      }
      const value = requireFinite(rawStartingLevels[mix.id], `${path}.startingLevels.${mix.id}`);
      if (value < levels.minimum || value > levels.maximum) {
        fail(
          `${path}.startingLevels.${mix.id}`,
          `must be between ${levels.minimum} and ${levels.maximum}`,
        );
      }
      startingLevels[mix.id] = value;
    }
    for (const key of startingKeys) {
      if (!mixIds.has(key)) fail(`${path}.startingLevels.${key}`, 'does not name a configured mix');
    }
    return {
      id: requireId(record.id, `${path}.id`),
      name: requireString(record.name, `${path}.name`, 100),
      abletonTrack: requireString(record.abletonTrack, `${path}.abletonTrack`, 255),
      startingLevels,
    };
  });
  assertUnique(sources, 'id', 'config.sources');
  assertUnique(sources, 'name', 'config.sources');
  assertUnique(sources, 'abletonTrack', 'config.sources');

  const allAbletonNames = new Map();
  for (const [kind, records] of [['mix', mixes], ['source', sources]]) {
    records.forEach((record, index) => {
      const earlier = allAbletonNames.get(record.abletonTrack);
      if (earlier) {
        fail(
          `config.${kind === 'mix' ? 'mixes' : 'sources'}[${index}].abletonTrack`,
          `duplicates ${earlier}`,
        );
      }
      allAbletonNames.set(
        record.abletonTrack,
        `config.${kind === 'mix' ? 'mixes' : 'sources'}[${index}].abletonTrack`,
      );
    });
  }

  return deepFreeze({ version: 1, server, levels, members, mixes, sources });
}

export async function loadConfig(filePath) {
  let text;
  try {
    text = await readFile(filePath, 'utf8');
  } catch (error) {
    throw new ConfigError(`could not read ${filePath}: ${error.message}`, 'config', { cause: error });
  }

  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(`invalid JSON in ${filePath}: ${error.message}`, 'config', { cause: error });
  }
  return validateConfig(raw);
}
