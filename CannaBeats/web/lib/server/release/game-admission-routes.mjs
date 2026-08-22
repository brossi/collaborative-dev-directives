import { ReleaseStoreError, releaseStoreErrorCode } from './store.mjs';
import { HOST_COOKIE } from './host-routes.mjs';

const MAX_BODY_BYTES = 16 * 1024;
const BODY_TIMEOUT_MS = 2_000;
export const PARTICIPANT_COOKIE = '__Host-cannabeats-participant';
export const PARTICIPANT_COOKIE_MAX_AGE = 400 * 24 * 60 * 60;

const FINITE_CODES = new Set([
  'invalid_request', 'unauthorized', 'request_conflict', 'expired', 'already_used',
  'capacity_reached', 'duplicate_name', 'game_started', 'game_ended', 'stale_state',
  'upgrade_required', 'database_unavailable', 'database_corrupt', 'catalog_incompatible',
]);

function failure(code) {
  const status = code === 'invalid_request' ? 400
    : code === 'unauthorized' ? 401
      : code === 'expired' || code === 'game_ended' ? 410
        : ['request_conflict', 'already_used', 'capacity_reached', 'duplicate_name',
          'game_started', 'stale_state', 'catalog_incompatible',
          'upgrade_required'].includes(code) ? 409
          : 503;
  return Response.json({ ok: false, code }, {
    status, headers: { 'Cache-Control': 'no-store' },
  });
}

function success(value, { status = 200, cookieToken = null } = {}) {
  const headers = { 'Cache-Control': 'no-store' };
  if (cookieToken !== null) {
    headers['Set-Cookie'] = `${PARTICIPANT_COOKIE}=${cookieToken}; Path=/; Max-Age=${PARTICIPANT_COOKIE_MAX_AGE}; Secure; HttpOnly; SameSite=Strict`;
  }
  return Response.json(value, { status, headers });
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

function hostCredential(request) {
  const hasAuthorization = request.headers.has('authorization');
  const matches = (request.headers.get('cookie') ?? '').split(';').map((part) => part.trim())
    .filter((part) => part.startsWith(`${HOST_COOKIE}=`));
  if (hasAuthorization === (matches.length > 0) || matches.length > 1) {
    throw new ReleaseStoreError('unauthorized');
  }
  if (hasAuthorization) {
    return { hostSessionKind: 'application', hostSessionToken: bearer(request) };
  }
  const token = matches[0].slice(HOST_COOKIE.length + 1);
  if (!/^[A-Za-z0-9_-]{22,128}$/u.test(token)) throw new ReleaseStoreError('unauthorized');
  return { hostSessionKind: 'web', hostSessionToken: token };
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

export function gameCreateRoute(request, runtime, now = Date.now()) {
  return route(async () => {
    const input = exact(await body(request), ['catalogVersion', 'gameId', 'requestId', 'rules']);
    const result = owner(runtime).createAuthorizedGame({
      ...input, ...hostCredential(request), now,
    });
    return success(result, { status: result.code === 'created' ? 201 : 200 });
  });
}

export function hostGameRecoveryRoute(request, runtime, now = Date.now()) {
  return route(async () => success(owner(runtime).recoverHostGame({
    ...hostCredential(request), now,
  })));
}

export function invitationIssueRoute(request, runtime, gameId, now = Date.now()) {
  return route(async () => {
    const input = exact(await body(request), ['expectedRevision', 'inviteToken', 'requestId']);
    return success(owner(runtime).issueGameInvitation({
      ...input, ...hostCredential(request), gameId, now,
    }), { status: 201 });
  });
}

export function invitationRevokeRoute(request, runtime, gameId, now = Date.now()) {
  return route(async () => {
    const input = exact(await body(request), ['expectedRevision', 'requestId']);
    return success(owner(runtime).revokeGameInvitation({
      ...input, ...hostCredential(request), gameId, now,
    }));
  });
}

export function participantAdmissionRoute(request, runtime, gameId, now = Date.now()) {
  return route(async () => {
    const input = exact(await body(request), [
      'displayName', 'inviteToken', 'participantId', 'requestId', 'sessionToken',
    ]);
    const result = owner(runtime).admitParticipant({ ...input, gameId, now });
    return success(result, { status: 201, cookieToken: input.sessionToken });
  });
}

export function participantSnapshotRoute(request, runtime, gameId, now = Date.now()) {
  return route(async () => {
    const token = participantCookie(request);
    return success(owner(runtime).participantSnapshot({ token, gameId, now }), {
      cookieToken: token,
    });
  });
}

export function participantRecoveryRoute(request, runtime, now = Date.now()) {
  return route(async () => {
    const token = participantCookie(request);
    const authority = owner(runtime).authorizeParticipantSession({ token, now });
    return success(owner(runtime).participantSnapshot({
      token, gameId: authority.gameId, now,
    }), { cookieToken: token });
  });
}

export function hostGameSnapshotRoute(request, runtime, gameId, now = Date.now()) {
  return route(async () => success(owner(runtime).hostGameSnapshot({
    ...hostCredential(request), gameId, now,
  })));
}

export function participantRemoveRoute(request, runtime, gameId, participantId, now = Date.now()) {
  return route(async () => {
    const input = exact(await body(request), ['expectedRevision', 'requestId']);
    return success(owner(runtime).removeParticipant({
      ...input, ...hostCredential(request), gameId,
      targetParticipantId: participantId, now,
    }));
  });
}

export function gameTerminateRoute(request, runtime, gameId, now = Date.now()) {
  return route(async () => {
    const input = exact(await body(request), ['expectedRevision', 'requestId']);
    return success(owner(runtime).terminateGame({
      ...input, ...hostCredential(request), gameId, now,
    }));
  });
}
