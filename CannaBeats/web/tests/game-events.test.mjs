import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { openDatabase } from "../../spikes/access-spotify-poc/db.mjs";
import { database, DATABASE_GAME_EVENT_REASON_CODES } from "../lib/server/database.ts";
import {
  deleteGameHistory,
  gameHistory,
  purgeExpiredGameHistory,
  recordGameEvent,
  sealGameHistory,
  GAME_EVENT_REASON_CODES,
} from "../lib/server/game-events.ts";
import {
  PRIVACY_PROJECTION_CONTRACT,
  projectMemberHistory,
} from "../lib/server/privacy-projection.ts";

const root = mkdtempSync(join(tmpdir(), "cannabeats-game-events-test-"));
after(() => rmSync(root, { recursive: true, force: true }));

function fixture(name) {
  const databasePath = join(root, `${name}.sqlite`);
  const access = openDatabase(databasePath);
  const hostId = randomUUID();
  const runId = randomUUID();
  const now = Date.parse("2026-08-12T12:00:00Z");
  access.prepare("INSERT INTO users (id, display_name, role, created_at) VALUES (?, 'Private Host', 'host', ?)")
    .run(hostId, now);
  access.prepare(`
    INSERT INTO game_sessions (code, host_user_id, status, active_run_id, created_at, updated_at)
    VALUES ('HIST23', ?, 'playing', ?, ?, ?)
  `).run(hostId, runId, now, now);
  access.close();
  process.env.CANNABEATS_DATABASE_PATH = databasePath;
  const db = database();
  db.prepare(`
    INSERT INTO game_runs (id, session_code, state, created_at, updated_at)
    VALUES (?, 'HIST23', ?, ?, ?)
  `).run(runId, JSON.stringify({ runId, code: "HIST23", phase: "playing" }), now, now);
  return { db, databasePath, hostId, now, runId };
}

test("significant history is chronological, run-scoped, and privacy bounded", () => {
  const { db, now, runId } = fixture("chronology");
  db.exec("BEGIN IMMEDIATE");
  try {
    recordGameEvent({
      runId,
      type: "game_started",
      outcome: "accepted",
      actorType: "host",
      round: 1,
      occurredAt: now + 1,
    });
    recordGameEvent({
      runId,
      type: "track_requested",
      outcome: "accepted",
      actorType: "host",
      actionId: randomUUID(),
      detailCode: "play",
      round: 1,
      occurredAt: now + 2,
    });
    recordGameEvent({
      runId,
      type: "answer_revealed",
      outcome: "accepted",
      actorType: "host",
      detailCode: "correct",
      detailValue: 0,
      round: 1,
      occurredAt: now + 3,
    });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  const history = gameHistory(runId);
  assert.deepEqual(history.coverage, {
    complete: true,
    baselineRevision: 0,
    lastRecordedRevision: 0,
    currentRevision: 0,
  });
  assert.deepEqual(history.events.map((event) => [event.sequence, event.type]), [
    [1, "game_started"],
    [2, "track_requested"],
    [3, "answer_revealed"],
  ]);
  assert.equal(history.current.phase, "playing");
  const serialized = JSON.stringify(history);
  assert.doesNotMatch(serialized, /Private Host|spotify:track|token|credential/i);
  assert.throws(
    () => recordGameEvent({
      runId,
      type: "track_requested",
      outcome: "accepted",
      actorType: "host",
      detailCode: "spotify:track:secret",
      occurredAt: now + 4,
    }),
    /detail code/i,
  );
  assert.throws(() => db.prepare(`
    INSERT INTO game_events
      (run_id, sequence, event_type, outcome, actor_type, detail_code, occurred_at)
    VALUES (?, 4, 'track_requested', 'accepted', 'host', 'spotify:track:secret', ?)
  `).run(runId, now + 4), /constraint/i);
  assert.throws(() => db.prepare(`
    INSERT INTO game_events
      (run_id, sequence, event_type, outcome, actor_type, occurred_at)
    VALUES (?, 4, 'free_form_event', 'accepted', 'host', ?)
  `).run(runId, now + 4), /constraint/i);
  assert.throws(
    () => recordGameEvent({
      runId,
      type: "audio_command_failed",
      outcome: "failed",
      actorType: "source",
      reasonCode: "token_secret_abcdefghijklmnopqrstuvwxyz",
      occurredAt: now + 4,
    }),
    /reason code/i,
  );
  assert.throws(() => db.prepare(`
    INSERT INTO game_events
      (run_id, sequence, event_type, outcome, actor_type, reason_code, occurred_at)
    VALUES (?, 4, 'audio_command_failed', 'failed', 'source',
            'token_secret_abcdefghijklmnopqrstuvwxyz', ?)
  `).run(runId, now + 4), /constraint/i);
});

test("application, SQLite, and operator reason taxonomies remain in parity", () => {
  const { db } = fixture("reason-parity");
  assert.deepEqual([...GAME_EVENT_REASON_CODES].sort(), [...DATABASE_GAME_EVENT_REASON_CODES].sort());
  const schema = db.prepare(`
    SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'game_events'
  `).get().sql;
  assert.deepEqual([...GAME_EVENT_REASON_CODES].sort(), [...PRIVACY_PROJECTION_CONTRACT.eventReasons].sort());
  for (const reason of GAME_EVENT_REASON_CODES) {
    assert.match(schema, new RegExp(`'${reason}'`));
  }
});

test("member history projects malformed legacy strings through the shared privacy contract", () => {
  const { db, now, runId } = fixture("privacy-projection");
  db.prepare("UPDATE game_runs SET state = ? WHERE id = ?")
    .run(JSON.stringify({ phase: "token_secret_phase", round: 1 }), runId);
  db.prepare(`
    INSERT INTO game_events
      (run_id, sequence, event_type, outcome, actor_type, actor_ref, action_id, command_ref,
       detail_code, reason_code, occurred_at)
    VALUES (?, 1, 'game_started', 'accepted', 'host',
            'token_secret_actor', 'token_secret_action', 'token_secret_command',
            'host', NULL, ?)
  `).run(runId, now);

  const history = gameHistory(runId);
  assert.equal(history.current.phase, null);
  assert.deepEqual({
    actorRef: history.events[0].actorRef,
    actionId: history.events[0].actionId,
    commandRef: history.events[0].commandRef,
  }, { actorRef: null, actionId: null, commandRef: null });
  assert.doesNotMatch(JSON.stringify(history), /token_secret/);
});

test("the shared member projection fails closed for every persisted output field", () => {
  const secret = "token_secret_persisted_value";
  const projected = projectMemberHistory({
    run: {
      id: secret, session_code: secret, revision: secret, updated_at: secret,
      ended_at: secret, terminal_outcome: secret,
    },
    state: { phase: secret, round: -1 },
    coverage: {
      baseline_revision: secret, last_recorded_revision: -1,
      purged_at: secret, lifecycle_state: secret,
    },
    events: [{
      sequence: -1, event_type: secret, outcome: secret, actor_type: secret,
      actor_ref: secret, action_id: secret, command_ref: secret, round: -1,
      detail_code: secret, detail_value: -1, reason_code: secret, occurred_at: secret,
    }],
    total: secret,
  });
  assert.deepEqual(projected, {
    runId: null,
    lobbyId: null,
    current: {
      phase: null, round: null, revision: null, updatedAt: null,
      endedAt: null, terminalOutcome: null,
    },
    coverage: {
      complete: false, baselineRevision: null, lastRecordedRevision: null,
      currentRevision: null,
    },
    retention: { purgedAt: null, lifecycle: null },
    events: [{
      sequence: null,
      type: "unrecognized_event_type",
      outcome: "unrecognized_outcome",
      actorType: "unrecognized_actor_type",
      actorRef: null,
      actionId: null,
      commandRef: null,
      round: null,
      detailCode: "unrecognized_detail_code",
      detailValue: null,
      reasonCode: "unrecognized_reason",
      occurredAt: null,
    }],
    truncated: false,
  });
  assert.doesNotMatch(JSON.stringify(projected), /token_secret/);
  assert.deepEqual(Object.keys(projected), PRIVACY_PROJECTION_CONTRACT.memberHistoryFields);
  assert.deepEqual(Object.keys(projected.current), PRIVACY_PROJECTION_CONTRACT.memberCurrentFields);
  assert.deepEqual(Object.keys(projected.coverage), PRIVACY_PROJECTION_CONTRACT.memberCoverageFields);
  assert.deepEqual(Object.keys(projected.retention), PRIVACY_PROJECTION_CONTRACT.memberRetentionFields);
});

test("a Slice 1 state write is disclosed as a significant-history coverage gap", () => {
  const { db, now, runId } = fixture("rollback-coverage");
  db.prepare("UPDATE game_runs SET state = ?, updated_at = ? WHERE id = ?")
    .run(JSON.stringify({ phase: "playing", round: 2 }), now + 1, runId);
  assert.deepEqual(gameHistory(runId).coverage, {
    complete: false,
    baselineRevision: 0,
    lastRecordedRevision: 0,
    currentRevision: 1,
  });
});

test("SQLite enforces history lifecycle edges, sealed immutability, and migration-ledger immutability", () => {
  const { db, now, runId } = fixture("history-db-authority");
  assert.throws(() => db.prepare(`
    UPDATE game_event_coverage SET lifecycle_state = 'purged', purged_at = ? WHERE run_id = ?
  `).run(now, runId), /lifecycle transition/i);

  recordGameEvent({
    runId,
    type: "game_completed",
    outcome: "completed",
    actorType: "system",
    occurredAt: now,
  });
  const state = JSON.parse(db.prepare("SELECT state FROM game_runs WHERE id = ?").get(runId).state);
  state.phase = "finished";
  db.prepare(`UPDATE game_runs SET state=?, ended_at=?, terminal_outcome='completed' WHERE id=?`)
    .run(JSON.stringify(state), now, runId);
  db.prepare("UPDATE game_sessions SET status='ended' WHERE active_run_id=?").run(runId);
  db.prepare(`UPDATE game_event_coverage SET last_recorded_revision=(
    SELECT revision FROM game_runs WHERE id=?) WHERE run_id=?`).run(runId, runId);
  db.prepare("UPDATE game_event_coverage SET lifecycle_state = 'terminal_pending' WHERE run_id = ?")
    .run(runId);
  db.prepare("UPDATE game_event_coverage SET lifecycle_state = 'sealed' WHERE run_id = ?")
    .run(runId);
  assert.throws(() => db.prepare("DELETE FROM game_events WHERE run_id = ?").run(runId), /sealed/i);
  assert.throws(() => db.prepare(`
    UPDATE game_events SET occurred_at = ? WHERE run_id = ? AND sequence = 1
  `).run(now + 1, runId), /immutable/i);
  assert.throws(() => db.prepare(`
    UPDATE game_event_coverage SET lifecycle_state = 'recording' WHERE run_id = ?
  `).run(runId), /lifecycle transition/i);

  const migration = db.prepare(`
    SELECT name, digest, applied_at FROM cannabeats_feature_migrations ORDER BY name LIMIT 1
  `).get();
  assert.throws(() => db.prepare(`
    UPDATE cannabeats_feature_migrations SET applied_at = ? WHERE name = ?
  `).run(migration.applied_at + 1, migration.name), /immutable/i);
  assert.throws(() => db.prepare(`
    DELETE FROM cannabeats_feature_migrations WHERE name = ?
  `).run(migration.name), /immutable/i);
});

test("SQLite refuses lifecycle edges without their authoritative terminal evidence", () => {
  const { db, now, runId } = fixture("history-edge-evidence");
  assert.throws(() => db.prepare(`
    UPDATE game_event_coverage SET lifecycle_state = 'terminal_pending' WHERE run_id = ?
  `).run(runId), /lifecycle transition|terminal evidence/i);
  assert.throws(() => db.prepare(`
    INSERT INTO game_event_coverage
      (run_id, baseline_revision, last_recorded_revision, started_at, lifecycle_state, purged_at)
    VALUES (?, 0, 0, ?, 'purged', ?)
  `).run(randomUUID(), now, now), /coverage initial state|foreign key/i);
  assert.throws(() => db.prepare(`
    DELETE FROM game_event_coverage WHERE run_id = ?
  `).run(runId), /coverage identity/i);
});

test("first feature migration repairs a weakened legacy coverage contract before attesting it", () => {
  const databasePath = join(root, "weakened-coverage.sqlite");
  const access = openDatabase(databasePath);
  const hostId = randomUUID();
  const runId = randomUUID();
  const now = Date.now();
  access.prepare("INSERT INTO users (id, display_name, role, created_at) VALUES (?, 'Host', 'host', ?)")
    .run(hostId, now);
  access.prepare(`
    INSERT INTO game_sessions (code, host_user_id, status, active_run_id, created_at, updated_at)
    VALUES ('WEAK23', ?, 'playing', ?, ?, ?)
  `).run(hostId, runId, now, now);
  access.exec(`
    CREATE TABLE game_runs (
      id TEXT PRIMARY KEY, session_code TEXT NOT NULL REFERENCES game_sessions(code),
      state TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, ended_at INTEGER,
      terminal_outcome TEXT
    );
    CREATE TABLE game_event_coverage (
      run_id TEXT PRIMARY KEY REFERENCES game_runs(id) ON DELETE CASCADE,
      baseline_revision INTEGER NOT NULL,
      last_recorded_revision INTEGER NOT NULL,
      started_at INTEGER NOT NULL,
      purged_at INTEGER,
      lifecycle_state TEXT NOT NULL DEFAULT 'recording'
    );
  `);
  access.prepare(`INSERT INTO game_runs (id, session_code, state, created_at, updated_at)
    VALUES (?, 'WEAK23', '{"phase":"playing"}', ?, ?)`)
    .run(runId, now, now);
  access.prepare(`INSERT INTO game_event_coverage
    (run_id, baseline_revision, last_recorded_revision, started_at)
    VALUES (?, 0, 0, ?)`)
    .run(runId, now);
  access.close();
  process.env.CANNABEATS_DATABASE_PATH = databasePath;
  const db = database();
  assert.throws(() => db.prepare(`
    UPDATE game_event_coverage SET baseline_revision = -1 WHERE run_id = ?
  `).run(runId), /constraint/i);
});

test("sealing is atomic and refuses an incomplete coverage trail", () => {
  const active = fixture("seal-atomic-active");
  assert.throws(() => sealGameHistory(active.runId), /terminal evidence/i);
  assert.equal(active.db.prepare(`
    SELECT lifecycle_state FROM game_event_coverage WHERE run_id = ?
  `).get(active.runId).lifecycle_state, "recording");
  recordGameEvent({
    runId: active.runId,
    type: "game_started",
    outcome: "accepted",
    actorType: "host",
    occurredAt: active.now,
  });

  const incomplete = fixture("seal-incomplete-coverage");
  recordGameEvent({
    runId: incomplete.runId,
    type: "game_completed",
    outcome: "completed",
    actorType: "system",
    occurredAt: incomplete.now,
  });
  const state = JSON.parse(incomplete.db.prepare("SELECT state FROM game_runs WHERE id = ?")
    .get(incomplete.runId).state);
  state.phase = "finished";
  incomplete.db.prepare(`
    UPDATE game_runs SET state = ?, ended_at = ?, terminal_outcome = 'completed' WHERE id = ?
  `).run(JSON.stringify(state), incomplete.now, incomplete.runId);
  incomplete.db.prepare("UPDATE game_sessions SET status = 'ended' WHERE active_run_id = ?")
    .run(incomplete.runId);
  assert.equal(incomplete.db.prepare(`
    SELECT last_recorded_revision < (SELECT revision FROM game_runs WHERE id = ?) AS incomplete
    FROM game_event_coverage WHERE run_id = ?
  `).get(incomplete.runId, incomplete.runId).incomplete, 1);
  assert.throws(() => sealGameHistory(incomplete.runId), /coverage/i);
  assert.equal(incomplete.db.prepare(`
    SELECT lifecycle_state FROM game_event_coverage WHERE run_id = ?
  `).get(incomplete.runId).lifecycle_state, "recording");
});

test("the checkpoint event schema expands without losing existing history", () => {
  const databasePath = join(root, "event-lifecycle-migration.sqlite");
  const access = openDatabase(databasePath);
  const hostId = randomUUID();
  const runId = randomUUID();
  const now = Date.parse("2026-08-12T12:00:00Z");
  access.prepare("INSERT INTO users (id, display_name, role, created_at) VALUES (?, 'Host', 'host', ?)")
    .run(hostId, now);
  access.prepare(`
    INSERT INTO game_sessions (code, host_user_id, status, active_run_id, created_at, updated_at)
    VALUES ('MIGR23', ?, 'playing', ?, ?, ?)
  `).run(hostId, runId, now, now);
  access.exec(`
    CREATE TABLE game_runs (
      id TEXT PRIMARY KEY,
      session_code TEXT NOT NULL REFERENCES game_sessions(code) ON DELETE CASCADE,
      state TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, ended_at INTEGER
    );
    CREATE TABLE game_events (
      run_id TEXT NOT NULL REFERENCES game_runs(id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL,
      event_type TEXT NOT NULL CHECK (event_type IN ('game_started', 'audio_command_interrupted')),
      outcome TEXT NOT NULL CHECK (outcome IN ('accepted', 'completed', 'failed', 'abandoned', 'interrupted', 'recovered')),
      actor_type TEXT NOT NULL, actor_ref TEXT, action_id TEXT, round INTEGER,
      detail_code TEXT, detail_value INTEGER,
      reason_code TEXT CHECK (reason_code IS NULL OR length(reason_code) <= 80),
      occurred_at INTEGER NOT NULL,
      PRIMARY KEY (run_id, sequence)
    );
  `);
  access.prepare(`
    INSERT INTO game_runs (id, session_code, state, created_at, updated_at)
    VALUES (?, 'MIGR23', '{"phase":"playing"}', ?, ?)
  `).run(runId, now, now);
  access.prepare(`
    INSERT INTO game_events
      (run_id, sequence, event_type, outcome, actor_type, occurred_at)
    VALUES (?, 1, 'game_started', 'accepted', 'host', ?)
  `).run(runId, now);
  access.prepare(`
    INSERT INTO game_events
      (run_id, sequence, event_type, outcome, actor_type, reason_code, occurred_at)
    VALUES (?, 2, 'audio_command_interrupted', 'interrupted', 'system',
            'legacy_raw_provider_error', ?)
  `).run(runId, now + 1);
  access.close();
  process.env.CANNABEATS_DATABASE_PATH = databasePath;
  const db = database();
  assert.equal(db.prepare("SELECT event_type FROM game_events WHERE run_id = ?").get(runId).event_type, "game_started");
  assert.equal(
    db.prepare("SELECT reason_code FROM game_events WHERE run_id = ? AND sequence = 2").get(runId).reason_code,
    "unrecognized_reason",
  );
  assert.ok(db.prepare("PRAGMA table_info(game_events)").all().some((column) => column.name === "command_ref"));
  assert.throws(() => db.prepare(`
    INSERT INTO game_events
      (run_id, sequence, event_type, outcome, actor_type, reason_code, occurred_at)
    VALUES (?, 3, 'audio_command_interrupted', 'interrupted', 'system',
            'another_arbitrary_reason', ?)
  `).run(runId, now + 2), /constraint/i);
  recordGameEvent({
    runId,
    type: "audio_command_interrupted",
    outcome: "interrupted",
    actorType: "system",
    commandRef: randomUUID(),
    reasonCode: "lease_expired",
    occurredAt: now + 1,
  });
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM game_events WHERE run_id = ?").get(runId).count, 3);
});

test("canonical migration verification rejects a permissive constraint containing every expected token", () => {
  const { db, databasePath } = fixture("permissive-superset");
  const schema = db.prepare(`
    SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'game_events'
  `).get().sql;
  const permissive = schema.replace(
    "reason_code IS NULL OR reason_code IN (",
    "reason_code IS NULL OR length(reason_code) > 0 OR reason_code IN (",
  );
  assert.notEqual(permissive, schema);
  db.exec("PRAGMA writable_schema = ON");
  db.prepare(`UPDATE sqlite_schema SET sql = ? WHERE type = 'table' AND name = 'game_events'`)
    .run(permissive);
  db.exec("PRAGMA writable_schema = OFF");
  db.exec("PRAGMA schema_version = 9001");

  fixture("permissive-superset-detour");
  process.env.CANNABEATS_DATABASE_PATH = databasePath;
  assert.throws(() => database(), /game-events migration failed canonical schema verification/i);
});

test("recorded feature migrations fail closed when an authoritative trigger is missing", () => {
  const { db, databasePath } = fixture("feature-trigger-tamper");
  assert.ok(db.prepare(`
    SELECT digest FROM cannabeats_feature_migrations WHERE name = 'history_lifecycle_v3'
  `).get());
  db.exec("DROP TRIGGER game_event_coverage_lifecycle_guard");
  fixture("feature-trigger-tamper-detour");
  process.env.CANNABEATS_DATABASE_PATH = databasePath;
  assert.throws(() => database(), /canonical feature objects are missing|canonical schema verification/i);
});

test("history deletion preserves an ended authoritative snapshot and refuses an active run", () => {
  const { db, hostId, now, runId } = fixture("deletion");
  const actionId = randomUUID();
  recordGameEvent({
    runId,
    type: "game_abandoned",
    outcome: "abandoned",
    actorType: "host",
    actionId,
    occurredAt: now,
  });
  db.prepare(`
    INSERT INTO game_action_receipts
      (run_id, actor_id, action_id, action, request_fingerprint, accepted_at)
    VALUES (?, ?, ?, 'abandon', 'fingerprint', ?)
  `).run(runId, hostId, actionId, now);
  assert.throws(() => deleteGameHistory(runId), /terminal evidence/i);

  db.prepare("UPDATE game_runs SET ended_at = ? WHERE id = ?").run(now, runId);
  assert.throws(() => deleteGameHistory(runId), /terminal evidence/i);
  db.prepare("UPDATE game_runs SET terminal_outcome = 'abandoned' WHERE id = ?").run(runId);
  db.prepare("UPDATE game_sessions SET status = 'ended' WHERE active_run_id = ?").run(runId);
  const result = deleteGameHistory(runId);
  assert.deepEqual(result, { events: 1, receipts: 1 });
  assert.equal(db.prepare("SELECT state FROM game_runs WHERE id = ?").get(runId).state.includes("playing"), true);
  assert.equal(gameHistory(runId).events.length, 0);
  assert.equal(db.prepare(`
    SELECT lifecycle_state FROM game_event_coverage WHERE run_id = ?
  `).get(runId).lifecycle_state, "purged");
});

test("history cannot seal or purge contradictory or absent full-history terminal evidence", () => {
  for (const [name, terminalEvent] of [
    ["contradictory", { type: "game_abandoned", outcome: "abandoned" }],
    ["absent", null],
  ]) {
    const { db, now, runId } = fixture(`terminal-${name}`);
    if (terminalEvent) recordGameEvent({
      runId,
      type: terminalEvent.type,
      outcome: terminalEvent.outcome,
      actorType: "system",
      occurredAt: now,
    });
    const state = JSON.parse(db.prepare("SELECT state FROM game_runs WHERE id = ?").get(runId).state);
    state.phase = "finished";
    db.prepare(`
      UPDATE game_runs SET state = ?, ended_at = ?, terminal_outcome = 'completed' WHERE id = ?
    `).run(JSON.stringify(state), now, runId);
    db.prepare("UPDATE game_sessions SET status = 'ended' WHERE active_run_id = ?").run(runId);
    assert.throws(() => deleteGameHistory(runId), /terminal evidence/i);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM game_events WHERE run_id = ?")
      .get(runId).count, terminalEvent ? 1 : 0);
  }
});

test("terminal history stays pending for a bounded late audio outcome, then seals", () => {
  const { db, now, runId } = fixture("terminal-pending-audio");
  const sourceId = randomUUID();
  const commandId = randomUUID();
  db.prepare(`
    INSERT INTO managed_audio_sources
      (id, display_name, token_hash, enabled, created_at, last_seen_at)
    VALUES (?, 'Source', 'hash', 1, ?, ?)
  `).run(sourceId, now, now);
  db.prepare(`
    INSERT INTO managed_audio_command_outcomes
      (command_id, source_id, run_id, completion_fingerprint, completed_at, command_state)
    VALUES (?, ?, ?, '{"pending":true,"kind":"play"}', 0, 'queued')
  `).run(commandId, sourceId, runId);
  const generation = randomUUID();
  db.prepare(`
    UPDATE managed_audio_command_outcomes
    SET command_state = 'claimed', claim_generation = ? WHERE command_id = ?
  `).run(generation, commandId);
  db.prepare(`
    UPDATE managed_audio_command_outcomes SET command_state = 'executing' WHERE command_id = ?
  `).run(commandId);
  db.prepare(`
    UPDATE managed_audio_command_outcomes SET command_state = 'outcome_unknown' WHERE command_id = ?
  `).run(commandId);
  recordGameEvent({
    runId, type: "audio_command_outcome_unknown", outcome: "unknown",
    actorType: "system", commandRef: commandId, detailCode: "play",
    reasonCode: "game_completed", occurredAt: now,
  });
  recordGameEvent({
    runId, type: "game_completed", outcome: "completed",
    actorType: "system", occurredAt: now + 1,
  });
  const state = JSON.parse(db.prepare("SELECT state FROM game_runs WHERE id = ?").get(runId).state);
  state.phase = "finished";
  db.prepare(`
    UPDATE game_runs SET state = ?, ended_at = ?, terminal_outcome = 'completed' WHERE id = ?
  `).run(JSON.stringify(state), now, runId);
  db.prepare(`
    UPDATE game_event_coverage
    SET last_recorded_revision = (SELECT revision FROM game_runs WHERE id = ?)
    WHERE run_id = ?
  `).run(runId, runId);
  db.prepare("UPDATE game_sessions SET status = 'ended' WHERE active_run_id = ?").run(runId);

  assert.deepEqual(sealGameHistory(runId), { sealed: false, replayed: false, pending: true });
  assert.equal(db.prepare(`
    SELECT lifecycle_state FROM game_event_coverage WHERE run_id = ?
  `).get(runId).lifecycle_state, "terminal_pending");
  db.prepare(`
    UPDATE managed_audio_command_outcomes
    SET command_state = 'completed', completed_at = ?, completion_fingerprint = '{"ok":true}'
    WHERE command_id = ?
  `).run(now + 2, commandId);
  recordGameEvent({
    runId, type: "audio_command_completed", outcome: "completed",
    actorType: "source", commandRef: commandId, detailCode: "play", occurredAt: now + 2,
  });
  assert.deepEqual(sealGameHistory(runId), { sealed: true, replayed: false });
});

test("retention is bounded and purges only ended histories older than the cutoff", () => {
  const { db, now, runId } = fixture("retention");
  recordGameEvent({
    runId,
    type: "game_completed",
    outcome: "completed",
    actorType: "system",
    occurredAt: now,
  });
  assert.throws(() => purgeExpiredGameHistory({ now, retentionDays: 0 }), /between 1 and 365/);
  assert.deepEqual(purgeExpiredGameHistory({ now: now + 91 * 86_400_000, retentionDays: 90 }), {
    runs: 0,
    events: 0,
    receipts: 0,
  });
  db.prepare("UPDATE game_runs SET ended_at = ? WHERE id = ?").run(now, runId);
  assert.deepEqual(purgeExpiredGameHistory({ now: now + 91 * 86_400_000, retentionDays: 90 }), {
    runs: 0,
    events: 0,
    receipts: 0,
  });
  const terminalState = JSON.parse(db.prepare("SELECT state FROM game_runs WHERE id = ?").get(runId).state);
  terminalState.phase = "finished";
  db.prepare("UPDATE game_runs SET state = ?, terminal_outcome = 'completed' WHERE id = ?")
    .run(JSON.stringify(terminalState), runId);
  db.prepare(`
    UPDATE game_event_coverage
    SET last_recorded_revision = (SELECT revision FROM game_runs WHERE id = ?)
    WHERE run_id = ?
  `).run(runId, runId);
  db.prepare("UPDATE game_sessions SET status = 'ended' WHERE active_run_id = ?").run(runId);
  assert.deepEqual(purgeExpiredGameHistory({ now: now + 91 * 86_400_000, retentionDays: 90 }), {
    runs: 1,
    events: 1,
    receipts: 0,
  });
  const retainedBoundary = gameHistory(runId).retention.purgedAt;
  assert.equal(retainedBoundary, now + 91 * 86_400_000);
  assert.deepEqual(purgeExpiredGameHistory({ now: now + 92 * 86_400_000, retentionDays: 90 }), {
    runs: 0,
    events: 0,
    receipts: 0,
  });
  assert.equal(gameHistory(runId).retention.purgedAt, retainedBoundary);
  assert.throws(() => recordGameEvent({
    runId,
    type: "audio_source_recovered",
    outcome: "recovered",
    actorType: "source",
    occurredAt: now + 93 * 86_400_000,
  }), /history was purged/i);
  assert.throws(() => db.prepare(`
    INSERT INTO game_events
      (run_id, sequence, event_type, outcome, actor_type, occurred_at)
    VALUES (?, 99, 'audio_source_recovered', 'recovered', 'source', ?)
  `).run(runId, now + 94 * 86_400_000), /history.*sealed|history.*purged|constraint/i);
});

test("retention fails closed when a terminal run has no coverage boundary", () => {
  const { db, now, runId } = fixture("missing-coverage");
  const terminalState = JSON.parse(db.prepare("SELECT state FROM game_runs WHERE id = ?").get(runId).state);
  terminalState.phase = "finished";
  db.prepare(`
    UPDATE game_runs SET state = ?, ended_at = ?, terminal_outcome = 'completed' WHERE id = ?
  `).run(JSON.stringify(terminalState), now, runId);
  db.prepare("UPDATE game_sessions SET status = 'ended' WHERE active_run_id = ?").run(runId);
  db.exec("DROP TRIGGER game_event_coverage_identity_guard");
  db.prepare("DELETE FROM game_event_coverage WHERE run_id = ?").run(runId);
  assert.throws(() => deleteGameHistory(runId), /coverage boundary/i);
  assert.throws(
    () => purgeExpiredGameHistory({ now: now + 91 * 86_400_000, retentionDays: 90 }),
    /coverage boundary/i,
  );
});

test("the deployed standalone retention command purges an ended run without deleting its snapshot", () => {
  const { db, databasePath, now, runId } = fixture("scheduled-retention");
  recordGameEvent({
    runId,
    type: "game_completed",
    outcome: "completed",
    actorType: "system",
    occurredAt: now,
  });
  db.prepare("UPDATE game_runs SET ended_at = ? WHERE id = ?")
    .run(Date.now() - 91 * 86_400_000, runId);
  const terminalState = JSON.parse(db.prepare("SELECT state FROM game_runs WHERE id = ?").get(runId).state);
  terminalState.phase = "finished";
  db.prepare("UPDATE game_runs SET state = ?, terminal_outcome = 'completed' WHERE id = ?")
    .run(JSON.stringify(terminalState), runId);
  db.prepare(`
    UPDATE game_event_coverage
    SET last_recorded_revision = (SELECT revision FROM game_runs WHERE id = ?)
    WHERE run_id = ?
  `).run(runId, runId);
  db.prepare("UPDATE game_sessions SET status = 'ended' WHERE active_run_id = ?").run(runId);
  const output = execFileSync(process.execPath, [
    "scripts/game-history.mjs", "purge", "--retention-days", "90",
  ], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, CANNABEATS_DATABASE_PATH: databasePath },
    encoding: "utf8",
  });
  assert.deepEqual(JSON.parse(output), {
    command: "purge", retentionDays: 90, runs: 1, events: 1, receipts: 0,
  });
  const replayedOutput = execFileSync(process.execPath, [
    "scripts/game-history.mjs", "purge", "--retention-days", "90",
  ], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, CANNABEATS_DATABASE_PATH: databasePath },
    encoding: "utf8",
  });
  assert.deepEqual(JSON.parse(replayedOutput), {
    command: "purge", retentionDays: 90, runs: 0, events: 0, receipts: 0,
  });
  assert.equal(db.prepare("SELECT 1 FROM game_runs WHERE id = ?").get(runId) !== undefined, true);
});

test("the standalone retention artifact no-ops without mutating a pre-history database", () => {
  const databasePath = join(root, "retention-unsupported-slice1.sqlite");
  const access = openDatabase(databasePath);
  const before = access.prepare(`
    SELECT type, name, sql FROM sqlite_schema ORDER BY type, name
  `).all();
  assert.equal(access.prepare(`
    SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'cannabeats_feature_migrations'
  `).get(), undefined);
  access.close();

  const output = execFileSync(process.execPath, [
    "scripts/game-history.mjs", "purge", "--retention-days", "90",
  ], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, CANNABEATS_DATABASE_PATH: databasePath },
    encoding: "utf8",
  });
  assert.deepEqual(JSON.parse(output), {
    command: "purge",
    status: "unsupported_schema",
    reason: "history_feature_unavailable",
  });
  const reopened = openDatabase(databasePath);
  assert.deepEqual(reopened.prepare(`
    SELECT type, name, sql FROM sqlite_schema ORDER BY type, name
  `).all(), before);
  assert.equal(reopened.prepare(`
    SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'cannabeats_feature_migrations'
  `).get(), undefined);
  reopened.close();
});
