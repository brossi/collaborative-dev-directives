import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, test } from 'node:test';

import {
  DIAGNOSTIC_RETENTION_MS, MAX_DIAGNOSTICS_PER_GAME,
} from '../../web/lib/server/release/diagnostics.mjs';
import { loadCatalogArtifacts } from '../../web/lib/server/release/catalog.mjs';
import { hostProofBytes } from '../../web/lib/server/release/host-authority.mjs';
import { ReleaseStoreError, createReleaseStore } from '../../web/lib/server/release/store.mjs';

const roots = [];
const catalog = loadCatalogArtifacts({
  catalogPath: new URL('../../web/data/catalog.json', import.meta.url),
  manifestPath: new URL('../../web/data/catalog-manifest.json', import.meta.url),
});

afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

function token() { return randomBytes(24).toString('base64url'); }
function expectCode(work, code) {
  assert.throws(work, (error) => error instanceof ReleaseStoreError && error.code === code);
}

function setupGame() {
  const root = mkdtempSync(join(tmpdir(), 'cannabeats-fr7-'));
  roots.push(root);
  const path = join(root, 'cannabeats.sqlite3');
  const store = createReleaseStore(path, { catalog, now: 1_000 });
  const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publicKey = keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const deviceId = randomUUID();
  const enrollmentCode = token();
  store.issueEnrollment({ enrollmentCode, requestId: randomUUID(), now: 1_100 });
  store.redeemEnrollment({
    enrollmentCode, requestId: randomUUID(), deviceId, publicKey,
    label: 'Diagnostic Host', now: 1_101,
  });
  const challenge = token();
  store.issueHostChallenge({ deviceId, challenge, requestId: randomUUID(), now: 1_200 });
  const hostToken = token();
  store.proveHostChallenge({
    deviceId, challenge, sessionToken: hostToken, requestId: randomUUID(), now: 1_201,
    signature: sign('sha256', hostProofBytes({
      challenge, deviceId, origin: 'https://play.cannabeats.social',
    }), keys.privateKey).toString('base64'),
  });
  const gameId = randomUUID();
  store.createAuthorizedGame({
    applicationSessionToken: hostToken, gameId, requestId: randomUUID(),
    catalogVersion: catalog.version, rules: { preset: 'family' }, now: 2_000,
  });
  return { deviceId, gameId, hostToken, keys, now: 2_100, path, root, store };
}

function record(setup, overrides = {}) {
  setup.now += 1;
  const input = {
    applicationSessionToken: setup.hostToken,
    gameId: setup.gameId,
    recordId: overrides.recordId ?? randomUUID(),
    kind: overrides.kind ?? 'audio',
    code: overrides.code ?? 'audio_interrupted',
    metricValue: overrides.metricValue ?? 1,
    now: overrides.now ?? setup.now,
  };
  return { input, result: setup.store.recordDiagnostic(input) };
}

test('diagnostic identity replays exactly while finite content and privacy remain closed', () => {
  const setup = setupGame();
  const first = record(setup);
  assert.deepEqual(setup.store.recordDiagnostic(first.input), first.result);
  expectCode(() => setup.store.recordDiagnostic({ ...first.input, metricValue: 2 }),
    'request_conflict');
  for (const invalid of [
    { kind: 'host', code: 'audio_interrupted', metricValue: 1 },
    { kind: 'audio', code: 'raw_error', metricValue: 1 },
    { kind: 'audio', code: 'audio_interrupted', metricValue: -1 },
    { kind: 'audio', code: 'audio_interrupted', metricValue: 1_000_000_001 },
    {
      kind: 'audio', code: 'audio_interrupted', metricValue: 1,
      now: Number.MAX_SAFE_INTEGER - DIAGNOSTIC_RETENTION_MS + 1,
    },
  ]) expectCode(() => record(setup, invalid), 'invalid_request');

  const exported = setup.store.exportDiagnostics({
    applicationSessionToken: setup.hostToken, gameId: setup.gameId, now: setup.now,
  });
  assert.deepEqual(Object.keys(exported).sort(), [
    'audio', 'code', 'diagnostics', 'game', 'gameEvents', 'generatedAt', 'playback',
  ]);
  assert.equal(exported.gameEvents[0].type, 'game_created');
  assert.deepEqual(exported.diagnostics, [{
    kind: 'audio', code: 'audio_interrupted', metricValue: 1,
    occurredAt: first.result.record.occurredAt,
    expiresAt: first.result.record.expiresAt,
  }]);
  const text = JSON.stringify(exported);
  for (const prohibited of [
    setup.gameId, setup.deviceId, setup.hostToken, first.input.recordId,
    'spotify:track:', 'Authorization', 'cookie', 'publicKey', 'signature', '/Users/',
  ]) assert.equal(text.includes(String(prohibited)), false, prohibited);
  setup.store.close();
});

test('diagnostic expiry is visible before and absent at equality and after restart cleanup', () => {
  const setup = setupGame();
  const first = record(setup, { now: 3_000 });
  const expiry = first.result.record.expiresAt;
  assert.equal(expiry, 3_000 + DIAGNOSTIC_RETENTION_MS);
  assert.equal(setup.store.exportDiagnostics({
    applicationSessionToken: setup.hostToken, gameId: setup.gameId, now: expiry - 1,
  }).diagnostics.length, 1);
  const before = setup.store.gameSnapshot(setup.gameId);
  assert.equal(setup.store.exportDiagnostics({
    applicationSessionToken: setup.hostToken, gameId: setup.gameId, now: expiry,
  }).diagnostics.length, 0);
  assert.deepEqual(setup.store.gameSnapshot(setup.gameId), before);
  const renewed = setup.store.recordDiagnostic({ ...first.input, now: expiry });
  assert.equal(renewed.record.recordId, first.input.recordId);
  assert.equal(renewed.record.occurredAt, expiry);
  assert.equal(renewed.record.expiresAt, expiry + DIAGNOSTIC_RETENTION_MS);
  assert.equal(setup.store.exportDiagnostics({
    applicationSessionToken: setup.hostToken, gameId: setup.gameId, now: expiry,
  }).diagnostics.length, 1);
  assert.deepEqual(setup.store.gameSnapshot(setup.gameId), before);
  setup.store.close();
  setup.store = createReleaseStore(setup.path, {
    catalog, now: expiry + DIAGNOSTIC_RETENTION_MS,
  });
  assert.deepEqual(setup.store.gameSnapshot(setup.gameId), before);
  setup.store.close();
  const database = new DatabaseSync(setup.path, { readOnly: true });
  assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM diagnostic_records`).get().count, 0);
  database.close();
});

test('diagnostic capacity accepts max-minus-one and max without changing game authority', () => {
  const setup = setupGame();
  const before = setup.store.gameSnapshot(setup.gameId);
  setup.store.close();
  const database = new DatabaseSync(setup.path);
  const insert = database.prepare(`INSERT INTO diagnostic_records
    (record_id,game_id,kind,code,metric_value,occurred_at,expires_at)
    VALUES (?,?,'audio','buffer_dropped',1,?,?)`);
  for (let index = 0; index < MAX_DIAGNOSTICS_PER_GAME - 1; index += 1) {
    const occurredAt = 3_000 + index;
    insert.run(randomUUID(), setup.gameId, occurredAt, occurredAt + DIAGNOSTIC_RETENTION_MS);
  }
  database.close();
  setup.now = 4_000;
  setup.store = createReleaseStore(setup.path, { catalog, now: setup.now });
  const maximum = record(setup, { code: 'buffer_dropped' });
  assert.equal(setup.store.recordDiagnostic(maximum.input).record.recordId,
    maximum.result.record.recordId);
  expectCode(() => record(setup, { code: 'buffer_dropped' }), 'diagnostic_capacity');
  assert.deepEqual(setup.store.gameSnapshot(setup.gameId), before);
  setup.store.close();
});

test('cross-kind diagnostic corruption fails export and restart without partial output', () => {
  const setup = setupGame();
  const first = record(setup);
  setup.store.close();
  const database = new DatabaseSync(setup.path);
  const trigger = database.prepare(`SELECT sql FROM sqlite_schema
    WHERE type='trigger' AND name='diagnostic_records_immutable_update'`).get().sql;
  database.exec('DROP TRIGGER diagnostic_records_immutable_update');
  database.prepare(`UPDATE diagnostic_records SET code='readiness_blocked'
    WHERE record_id=?`).run(first.input.recordId);
  database.exec(trigger);
  database.close();
  expectCode(() => createReleaseStore(setup.path, { catalog, now: setup.now + 1 }),
    'database_corrupt');
});
