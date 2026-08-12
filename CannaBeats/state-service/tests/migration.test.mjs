import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { migrateMonolith } from "../src/migrate-monolith.mjs";
import { openStateStoreReadOnly } from "../src/store.mjs";

const root = mkdtempSync(join(tmpdir(), "cannabeats-state-migration-"));
after(() => rmSync(root, { recursive: true, force: true }));

function digest(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function legacyFixture(name, { status = "ended" } = {}) {
  const path = join(root, `${name}.sqlite`);
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys=ON");
  db.exec(`
    CREATE TABLE game_sessions (
      code TEXT PRIMARY KEY, host_user_id TEXT NOT NULL, status TEXT NOT NULL,
      active_run_id TEXT, run_generation INTEGER NOT NULL DEFAULT 1,
      audio_mode TEXT NOT NULL DEFAULT 'managed', created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE game_session_members (
      session_code TEXT NOT NULL, user_id TEXT NOT NULL, joined_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL, PRIMARY KEY(session_code,user_id)
    );
    CREATE TABLE game_runs (
      id TEXT PRIMARY KEY, session_code TEXT NOT NULL, state TEXT NOT NULL,
      revision INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      ended_at INTEGER, terminal_outcome TEXT
    );
    CREATE TABLE game_action_receipts (
      run_id TEXT NOT NULL, actor_id TEXT NOT NULL, action_id TEXT NOT NULL,
      action TEXT NOT NULL, request_fingerprint TEXT NOT NULL, accepted_at INTEGER NOT NULL,
      PRIMARY KEY(run_id,actor_id,action_id)
    );
    CREATE TABLE game_event_coverage (
      run_id TEXT PRIMARY KEY, baseline_revision INTEGER NOT NULL,
      last_recorded_revision INTEGER NOT NULL, started_at INTEGER NOT NULL,
      purged_at INTEGER, lifecycle_state TEXT NOT NULL
    );
    CREATE TABLE game_events (
      run_id TEXT NOT NULL, sequence INTEGER NOT NULL, event_type TEXT NOT NULL,
      outcome TEXT NOT NULL, actor_type TEXT NOT NULL, actor_ref TEXT, action_id TEXT,
      command_ref TEXT, round INTEGER, detail_code TEXT, detail_value INTEGER,
      reason_code TEXT, occurred_at INTEGER NOT NULL, PRIMARY KEY(run_id,sequence)
    );
    CREATE TABLE managed_audio_sources (
      id TEXT PRIMARY KEY, display_name TEXT NOT NULL, token_hash TEXT NOT NULL,
      enabled INTEGER NOT NULL, created_at INTEGER NOT NULL, last_seen_at INTEGER,
      last_error TEXT
    );
    CREATE TABLE managed_audio_leases (
      id TEXT PRIMARY KEY, source_id TEXT NOT NULL, session_code TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE managed_audio_commands (
      id TEXT PRIMARY KEY, source_id TEXT NOT NULL, session_code TEXT NOT NULL,
      kind TEXT NOT NULL, track_uri TEXT, requested_by TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE managed_audio_command_outcomes (
      command_id TEXT PRIMARY KEY, run_id TEXT, command_state TEXT NOT NULL,
      claim_generation TEXT, completion_fingerprint TEXT NOT NULL,
      completed_at INTEGER NOT NULL
    );
  `);
  const now = Date.parse("2026-08-12T16:00:00Z");
  const host = randomUUID();
  const run = randomUUID();
  const action = randomUUID();
  const source = randomUUID();
  const command = randomUUID();
  db.prepare(`INSERT INTO game_sessions VALUES ('ABC234',?,?,?,?,?,?,?)`).run(
    host,status,run,1,"managed",now,now,
  );
  db.prepare(`INSERT INTO game_session_members VALUES ('ABC234',?,?,?)`)
    .run(host,now,now);
  db.prepare(`INSERT INTO game_runs VALUES (?,'ABC234',?,2,?,?,?,?)`).run(
    run,JSON.stringify({ phase: "finished", revision: 2 }),now,now,now,"completed",
  );
  db.prepare(`INSERT INTO game_action_receipts VALUES (?,?,?,'advance','fingerprint',?)`)
    .run(run,host,action,now);
  db.prepare(`INSERT INTO game_event_coverage VALUES (?,0,2,?,NULL,'sealed')`)
    .run(run,now);
  db.prepare(`INSERT INTO game_events VALUES (
    ?,1,'game_completed','completed','system',NULL,NULL,NULL,2,NULL,NULL,NULL,?
  )`).run(run,now);
  db.prepare(`INSERT INTO managed_audio_sources VALUES (?,'Source','hash',1,?,NULL,NULL)`)
    .run(source,now);
  db.prepare(`INSERT INTO managed_audio_commands VALUES (
    ?,?,'ABC234','pause',NULL,?,?
  )`).run(command,source,host,now);
  db.prepare(`INSERT INTO managed_audio_command_outcomes VALUES (
    ?,?,'completed',?,'{"ok":true,"playbackStatus":"paused","error":null}',?
  )`).run(command,run,randomUUID(),now);
  db.close();
  return { path, now, host, run, command };
}

test("drained migration is non-destructive, complete, and idempotent", () => {
  const legacy = legacyFixture("drained");
  const destination = join(root, "drained-state.sqlite");
  const before = digest(legacy.path);
  const first = migrateMonolith({
    sourcePath: legacy.path, destinationPath: destination, now: legacy.now + 1,
  });
  assert.equal(first.replayed, false);
  assert.equal(digest(legacy.path), before);
  assert.deepEqual(first.rowCounts, {
    lobbies: 1, members: 1, runs: 1, receipts: 1, coverage: 1,
    events: 1, sources: 1, commands: 1,
  });
  const state = openStateStoreReadOnly(destination);
  assert.equal(state.prepare("PRAGMA foreign_key_check").all().length, 0);
  assert.deepEqual({ ...state.prepare(`SELECT status,activated_at,first_admitted_at
    FROM state_authority WHERE singleton='state'`).get() }, {
    status: "candidate", activated_at: null, first_admitted_at: null,
  });
  assert.equal(state.prepare("SELECT lifecycle FROM history_streams WHERE run_id=?")
    .get(legacy.run).lifecycle, "sealed");
  assert.equal(state.prepare(`SELECT to_state FROM managed_command_transitions
    WHERE command_id=?`).get(legacy.command).to_state, "completed");
  assert.throws(() => state.prepare("DELETE FROM managed_command_transitions").run(), /read.?only/i);
  state.close();
  const replay = migrateMonolith({ sourcePath: legacy.path, destinationPath: destination });
  assert.equal(replay.replayed, true);
  assert.equal(replay.contentDigest, first.contentDigest);
});

test("migration refuses active lobbies before creating destination authority", () => {
  const legacy = legacyFixture("active", { status: "playing" });
  const destination = join(root, "active-state.sqlite");
  assert.throws(() => migrateMonolith({
    sourcePath: legacy.path, destinationPath: destination,
  }), /requires a drained source/);
  assert.equal(existsSync(destination), false);
  assert.equal(readdirSync(root).some((name) => name.startsWith("active-state.sqlite.candidate-")), false);
});

test("failed candidate validation leaves source and destination authority untouched", () => {
  const legacy = legacyFixture("invalid-history");
  const source = new DatabaseSync(legacy.path);
  source.prepare("UPDATE game_event_coverage SET lifecycle_state='poisoned'").run();
  source.close();
  const before = digest(legacy.path);
  const destination = join(root, "invalid-history-state.sqlite");
  assert.throws(() => migrateMonolith({
    sourcePath: legacy.path, destinationPath: destination,
  }), /check constraint|lifecycle/i);
  assert.equal(digest(legacy.path), before);
  assert.equal(existsSync(destination), false);
  assert.equal(readdirSync(root).some((name) =>
    name.startsWith("invalid-history-state.sqlite.candidate-")), false);
});
