import { ReleaseStoreError } from './store.mjs';
import { HOST_CLIENT_CONTRACT, HOST_CLIENT_HEADER } from './host-contract.mjs';

export { HOST_CLIENT_CONTRACT, HOST_CLIENT_HEADER } from './host-contract.mjs';

const MAX_BODY_BYTES = 16 * 1024;
const BODY_TIMEOUT_MS = 2_000;
export const HOST_COOKIE = '__Host-cannabeats-host';

function failure(code) {
  const status = code === 'invalid_request' ? 400
    : code === 'unauthorized' || code === 'proof_rejected' ? 401
      : code === 'expired' ? 410
        : code === 'capacity_reached' ? 429
          : code === 'request_conflict' || code === 'already_used'
              || code === 'upgrade_required' ? 409
            : code === 'database_corrupt' ? 500 : 503;
  return Response.json({ ok: false, code }, {
    status, headers: { 'Cache-Control': 'no-store' },
  });
}

function success(body, { status = 200, headers = {} } = {}) {
  return Response.json(body, {
    status, headers: { 'Cache-Control': 'no-store', ...headers },
  });
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

function bearer(request) {
  const authorization = request.headers.get('authorization') ?? '';
  const match = /^Bearer ([A-Za-z0-9_-]{22,128})$/u.exec(authorization);
  if (!match) throw new ReleaseStoreError('unauthorized');
  return match[1];
}

export function requireHostContract(request) {
  if (request.headers.get(HOST_CLIENT_HEADER) !== HOST_CLIENT_CONTRACT) {
    throw new ReleaseStoreError('upgrade_required');
  }
  return HOST_CLIENT_CONTRACT;
}

async function route(work) {
  try {
    return await work();
  } catch (error) {
    const code = error instanceof ReleaseStoreError ? error.code : 'database_unavailable';
    return failure([
      'invalid_request', 'unauthorized', 'request_conflict', 'expired', 'already_used',
      'capacity_reached', 'proof_rejected', 'database_unavailable', 'database_corrupt',
      'upgrade_required',
    ].includes(code) ? code : 'database_unavailable');
  }
}

function owner(runtime) {
  return typeof runtime === 'function' ? runtime() : runtime;
}

export function enrollmentIssueRoute(request, runtime, now = Date.now()) {
  return route(async () => {
    const input = exact(await body(request), ['enrollmentCode', 'requestId']);
    return success(owner(runtime).issueEnrollment({
      ...input, applicationSessionToken: bearer(request), now,
    }), { status: 201 });
  });
}

export function enrollmentRedeemRoute(request, runtime, now = Date.now()) {
  return route(async () => {
    const input = exact(await body(request), [
      'deviceId', 'enrollmentCode', 'label', 'publicKey', 'requestId',
    ]);
    return success(owner(runtime).redeemEnrollment({ ...input, now }), { status: 201 });
  });
}

export function challengeIssueRoute(request, runtime, now = Date.now()) {
  return route(async () => {
    const input = exact(await body(request), ['challenge', 'deviceId', 'requestId']);
    return success(owner(runtime).issueHostChallenge({ ...input, now }), { status: 201 });
  });
}

export function challengeProveRoute(request, runtime, now = Date.now()) {
  return route(async () => {
    const input = exact(await body(request), [
      'challenge', 'deviceId', 'requestId', 'sessionToken', 'signature',
    ]);
    const result = owner(runtime).proveHostChallenge({ ...input, now });
    return result.code === 'proof_rejected' ? failure('proof_rejected') : success(result, { status: 201 });
  });
}

export function webTicketIssueRoute(request, runtime, now = Date.now()) {
  return route(async () => {
    const hostContract = requireHostContract(request);
    const input = exact(await body(request), ['requestId', 'ticket']);
    return success(owner(runtime).issueHostWebTicket({
      ...input, applicationSessionToken: bearer(request), hostContract, now,
    }), { status: 201 });
  });
}

export function webTicketExchangeRoute(request, runtime, now = Date.now()) {
  return route(async () => {
    const input = exact(await body(request), ['ticket']);
    const result = owner(runtime).exchangeHostWebTicket({ ...input, now });
    const maxAge = Math.max(0, Math.floor((result.expiresAt - now) / 1_000));
    return success(result, {
      headers: {
        'Set-Cookie': `${HOST_COOKIE}=${input.ticket}; Path=/; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=Strict`,
      },
    });
  });
}

export function deviceListRoute(request, runtime, now = Date.now()) {
  return route(async () => success({
    devices: owner(runtime).listHostDevices({ applicationSessionToken: bearer(request), now }),
  }));
}

export function deviceRevokeRoute(request, runtime, targetDeviceId, now = Date.now()) {
  return route(async () => {
    const input = exact(await body(request), ['requestId']);
    return success(owner(runtime).revokeHostDevice({
      applicationSessionToken: bearer(request), targetDeviceId, requestId: input.requestId, now,
    }));
  });
}
