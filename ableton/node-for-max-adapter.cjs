'use strict';

/*
 * Node-for-Max transport scaffold.
 *
 * `max-api` is provided by node.script inside Max. This file is intentionally
 * not imported by the dependency-free mock server. It proves and documents the
 * selector/JSON boundary only; the real MaxBridge bootstrap is a TODO described
 * in docs/max-for-live-integration.md.
 */

const maxApi = require('max-api');

const PROTOCOL_VERSION = 1;
let sequence = 0;

function nextRequestId() {
  sequence += 1;
  return `node-${sequence}`;
}

function stringifyMessage(message) {
  return JSON.stringify({ protocolVersion: PROTOCOL_VERSION, ...message });
}

function parseMessage(atoms) {
  const text = atoms.map(String).join(' ');
  const message = JSON.parse(text);

  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    throw new TypeError('Max event must decode to a JSON object');
  }
  if (message.protocolVersion !== PROTOCOL_VERSION) {
    throw new Error(
      `Unsupported protocolVersion ${String(message.protocolVersion)}`,
    );
  }
  return message;
}

function sendCommand(message) {
  maxApi.outlet('iem.command', stringifyMessage(message));
}

function postError(context, error) {
  const message = error instanceof Error ? error.message : String(error);
  maxApi.post(`[iem-remote] ${context}: ${message}`, maxApi.POST_LEVELS.ERROR);
}

/*
 * The completed Max-side controller will send:
 *   iem.event <one JSON object>
 *
 * This handler validates framing now. TODO: forward valid events to a
 * server/bridges/max-bridge.js transport instead of only logging them.
 */
maxApi.addHandler('iem.event', (...atoms) => {
  try {
    const event = parseMessage(atoms);
    maxApi.post(
      `[iem-remote] received Max event ${String(event.type || 'unknown')}`,
      maxApi.POST_LEVELS.INFO,
    );
  } catch (error) {
    postError('invalid iem.event', error);
  }
});

/* Manual wiring/protocol diagnostic from a Max message box. */
maxApi.addHandler('iem.transport.ping', () => {
  sendCommand({ type: 'ping', requestId: nextRequestId() });
});

maxApi.addHandler('iem.transport.status', () => {
  maxApi.outlet(
    'iem.adapter-status',
    stringifyMessage({
      type: 'adapter-status',
      state: 'scaffold-only',
      connected: false,
      message: 'MaxBridge and Live API controller are not implemented',
    }),
  );
});

maxApi.post(
  '[iem-remote] Node-for-Max scaffold loaded; real Ableton control is disabled',
  maxApi.POST_LEVELS.WARN,
);
