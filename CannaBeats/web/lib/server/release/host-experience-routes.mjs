import {
  HOST_CLIENT_CONTRACT, requireHostContract,
} from './host-routes.mjs';
import { AUDIO_CLIENT_CONTRACT, AUDIO_CLIENT_HEADER } from './audio-routes.mjs';
import { ReleaseStoreError } from './store.mjs';

const MAX_BODY_BYTES = 4 * 1024;
const BODY_TIMEOUT_MS = 2_000;
const RELAY_TIMEOUT_MS = 2_000;
const MAX_RELAY_HEALTH_BYTES = 4 * 1024;
const FINITE_CODES = new Set([
  'invalid_request', 'unauthorized', 'request_conflict', 'diagnostic_capacity',
  'upgrade_required', 'database_unavailable', 'database_corrupt',
]);

function failure(code) {
  const status = code === 'invalid_request' ? 400
    : code === 'unauthorized' ? 401
      : ['request_conflict', 'diagnostic_capacity', 'upgrade_required'].includes(code) ? 409
        : 503;
  return Response.json({ ok: false, code }, {
    status, headers: { 'Cache-Control': 'no-store' },
  });
}

function success(value, status = 200) {
  return Response.json(value, {
    status, headers: { 'Cache-Control': 'no-store' },
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
  const match = /^Bearer ([A-Za-z0-9_-]{22,128})$/u.exec(
    request.headers.get('authorization') ?? '',
  );
  if (!match) throw new ReleaseStoreError('unauthorized');
  return match[1];
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

function relayOrigin(environment) {
  let url;
  try { url = new URL(environment.CANNABEATS_RELAY_ORIGIN); } catch { return null; }
  if (url.protocol !== 'http:' || !url.hostname || url.username || url.password
      || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) return null;
  return url.origin;
}

async function relayHealthBody(response) {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null && (!/^\d+$/u.test(contentLength)
      || Number(contentLength) > MAX_RELAY_HEALTH_BYTES)) return null;
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RELAY_HEALTH_BYTES) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(
      Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))),
    ));
  } catch { return null; }
}

export async function probeRelayReadiness({
  environment = process.env, fetchImpl = fetch, timeoutMs = RELAY_TIMEOUT_MS,
} = {}) {
  const origin = relayOrigin(environment);
  if (!origin) return Object.freeze({ state: 'blocked', reason: 'relay_unavailable' });
  const abort = new AbortController();
  const deadline = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${origin}/health`, {
      cache: 'no-store', signal: abort.signal,
      headers: { [AUDIO_CLIENT_HEADER]: AUDIO_CLIENT_CONTRACT },
    });
    if (!response.ok || response.headers.get('content-type') !== 'application/json') {
      return Object.freeze({ state: 'blocked', reason: 'relay_unavailable' });
    }
    const value = await relayHealthBody(response);
    if (!value || typeof value !== 'object' || value.ok !== true
        || !Number.isSafeInteger(value.listeners) || value.listeners < 0
        || typeof value.publisherActive !== 'boolean') {
      return Object.freeze({ state: 'blocked', reason: 'relay_unavailable' });
    }
    return Object.freeze({ state: 'ready', reason: 'ready' });
  } catch {
    return Object.freeze({ state: 'blocked', reason: 'relay_unavailable' });
  } finally {
    clearTimeout(deadline);
  }
}

export function hostReadinessRoute(
  request, runtime, now = Date.now(), relayProbe = probeRelayReadiness,
) {
  return route(async () => {
    requireHostContract(request);
    const applicationSessionToken = bearer(request);
    const releaseOwner = owner(runtime);
    releaseOwner.authorizeHostSession({
      token: applicationSessionToken, kind: 'application', now,
    });
    const [recovery, relay] = await Promise.all([
      Promise.resolve(releaseOwner.recoverHostGame({
        hostSessionKind: 'application', hostSessionToken: applicationSessionToken, now,
      })),
      Promise.resolve(relayProbe()),
    ]);
    const finiteRelay = !relay || !['ready', 'blocked'].includes(relay.state)
        || !['ready', 'relay_unavailable'].includes(relay.reason)
        || (relay.state === 'ready') !== (relay.reason === 'ready')
      ? Object.freeze({ state: 'blocked', reason: 'relay_unavailable' }) : relay;
    const game = recovery.game === null ? null : Object.freeze({
      gameId: recovery.game.gameId,
      lifecycle: recovery.game.lifecycle,
      revision: recovery.game.revision,
    });
    return success(Object.freeze({
      code: 'host_readiness', hostContract: HOST_CLIENT_CONTRACT,
      relay: finiteRelay, activeGame: game,
    }));
  });
}

export function diagnosticRecordRoute(request, runtime, gameId, now = Date.now()) {
  return route(async () => {
    requireHostContract(request);
    const input = exact(await body(request), ['recordId', 'kind', 'code', 'metricValue']);
    const result = owner(runtime).recordDiagnostic({
      ...input, gameId, applicationSessionToken: bearer(request), now,
    });
    return success(result, 201);
  });
}

export function diagnosticExportRoute(request, runtime, gameId, now = Date.now()) {
  return route(async () => {
    requireHostContract(request);
    return success(owner(runtime).exportDiagnostics({
      gameId, applicationSessionToken: bearer(request), now,
    }));
  });
}
