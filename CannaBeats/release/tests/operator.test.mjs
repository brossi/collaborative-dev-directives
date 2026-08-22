import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { closeSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { afterEach } from 'node:test';

import { loadCatalogArtifacts } from '../../web/lib/server/release/catalog.mjs';
import { hostProofBytes } from '../../web/lib/server/release/host-authority.mjs';
import {
  operatorActiveGameRoute, operatorDeviceRevocationRoute, operatorDiagnosticPurgeRoute,
  operatorEnrollmentRoute, operatorStatusRoute,
} from '../../web/lib/server/release/operator-routes.mjs';
import { createReleaseStore } from '../../web/lib/server/release/store.mjs';
import {
  OperatorError, executeOperatorCommand, parseOperatorArguments,
} from '../scripts/operator.mjs';

const roots = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});
const catalog = loadCatalogArtifacts({
  catalogPath: new URL('../../web/data/catalog.json', import.meta.url),
  manifestPath: new URL('../../web/data/catalog-manifest.json', import.meta.url),
});
const operatorToken = 'O'.repeat(43);
const bearer = () => randomBytes(24).toString('base64url');
const authorized = (url, init = {}) => new Request(url, {
  ...init, headers: { authorization: `Bearer ${operatorToken}`, ...init.headers },
});
const tokenOptions = { tokenProvider: () => operatorToken };

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'cannabeats-fr83-operator-'));
  roots.push(root);
  const store = createReleaseStore(join(root, 'database.sqlite3'), { catalog, now: 1_000 });
  const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const deviceId = randomUUID();
  const enrollmentCode = bearer();
  store.issueEnrollment({ enrollmentCode, requestId: randomUUID(), now: 1_100 });
  store.redeemEnrollment({
    enrollmentCode, requestId: randomUUID(), deviceId,
    publicKey: keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    label: 'Private Family Mac', now: 1_101,
  });
  const challenge = bearer();
  store.issueHostChallenge({ deviceId, challenge, requestId: randomUUID(), now: 1_200 });
  const hostToken = bearer();
  store.proveHostChallenge({
    deviceId, challenge, sessionToken: hostToken, requestId: randomUUID(), now: 1_201,
    signature: sign('sha256', hostProofBytes({
      challenge, deviceId, origin: 'https://play.cannabeats.social',
    }), keys.privateKey).toString('base64'),
  });
  const gameId = randomUUID();
  store.createAuthorizedGame({
    applicationSessionToken: hostToken, gameId, requestId: randomUUID(),
    catalogVersion: catalog.version, rules: { preset: 'family' }, now: 1_300,
  });
  const recordId = randomUUID();
  store.recordDiagnostic({
    applicationSessionToken: hostToken, gameId, recordId,
    kind: 'audio', code: 'audio_interrupted', metricValue: 1, now: 1_400,
  });
  return { store, deviceId, hostToken, gameId, recordId };
}

test('operator reads are authenticated, bounded, and omit private retained identities', async () => {
  const state = setup();
  const absent = await operatorStatusRoute(
    new Request('https://play.cannabeats.social/api/operator/status'), state.store, tokenOptions,
  );
  assert.equal(absent.status, 401);
  const status = await operatorStatusRoute(authorized(
    'https://play.cannabeats.social/api/operator/status',
  ), state.store, tokenOptions);
  const statusValue = await status.json();
  assert.deepEqual(statusValue, {
    code: 'operator_status', ready: true, reason: 'ready', schemaGeneration: 1,
    catalogVersion: catalog.version, activeGame: true, activeDevices: 1, diagnostics: 1,
  });
  const summary = await operatorActiveGameRoute(authorized(
    'https://play.cannabeats.social/api/operator/active-game',
  ), state.store, tokenOptions);
  const summaryValue = await summary.json();
  assert.deepEqual(summaryValue, {
    code: 'active_game_summary', lifecycle: 'lobby', revision: 0,
    phase: 'lobby', round: 0, players: 0,
  });
  const output = `${JSON.stringify(statusValue)}${JSON.stringify(summaryValue)}`;
  for (const secret of [operatorToken, state.deviceId, state.hostToken, state.gameId, state.recordId,
    'Private Family Mac']) assert.equal(output.includes(secret), false, secret);
  state.store.close();
});

test('operator bootstrap, diagnostic purge, and device revocation retain finite replay behavior', async () => {
  const state = setup();
  const bootstrapCode = bearer();
  const enrollmentRequest = randomUUID();
  const enrollment = await operatorEnrollmentRoute(authorized(
    'https://play.cannabeats.social/api/operator/enrollments', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enrollmentCode: bootstrapCode, requestId: enrollmentRequest }),
    },
  ), state.store, 2_000, tokenOptions);
  assert.deepEqual(Object.keys(await enrollment.clone().json()).sort(), ['code', 'expiresAt']);
  assert.equal((await enrollment.text()).includes(bootstrapCode), false);

  const purge = await operatorDiagnosticPurgeRoute(authorized(
    'https://play.cannabeats.social/api/operator/diagnostics/purge', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    },
  ), state.store, 2_001, tokenOptions);
  assert.deepEqual(await purge.json(), { code: 'diagnostics_purged' });
  assert.equal(state.store.operatorStatus().diagnostics, 0);

  const requestId = randomUUID();
  const revoke = () => operatorDeviceRevocationRoute(authorized(
    'https://play.cannabeats.social/api/operator/device-revocations', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId, targetDeviceId: state.deviceId }),
    },
  ), state.store, 2_002, tokenOptions);
  const first = await revoke();
  const replay = await revoke();
  assert.deepEqual(await first.clone().json(), { code: 'device_revoked', revokedAt: 2_002 });
  assert.deepEqual(await replay.json(), await first.json());
  assert.equal(state.store.gameSnapshot(state.gameId).lifecycle, 'abandoned');
  assert.deepEqual(state.store.operatorActiveGameSummary(), { code: 'active_game_absent' });
  assert.throws(() => state.store.authorizeHostSession({
    token: state.hostToken, now: 2_003,
  }), (error) => error.code === 'unauthorized');
  const conflict = await operatorDeviceRevocationRoute(authorized(
    'https://play.cannabeats.social/api/operator/device-revocations', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId, targetDeviceId: randomUUID() }),
    },
  ), state.store, 2_004, tokenOptions);
  assert.equal(conflict.status, 409);
  assert.deepEqual(await conflict.json(), { ok: false, code: 'request_conflict' });
  state.store.close();
});

test('operator routes reject expanded bodies and normalize token dependency failure', async () => {
  let called = false;
  const runtime = { issueEnrollment: () => { called = true; } };
  const expanded = await operatorEnrollmentRoute(authorized(
    'https://play.cannabeats.social/api/operator/enrollments', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enrollmentCode: bearer(), requestId: randomUUID(), extra: true }),
    },
  ), runtime, 2_000, tokenOptions);
  assert.equal(expanded.status, 400);
  assert.equal(called, false);
  const unavailable = await operatorStatusRoute(authorized(
    'https://play.cannabeats.social/api/operator/status',
  ), { operatorStatus: () => { called = true; } }, {
    tokenProvider: () => { throw new Error('private token path'); },
  });
  assert.equal(unavailable.status, 503);
  assert.deepEqual(await unavailable.json(), { ok: false, code: 'operator_unavailable' });
  assert.equal(called, false);
});

test('operator CLI sends secrets only in authenticated request bytes and validates finite output', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cannabeats-fr83-operator-cli-'));
  roots.push(root);
  const tokenPath = join(root, 'operator-token');
  writeFileSync(tokenPath, operatorToken, { mode: 0o400 });
  const requestId = randomUUID();
  const enrollmentCode = bearer();
  let received;
  const result = await executeOperatorCommand([
    'bootstrap-enrollment', '--request-id', requestId, '--code-fd', '7',
  ], {
    origin: 'https://operator.example', tokenPath, codeReader: (descriptor) => {
      assert.equal(descriptor, 7);
      return enrollmentCode;
    },
    fetchImpl: async (url, options) => {
      received = { url: String(url), options };
      return Response.json({ code: 'enrollment_issued', expiresAt: 902_000 });
    },
  });
  assert.deepEqual(result, { code: 'enrollment_issued', expiresAt: 902_000 });
  assert.equal(received.url, 'https://operator.example/api/operator/enrollments');
  assert.equal(received.options.headers.authorization, `Bearer ${operatorToken}`);
  assert.deepEqual(JSON.parse(received.options.body), { enrollmentCode, requestId });
  assert.equal(JSON.stringify(result).includes(operatorToken), false);
  assert.equal(JSON.stringify(result).includes(enrollmentCode), false);
  assert.deepEqual(parseOperatorArguments(['status']), { command: 'status' });
  assert.throws(() => parseOperatorArguments(['status', '--extra']),
    (error) => error instanceof OperatorError && error.code === 'invalid_arguments');
});

test('operator CLI rejects private fields, unknown failures, and over-bound streams finitely', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cannabeats-fr83-operator-negative-'));
  roots.push(root);
  const tokenPath = join(root, 'operator-token');
  writeFileSync(tokenPath, operatorToken, { mode: 0o400 });
  const malformed = {
    code: 'operator_status', ready: 'private-ready-value', reason: 'private_reason',
    schemaGeneration: 1, catalogVersion: catalog.version, activeGame: false,
    activeDevices: 0, diagnostics: 0,
  };
  await assert.rejects(executeOperatorCommand(['status'], {
    origin: 'https://operator.example', tokenPath,
    fetchImpl: async () => Response.json(malformed),
  }), (error) => error instanceof OperatorError
    && error.code === 'operator_response_invalid'
    && !error.message.includes('private'));
  await assert.rejects(executeOperatorCommand(['status'], {
    origin: 'https://operator.example', tokenPath,
    fetchImpl: async () => Response.json({ ok: false, code: 'private_internal_error' }, {
      status: 503,
    }),
  }), (error) => error instanceof OperatorError && error.code === 'operator_unavailable');
  await assert.rejects(executeOperatorCommand(['status'], {
    origin: 'https://operator.example', tokenPath,
    fetchImpl: async () => new Response('x'.repeat(4 * 1024 + 1)),
  }), (error) => error instanceof OperatorError && error.code === 'operator_response_invalid');

  const codePath = join(root, 'oversized-code');
  writeFileSync(codePath, 'A'.repeat(131));
  const descriptor = openSync(codePath, 'r');
  try {
    await assert.rejects(executeOperatorCommand([
      'bootstrap-enrollment', '--request-id', randomUUID(), '--code-fd', String(descriptor),
    ], {
      origin: 'https://operator.example', tokenPath,
      fetchImpl: async () => { throw new Error('oversized code must not dispatch'); },
    }), (error) => error instanceof OperatorError && error.code === 'invalid_arguments');
  } finally { closeSync(descriptor); }
});
