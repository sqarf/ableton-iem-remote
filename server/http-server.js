import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MixerServiceError } from './mixer-service.js';

const DEFAULT_PUBLIC_DIRECTORY = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const MIME_TYPES = Object.freeze({
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
});

class HttpError extends Error {
  constructor(statusCode, code, message, details) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

function setSecurityHeaders(response) {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'",
  );
}

function setApiHeaders(response) {
  setSecurityHeaders(response);
  response.setHeader('Cache-Control', 'no-store');
}

function sendJson(response, statusCode, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  setApiHeaders(response);
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...extraHeaders,
  });
  response.end(body);
}

function sendError(response, error) {
  if (response.headersSent) {
    response.end();
    return;
  }
  const known = error instanceof HttpError || error instanceof MixerServiceError;
  const statusCode = known && Number.isInteger(error.statusCode) ? error.statusCode : 500;
  const code = known && typeof error.code === 'string' ? error.code : 'INTERNAL_ERROR';
  const message = known ? error.message : 'An unexpected server error occurred';
  sendJson(response, statusCode, {
    error: {
      code,
      message,
      ...(known && error.details !== undefined ? { details: error.details } : {}),
    },
  });
}

async function readBody(request, limit) {
  const declaredLength = Number(request.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    request.resume();
    throw new HttpError(413, 'BODY_TOO_LARGE', `Request body exceeds ${limit} bytes`);
  }
  if (request.readableEnded) return Buffer.alloc(0);

  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    const cleanup = () => {
      request.off('data', onData);
      request.off('end', onEnd);
      request.off('aborted', onAborted);
      request.off('error', onError);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onData = (chunk) => {
      total += chunk.length;
      if (total > limit) {
        chunks.length = 0;
        fail(new HttpError(413, 'BODY_TOO_LARGE', `Request body exceeds ${limit} bytes`));
        request.resume();
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolvePromise(Buffer.concat(chunks));
    };
    const onAborted = () => fail(new HttpError(400, 'REQUEST_ABORTED', 'Request body was interrupted'));
    const onError = (error) => fail(error);
    request.on('data', onData);
    request.once('end', onEnd);
    request.once('aborted', onAborted);
    request.once('error', onError);
  });
}

async function readJsonBody(request, limit) {
  const contentType = request.headers['content-type'];
  if (typeof contentType !== 'string' || !/^application\/json(?:\s*;|$)/i.test(contentType)) {
    throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json');
  }
  const body = await readBody(request, limit);
  if (body.length === 0) {
    throw new HttpError(400, 'INVALID_JSON', 'Request body must contain JSON');
  }
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    throw new HttpError(400, 'INVALID_JSON', 'Request body is not valid JSON');
  }
}

function publicConfig(config, service) {
  return {
    version: config.version,
    levels: config.levels,
    members: config.members.map(({ id, name, mixId }) => ({ id, name, mixId })),
    mixes: config.mixes.map(({ id, name }) => ({ id, name })),
    sources: config.sources.map(({ id, name }) => ({ id, name })),
    bridge: service.getStatus(),
  };
}

function decodeSegments(pathname) {
  try {
    return pathname.split('/').filter(Boolean).map((segment) => decodeURIComponent(segment));
  } catch {
    throw new HttpError(400, 'INVALID_PATH', 'URL path contains invalid escaping');
  }
}

function sseEvent(response, eventName, payload) {
  return response.write(`event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function openEventStream(request, response, url, service) {
  const memberId = url.searchParams.get('memberId');
  const mixId = url.searchParams.get('mixId');
  if (!memberId || !mixId) {
    throw new HttpError(400, 'INVALID_QUERY', 'memberId and mixId query parameters are required');
  }
  const snapshot = service.getState(memberId, mixId);

  setApiHeaders(response);
  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  let blocked = false;
  let closed = false;
  const writeRaw = (text) => {
    if (blocked || closed) return false;
    if (!response.write(text)) blocked = true;
    return !blocked;
  };
  const writeEvent = (eventName, payload) => {
    if (blocked || closed) return false;
    if (!sseEvent(response, eventName, payload)) blocked = true;
    return !blocked;
  };
  writeRaw('retry: 2000\n\n');
  writeEvent('snapshot', snapshot);

  const onLevel = (update) => {
    if (update.memberId === memberId && update.mixId === mixId) {
      writeEvent('level', update);
    }
  };
  const onStatus = (bridge) => writeEvent('status', { bridge });
  const onReady = () => {
    try {
      writeEvent('snapshot', service.getState(memberId, mixId));
    } catch {
      // A simultaneous stop will publish another status; the stream can stay
      // open for the next completed bridge generation.
    }
  };
  const onDrain = () => {
    if (closed) return;
    blocked = false;
    try {
      writeEvent('snapshot', service.getState(memberId, mixId));
    } catch {
      response.end();
    }
  };
  service.on('level', onLevel);
  service.on('status', onStatus);
  service.on('ready', onReady);
  response.on('drain', onDrain);

  const keepAlive = setInterval(() => writeRaw(': keepalive\n\n'), 15_000);
  keepAlive.unref();
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(keepAlive);
    service.off('level', onLevel);
    service.off('status', onStatus);
    service.off('ready', onReady);
    response.off('drain', onDrain);
  };
  request.once('close', close);
  response.once('close', close);
}

async function handleApi(request, response, url, config, service) {
  const segments = decodeSegments(url.pathname);
  const method = request.method ?? 'GET';

  if (segments.length === 2 && segments[1] === 'health') {
    if (method !== 'GET') {
      throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'This endpoint only accepts GET');
    }
    const bridge = service.getStatus();
    sendJson(response, bridge.connected ? 200 : 503, { ok: bridge.connected, bridge });
    return;
  }

  if (segments.length === 2 && segments[1] === 'config') {
    if (method !== 'GET') {
      throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'This endpoint only accepts GET');
    }
    sendJson(response, 200, publicConfig(config, service));
    return;
  }

  if (segments.length === 2 && segments[1] === 'events') {
    if (method !== 'GET') {
      throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'This endpoint only accepts GET');
    }
    openEventStream(request, response, url, service);
    return;
  }

  const isMemberMix = segments.length >= 6
    && segments[0] === 'api'
    && segments[1] === 'members'
    && segments[3] === 'mixes';
  if (isMemberMix) {
    const memberId = segments[2];
    const mixId = segments[4];

    if (segments.length === 6 && segments[5] === 'state') {
      if (method !== 'GET') {
        throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'This endpoint only accepts GET');
      }
      sendJson(response, 200, service.getState(memberId, mixId));
      return;
    }

    if (segments.length === 7 && segments[5] === 'sources') {
      if (method !== 'PUT') {
        throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'This endpoint only accepts PUT');
      }
      const body = await readJsonBody(request, config.server.requestBodyLimitBytes);
      if (!body || typeof body !== 'object' || Array.isArray(body) || !Object.hasOwn(body, 'value')) {
        throw new HttpError(400, 'INVALID_REQUEST', 'JSON body must be an object containing value');
      }
      if (Object.keys(body).some((key) => key !== 'value')) {
        throw new HttpError(400, 'INVALID_REQUEST', 'JSON body may only contain value');
      }
      const result = await service.setLevel(memberId, mixId, segments[6], body.value);
      sendJson(response, 200, result);
      return;
    }

    if (segments.length === 6 && segments[5] === 'reset') {
      if (method !== 'POST') {
        throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'This endpoint only accepts POST');
      }
      const body = await readBody(request, config.server.requestBodyLimitBytes);
      if (body.length > 0) {
        throw new HttpError(400, 'INVALID_REQUEST', 'Reset requests must not include a body');
      }
      sendJson(response, 200, await service.resetMix(memberId, mixId));
      return;
    }
  }

  throw new HttpError(404, 'API_NOT_FOUND', 'API endpoint not found');
}

async function serveStatic(request, response, url, publicDirectory) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Static resources only accept GET and HEAD');
  }
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    throw new HttpError(400, 'INVALID_PATH', 'URL path contains invalid escaping');
  }
  if (pathname.includes('\u0000')) throw new HttpError(400, 'INVALID_PATH', 'Invalid URL path');
  const requested = pathname === '/' ? '/index.html' : pathname;
  let filePath = resolve(publicDirectory, `.${requested}`);
  const rootPrefix = publicDirectory.endsWith(sep) ? publicDirectory : `${publicDirectory}${sep}`;
  if (filePath !== publicDirectory && !filePath.startsWith(rootPrefix)) {
    throw new HttpError(403, 'PATH_FORBIDDEN', 'Requested path is outside the public directory');
  }

  let fileStats;
  try {
    fileStats = await stat(filePath);
    if (fileStats.isDirectory()) {
      filePath = resolve(filePath, 'index.html');
      fileStats = await stat(filePath);
    }
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
      throw new HttpError(404, 'NOT_FOUND', 'Resource not found');
    }
    throw error;
  }
  if (!fileStats.isFile()) throw new HttpError(404, 'NOT_FOUND', 'Resource not found');

  const [canonicalRoot, canonicalFile] = await Promise.all([
    realpath(publicDirectory),
    realpath(filePath),
  ]);
  const canonicalPrefix = canonicalRoot.endsWith(sep) ? canonicalRoot : `${canonicalRoot}${sep}`;
  if (canonicalFile !== canonicalRoot && !canonicalFile.startsWith(canonicalPrefix)) {
    throw new HttpError(403, 'PATH_FORBIDDEN', 'Requested path is outside the public directory');
  }
  filePath = canonicalFile;

  setSecurityHeaders(response);
  response.writeHead(200, {
    'Content-Type': MIME_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': fileStats.size,
    'Cache-Control': 'no-cache',
  });
  if (request.method === 'HEAD') {
    response.end();
    return;
  }
  const stream = createReadStream(filePath);
  stream.on('error', () => response.destroy());
  stream.pipe(response);
}

export function createRequestHandler({ config, service, publicDir = DEFAULT_PUBLIC_DIRECTORY }) {
  if (!config || !service) throw new TypeError('createRequestHandler requires config and service');
  const publicDirectory = resolve(publicDir);
  return async function requestHandler(request, response) {
    try {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
        await handleApi(request, response, url, config, service);
      } else {
        await serveStatic(request, response, url, publicDirectory);
      }
    } catch (error) {
      if (!(error instanceof HttpError) && !(error instanceof MixerServiceError)) {
        console.error('Request failed:', error);
      }
      sendError(response, error);
    }
  };
}

/** Return a normal node:http Server so tests can listen on an ephemeral port. */
export function createHttpServer(options) {
  const normalized = options?.service
    ? options
    : { ...options, service: options?.mixerService };
  return createServer(createRequestHandler(normalized));
}

export default createHttpServer;
