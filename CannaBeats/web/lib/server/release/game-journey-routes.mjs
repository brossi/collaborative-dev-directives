import { PARTICIPANT_COOKIE, PARTICIPANT_COOKIE_MAX_AGE } from './game-admission-routes.mjs';
import { HOST_COOKIE } from './host-routes.mjs';
import { ReleaseStoreError, releaseStoreErrorCode } from './store.mjs';

const MAX_BODY_BYTES = 16 * 1024;
const BODY_TIMEOUT_MS = 2_000;
export const GAME_JOURNEY_CLIENT_CONTRACT = '3';
export const GAME_JOURNEY_CLIENT_HEADER = 'x-cannabeats-client-contract';
export const GAME_JOURNEY_ROLE_HEADER = 'x-cannabeats-game-role';

const FINITE_CODES = new Set([
  'invalid_request', 'unauthorized', 'request_conflict', 'capacity_reached',
  'duplicate_name', 'game_ended', 'stale_state', 'operation_rejected',
  'catalog_exhausted', 'audio_not_ready', 'incompatible_client', 'database_unavailable',
  'database_corrupt', 'catalog_incompatible', 'upgrade_required',
]);

function failure(code) {
  const status = code === 'invalid_request' ? 400
    : code === 'unauthorized' ? 401
      : code === 'game_ended' ? 410
        : ['request_conflict', 'capacity_reached', 'duplicate_name', 'stale_state',
          'operation_rejected', 'catalog_exhausted', 'incompatible_client',
          'catalog_incompatible', 'audio_not_ready', 'upgrade_required'].includes(code) ? 409
          : 503;
  return Response.json({ ok: false, code }, {
    status, headers: { 'Cache-Control': 'no-store' },
  });
}

function success(value, participantToken = null) {
  const headers = { 'Cache-Control': 'no-store' };
  if (participantToken !== null) {
    headers['Set-Cookie'] = `${PARTICIPANT_COOKIE}=${participantToken}; Path=/; Max-Age=${PARTICIPANT_COOKIE_MAX_AGE}; Secure; HttpOnly; SameSite=Strict`;
  }
  return Response.json(value, { headers });
}

function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0')) {
    throw new ReleaseStoreError('invalid_request');
  }
  return value;
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
  if (!/^[A-Za-z0-9_-]{22,128}$/u.test(token)) throw new ReleaseStoreError('unauthorized');
  return token;
}

function namedCookie(request, name) {
  const matches = (request.headers.get('cookie') ?? '').split(';').map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`));
  if (matches.length !== 1) throw new ReleaseStoreError('unauthorized');
  const token = matches[0].slice(name.length + 1);
  if (!/^[A-Za-z0-9_-]{22,128}$/u.test(token)) throw new ReleaseStoreError('unauthorized');
  return token;
}

function owner(runtime) {
  return typeof runtime === 'function' ? runtime() : runtime;
}

export async function gameActionRoute(request, runtime, gameId, now = Date.now()) {
  try {
    if (request.headers.get(GAME_JOURNEY_CLIENT_HEADER) !== GAME_JOURNEY_CLIENT_CONTRACT) {
      throw new ReleaseStoreError('incompatible_client');
    }
    const input = exact(await body(request), [
      'expectedRevision', 'operation', 'payload', 'requestId',
    ]);
    const hasAuthorization = request.headers.has('authorization');
    const hasParticipantCookie = (request.headers.get('cookie') ?? '').split(';')
      .some((part) => part.trim().startsWith(`${PARTICIPANT_COOKIE}=`));
    const hasHostCookie = (request.headers.get('cookie') ?? '').split(';')
      .some((part) => part.trim().startsWith(`${HOST_COOKIE}=`));
    const requestedRole = request.headers.get(GAME_JOURNEY_ROLE_HEADER);
    if (requestedRole !== null && !['host', 'participant'].includes(requestedRole)) {
      throw new ReleaseStoreError('unauthorized');
    }
    const role = requestedRole ?? ([hasAuthorization, hasHostCookie, hasParticipantCookie]
      .filter(Boolean).length === 1
      ? (hasAuthorization || hasHostCookie ? 'host' : 'participant') : null);
    if (role === 'host' && hasAuthorization !== hasHostCookie) {
      if (hasAuthorization) {
        return success(owner(runtime).applyHostGameAction({
          ...input, applicationSessionToken: bearer(request), gameId, now,
        }));
      }
      return success(owner(runtime).applyHostGameAction({
        ...input, hostSessionKind: 'web', hostSessionToken: namedCookie(request, HOST_COOKIE),
        gameId, now,
      }));
    }
    if (role === 'participant' && hasParticipantCookie && !hasAuthorization) {
      const token = participantCookie(request);
      return success(owner(runtime).applyParticipantGameAction({
        ...input, participantSessionToken: token, gameId, now,
      }), token);
    }
    throw new ReleaseStoreError('unauthorized');
  } catch (error) {
    const candidate = releaseStoreErrorCode(error) ?? 'database_unavailable';
    return failure(FINITE_CODES.has(candidate) ? candidate : 'database_unavailable');
  }
}
