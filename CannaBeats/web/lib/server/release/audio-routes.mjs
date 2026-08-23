import { readFileSync } from 'node:fs';

import { PARTICIPANT_COOKIE } from './game-admission-routes.mjs';
import { AUDIO_AUTHORITY_RECHECK_MS } from './audio-sessions.mjs';
import { ReleaseStoreError, releaseStoreErrorCode } from './store.mjs';

export const AUDIO_CLIENT_CONTRACT = '1';
export const AUDIO_CLIENT_HEADER = 'x-cannabeats-audio-contract';
export const AUDIO_SESSION_HEADER = 'x-cannabeats-audio-session';
export const AUDIO_GENERATION_HEADER = 'x-cannabeats-audio-generation';
export const AUDIO_CONNECTION_HEADER = 'x-cannabeats-audio-connection';
export const AUDIO_RATE_HEADER = 'x-cannabeats-audio-rate';
export const AUDIO_CHANNELS_HEADER = 'x-cannabeats-audio-channels';
export const AUDIO_ENCODING_HEADER = 'x-cannabeats-audio-encoding';
export const MAX_STREAM_CHUNK_BYTES = 16 * 1024;

const MAX_BODY_BYTES = 4 * 1024;
const BODY_TIMEOUT_MS = 2_000;
export const AUTHORITY_RECHECK_MS = AUDIO_AUTHORITY_RECHECK_MS;
const RELAY_SETUP_TIMEOUT_MS = 5_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SECRET_PATTERN = /^[0-9A-Za-z_-]{22,128}$/u;
const FINITE_CODES = new Set([
  'invalid_request', 'unauthorized', 'request_conflict', 'game_inactive',
  'audio_session_open', 'audio_session_not_found', 'audio_busy', 'audio_capacity',
  'stale_generation', 'operation_rejected', 'transition_capacity',
  'incompatible_client', 'audio_unavailable', 'database_unavailable', 'database_corrupt',
]);

function failure(code) {
  const status = code === 'invalid_request' ? 400
    : code === 'unauthorized' ? 401
      : code === 'audio_session_not_found' ? 404
        : ['request_conflict', 'game_inactive', 'audio_session_open', 'audio_busy',
          'audio_capacity', 'stale_generation', 'operation_rejected', 'transition_capacity',
          'incompatible_client'].includes(code) ? 409
          : 503;
  return Response.json({ ok: false, code }, {
    status, headers: { 'Cache-Control': 'no-store' },
  });
}

function success(value) {
  return Response.json(value, { headers: { 'Cache-Control': 'no-store' } });
}

function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0')) {
    throw new ReleaseStoreError('invalid_request');
  }
  return value;
}

function contract(request) {
  if (request.headers.get(AUDIO_CLIENT_HEADER) !== AUDIO_CLIENT_CONTRACT) {
    throw new ReleaseStoreError('incompatible_client');
  }
}

function bearer(request) {
  const match = /^Bearer ([A-Za-z0-9_-]{22,128})$/u.exec(
    request.headers.get('authorization') ?? '',
  );
  if (!match) throw new ReleaseStoreError('unauthorized');
  return match[1];
}

function participantCookie(request) {
  const matches = (request.headers.get('cookie') ?? '').split(';').map((part) => part.trim())
    .filter((part) => part.startsWith(`${PARTICIPANT_COOKIE}=`));
  if (matches.length !== 1) throw new ReleaseStoreError('unauthorized');
  const token = matches[0].slice(PARTICIPANT_COOKIE.length + 1);
  if (!SECRET_PATTERN.test(token)) throw new ReleaseStoreError('unauthorized');
  return token;
}

function hasParticipantCookie(request) {
  return (request.headers.get('cookie') ?? '').split(';')
    .some((part) => part.trim().startsWith(`${PARTICIPANT_COOKIE}=`));
}

async function body(request) {
  if (!request.body) throw new ReleaseStoreError('invalid_request');
  const contentLength = request.headers.get('content-length');
  if (contentLength !== null && (!/^\d+$/u.test(contentLength)
      || Number(contentLength) > MAX_BODY_BYTES)) throw new ReleaseStoreError('invalid_request');
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  const deadline = setTimeout(() => reader.cancel().catch(() => {}), BODY_TIMEOUT_MS);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) throw new ReleaseStoreError('invalid_request');
      chunks.push(value);
    }
  } catch (error) {
    if (releaseStoreErrorCode(error) !== null) throw error;
    throw new ReleaseStoreError('invalid_request');
  } finally {
    clearTimeout(deadline);
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(
      Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))),
    ));
  } catch {
    throw new ReleaseStoreError('invalid_request');
  }
}

function owner(runtime) {
  return typeof runtime === 'function' ? runtime() : runtime;
}

async function route(work) {
  try {
    return await work();
  } catch (error) {
    const candidate = releaseStoreErrorCode(error) ?? 'database_unavailable';
    return failure(FINITE_CODES.has(candidate) ? candidate : 'database_unavailable');
  }
}

function uuid(value) {
  if (!UUID_PATTERN.test(value ?? '')) throw new ReleaseStoreError('invalid_request');
  return value;
}

function streamFormat(request) {
  const rateText = request.headers.get(AUDIO_RATE_HEADER);
  if (!['44100', '48000'].includes(rateText ?? '')
      || request.headers.get(AUDIO_CHANNELS_HEADER) !== '2'
      || request.headers.get(AUDIO_ENCODING_HEADER) !== 's16le'
      || request.headers.get('content-type') !== 'application/octet-stream') {
    throw new ReleaseStoreError('invalid_request');
  }
  return Object.freeze({ rate: Number(rateText), channels: 2, encoding: 's16le' });
}

function readSecret(path) {
  if (typeof path !== 'string' || !path) throw new ReleaseStoreError('audio_unavailable');
  let value;
  try { value = readFileSync(path, 'utf8').trim(); } catch {
    throw new ReleaseStoreError('audio_unavailable');
  }
  if (!SECRET_PATTERN.test(value)) throw new ReleaseStoreError('audio_unavailable');
  return value;
}

function configuredRelay(environment) {
  let url;
  try { url = new URL(environment.CANNABEATS_RELAY_ORIGIN); } catch {
    throw new ReleaseStoreError('audio_unavailable');
  }
  if (url.protocol !== 'http:' || !url.hostname || url.username || url.password
      || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) {
    throw new ReleaseStoreError('audio_unavailable');
  }
  return Object.freeze({
    origin: url.origin,
    ingestToken: readSecret(environment.CANNABEATS_RELAY_INGEST_SECRET_FILE),
    listenToken: readSecret(environment.CANNABEATS_RELAY_LISTEN_SECRET_FILE),
  });
}

function dependencies(overrides = {}) {
  if (overrides.relay) {
    const { origin, ingestToken, listenToken } = overrides.relay;
    if (typeof origin !== 'string' || !SECRET_PATTERN.test(ingestToken ?? '')
        || !SECRET_PATTERN.test(listenToken ?? '') || ingestToken === listenToken) {
      throw new ReleaseStoreError('audio_unavailable');
    }
    return {
      relay: { origin, ingestToken, listenToken },
      fetchImpl: overrides.fetchImpl ?? fetch,
      clock: overrides.clock ?? Date.now,
      recheckMs: overrides.recheckMs ?? AUTHORITY_RECHECK_MS,
    };
  }
  return {
    relay: configuredRelay(overrides.environment ?? process.env),
    fetchImpl: overrides.fetchImpl ?? fetch,
    clock: overrides.clock ?? Date.now,
    recheckMs: overrides.recheckMs ?? AUTHORITY_RECHECK_MS,
  };
}

function relayHeaders(session, token, extra = {}) {
  return {
    authorization: `Bearer ${token}`,
    [AUDIO_CLIENT_HEADER]: AUDIO_CLIENT_CONTRACT,
    [AUDIO_SESSION_HEADER]: session.audioSessionId,
    [AUDIO_GENERATION_HEADER]: String(session.generation),
    ...extra,
  };
}

function validateRelayResponse(response, session, format) {
  return response.status === 200 && response.body
    && response.headers.get(AUDIO_CLIENT_HEADER) === AUDIO_CLIENT_CONTRACT
    && response.headers.get(AUDIO_SESSION_HEADER) === session.audioSessionId
    && response.headers.get(AUDIO_GENERATION_HEADER) === String(session.generation)
    && response.headers.get(AUDIO_RATE_HEADER) === String(format.rate)
    && response.headers.get(AUDIO_CHANNELS_HEADER) === '2'
    && response.headers.get(AUDIO_ENCODING_HEADER) === 's16le'
    && response.headers.get('content-type') === 'application/octet-stream';
}

function outputHeaders(session, format) {
  return {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/octet-stream',
    [AUDIO_CLIENT_HEADER]: AUDIO_CLIENT_CONTRACT,
    [AUDIO_SESSION_HEADER]: session.audioSessionId,
    [AUDIO_GENERATION_HEADER]: String(session.generation),
    [AUDIO_RATE_HEADER]: String(format.rate),
    [AUDIO_CHANNELS_HEADER]: '2',
    [AUDIO_ENCODING_HEADER]: 's16le',
  };
}

function responseStartingStream(source) {
  const reader = source.getReader();
  return new ReadableStream({
    start(controller) {
      // Next flushes route-handler response headers only after the first body
      // write. An empty write starts the response without adding wire bytes.
      controller.enqueue(new Uint8Array(0));
    },
    async pull(controller) {
      try {
        const item = await reader.read();
        if (item.done) controller.close();
        else controller.enqueue(item.value);
      } catch (error) {
        controller.error(error);
      }
    },
    cancel() { return reader.cancel(); },
  });
}

function authorityBoundStream(source, {
  authorize, onClose = () => {}, recheckMs, maxChunkBytes = null,
}) {
  const reader = source.getReader();
  let controller;
  let closed = false;
  let closeCalled = false;
  const finish = () => {
    if (!closeCalled) {
      closeCalled = true;
      try { onClose(); } catch {}
    }
  };
  const stop = (error = null) => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    reader.cancel().catch(() => {});
    finish();
    if (error && controller) {
      try { controller.error(error); } catch {}
    }
  };
  const timer = setInterval(() => {
    if (closed) return;
    try { authorize(); } catch { stop(new Error('stream_interrupted')); }
  }, recheckMs);
  timer.unref?.();
  return new ReadableStream({
    start(value) { controller = value; },
    async pull(value) {
      if (closed) return;
      try {
        const item = await reader.read();
        if (item.done) {
          closed = true;
          clearInterval(timer);
          finish();
          value.close();
        } else {
          if (!(item.value instanceof Uint8Array) || item.value.byteLength === 0) {
            throw new Error('stream_interrupted');
          }
          if (maxChunkBytes === null) {
            value.enqueue(item.value);
          } else {
            for (let offset = 0; offset < item.value.byteLength; offset += maxChunkBytes) {
              value.enqueue(item.value.subarray(offset, offset + maxChunkBytes));
            }
          }
        }
      } catch {
        stop(new Error('stream_interrupted'));
      }
    },
    cancel() { stop(); },
  });
}

export function openAudioSessionRoute(request, runtime, gameId, now = Date.now()) {
  return route(async () => {
    contract(request);
    const input = exact(await body(request), ['audioSessionId', 'requestId']);
    return success(owner(runtime).openAudioSession({
      ...input, applicationSessionToken: bearer(request), gameId, now,
    }));
  });
}

export function currentAudioSessionRoute(request, runtime, gameId, now = Date.now()) {
  return route(async () => {
    contract(request);
    return success(owner(runtime).currentAudioSession({
      applicationSessionToken: bearer(request), gameId, now,
    }));
  });
}

export function endAudioSessionRoute(
  request, runtime, gameId, audioSessionId, now = Date.now(),
) {
  return route(async () => {
    contract(request);
    const input = exact(await body(request), ['requestId']);
    return success(owner(runtime).endAudioSession({
      ...input, applicationSessionToken: bearer(request), gameId,
      audioSessionId: uuid(audioSessionId), now,
    }));
  });
}

export function audioIngestRoute(
  request, runtime, gameId, audioSessionId, now = Date.now(), dependencyOverrides = {},
) {
  return route(async () => {
    contract(request);
    if (!request.body) throw new ReleaseStoreError('invalid_request');
    const format = streamFormat(request);
    const applicationSessionToken = bearer(request);
    const connectionId = uuid(request.headers.get(AUDIO_CONNECTION_HEADER));
    const currentRuntime = owner(runtime);
    const claimed = currentRuntime.claimAudioIngest({
      applicationSessionToken, gameId, audioSessionId: uuid(audioSessionId), connectionId, now,
    }).session;
    const deps = dependencies(dependencyOverrides);
    const relayAbort = new AbortController();
    const relayDeadline = setTimeout(() => relayAbort.abort(), RELAY_SETUP_TIMEOUT_MS);
    const interrupt = (reasonCode) => currentRuntime.interruptAudioIngest({
      gameId, audioSessionId, connectionId, reasonCode, now: deps.clock(),
    });
    const guardedBody = authorityBoundStream(request.body, {
      authorize: () => {
        const rechecked = currentRuntime.recheckAudioHostStream({
          applicationSessionToken, gameId, audioSessionId, connectionId,
          now: deps.clock(),
        });
        if (rechecked.generation !== claimed.generation) {
          throw new ReleaseStoreError('unauthorized');
        }
      },
      onClose: () => interrupt('ingest_lost'),
      recheckMs: deps.recheckMs,
      maxChunkBytes: MAX_STREAM_CHUNK_BYTES,
    });
    let upstream;
    try {
      upstream = await deps.fetchImpl(`${deps.relay.origin}/ingest`, {
        method: 'POST', duplex: 'half', body: guardedBody, signal: relayAbort.signal,
        headers: relayHeaders(claimed, deps.relay.ingestToken, {
          'content-type': 'application/octet-stream',
          [AUDIO_CONNECTION_HEADER]: connectionId,
          [AUDIO_RATE_HEADER]: String(format.rate),
          [AUDIO_CHANNELS_HEADER]: '2',
          [AUDIO_ENCODING_HEADER]: 's16le',
        }),
      });
    } catch {
      clearTimeout(relayDeadline);
      relayAbort.abort();
      interrupt('relay_unavailable');
      throw new ReleaseStoreError('audio_unavailable');
    }
    clearTimeout(relayDeadline);
    if (!validateRelayResponse(upstream, claimed, format)) {
      relayAbort.abort();
      interrupt('malformed_relay');
      throw new ReleaseStoreError('audio_unavailable');
    }
    let active;
    try {
      active = currentRuntime.activateAudioIngest({
        applicationSessionToken, gameId, audioSessionId, connectionId, now: deps.clock(),
      }).session;
    } catch (error) {
      relayAbort.abort();
      interrupt('ingest_lost');
      throw error;
    }
    return new Response(responseStartingStream(upstream.body), {
      status: 200, headers: outputHeaders(active, format),
    });
  });
}

export function audioListenRoute(
  request, runtime, gameId, audioSessionId, now = Date.now(), dependencyOverrides = {},
) {
  return route(async () => {
    contract(request);
    const hasBearer = request.headers.has('authorization');
    const hasParticipant = hasParticipantCookie(request);
    if (hasBearer === hasParticipant) throw new ReleaseStoreError('unauthorized');
    const currentRuntime = owner(runtime);
    const normalizedSessionId = uuid(audioSessionId);
    const authority = hasBearer
      ? { kind: 'host', token: bearer(request) }
      : { kind: 'participant', token: participantCookie(request) };
    const authorize = (authorizationNow) => authority.kind === 'host'
      ? currentRuntime.authorizeAudioHostStream({
        applicationSessionToken: authority.token, gameId,
        audioSessionId: normalizedSessionId, requireActive: true,
        now: authorizationNow,
      })
      : currentRuntime.authorizeAudioParticipantStream({
        participantSessionToken: authority.token, gameId,
        audioSessionId: normalizedSessionId,
        now: authorizationNow,
      });
    const recheck = (authorizationNow) => {
      const rechecked = authority.kind === 'host'
      ? currentRuntime.recheckAudioHostStream({
        applicationSessionToken: authority.token, gameId,
        audioSessionId: normalizedSessionId, requireActive: true,
        now: authorizationNow,
      })
      : currentRuntime.recheckAudioParticipantStream({
        participantSessionToken: authority.token, gameId,
        audioSessionId: normalizedSessionId,
        now: authorizationNow,
      });
      if (rechecked.generation !== session.generation) {
        throw new ReleaseStoreError('unauthorized');
      }
    };
    const session = authorize(now);
    const deps = dependencies(dependencyOverrides);
    const relayAbort = new AbortController();
    const relayDeadline = setTimeout(() => relayAbort.abort(), RELAY_SETUP_TIMEOUT_MS);
    let upstream;
    try {
      upstream = await deps.fetchImpl(`${deps.relay.origin}/listen`, {
        method: 'GET', headers: relayHeaders(session, deps.relay.listenToken),
        signal: relayAbort.signal,
      });
    } catch {
      clearTimeout(relayDeadline);
      throw new ReleaseStoreError('audio_unavailable');
    }
    clearTimeout(relayDeadline);
    const rateText = upstream.headers.get(AUDIO_RATE_HEADER);
    const format = { rate: Number(rateText), channels: 2, encoding: 's16le' };
    if (!['44100', '48000'].includes(rateText ?? '')
        || !validateRelayResponse(upstream, session, format)) {
      relayAbort.abort();
      throw new ReleaseStoreError('audio_unavailable');
    }
    authorize(deps.clock());
    const guarded = authorityBoundStream(upstream.body, {
      authorize: () => recheck(deps.clock()),
      recheckMs: deps.recheckMs,
      maxChunkBytes: MAX_STREAM_CHUNK_BYTES,
    });
    return new Response(responseStartingStream(guarded), {
      status: 200, headers: outputHeaders(session, format),
    });
  });
}
