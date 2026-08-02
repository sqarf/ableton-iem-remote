import { BRIDGE_STATES, Bridge, BridgeError } from './bridge.js';

export const MAX_BRIDGE_PROTOCOL = 'iem-remote';
export const MAX_BRIDGE_PROTOCOL_VERSION = 1;

const DEFAULT_REQUEST_TIMEOUT_MS = 3_000;
const COMPLETED_REQUEST_LIMIT = 256;
const ADAPTER_ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function makeBridgeError(code, message, cause) {
  return new BridgeError(code, message, cause === undefined ? {} : { cause });
}

/**
 * Bridge between the HTTP-facing mixer service and the Node-for-Max transport.
 *
 * The transport is deliberately tiny: on/off('message', handler) plus
 * send(command). Keeping Max-specific APIs out of this class makes the protocol
 * testable in ordinary Node and keeps the server-facing bridge contract shared
 * with MockBridge.
 */
export class MaxBridge extends Bridge {
  #config;
  #transport;
  #requestTimeoutMs;
  #mixIds;
  #sourceIds;
  #levels = new Map();
  #generation = null;
  #pending = new Map();
  #completedRequestIds = new Set();
  #completedRequestOrder = [];
  #nextRequestNumber = 1;
  #subscribed = false;
  #startPromise = null;
  #stopping = false;

  constructor(configOrOptions, maybeOptions = {}) {
    super();

    const options = configOrOptions?.config
      ? configOrOptions
      : { ...maybeOptions, config: configOrOptions };
    const { config, transport, requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = options;

    if (!config || !Array.isArray(config.mixes) || !Array.isArray(config.sources)) {
      throw new TypeError('MaxBridge requires a validated config');
    }
    if (
      !transport
      || typeof transport.on !== 'function'
      || typeof transport.off !== 'function'
      || typeof transport.send !== 'function'
    ) {
      throw new TypeError(
        "MaxBridge transport must provide on/off('message', handler) and send(command)",
      );
    }
    if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
      throw new TypeError('requestTimeoutMs must be a positive finite number');
    }

    this.#config = config;
    this.#transport = transport;
    this.#requestTimeoutMs = requestTimeoutMs;
    this.#mixIds = new Set(config.mixes.map(({ id }) => id));
    this.#sourceIds = new Set(config.sources.map(({ id }) => id));
  }

  get generation() {
    return this.#generation;
  }

  start() {
    if (this.status.connected) return Promise.resolve(this.status);
    if (this.#startPromise) return this.#startPromise;

    this.#stopping = false;
    this.#subscribe();
    this.#clearResolution();
    this._setStatus(BRIDGE_STATES.CONNECTING, 'Resolving configured Ableton tracks');

    this.#startPromise = (async () => {
      try {
        const resolution = await this.#request(
          'resolve',
          {
            sources: this.#config.sources.map(({ id, abletonTrack }) => ({ id, abletonTrack })),
            mixes: this.#config.mixes.map(({ id, abletonTrack }) => ({ id, abletonTrack })),
            levels: {
              minimum: this.#config.levels.minimum,
              maximum: this.#config.levels.maximum,
            },
          },
          'resolved',
        );
        if (this.#stopping) {
          throw makeBridgeError('BRIDGE_STOPPED', 'Max for Live bridge stopped during startup');
        }
        if (this.#generation !== resolution.generation) {
          throw makeBridgeError(
            'BRIDGE_UNAVAILABLE',
            'Max for Live mapping changed before startup completed',
          );
        }
        return this._setStatus(
          BRIDGE_STATES.CONNECTED,
          `Max for Live bridge connected (mapping generation ${this.#generation})`,
        );
      } catch (error) {
        this.#clearResolution();
        const bridgeError = error instanceof BridgeError
          ? error
          : makeBridgeError(
            'BRIDGE_UNAVAILABLE',
            `Could not resolve Ableton tracks: ${error instanceof Error ? error.message : error}`,
            error,
          );
        if (!this.#stopping) this._setStatus(BRIDGE_STATES.ERROR, bridgeError.message);
        throw bridgeError;
      } finally {
        this.#startPromise = null;
      }
    })();

    return this.#startPromise;
  }

  async stop() {
    if (this.status.state === BRIDGE_STATES.STOPPED && !this.#subscribed) return this.status;

    this.#stopping = true;
    this.#rejectAll(
      makeBridgeError('BRIDGE_STOPPED', 'Max for Live bridge stopped before the request completed'),
    );
    this.#clearResolution();

    if (this.#subscribed) {
      try {
        await this.#request(
          'stop',
          {},
          'stopped',
          {},
          { allowWhileStopping: true },
        );
      } catch {
        // Shutdown must still complete when Max is already gone or cannot ack.
      }
      this.#transport.off('message', this.#onMessage);
      this.#subscribed = false;
    }

    return this._setStatus(BRIDGE_STATES.STOPPED, 'Max for Live bridge stopped');
  }

  async getSnapshot(mixId) {
    this.#requireConnected();
    this.#requireMix(mixId);

    if (!this.#hasCompleteSnapshot()) {
      const snapshot = await this.#request(
        'get-snapshot',
        { generation: this.#generation },
        'snapshot',
      );
      if (snapshot.generation !== this.#generation) {
        throw makeBridgeError(
          'BRIDGE_STALE_GENERATION',
          `Ableton snapshot used mapping generation ${snapshot.generation}; expected ${this.#generation}`,
        );
      }
      this.#replaceLevels(snapshot.levels);
    }

    return this.#snapshotForMix(mixId);
  }

  async setLevel(mixId, sourceId, value) {
    this.#requireConnected();
    this.#requireLevel(mixId, sourceId, value);
    const generation = this.#generation;

    const result = await this.#request(
      'set-level',
      { generation, mixId, sourceId, value },
      'level',
      { generation, mixId, sourceId },
    );
    return result;
  }

  #subscribe() {
    if (this.#subscribed) return;
    this.#transport.on('message', this.#onMessage);
    this.#subscribed = true;
  }

  #request(type, fields, expectedType, expected = {}, options = {}) {
    if (this.#stopping && options.allowWhileStopping !== true) {
      return Promise.reject(makeBridgeError('BRIDGE_STOPPED', 'Max for Live bridge is stopping'));
    }

    const requestId = this.#newRequestId();
    const command = this.#makeCommand(type, requestId, fields);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.#pending.get(requestId);
        if (!pending) return;
        this.#pending.delete(requestId);
        this.#rememberCompleted(requestId);
        reject(makeBridgeError(
          'BRIDGE_TIMEOUT',
          `Timed out waiting for Max for Live ${expectedType} response`,
        ));
      }, this.#requestTimeoutMs);

      this.#pending.set(requestId, {
        expectedType,
        expected,
        resolve,
        reject,
        timer,
      });

      try {
        const sendResult = this.#transport.send(command);
        Promise.resolve(sendResult).catch((error) => {
          this.#rejectRequest(
            requestId,
            makeBridgeError(
              'BRIDGE_UNAVAILABLE',
              `Could not send ${type} command to Max for Live`,
              error,
            ),
          );
        });
      } catch (error) {
        this.#rejectRequest(
          requestId,
          makeBridgeError(
            'BRIDGE_UNAVAILABLE',
            `Could not send ${type} command to Max for Live`,
            error,
          ),
        );
      }
    });
  }

  #makeCommand(type, requestId, fields = {}) {
    return Object.freeze({
      protocol: MAX_BRIDGE_PROTOCOL,
      version: MAX_BRIDGE_PROTOCOL_VERSION,
      type,
      requestId,
      ...fields,
    });
  }

  #newRequestId() {
    const requestId = `node-${this.#nextRequestNumber}`;
    this.#nextRequestNumber += 1;
    return requestId;
  }

  #resolveRequest(requestId, value) {
    const pending = this.#pending.get(requestId);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this.#pending.delete(requestId);
    this.#rememberCompleted(requestId);
    pending.resolve(value);
    return true;
  }

  #rejectRequest(requestId, error) {
    const pending = this.#pending.get(requestId);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this.#pending.delete(requestId);
    this.#rememberCompleted(requestId);
    pending.reject(error);
    return true;
  }

  #rejectAll(error) {
    for (const requestId of [...this.#pending.keys()]) this.#rejectRequest(requestId, error);
  }

  #rememberCompleted(requestId) {
    if (this.#completedRequestIds.has(requestId)) return;
    this.#completedRequestIds.add(requestId);
    this.#completedRequestOrder.push(requestId);
    if (this.#completedRequestOrder.length > COMPLETED_REQUEST_LIMIT) {
      const oldest = this.#completedRequestOrder.shift();
      this.#completedRequestIds.delete(oldest);
    }
  }

  #onMessage = (rawMessage) => {
    let message;
    try {
      message = typeof rawMessage === 'string' ? JSON.parse(rawMessage) : rawMessage;
    } catch (error) {
      this.#protocolFailure('Max for Live sent invalid JSON', error);
      return;
    }

    if (
      !isRecord(message)
      || message.protocol !== MAX_BRIDGE_PROTOCOL
      || message.version !== MAX_BRIDGE_PROTOCOL_VERSION
      || typeof message.type !== 'string'
    ) {
      this.#protocolFailure('Max for Live sent an invalid protocol envelope');
      return;
    }

    switch (message.type) {
      case 'resolved':
        this.#handleResolved(message);
        break;
      case 'snapshot':
        this.#handleSnapshot(message);
        break;
      case 'level':
        this.#handleLevel(message);
        break;
      case 'status':
        this.#handleAdapterStatus(message);
        break;
      case 'error':
        this.#handleAdapterError(message);
        break;
      case 'invalidated':
        this.#disconnect('Ableton mapping was invalidated');
        break;
      case 'disconnected':
        this.#disconnect('Max for Live adapter disconnected');
        break;
      case 'stopped':
        this.#handleStopped(message);
        break;
      case 'pong':
        break;
      default:
        this.#protocolFailure(`Max for Live sent unknown event type "${message.type}"`);
    }
  };

  #handleResolved(message) {
    const pending = this.#pendingFor(message, 'resolved');
    if (!pending) return;
    try {
      const normalized = {
        generation: this.#requireGeneration(message.generation, 'resolved generation'),
        levels: this.#normalizeLevels(message.levels, 'resolved levels'),
      };
      // Install the complete resolution before settling the request. Max may
      // deliver an observer update immediately after `resolved`, in the same
      // transport turn, before start()'s promise continuation can run.
      this.#replaceLevels(normalized.levels);
      this.#generation = normalized.generation;
      this.#resolveRequest(message.requestId, normalized);
    } catch (error) {
      this.#protocolFailure(error.message, error);
    }
  }

  #handleSnapshot(message) {
    const pending = this.#pendingFor(message, 'snapshot');
    if (!pending) return;
    try {
      const normalized = {
        generation: this.#requireGeneration(message.generation, 'snapshot generation'),
        levels: this.#normalizeLevels(message.levels, 'snapshot levels'),
      };
      if (this.#generation !== null && normalized.generation !== this.#generation) {
        this.#rejectRequest(
          message.requestId,
          makeBridgeError(
            'BRIDGE_STALE_GENERATION',
            `Snapshot used mapping generation ${normalized.generation}; expected ${this.#generation}`,
          ),
        );
        return;
      }
      this.#resolveRequest(message.requestId, normalized);
    } catch (error) {
      this.#protocolFailure(error.message, error);
    }
  }

  #handleLevel(message) {
    const hasRequestId = typeof message.requestId === 'string' && message.requestId.length > 0;
    if (hasRequestId && this.#completedRequestIds.has(message.requestId)) return;

    const pending = hasRequestId ? this.#pending.get(message.requestId) : null;
    if (pending && pending.expectedType !== 'level') {
      this.#protocolFailure(
        `Max for Live sent level for a request awaiting ${pending.expectedType}`,
      );
      return;
    }
    if (hasRequestId && !pending) return;

    let generation;
    try {
      generation = this.#requireGeneration(message.generation, 'level generation');
      this.#requireLevel(message.mixId, message.sourceId, message.value);
    } catch (error) {
      this.#protocolFailure(error.message, error);
      return;
    }

    if (this.#generation === null) {
      if (pending) {
        this.#rejectRequest(
          message.requestId,
          makeBridgeError('BRIDGE_UNAVAILABLE', 'No resolved Ableton mapping is active'),
        );
      }
      return;
    }
    if (generation !== this.#generation) {
      if (pending) {
        this.#rejectRequest(
          message.requestId,
          makeBridgeError(
            'BRIDGE_STALE_GENERATION',
            `Level used mapping generation ${generation}; expected ${this.#generation}`,
          ),
        );
      }
      if (generation > this.#generation) {
        this.#disconnect('Ableton mapping generation changed; rescan is required');
      }
      return;
    }

    if (pending) {
      const expected = pending.expected;
      if (
        expected.generation !== generation
        || expected.mixId !== message.mixId
        || expected.sourceId !== message.sourceId
      ) {
        this.#protocolFailure('Max for Live level confirmation did not match its command');
        return;
      }
    }

    // A current generation is authoritative even during the narrow interval
    // after `resolved` and before start() changes CONNECTING to CONNECTED.
    this.#levels.get(message.mixId).set(message.sourceId, message.value);
    const update = this._emitLevel(message.mixId, message.sourceId, message.value);
    if (pending) this.#resolveRequest(message.requestId, update);
  }

  #handleAdapterStatus(message) {
    switch (message.state) {
      case 'connecting':
        if (this.status.connected || this.#generation !== null) {
          this.#disconnect('Ableton mapping is being rebuilt; rescan is in progress');
        }
        this._setStatus(BRIDGE_STATES.CONNECTING, 'Max for Live adapter is connecting');
        break;
      case 'connected':
        if (this.#generation !== null && this.status.connected) {
          this._setStatus(BRIDGE_STATES.CONNECTED, 'Max for Live adapter is connected');
        }
        break;
      case 'disconnected':
        this.#disconnect('Max for Live adapter disconnected');
        break;
      case 'invalidated':
        this.#disconnect('Ableton mapping changed; rescan is required');
        break;
      case 'stopped':
        this.#disconnect('Max for Live adapter stopped', true);
        break;
      case 'error':
        this.#failConnection(this.#adapterError(
          'BRIDGE_ADAPTER_ERROR',
          'Max for Live adapter reported an error',
          message.message,
        ));
        break;
      default:
        this.#protocolFailure('Max for Live sent an invalid status state');
    }
  }

  #handleAdapterError(message) {
    const code = typeof message.code === 'string' && ADAPTER_ERROR_CODE_PATTERN.test(message.code)
      ? message.code
      : 'BRIDGE_ADAPTER_ERROR';
    const pending = typeof message.requestId === 'string'
      ? this.#pending.get(message.requestId)
      : null;
    if (pending) {
      const publicMessage = {
        resolved: 'Max for Live could not resolve the configured Ableton mapping',
        snapshot: 'Max for Live could not read the authoritative mixer state',
        level: 'Max for Live rejected the level change',
      }[pending.expectedType] ?? 'Max for Live rejected the bridge request';
      const error = this.#adapterError(code, publicMessage, message.message);
      this.#rejectRequest(message.requestId, error);
      return;
    }
    if (
      typeof message.requestId === 'string'
      && this.#completedRequestIds.has(message.requestId)
    ) {
      return;
    }
    this.#failConnection(this.#adapterError(
      code,
      'Max for Live adapter reported an error',
      message.message,
    ));
  }

  #handleStopped(message) {
    const requestId = typeof message.requestId === 'string' ? message.requestId : null;
    if (requestId && this.#completedRequestIds.has(requestId)) return;
    const pending = requestId ? this.#pending.get(requestId) : null;
    if (pending?.expectedType === 'stopped') {
      this.#resolveRequest(requestId, message);
      return;
    }
    if (pending) {
      this.#protocolFailure(
        `Max for Live sent stopped for a request awaiting ${pending.expectedType}`,
      );
      return;
    }
    this.#disconnect('Max for Live adapter stopped', true);
  }

  #pendingFor(message, expectedType) {
    if (typeof message.requestId !== 'string' || message.requestId.length === 0) {
      this.#protocolFailure(`Max for Live ${expectedType} response has no requestId`);
      return null;
    }
    if (this.#completedRequestIds.has(message.requestId)) return null;
    const pending = this.#pending.get(message.requestId);
    if (!pending) return null;
    if (pending.expectedType !== expectedType) {
      this.#protocolFailure(
        `Max for Live sent ${expectedType} for a request awaiting ${pending.expectedType}`,
      );
      return null;
    }
    return pending;
  }

  #normalizeLevels(rawLevels, label) {
    if (!isRecord(rawLevels)) throw new TypeError(`${label} must be an object`);
    const mixKeys = Object.keys(rawLevels);
    if (
      mixKeys.length !== this.#mixIds.size
      || mixKeys.some((mixId) => !this.#mixIds.has(mixId))
    ) {
      throw new TypeError(`${label} must contain every configured mix and no others`);
    }

    const normalized = {};
    for (const mix of this.#config.mixes) {
      const rawMix = rawLevels[mix.id];
      if (!isRecord(rawMix)) throw new TypeError(`${label}.${mix.id} must be an object`);
      const sourceKeys = Object.keys(rawMix);
      if (
        sourceKeys.length !== this.#sourceIds.size
        || sourceKeys.some((sourceId) => !this.#sourceIds.has(sourceId))
      ) {
        throw new TypeError(
          `${label}.${mix.id} must contain every configured source and no others`,
        );
      }
      normalized[mix.id] = {};
      for (const source of this.#config.sources) {
        const value = rawMix[source.id];
        this.#requireLevel(mix.id, source.id, value);
        normalized[mix.id][source.id] = value;
      }
      Object.freeze(normalized[mix.id]);
    }
    return Object.freeze(normalized);
  }

  #replaceLevels(levels) {
    this.#levels.clear();
    for (const mix of this.#config.mixes) {
      this.#levels.set(mix.id, new Map(
        this.#config.sources.map((source) => [source.id, levels[mix.id][source.id]]),
      ));
    }
  }

  #hasCompleteSnapshot() {
    if (this.#levels.size !== this.#mixIds.size) return false;
    for (const mixId of this.#mixIds) {
      const values = this.#levels.get(mixId);
      if (!values || values.size !== this.#sourceIds.size) return false;
      for (const sourceId of this.#sourceIds) {
        if (!values.has(sourceId)) return false;
      }
    }
    return true;
  }

  #snapshotForMix(mixId) {
    const values = this.#levels.get(mixId);
    if (!values || values.size !== this.#sourceIds.size) {
      throw makeBridgeError(
        'BRIDGE_UNAVAILABLE',
        `No complete authoritative snapshot is available for mix "${mixId}"`,
      );
    }
    return Object.freeze(Object.fromEntries(values));
  }

  #clearResolution() {
    this.#generation = null;
    this.#levels.clear();
  }

  #requireConnected() {
    if (!this.status.connected || this.#generation === null) {
      throw makeBridgeError('BRIDGE_UNAVAILABLE', 'Max for Live bridge is not connected');
    }
  }

  #requireMix(mixId) {
    if (!this.#mixIds.has(mixId)) {
      throw makeBridgeError('UNKNOWN_MIX', `Unknown mix "${mixId}"`);
    }
  }

  #requireLevel(mixId, sourceId, value) {
    this.#requireMix(mixId);
    if (!this.#sourceIds.has(sourceId)) {
      throw makeBridgeError('UNKNOWN_SOURCE', `Unknown source "${sourceId}"`);
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw makeBridgeError('INVALID_LEVEL', 'Level must be a finite number');
    }
    if (value < this.#config.levels.minimum || value > this.#config.levels.maximum) {
      throw makeBridgeError(
        'INVALID_LEVEL',
        `Level must be between ${this.#config.levels.minimum} and ${this.#config.levels.maximum}`,
      );
    }
  }

  #requireGeneration(value, label) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new TypeError(`${label} must be a positive integer`);
    }
    return value;
  }

  #adapterError(code, publicMessage, privateMessage) {
    const cause = typeof privateMessage === 'string' && privateMessage
      ? new Error(privateMessage)
      : undefined;
    return makeBridgeError(code, publicMessage, cause);
  }

  #protocolFailure(detail, cause) {
    const privateCause = cause ?? new Error(detail);
    this.#failConnection(makeBridgeError(
      'BRIDGE_PROTOCOL_ERROR',
      'Max for Live sent invalid bridge data; rescan or reload the device',
      privateCause,
    ));
  }

  #failConnection(error) {
    this.#clearResolution();
    this.#rejectAll(error);
    this._setStatus(BRIDGE_STATES.ERROR, error.message);
  }

  #disconnect(message, stopped = false) {
    const error = makeBridgeError('BRIDGE_UNAVAILABLE', message);
    this.#clearResolution();
    this.#rejectAll(error);
    this._setStatus(stopped ? BRIDGE_STATES.STOPPED : BRIDGE_STATES.DISCONNECTED, message);
  }
}

export default MaxBridge;
