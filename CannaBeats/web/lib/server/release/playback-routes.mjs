import { ReleaseStoreError } from './store.mjs';

const MAX_BODY_BYTES = 4 * 1024;
const BODY_TIMEOUT_MS = 2_000;
export const PLAYBACK_CLIENT_CONTRACT = '1';
export const PLAYBACK_CLIENT_HEADER = 'x-cannabeats-playback-contract';

const FINITE_CODES = new Set([
  'invalid_request', 'unauthorized', 'request_conflict', 'game_ended',
  'command_not_found', 'operation_rejected', 'stale_claim', 'playback_capacity',
  'transition_capacity', 'incompatible_client', 'database_unavailable',
  'database_corrupt',
]);

function failure(code) {
  const status = code === 'invalid_request' ? 400
    : code === 'unauthorized' ? 401
      : code === 'command_not_found' ? 404
        : code === 'game_ended' ? 410
          : ['request_conflict', 'operation_rejected', 'stale_claim',
            'playback_capacity', 'transition_capacity', 'incompatible_client'].includes(code)
            ? 409 : 503;
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
  if (request.headers.get(PLAYBACK_CLIENT_HEADER) !== PLAYBACK_CLIENT_CONTRACT) {
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
    if (error instanceof ReleaseStoreError) throw error;
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
    const candidate = error instanceof ReleaseStoreError ? error.code : 'database_unavailable';
    return failure(FINITE_CODES.has(candidate) ? candidate : 'database_unavailable');
  }
}

export function nextPlaybackCommandRoute(request, runtime, gameId, now = Date.now()) {
  return route(async () => {
    contract(request);
    return success(owner(runtime).nextPlaybackCommand({
      applicationSessionToken: bearer(request), gameId, now,
    }));
  });
}

export function playbackTransitionRoute(request, runtime, gameId, commandId, now = Date.now()) {
  return route(async () => {
    contract(request);
    const input = exact(await body(request), [
      'claimGeneration', 'outcome', 'outcomeHash', 'reasonCode', 'targetState',
    ]);
    return success(owner(runtime).transitionPlaybackCommand({
      ...input, applicationSessionToken: bearer(request), commandId, gameId, now,
    }));
  });
}
