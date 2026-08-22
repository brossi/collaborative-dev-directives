import { timingSafeEqual } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';

import { ReleaseStoreError } from './store.mjs';

const MAX_BODY_BYTES = 4 * 1024;
const BODY_TIMEOUT_MS = 2_000;
const TOKEN = /^[A-Za-z0-9_-]{43}$/u;
const FINITE_CODES = new Set([
  'invalid_request', 'unauthorized', 'request_conflict', 'already_used',
  'capacity_reached', 'database_unavailable', 'database_corrupt',
]);

function failure(code) {
  const finite = FINITE_CODES.has(code) ? code : 'operator_unavailable';
  const status = finite === 'invalid_request' ? 400
    : finite === 'unauthorized' ? 401
      : ['request_conflict', 'already_used', 'capacity_reached'].includes(finite) ? 409 : 503;
  return Response.json({ ok: false, code: finite }, {
    status, headers: { 'Cache-Control': 'no-store' },
  });
}
function success(value, status = 200) {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
}
function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) {
    throw new ReleaseStoreError('invalid_request');
  }
  return value;
}
async function body(request) {
  if (!request.body) throw new ReleaseStoreError('invalid_request');
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > MAX_BODY_BYTES)) {
    throw new ReleaseStoreError('invalid_request');
  }
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  const deadline = setTimeout(() => reader.cancel().catch(() => {}), BODY_TIMEOUT_MS);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) throw new ReleaseStoreError('invalid_request');
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    if (error instanceof ReleaseStoreError) throw error;
    throw new ReleaseStoreError('invalid_request');
  } finally { clearTimeout(deadline); }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } catch { throw new ReleaseStoreError('invalid_request'); }
}

export function readOperatorToken(environment = process.env) {
  const path = environment.CANNABEATS_OPERATOR_TOKEN_FILE;
  if (typeof path !== 'string' || !path) throw new Error('operator_unavailable');
  try {
    const retained = lstatSync(path);
    if (retained.isSymbolicLink() || !retained.isFile() || retained.size !== 43) {
      throw new Error('operator_unavailable');
    }
    const token = readFileSync(path, 'utf8');
    if (!TOKEN.test(token)) throw new Error('operator_unavailable');
    return token;
  } catch { throw new Error('operator_unavailable'); }
}

function authorize(request, tokenProvider) {
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/u.exec(
    request.headers.get('authorization') ?? '',
  );
  if (!match) throw new ReleaseStoreError('unauthorized');
  const expected = Buffer.from(tokenProvider());
  const received = Buffer.from(match[1]);
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
    throw new ReleaseStoreError('unauthorized');
  }
}
function owner(runtime) { return typeof runtime === 'function' ? runtime() : runtime; }
async function route(request, tokenProvider, work) {
  try {
    authorize(request, tokenProvider);
    return success(await work());
  } catch (error) {
    const code = error instanceof ReleaseStoreError ? error.code : error?.message;
    return failure(code);
  }
}

export function operatorStatusRoute(request, runtime, {
  tokenProvider = readOperatorToken,
} = {}) {
  return route(request, tokenProvider, () => owner(runtime).operatorStatus());
}

export function operatorActiveGameRoute(request, runtime, {
  tokenProvider = readOperatorToken,
} = {}) {
  return route(request, tokenProvider, () => owner(runtime).operatorActiveGameSummary());
}

export function operatorEnrollmentRoute(request, runtime, now = Date.now(), {
  tokenProvider = readOperatorToken,
} = {}) {
  return route(request, tokenProvider, async () => {
    const input = exact(await body(request), ['enrollmentCode', 'requestId']);
    const result = owner(runtime).issueEnrollment({ ...input, now });
    return Object.freeze({ code: result.code, expiresAt: result.expiresAt });
  });
}

export function operatorDeviceRevocationRoute(request, runtime, now = Date.now(), {
  tokenProvider = readOperatorToken,
} = {}) {
  return route(request, tokenProvider, async () => {
    const input = exact(await body(request), ['requestId', 'targetDeviceId']);
    const result = owner(runtime).operatorRevokeHostDevice({ ...input, now });
    return Object.freeze({ code: result.code, revokedAt: result.revokedAt });
  });
}

export function operatorDiagnosticPurgeRoute(request, runtime, now = Date.now(), {
  tokenProvider = readOperatorToken,
} = {}) {
  return route(request, tokenProvider, async () => {
    exact(await body(request), []);
    return owner(runtime).operatorPurgeDiagnostics({ now });
  });
}
