import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import { openDatabase } from '../db.mjs';
import {
  componentReport,
  openOperatorDatabase,
  sessionReport,
} from '../operations/operator-report.mjs';

const root = mkdtempSync(join(tmpdir(), 'cannabeats-operator-test-'));
after(() => rmSync(root, { recursive: true, force: true }));

function fixture(now = Date.parse('2026-08-11T12:00:00Z')) {
  const databasePath = join(root, `${randomUUID()}.sqlite`);
  const db = openDatabase(databasePath);
  db.exec(`
    CREATE TABLE game_runs (
      id TEXT PRIMARY KEY,
      session_code TEXT NOT NULL REFERENCES game_sessions(code) ON DELETE CASCADE,
      state TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      ended_at INTEGER
    );
    CREATE TABLE game_run_player_identities (
      run_id TEXT NOT NULL REFERENCES game_runs(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      player_id TEXT NOT NULL,
      joined_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      PRIMARY KEY (run_id, user_id)
    );
    CREATE TABLE managed_audio_sources (
      id TEXT PRIMARY KEY, display_name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
      enabled INTEGER NOT NULL, created_at INTEGER NOT NULL, last_seen_at INTEGER,
      device_id TEXT, last_error TEXT
    );
    CREATE TABLE managed_audio_leases (
      id TEXT PRIMARY KEY, source_id TEXT NOT NULL UNIQUE REFERENCES managed_audio_sources(id),
      session_code TEXT NOT NULL UNIQUE REFERENCES game_sessions(code), acquired_by TEXT NOT NULL REFERENCES users(id),
      acquired_at INTEGER NOT NULL, renewed_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      playback_status TEXT NOT NULL, last_error TEXT
    );
    CREATE TABLE managed_audio_commands (
      id TEXT PRIMARY KEY, lease_id TEXT NOT NULL REFERENCES managed_audio_leases(id),
      source_id TEXT NOT NULL REFERENCES managed_audio_sources(id),
      session_code TEXT NOT NULL REFERENCES game_sessions(code), kind TEXT NOT NULL,
      track_uri TEXT, requested_by TEXT NOT NULL REFERENCES users(id), created_at INTEGER NOT NULL,
      delivered_at INTEGER, completed_at INTEGER, error TEXT
    );
  `);
  const hostId = randomUUID();
  const runId = randomUUID();
  const sourceId = randomUUID();
  const leaseId = randomUUID();
  db.prepare('INSERT INTO users (id, display_name, role, created_at) VALUES (?, ?, ?, ?)')
    .run(hostId, 'Private Host Name', 'host', now - 60_000);
  db.prepare(`
    INSERT INTO game_sessions (code, host_user_id, status, active_run_id, created_at, updated_at)
    VALUES ('ABC234', ?, 'playing', ?, ?, ?)
  `).run(hostId, runId, now - 60_000, now - 10_000);
  db.prepare(`
    INSERT INTO game_session_members (session_code, user_id, joined_at, last_seen_at)
    VALUES ('ABC234', ?, ?, ?)
  `).run(hostId, now - 60_000, now - 5_000);
  db.prepare(`
    INSERT INTO game_runs (id, session_code, state, created_at, updated_at)
    VALUES (?, 'ABC234', ?, ?, ?)
  `).run(runId, JSON.stringify({
    phase: 'playing', round: 3,
    players: [{ id: randomUUID(), name: 'Private Player Name', control: 'phone', timeline: [] }],
  }), now - 50_000, now - 10_000);
  db.prepare(`
    INSERT INTO managed_audio_sources
      (id, display_name, token_hash, enabled, created_at, last_seen_at, device_id, last_error)
    VALUES (?, 'Private source name', 'private-source-token-hash', 1, ?, ?, 'private-device-id', 'raw private source error')
  `).run(sourceId, now - 60_000, now - 1_000);
  db.prepare(`
    INSERT INTO managed_audio_leases
      (id, source_id, session_code, acquired_by, acquired_at, renewed_at, expires_at, playback_status, last_error)
    VALUES (?, ?, 'ABC234', ?, ?, ?, ?, 'playing', 'raw private lease error')
  `).run(leaseId, sourceId, hostId, now - 30_000, now - 1_000, now + 60_000);
  db.prepare(`
    INSERT INTO managed_audio_commands
      (id, lease_id, source_id, session_code, kind, track_uri, requested_by, created_at, delivered_at, completed_at, error)
    VALUES (?, ?, ?, 'ABC234', 'play', 'spotify:track:1234567890123456789012', ?, ?, ?, ?, 'raw provider failure')
  `).run(randomUUID(), leaseId, sourceId, hostId, now - 9_000, now - 8_000, now - 7_000);
  db.close();
  return { databasePath, now };
}

test('the operator summary reports conservative state without private fields', () => {
  const { databasePath, now } = fixture();
  const db = openOperatorDatabase(databasePath);
  const report = sessionReport(db, {
    now,
    applicationVersion: 'git-test',
    catalogVersion: 'catalog-test',
  });
  db.close();
  assert.equal(report.sessions.length, 1);
  const session = report.sessions[0];
  assert.equal(session.liveness.state, 'active');
  assert.equal(session.liveness.confidence, 'inferred');
  assert.equal(session.audio.errorCategory, 'managed_source_error');
  assert.equal(session.audio.latestCommand.errorCategory, 'command_failed');
  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, /Private Host Name|Private Player Name|Private source name/);
  assert.doesNotMatch(serialized, /private-device-id|raw private|spotify:track/);
});

test('the operator database connection rejects writes', () => {
  const { databasePath } = fixture();
  const db = openOperatorDatabase(databasePath);
  assert.throws(() => db.exec("UPDATE game_sessions SET status = 'ended'"), /read-only|readonly/i);
  db.close();
});

test('the operator summary fails closed when a required query cannot run', () => {
  const directory = mkdtempSync(join(tmpdir(), 'cannabeats-operator-broken-schema-'));
  const databasePath = join(directory, 'operator.sqlite');
  const db = new DatabaseSync(databasePath);
  db.exec(`
    CREATE TABLE game_sessions (
      code TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      active_run_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    INSERT INTO game_sessions (code, status, created_at, updated_at)
    VALUES ('FAIL23', 'lobby', 1, 1);
  `);
  db.close();
  const operatorDb = openOperatorDatabase(databasePath);
  try {
    assert.throws(() => sessionReport(operatorDb), /game_runs|operator report/i);
  } finally {
    operatorDb.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('component checks distinguish readiness, capacity, relay, and source state', async () => {
  const { databasePath, now } = fixture();
  const db = openOperatorDatabase(databasePath);
  const calls = [];
  const report = await componentReport({
    db,
    databasePath,
    accessOrigin: 'http://access.test',
    gameOrigin: 'http://game.test',
    relayOrigin: 'http://relay.test',
    relayListenToken: 'private-relay-token',
    now,
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), authorization: options.headers?.authorization });
      if (String(url).endsWith('/stream.pcm')) {
        return new Response(new Uint8Array([0, 1]), {
          headers: {
            'Content-Type': 'audio/L16;rate=48000;channels=2',
            'X-Audio-Rate': '48000',
            'X-Audio-Channels': '2',
            'X-Audio-Encoding': 's16le',
          },
        });
      }
      return Response.json({ ready: true });
    },
  });
  db.close();
  assert.equal(report.components.access.status, 'healthy');
  assert.equal(report.components.game.status, 'healthy');
  assert.equal(report.components.database.status, 'healthy');
  assert.equal(report.components.relay.status, 'healthy');
  assert.equal(report.components.managedSource.status, 'degraded');
  assert.equal(report.components.managedSource.reasonCode, 'source_reported_error');
  assert.equal(report.components.certificate.status, 'unknown');
  assert.ok(calls.some((call) => call.url === 'http://relay.test/stream.pcm'
    && call.authorization === 'Bearer private-relay-token'));
  assert.doesNotMatch(JSON.stringify(report), /private-relay-token/);
  assert.doesNotMatch(JSON.stringify(report), /raw private source error/);
});

test('component checks reject successful responses with invalid contracts', async () => {
  const { databasePath, now } = fixture();
  const writable = new DatabaseSync(databasePath);
  writable.prepare('UPDATE managed_audio_sources SET last_error = NULL').run();
  writable.close();
  const db = openOperatorDatabase(databasePath);
  const report = await componentReport({
    db,
    databasePath,
    accessOrigin: 'http://access.test',
    gameOrigin: 'http://game.test',
    relayOrigin: 'http://relay.test',
    relayListenToken: 'private-relay-token',
    now,
    fetchImpl: async (url) => String(url).endsWith('/stream.pcm')
      ? Response.json({ ready: true })
      : Response.json({ ready: false }),
  });
  db.close();
  assert.deepEqual(report.components.access, {
    status: 'degraded', reasonCode: 'readiness_contract_invalid',
  });
  assert.deepEqual(report.components.game, {
    status: 'degraded', reasonCode: 'readiness_contract_invalid',
  });
  assert.deepEqual(report.components.relay, {
    status: 'degraded', reasonCode: 'stream_contract_invalid',
  });
  assert.equal(report.components.managedSource.status, 'healthy');
});

test('component dependency checks use a bounded timeout and report it safely', async () => {
  const { databasePath, now } = fixture();
  const db = openOperatorDatabase(databasePath);
  const report = await componentReport({
    db,
    databasePath,
    accessOrigin: 'http://access.test',
    now,
    dependencyTimeoutMs: 5,
    fetchImpl: async (_url, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(
        Object.assign(new Error('private dependency detail'), { name: 'AbortError' }),
      ));
    }),
  });
  db.close();
  assert.deepEqual(report.components.access, { status: 'unavailable', reasonCode: 'timeout' });
  assert.doesNotMatch(JSON.stringify(report), /private dependency detail/);
});

test('database, volume, and certificate failures remain independent safe states', async () => {
  const report = await componentReport({
    db: { prepare: () => { throw new Error('private database detail'); } },
    databasePath: '/private/database/path.sqlite',
    accessOrigin: 'https://access.test',
    fetchImpl: async () => Response.json({ ready: true }),
    statfsImpl: () => { throw new Error('private volume detail'); },
    certificateCheck: async () => ({ status: 'degraded', reasonCode: 'certificate_expiring', daysRemaining: 3 }),
  });
  assert.deepEqual(report.components.database, { status: 'unavailable', reasonCode: 'read_failed' });
  assert.deepEqual(report.components.databaseVolume, { status: 'unknown', reasonCode: 'capacity_unavailable' });
  assert.deepEqual(report.components.managedSource, { status: 'unknown', reasonCode: 'source_state_unavailable' });
  assert.deepEqual(report.components.certificate, {
    status: 'degraded', reasonCode: 'certificate_expiring', daysRemaining: 3,
  });
  assert.doesNotMatch(JSON.stringify(report), /private|database\/path/);
});
