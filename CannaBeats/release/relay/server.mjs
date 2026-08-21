import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const AUDIO_CONTRACT = '1';
export const AUDIO_CHANNELS = 2;
export const AUDIO_ENCODING = 's16le';
export const AUDIO_FRAME_BYTES = 4;
export const MAX_LISTENERS = 9;
export const MAX_HEADER_BYTES = 8 * 1024;
export const MAX_PUBLISHER_CHUNK_BYTES = 16 * 1024;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SECRET_PATTERN = /^[0-9A-Za-z_-]{22,128}$/u;
const RATE_PATTERN = /^(44100|48000)$/u;
const GENERATION_PATTERN = /^[1-9][0-9]{0,8}$/u;

function validSecret(value) {
  return typeof value === 'string' && SECRET_PATTERN.test(value);
}

function bearer(request, expected) {
  return request.headers.authorization === `Bearer ${expected}`;
}

function scalarHeader(request, name) {
  const value = request.headers[name];
  return typeof value === 'string' ? value : null;
}

function audioIdentity(request, { connection = false, format = false } = {}) {
  const sessionId = scalarHeader(request, 'x-cannabeats-audio-session');
  const generationText = scalarHeader(request, 'x-cannabeats-audio-generation');
  const connectionId = connection
    ? scalarHeader(request, 'x-cannabeats-audio-connection') : null;
  const rateText = format ? scalarHeader(request, 'x-cannabeats-audio-rate') : null;
  if (!UUID_PATTERN.test(sessionId ?? '') || !GENERATION_PATTERN.test(generationText ?? '')
      || (connection && !UUID_PATTERN.test(connectionId ?? ''))
      || (format && (!RATE_PATTERN.test(rateText ?? '')
        || scalarHeader(request, 'x-cannabeats-audio-channels') !== String(AUDIO_CHANNELS)
        || scalarHeader(request, 'x-cannabeats-audio-encoding') !== AUDIO_ENCODING))) {
    return null;
  }
  return Object.freeze({
    sessionId,
    generation: Number(generationText),
    connectionId,
    rate: format ? Number(rateText) : null,
  });
}

function audioHeaders(identity) {
  return {
    'cache-control': 'no-store',
    'content-type': 'application/octet-stream',
    'x-cannabeats-audio-contract': AUDIO_CONTRACT,
    'x-cannabeats-audio-session': identity.sessionId,
    'x-cannabeats-audio-generation': String(identity.generation),
    'x-cannabeats-audio-rate': String(identity.rate),
    'x-cannabeats-audio-channels': String(AUDIO_CHANNELS),
    'x-cannabeats-audio-encoding': AUDIO_ENCODING,
  };
}

function finiteResponse(response, status, code) {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  const body = JSON.stringify({ code });
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
    'content-type': 'application/json',
  });
  response.end(body);
}

export function createAudioRelay({ ingestToken, listenToken }) {
  if (!validSecret(ingestToken) || !validSecret(listenToken) || ingestToken === listenToken) {
    throw new Error('invalid_configuration');
  }
  let publisher = null;
  const counters = {
    acceptedBytes: 0,
    droppedListeners: 0,
    malformedPublisherEnds: 0,
    maxForwardedChunkBytes: 0,
    publisherConnections: 0,
  };

  function closeListeners(active) {
    for (const response of active.listeners) response.destroy();
    active.listeners.clear();
  }

  function finishPublisher(active, { malformed = false } = {}) {
    if (active.finished) return;
    active.finished = true;
    if (malformed) counters.malformedPublisherEnds += 1;
    closeListeners(active);
    if (publisher === active) publisher = null;
    if (!active.response.writableEnded) active.response.end();
  }

  const server = createServer({ maxHeaderSize: MAX_HEADER_BYTES }, (request, response) => {
    let url;
    try { url = new URL(request.url ?? '/', 'http://relay.invalid'); } catch {
      finiteResponse(response, 400, 'invalid_request');
      return;
    }
    if (url.search || scalarHeader(request, 'x-cannabeats-audio-contract') !== AUDIO_CONTRACT) {
      finiteResponse(response, 400, 'invalid_request');
      return;
    }

    if (request.method === 'GET' && url.pathname === '/health') {
      const body = JSON.stringify({
        ok: true,
        publisherActive: publisher !== null,
        listeners: publisher?.listeners.size ?? 0,
        acceptedBytes: counters.acceptedBytes,
        droppedListeners: counters.droppedListeners,
        malformedPublisherEnds: counters.malformedPublisherEnds,
        maxForwardedChunkBytes: counters.maxForwardedChunkBytes,
        publisherConnections: counters.publisherConnections,
      });
      response.writeHead(200, {
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(body),
        'content-type': 'application/json',
      });
      response.end(body);
      return;
    }

    if (request.method === 'POST' && url.pathname === '/ingest') {
      if (!bearer(request, ingestToken)
          || scalarHeader(request, 'content-type') !== 'application/octet-stream') {
        finiteResponse(response, 401, 'unauthorized');
        return;
      }
      const identity = audioIdentity(request, { connection: true, format: true });
      if (!identity) {
        finiteResponse(response, 400, 'invalid_request');
        return;
      }
      if (publisher) {
        finiteResponse(response, 409, 'publisher_busy');
        return;
      }
      const active = {
        carry: Buffer.alloc(0),
        finished: false,
        identity,
        listeners: new Set(),
        request,
        response,
      };
      publisher = active;
      counters.publisherConnections += 1;
      response.writeHead(200, audioHeaders(identity));
      response.flushHeaders();

      const forward = (frames) => {
        counters.acceptedBytes += frames.length;
        counters.maxForwardedChunkBytes = Math.max(
          counters.maxForwardedChunkBytes, frames.length,
        );
        for (const listener of [...active.listeners]) {
          if (!listener.write(frames)) {
            counters.droppedListeners += 1;
            active.listeners.delete(listener);
            listener.destroy();
          }
        }
      };
      request.on('data', (chunk) => {
        if (active.finished || !Buffer.isBuffer(chunk)) return;
        let offset = 0;
        if (active.carry.length) {
          const needed = AUDIO_FRAME_BYTES - active.carry.length;
          if (chunk.length < needed) {
            active.carry = Buffer.concat([active.carry, chunk]);
            return;
          }
          forward(Buffer.concat([active.carry, chunk.subarray(0, needed)]));
          active.carry = Buffer.alloc(0);
          offset = needed;
        }
        while (chunk.length - offset >= AUDIO_FRAME_BYTES) {
          const complete = Math.min(
            Math.floor((chunk.length - offset) / AUDIO_FRAME_BYTES) * AUDIO_FRAME_BYTES,
            MAX_PUBLISHER_CHUNK_BYTES,
          );
          forward(chunk.subarray(offset, offset + complete));
          offset += complete;
        }
        if (offset < chunk.length) active.carry = Buffer.from(chunk.subarray(offset));
      });
      request.once('end', () => finishPublisher(active, { malformed: active.carry.length !== 0 }));
      request.once('aborted', () => finishPublisher(active, { malformed: active.carry.length !== 0 }));
      request.once('error', () => finishPublisher(active, { malformed: active.carry.length !== 0 }));
      response.once('close', () => finishPublisher(active, { malformed: active.carry.length !== 0 }));
      return;
    }

    if (request.method === 'GET' && url.pathname === '/listen') {
      if (!bearer(request, listenToken)) {
        finiteResponse(response, 401, 'unauthorized');
        return;
      }
      const identity = audioIdentity(request);
      if (!identity) {
        finiteResponse(response, 400, 'invalid_request');
        return;
      }
      const active = publisher;
      if (!active || active.finished || identity.sessionId !== active.identity.sessionId
          || identity.generation !== active.identity.generation) {
        finiteResponse(response, 409, 'generation_unavailable');
        return;
      }
      if (active.listeners.size >= MAX_LISTENERS) {
        finiteResponse(response, 503, 'listener_capacity');
        return;
      }
      active.listeners.add(response);
      response.writeHead(200, audioHeaders(active.identity));
      response.flushHeaders();
      const remove = () => active.listeners.delete(response);
      request.once('aborted', remove);
      request.once('error', remove);
      response.once('close', remove);
      return;
    }

    finiteResponse(response, 404, 'not_found');
  });
  server.headersTimeout = 5_000;
  server.keepAliveTimeout = 5_000;
  server.requestTimeout = 0;
  server.on('close', () => {
    if (publisher) finishPublisher(publisher);
  });
  return server;
}

function readSecret(path) {
  if (typeof path !== 'string' || !path) throw new Error('invalid_configuration');
  const value = readFileSync(path, 'utf8').trim();
  if (!validSecret(value)) throw new Error('invalid_configuration');
  return value;
}

export function startAudioRelay(environment = process.env) {
  const port = Number(environment.CANNABEATS_RELAY_PORT ?? '8090');
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error('invalid_configuration');
  }
  const server = createAudioRelay({
    ingestToken: readSecret(environment.CANNABEATS_RELAY_INGEST_SECRET_FILE),
    listenToken: readSecret(environment.CANNABEATS_RELAY_LISTEN_SECRET_FILE),
  });
  server.listen(port, '0.0.0.0');
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startAudioRelay();
}
