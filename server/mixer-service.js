import { EventEmitter } from 'node:events';

export class MixerServiceError extends Error {
  constructor(code, message, statusCode = 500, options = {}) {
    super(message, options);
    this.name = 'MixerServiceError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function unavailableError(message = 'Ableton bridge is unavailable', cause) {
  return new MixerServiceError('BRIDGE_UNAVAILABLE', message, 503, { cause });
}

function normalizeStatus(status) {
  const state = typeof status?.state === 'string' ? status.state : 'disconnected';
  return Object.freeze({
    state,
    connected: status?.connected === true,
    ...(typeof status?.message === 'string' && status.message ? { message: status.message } : {}),
  });
}

/**
 * Owns authorization, clamping, coalescing, and bridge-confirmed state.
 * Construct with either new MixerService({ config, bridge }) or
 * new MixerService(config, bridge).
 */
export class MixerService extends EventEmitter {
  #config;
  #bridge;
  #members;
  #mixes;
  #sources;
  #memberByMix;
  #values = new Map();
  #revisions = new Map();
  #pendingWrites = new Map();
  #inFlight = new Set();
  #activeKeys = new Set();
  #startPromise = null;
  #started = false;
  #stopping = false;
  #status;

  constructor(configOrOptions, maybeBridge) {
    super();
    const options = maybeBridge
      ? { config: configOrOptions, bridge: maybeBridge }
      : configOrOptions;
    if (!options?.config || !options?.bridge) {
      throw new TypeError('MixerService requires { config, bridge }');
    }
    this.#config = options.config;
    this.#bridge = options.bridge;
    this.#members = new Map(this.#config.members.map((member) => [member.id, member]));
    this.#mixes = new Map(this.#config.mixes.map((mix) => [mix.id, mix]));
    this.#sources = new Map(this.#config.sources.map((source) => [source.id, source]));
    this.#memberByMix = new Map(this.#config.members.map((member) => [member.mixId, member]));
    this.#status = normalizeStatus(this.#bridge.getStatus?.() ?? this.#bridge.status);

    for (const mix of this.#config.mixes) {
      this.#values.set(mix.id, new Map());
      this.#revisions.set(mix.id, 0);
    }
  }

  get config() {
    return this.#config;
  }

  get bridgeStatus() {
    return this.#status;
  }

  getStatus() {
    return this.#status;
  }

  start() {
    if (this.#startPromise) return this.#startPromise;
    if (this.#started && !this.#stopping) return Promise.resolve(this.#status);
    if (this.#stopping) {
      return Promise.reject(
        new MixerServiceError('SERVICE_UNAVAILABLE', 'Mixer service is stopping', 503),
      );
    }
    this.#startPromise = (async () => {
      try {
        return await this.#startInternal();
      } finally {
        this.#startPromise = null;
      }
    })();
    return this.#startPromise;
  }

  async #startInternal() {
    this.#stopping = false;
    for (const mix of this.#config.mixes) {
      this.#values.get(mix.id).clear();
      this.#revisions.set(mix.id, 0);
    }
    this.#bridge.on('status', this.#onBridgeStatus);
    this.#bridge.on('level', this.#onBridgeLevel);

    try {
      await this.#bridge.start();
      for (const mix of this.#config.mixes) {
        const snapshot = await this.#bridge.getSnapshot(mix.id);
        this.#loadInitialSnapshot(mix.id, snapshot);
      }
      this.#status = normalizeStatus(this.#bridge.getStatus?.() ?? this.#bridge.status);
      this.#started = true;
      return this.#status;
    } catch (error) {
      this.#started = false;
      this.#bridge.off('status', this.#onBridgeStatus);
      this.#bridge.off('level', this.#onBridgeLevel);
      try {
        await this.#bridge.stop();
      } catch {
        // Startup's original error is more useful than a cleanup error.
      }
      const message = error instanceof Error ? error.message : String(error);
      const serviceError = unavailableError(`Could not start Ableton bridge: ${message}`, error);
      this.#status = Object.freeze({
        state: 'error',
        connected: false,
        message: serviceError.message,
      });
      this.emit('status', this.#status);
      throw serviceError;
    }
  }

  getState(memberId, mixId) {
    this.#assertStarted();
    this.#authorize(memberId, mixId);
    const values = this.#values.get(mixId);
    const levels = {};
    for (const source of this.#config.sources) {
      const value = values.get(source.id);
      if (typeof value !== 'number') {
        throw unavailableError(`No authoritative value is available for source "${source.id}"`);
      }
      levels[source.id] = value;
    }
    return Object.freeze({
      memberId,
      mixId,
      revision: this.#revisions.get(mixId),
      levels: Object.freeze(levels),
      bridge: this.#status,
    });
  }

  getSnapshot(memberId, mixId) {
    return this.getState(memberId, mixId);
  }

  async setLevel(memberId, mixId, sourceId, requestedValue) {
    this.#assertStarted();
    this.#authorize(memberId, mixId);
    this.#requireSource(sourceId);
    if (typeof requestedValue !== 'number' || !Number.isFinite(requestedValue)) {
      throw new MixerServiceError('INVALID_LEVEL', 'value must be a finite number', 400);
    }
    if (!this.#status.connected) throw unavailableError();

    const value = Math.min(
      this.#config.levels.maximum,
      Math.max(this.#config.levels.minimum, requestedValue),
    );
    return this.#enqueueWrite(memberId, mixId, sourceId, value);
  }

  setSourceLevel(memberId, mixId, sourceId, value) {
    return this.setLevel(memberId, mixId, sourceId, value);
  }

  async resetMix(memberId, mixId) {
    this.#assertStarted();
    this.#authorize(memberId, mixId);
    if (!this.#status.connected) throw unavailableError();
    await Promise.all(
      this.#config.sources.map((source) => (
        this.setLevel(memberId, mixId, source.id, source.startingLevels[mixId])
      )),
    );
    return this.getState(memberId, mixId);
  }

  reset(memberId, mixId) {
    return this.resetMix(memberId, mixId);
  }

  async stop() {
    if (this.#startPromise) {
      try {
        await this.#startPromise;
      } catch {
        return;
      }
    }
    if (!this.#started && !this.#stopping) return;
    this.#stopping = true;

    const stoppedError = new MixerServiceError(
      'SERVICE_STOPPED',
      'Mixer service stopped before the write reached Ableton',
      503,
    );
    for (const pending of this.#pendingWrites.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      for (const waiter of pending.waiters) waiter.reject(stoppedError);
    }
    this.#pendingWrites.clear();

    if (this.#inFlight.size > 0) {
      await Promise.allSettled([...this.#inFlight]);
    }
    try {
      await this.#bridge.stop();
    } finally {
      this.#bridge.off('status', this.#onBridgeStatus);
      this.#bridge.off('level', this.#onBridgeLevel);
      this.#started = false;
      this.#stopping = false;
      this.#status = normalizeStatus(this.#bridge.getStatus?.() ?? this.#bridge.status);
    }
  }

  #assertStarted() {
    if (!this.#started || this.#stopping) {
      throw new MixerServiceError('SERVICE_UNAVAILABLE', 'Mixer service is not running', 503);
    }
  }

  #authorize(memberId, mixId) {
    const member = this.#members.get(memberId);
    if (!member) {
      throw new MixerServiceError('MEMBER_NOT_FOUND', `Unknown member "${memberId}"`, 404);
    }
    if (!this.#mixes.has(mixId)) {
      throw new MixerServiceError('MIX_NOT_FOUND', `Unknown mix "${mixId}"`, 404);
    }
    if (member.mixId !== mixId) {
      throw new MixerServiceError(
        'MIX_FORBIDDEN',
        `Member "${memberId}" may only access mix "${member.mixId}"`,
        403,
      );
    }
    return member;
  }

  #requireSource(sourceId) {
    const source = this.#sources.get(sourceId);
    if (!source) {
      throw new MixerServiceError('SOURCE_NOT_FOUND', `Unknown source "${sourceId}"`, 404);
    }
    return source;
  }

  #loadInitialSnapshot(mixId, snapshot) {
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
      throw new Error(`Bridge returned an invalid snapshot for mix "${mixId}"`);
    }
    const values = this.#values.get(mixId);
    for (const source of this.#config.sources) {
      const value = snapshot[source.id];
      if (
        typeof value !== 'number'
        || !Number.isFinite(value)
        || value < this.#config.levels.minimum
        || value > this.#config.levels.maximum
      ) {
        throw new Error(`Bridge returned an invalid value for ${mixId}/${source.id}`);
      }
      if (!values.has(source.id)) values.set(source.id, value);
    }
  }

  #enqueueWrite(memberId, mixId, sourceId, value) {
    const key = `${mixId}\u0000${sourceId}`;
    let pending = this.#pendingWrites.get(key);
    if (!pending) {
      pending = { key, memberId, mixId, sourceId, value, waiters: [], timer: null };
      this.#pendingWrites.set(key, pending);
      const flush = () => {
        pending.timer = null;
        this.#flushWrite(pending);
      };
      if (this.#config.server.writeCoalesceMs === 0) {
        queueMicrotask(flush);
      } else {
        pending.timer = setTimeout(flush, this.#config.server.writeCoalesceMs);
      }
    } else {
      pending.memberId = memberId;
      pending.value = value;
    }

    return new Promise((resolve, reject) => {
      pending.waiters.push({ resolve, reject });
    });
  }

  #flushWrite(pending) {
    if (this.#pendingWrites.get(pending.key) !== pending) return;
    if (this.#activeKeys.has(pending.key)) return;
    this.#pendingWrites.delete(pending.key);

    if (this.#stopping || !this.#started) {
      const error = new MixerServiceError('SERVICE_STOPPED', 'Mixer service is stopping', 503);
      for (const waiter of pending.waiters) waiter.reject(error);
      return;
    }

    this.#activeKeys.add(pending.key);
    const operation = (async () => {
      try {
        const authoritative = await this.#bridge.setLevel(
          pending.mixId,
          pending.sourceId,
          pending.value,
        );
        if (
          !authoritative
          || typeof authoritative !== 'object'
          || authoritative.mixId !== pending.mixId
          || authoritative.sourceId !== pending.sourceId
        ) {
          throw new Error(
            `Bridge returned an invalid confirmation for ${pending.mixId}/${pending.sourceId}`,
          );
        }
        const result = this.#acceptAuthoritativeLevel(authoritative);
        if (!result) {
          throw new Error(
            `Bridge returned an invalid authoritative value for ${pending.mixId}/${pending.sourceId}`,
          );
        }
        for (const waiter of pending.waiters) waiter.resolve(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const serviceError = error instanceof MixerServiceError
          ? error
          : unavailableError(`Ableton bridge rejected the level change: ${message}`, error);
        for (const waiter of pending.waiters) waiter.reject(serviceError);
      }
    })();
    this.#inFlight.add(operation);
    const releaseKey = () => {
      this.#inFlight.delete(operation);
      this.#activeKeys.delete(pending.key);
      const queued = this.#pendingWrites.get(pending.key);
      if (queued && queued.timer === null) this.#flushWrite(queued);
    };
    operation.then(releaseKey, releaseKey);
  }

  #acceptAuthoritativeLevel(update) {
    const { mixId, sourceId, value } = update ?? {};
    if (!this.#mixes.has(mixId) || !this.#sources.has(sourceId)) return null;
    if (
      typeof value !== 'number'
      || !Number.isFinite(value)
      || value < this.#config.levels.minimum
      || value > this.#config.levels.maximum
    ) {
      return null;
    }
    const values = this.#values.get(mixId);
    if (Object.is(values.get(sourceId), value)) return this.#makeLevelUpdate(mixId, sourceId);
    values.set(sourceId, value);
    this.#revisions.set(mixId, this.#revisions.get(mixId) + 1);
    const event = this.#makeLevelUpdate(mixId, sourceId);
    this.emit('level', event);
    return event;
  }

  #makeLevelUpdate(mixId, sourceId) {
    const member = this.#memberByMix.get(mixId);
    return Object.freeze({
      memberId: member.id,
      mixId,
      sourceId,
      value: this.#values.get(mixId).get(sourceId),
      revision: this.#revisions.get(mixId),
    });
  }

  #onBridgeStatus = (status) => {
    this.#status = normalizeStatus(status);
    this.emit('status', this.#status);
  };

  #onBridgeLevel = (update) => {
    this.#acceptAuthoritativeLevel(update);
  };
}

export default MixerService;
