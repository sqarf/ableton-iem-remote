import { EventEmitter } from 'node:events';

export const BRIDGE_STATES = Object.freeze({
  STOPPED: 'stopped',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  DISCONNECTED: 'disconnected',
  ERROR: 'error',
});

export class BridgeError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = 'BridgeError';
    this.code = code;
  }
}

/**
 * Server-facing bridge contract.
 *
 * Adapters emit:
 *   status -> { state, connected, message? }
 *   level  -> { mixId, sourceId, value }
 *
 * `level` is authoritative: an adapter emits it only after the backing mixer has
 * accepted/read the value. setLevel() resolves to that same authoritative event.
 * getSnapshot() may return an object or a Promise for an object keyed by source ID.
 */
export class Bridge extends EventEmitter {
  #status = Object.freeze({
    state: BRIDGE_STATES.STOPPED,
    connected: false,
    message: 'Bridge is stopped',
  });

  get status() {
    return this.#status;
  }

  getStatus() {
    return this.#status;
  }

  _setStatus(state, message) {
    const status = Object.freeze({
      state,
      connected: state === BRIDGE_STATES.CONNECTED,
      ...(message ? { message } : {}),
    });
    if (
      status.state === this.#status.state
      && status.connected === this.#status.connected
      && status.message === this.#status.message
    ) {
      return status;
    }
    this.#status = status;
    this.emit('status', status);
    return status;
  }

  _emitLevel(mixId, sourceId, value) {
    const update = Object.freeze({ mixId, sourceId, value });
    this.emit('level', update);
    return update;
  }

  async start() {
    throw new BridgeError('BRIDGE_NOT_IMPLEMENTED', 'Bridge start() is not implemented');
  }

  async stop() {
    throw new BridgeError('BRIDGE_NOT_IMPLEMENTED', 'Bridge stop() is not implemented');
  }

  async getSnapshot(_mixId) {
    throw new BridgeError('BRIDGE_NOT_IMPLEMENTED', 'Bridge getSnapshot() is not implemented');
  }

  async setLevel(_mixId, _sourceId, _value) {
    throw new BridgeError('BRIDGE_NOT_IMPLEMENTED', 'Bridge setLevel() is not implemented');
  }
}
