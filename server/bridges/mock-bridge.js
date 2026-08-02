import { BRIDGE_STATES, Bridge, BridgeError } from './bridge.js';

function delay(milliseconds) {
  return milliseconds > 0
    ? new Promise((resolve) => setTimeout(resolve, milliseconds))
    : Promise.resolve();
}

/** A deterministic in-process implementation of the Ableton bridge contract. */
export class MockBridge extends Bridge {
  #config;
  #levels = new Map();
  #sourceIds;
  #latencyMs;

  constructor(config, { latencyMs = 0 } = {}) {
    super();
    if (!Number.isFinite(latencyMs) || latencyMs < 0) {
      throw new TypeError('latencyMs must be a non-negative finite number');
    }
    this.#config = config;
    this.#latencyMs = latencyMs;
    this.#sourceIds = new Set(config.sources.map(({ id }) => id));

    for (const mix of config.mixes) {
      const values = new Map();
      for (const source of config.sources) {
        values.set(source.id, source.startingLevels[mix.id]);
      }
      this.#levels.set(mix.id, values);
    }
  }

  async start() {
    if (this.status.connected) return this.status;
    this._setStatus(BRIDGE_STATES.CONNECTING, 'Starting mock Ableton bridge');
    await delay(this.#latencyMs);
    return this._setStatus(BRIDGE_STATES.CONNECTED, 'Mock Ableton bridge connected');
  }

  async stop() {
    if (this.status.state === BRIDGE_STATES.STOPPED) return this.status;
    return this._setStatus(BRIDGE_STATES.STOPPED, 'Mock Ableton bridge stopped');
  }

  getSnapshot(mixId) {
    const values = this.#requireMix(mixId);
    return Object.freeze(Object.fromEntries(values));
  }

  async setLevel(mixId, sourceId, value) {
    this.#requireConnected();
    this.#requireLevel(mixId, sourceId, value);
    await delay(this.#latencyMs);
    this.#requireConnected();
    const values = this.#requireMix(mixId);
    values.set(sourceId, value);
    return this._emitLevel(mixId, sourceId, value);
  }

  /** Simulate an observed change made directly in Ableton. */
  simulateExternalChange(mixId, sourceId, value) {
    this.#requireConnected();
    this.#requireLevel(mixId, sourceId, value);
    const values = this.#requireMix(mixId);
    values.set(sourceId, value);
    return this._emitLevel(mixId, sourceId, value);
  }

  #requireConnected() {
    if (!this.status.connected) {
      throw new BridgeError('BRIDGE_UNAVAILABLE', 'Mock Ableton bridge is not connected');
    }
  }

  #requireMix(mixId) {
    const values = this.#levels.get(mixId);
    if (!values) throw new BridgeError('UNKNOWN_MIX', `Unknown mix "${mixId}"`);
    return values;
  }

  #requireLevel(mixId, sourceId, value) {
    this.#requireMix(mixId);
    if (!this.#sourceIds.has(sourceId)) {
      throw new BridgeError('UNKNOWN_SOURCE', `Unknown source "${sourceId}"`);
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new BridgeError('INVALID_LEVEL', 'Level must be a finite number');
    }
    if (value < this.#config.levels.minimum || value > this.#config.levels.maximum) {
      throw new BridgeError(
        'INVALID_LEVEL',
        `Level must be between ${this.#config.levels.minimum} and ${this.#config.levels.maximum}`,
      );
    }
  }
}

export default MockBridge;
