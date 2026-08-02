'use strict';

const path = require('node:path');

const config = require(path.resolve(__dirname, '../../../config/band.json'));
const handlers = new Map();
const levels = Object.fromEntries(config.mixes.map((mix) => [
  mix.id,
  Object.fromEntries(config.sources.map((source) => [
    source.id,
    source.startingLevels[mix.id],
  ])),
]));
let generation = 0;

function notify(payload) {
  if (process.connected && typeof process.send === 'function') process.send(payload);
}

function emitEvent(message) {
  setImmediate(() => handlers.get('iem.event')?.(JSON.stringify({
    protocol: 'iem-remote',
    version: 1,
    ...message,
  })));
}

function handleCommand(command) {
  switch (command.type) {
    case 'resolve':
      generation += 1;
      emitEvent({
        type: 'resolved',
        requestId: command.requestId,
        generation,
        levels,
      });
      break;
    case 'get-snapshot':
      emitEvent({
        type: 'snapshot',
        requestId: command.requestId,
        generation,
        levels,
      });
      break;
    case 'set-level':
      levels[command.mixId][command.sourceId] = command.value;
      emitEvent({
        type: 'level',
        requestId: command.requestId,
        generation,
        mixId: command.mixId,
        sourceId: command.sourceId,
        value: command.value,
      });
      break;
    case 'ping':
      emitEvent({ type: 'pong', requestId: command.requestId });
      break;
    case 'stop':
      emitEvent({ type: 'stopped', requestId: command.requestId });
      break;
    default:
      emitEvent({
        type: 'error',
        requestId: command.requestId,
        code: 'UNKNOWN_COMMAND',
        message: `Unknown command ${String(command.type)}`,
      });
  }
}

exports.POST_LEVELS = Object.freeze({ INFO: 'info', WARN: 'warn', ERROR: 'error' });

exports.addHandler = function addHandler(selector, handler) {
  handlers.set(selector, handler);
};

exports.post = function post(message, level) {
  notify({ type: 'post', message: String(message), level });
};

exports.outlet = function outlet(selector, payload) {
  notify({ type: 'outlet', selector, payload: String(payload) });
  if (selector === 'iem.command') handleCommand(JSON.parse(String(payload)));
};

process.on('message', (message) => {
  if (!message || typeof message !== 'object') return;
  if (message.type === 'invoke') handlers.get(message.selector)?.(...(message.atoms ?? []));
  if (message.type === 'external-level') {
    levels[message.mixId][message.sourceId] = message.value;
    emitEvent({
      type: 'level',
      generation,
      mixId: message.mixId,
      sourceId: message.sourceId,
      value: message.value,
    });
  }
  if (message.type === 'disconnect') {
    emitEvent({
      type: 'status',
      state: 'disconnected',
      connected: false,
      message: 'Simulated topology invalidation',
    });
  }
  if (message.type === 'exit') process.exit(0);
});
