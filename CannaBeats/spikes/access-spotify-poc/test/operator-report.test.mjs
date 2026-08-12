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
  componentReportExitCode,
  formatSessionReport,
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
      revision INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      ended_at INTEGER,
      terminal_outcome TEXT
    );
    CREATE TABLE game_event_coverage (
      run_id TEXT PRIMARY KEY REFERENCES game_runs(id) ON DELETE CASCADE,
      baseline_revision INTEGER NOT NULL,
      last_recorded_revision INTEGER NOT NULL,
      started_at INTEGER NOT NULL,
      purged_at INTEGER
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
    CREATE TABLE game_events (
      run_id TEXT NOT NULL REFERENCES game_runs(id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL, event_type TEXT NOT NULL, outcome TEXT NOT NULL,
      actor_type TEXT NOT NULL, actor_ref TEXT, action_id TEXT, round INTEGER,
      detail_code TEXT, detail_value INTEGER, reason_code TEXT, occurred_at INTEGER NOT NULL,
      PRIMARY KEY (run_id, sequence)
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
    INSERT INTO game_event_coverage
      (run_id, baseline_revision, last_recorded_revision, started_at)
    VALUES (?, 0, 0, ?)
  `).run(runId, now - 50_000);
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
  db.prepare(`
    INSERT INTO game_events
      (run_id, sequence, event_type, outcome, actor_type, actor_ref, action_id,
       round, detail_code, occurred_at)
    VALUES
      (?, 1, 'game_started', 'accepted', 'host', ?, ?, 1, NULL, ?),
      (?, 2, 'track_requested', 'accepted', 'host', ?, ?, 1, 'play', ?),
      (?, 3, 'audio_command_failed', 'failed', 'source', ?, ?, 1, 'play', ?)
  `).run(
    runId, hostId, randomUUID(), now - 12_000,
    runId, hostId, randomUUID(), now - 11_000,
    runId, sourceId, randomUUID(), now - 10_000,
  );
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
  assert.equal(session.history.available, true);
  assert.equal(session.history.eventCount, 3);
  assert.equal(session.history.coverage.complete, true);
  assert.deepEqual(session.history.outcomes, { accepted: 2, failed: 1 });
  assert.deepEqual(session.history.recentEvents.map((event) => event.type), [
    'game_started', 'track_requested', 'audio_command_failed',
  ]);
  assert.equal(session.history.recentEvents.at(-1).reasonCode, null);
  const text = formatSessionReport(report);
  assert.match(text, /coverage=complete baseline=0 current=0/);
  assert.match(text, /retention=full-history/);
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

test('the operator projection never returns an unreviewed persisted reason code', () => {
  const { databasePath, now } = fixture();
  const writable = new DatabaseSync(databasePath);
  writable.prepare("UPDATE game_events SET reason_code = 'token_secret_abcdefghijklmnopqrstuvwxyz' WHERE sequence = 3").run();
  writable.close();
  const db = openOperatorDatabase(databasePath);
  const serialized = JSON.stringify(sessionReport(db, { now }));
  db.close();
  assert.doesNotMatch(serialized, /token_secret_abcdefghijklmnopqrstuvwxyz/);
  assert.match(serialized, /unrecognized_reason/);
});

test('the operator report can inspect a pre-history run before current-app migration', () => {
  const { databasePath, now } = fixture();
  const writable = new DatabaseSync(databasePath);
  writable.exec('ALTER TABLE game_runs DROP COLUMN terminal_outcome');
  writable.close();
  const db = openOperatorDatabase(databasePath);
  const report = sessionReport(db, { now });
  db.close();
  assert.equal(report.sessions.length, 1);
  assert.equal(report.sessions[0].runId !== null, true);
  assert.equal(report.sessions[0].liveness.state, 'active');
});

test('an explicit terminal abandonment is not reported as a completed game', () => {
  const { databasePath, now } = fixture();
  const writable = new DatabaseSync(databasePath);
  writable.prepare("UPDATE game_sessions SET status = 'ended' WHERE code = 'ABC234'").run();
  writable.prepare("UPDATE game_runs SET ended_at = ?, terminal_outcome = 'abandoned'").run(now);
  if (!writable.prepare("PRAGMA table_info(game_event_coverage)").all()
    .some((column) => column.name === 'lifecycle_state')) {
    writable.exec("ALTER TABLE game_event_coverage ADD COLUMN lifecycle_state TEXT NOT NULL DEFAULT 'recording'");
  }
  writable.prepare(`
    UPDATE game_event_coverage
    SET last_recorded_revision = (SELECT revision FROM game_runs WHERE id = run_id),
        lifecycle_state = 'sealed'
  `).run();
  writable.prepare(`
    INSERT INTO game_events
      (run_id, sequence, event_type, outcome, actor_type, round, occurred_at)
    SELECT id, 4, 'game_abandoned', 'abandoned', 'host', 3, ? FROM game_runs
  `).run(now);
  writable.close();
  const db = openOperatorDatabase(databasePath);
  const session = sessionReport(db, { now }).sessions[0];
  db.close();
  assert.deepEqual(session.liveness, {
    state: 'abandoned', confidence: 'confirmed', reasonCode: 'explicit_host_abandonment',
  });
  assert.deepEqual(session.history.terminal, {
    type: 'game_abandoned', outcome: 'abandoned', occurredAt: new Date(now).toISOString(),
    consistent: true,
  });
  const purge = new DatabaseSync(databasePath);
  purge.prepare("DELETE FROM game_events").run();
  purge.close();
  const afterPurgeDb = openOperatorDatabase(databasePath);
  const afterPurge = sessionReport(afterPurgeDb, { now }).sessions[0];
  afterPurgeDb.close();
  assert.deepEqual(afterPurge.liveness, {
    state: 'unknown', confidence: 'unavailable', reasonCode: 'terminal_evidence_inconsistent',
  });

  const markPurged = new DatabaseSync(databasePath);
  markPurged.prepare("UPDATE game_event_coverage SET purged_at = ?").run(now);
  markPurged.close();
  const retainedDb = openOperatorDatabase(databasePath);
  const retained = sessionReport(retainedDb, { now }).sessions[0];
  retainedDb.close();
  assert.deepEqual(retained.liveness, {
    state: 'abandoned', confidence: 'confirmed', reasonCode: 'explicit_host_abandonment',
  });
});

test('an abandoned outcome with a finished snapshot fails closed', () => {
  const { databasePath, now } = fixture();
  const writable = new DatabaseSync(databasePath);
  writable.prepare("UPDATE game_sessions SET status = 'ended' WHERE code = 'ABC234'").run();
  writable.prepare(`
    UPDATE game_runs SET ended_at = ?, terminal_outcome = 'abandoned',
      state = json_set(state, '$.phase', 'finished')
  `).run(now);
  writable.prepare(`
    INSERT INTO game_events
      (run_id, sequence, event_type, outcome, actor_type, round, occurred_at)
    SELECT id, 4, 'game_abandoned', 'abandoned', 'host', 3, ? FROM game_runs
  `).run(now);
  writable.close();
  const db = openOperatorDatabase(databasePath);
  const session = sessionReport(db, { now }).sessions[0];
  db.close();
  assert.deepEqual(session.liveness, {
    state: 'unknown', confidence: 'unavailable', reasonCode: 'terminal_evidence_inconsistent',
  });
});

test('operator conclusions use only projected safe timestamps and revisions', () => {
  const { databasePath, now } = fixture();
  const writable = new DatabaseSync(databasePath);
  if (!writable.prepare("PRAGMA table_info(game_event_coverage)").all()
    .some((column) => column.name === 'lifecycle_state')) {
    writable.exec("ALTER TABLE game_event_coverage ADD COLUMN lifecycle_state TEXT NOT NULL DEFAULT 'recording'");
  }
  writable.prepare("UPDATE game_sessions SET status = 'ended' WHERE code = 'ABC234'").run();
  writable.prepare(`
    UPDATE game_runs SET ended_at = ?, terminal_outcome = 'completed',
      state = json_set(state, '$.phase', 'finished')
  `).run(now + 0.5);
  writable.prepare(`
    UPDATE game_event_coverage
    SET last_recorded_revision = (SELECT revision FROM game_runs WHERE id = run_id),
        lifecycle_state = 'sealed'
  `).run();
  writable.prepare(`
    INSERT INTO game_events
      (run_id, sequence, event_type, outcome, actor_type, round, occurred_at)
    SELECT id, 4, 'game_completed', 'completed', 'system', 3, ? FROM game_runs
  `).run(now);
  writable.close();

  for (const invalidEndedAt of [now + 0.5, 1e300]) {
    const mutate = new DatabaseSync(databasePath);
    mutate.prepare('UPDATE game_runs SET ended_at = ?').run(invalidEndedAt);
    mutate.close();
    const db = openOperatorDatabase(databasePath);
    const session = sessionReport(db, { now }).sessions[0];
    db.close();
    assert.deepEqual(session.liveness, {
      state: 'unknown', confidence: 'unavailable', reasonCode: 'terminal_evidence_inconsistent',
    });
    assert.equal(session.history.terminal.consistent, false);
  }

  const unsafe = new DatabaseSync(databasePath);
  unsafe.prepare('UPDATE game_runs SET ended_at = ?, revision = ?').run(now, 9007199254740992);
  unsafe.prepare('UPDATE game_event_coverage SET last_recorded_revision = ?')
    .run(9007199254740992);
  unsafe.close();
  const db = openOperatorDatabase(databasePath);
  const session = sessionReport(db, { now }).sessions[0];
  db.close();
  assert.equal(session.history.coverage.complete, false);
  assert.equal(session.history.coverage.lastRecordedRevision, null);
  assert.equal(session.history.coverage.currentRevision, null);
  assert.deepEqual(session.liveness, {
    state: 'unknown', confidence: 'unavailable', reasonCode: 'terminal_evidence_inconsistent',
  });
});

test('the operator projection allowlists every persisted enum-like string', () => {
  const { databasePath, now } = fixture();
  const sentinel = 'token_secret_abcdefghijklmnopqrstuvwxyz';
  const writable = new DatabaseSync(databasePath);
  writable.prepare("UPDATE game_runs SET state = json_set(state, '$.phase', ?)").run(sentinel);
  writable.prepare("UPDATE managed_audio_leases SET playback_status = ?").run(sentinel);
  writable.prepare("UPDATE managed_audio_commands SET kind = ?").run(sentinel);
  writable.prepare(`
    UPDATE game_events SET event_type = ?, outcome = ?, actor_type = ?, detail_code = ?
    WHERE sequence = 3
  `).run(sentinel, sentinel, sentinel, sentinel);
  writable.prepare(`
    UPDATE game_events SET event_type = 'game_completed', outcome = ? WHERE sequence = 1
  `).run(sentinel);
  writable.close();
  const db = openOperatorDatabase(databasePath);
  const serialized = JSON.stringify(sessionReport(db, { now }));
  db.close();
  assert.doesNotMatch(serialized, new RegExp(sentinel));
  assert.match(serialized, /unrecognized_/);
});

test('the operator and member-facing history consume the shared audio lifecycle taxonomy', () => {
  const { databasePath, now } = fixture();
  const writable = new DatabaseSync(databasePath);
  writable.prepare(`
    UPDATE game_events
    SET event_type = 'audio_command_cancelled', outcome = 'cancelled'
    WHERE sequence = 3
  `).run();
  writable.close();
  const db = openOperatorDatabase(databasePath);
  const event = sessionReport(db, { now }).sessions[0].history.recentEvents.at(-1);
  db.close();
  assert.deepEqual({ type: event.type, outcome: event.outcome }, {
    type: 'audio_command_cancelled', outcome: 'cancelled',
  });
});

test('terminal conclusions fail closed when the history table exists but run coverage is missing', () => {
  const { databasePath, now } = fixture();
  const writable = new DatabaseSync(databasePath);
  writable.prepare("UPDATE game_sessions SET status = 'ended' WHERE code = 'ABC234'").run();
  writable.prepare(`
    UPDATE game_runs SET ended_at = ?, terminal_outcome = 'completed',
      state = json_set(state, '$.phase', 'finished')
  `).run(now);
  writable.prepare('DELETE FROM game_events').run();
  writable.prepare('DELETE FROM game_event_coverage').run();
  writable.close();
  const db = openOperatorDatabase(databasePath);
  const liveness = sessionReport(db, { now }).sessions[0].liveness;
  db.close();
  assert.deepEqual(liveness, {
    state: 'unknown', confidence: 'unavailable', reasonCode: 'terminal_evidence_inconsistent',
  });
});

test('contradictory terminal evidence fails closed instead of claiming a confirmed outcome', () => {
  const { databasePath, now } = fixture();
  const writable = new DatabaseSync(databasePath);
  writable.prepare("UPDATE game_sessions SET status = 'ended' WHERE code = 'ABC234'").run();
  writable.prepare("UPDATE game_runs SET ended_at = ?, terminal_outcome = 'completed'").run(now);
  writable.prepare(`
    INSERT INTO game_events
      (run_id, sequence, event_type, outcome, actor_type, round, occurred_at)
    SELECT id, 4, 'game_abandoned', 'abandoned', 'host', 3, ? FROM game_runs
  `).run(now);
  writable.close();
  const db = openOperatorDatabase(databasePath);
  const session = sessionReport(db, { now }).sessions[0];
  db.close();
  assert.deepEqual(session.liveness, {
    state: 'unknown', confidence: 'unavailable', reasonCode: 'terminal_evidence_inconsistent',
  });
  assert.equal(session.history.terminal.consistent, false);
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

test('scheduled component checks fail only at the configured severity threshold', () => {
  const report = { components: {
    access: { status: 'healthy' },
    managedSource: { status: 'degraded' },
    certificate: { status: 'unknown' },
  } };
  assert.equal(componentReportExitCode(report, 'unavailable'), 0);
  assert.equal(componentReportExitCode(report, 'degraded'), 2);
  report.components.access.status = 'unavailable';
  assert.equal(componentReportExitCode(report, 'unavailable'), 2);
  assert.throws(() => componentReportExitCode(report, 'private-severity'), /fail-on/i);
});
