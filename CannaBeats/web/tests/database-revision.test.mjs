import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { openDatabase } from "../../spikes/access-spotify-poc/db.mjs";
import {
  GameStateBusyError,
  StaleGameStateError,
  saveGameRunState,
} from "../lib/server/game-state.ts";
import { database } from "../lib/server/database.ts";

const root = mkdtempSync(join(tmpdir(), "cannabeats-game-revision-test-"));
after(() => rmSync(root, { recursive: true, force: true }));

test("the bridge gives Slice 1 state writers a monotonic database revision", () => {
  const databasePath = join(root, "slice-one.sqlite");
  const sliceOne = openDatabase(databasePath);
  const now = Date.now();
  sliceOne.prepare("INSERT INTO users (id, display_name, role, created_at) VALUES ('host-1', 'Host', 'host', ?)")
    .run(now);
  sliceOne.prepare(`
    INSERT INTO game_sessions (code, host_user_id, status, active_run_id, created_at, updated_at)
    VALUES ('ROLL23', 'host-1', 'playing', 'run-1', ?, ?)
  `).run(now, now);
  sliceOne.exec(`
    CREATE TABLE game_runs (
      id TEXT PRIMARY KEY,
      session_code TEXT NOT NULL REFERENCES game_sessions(code) ON DELETE CASCADE,
      state TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      ended_at INTEGER
    )
  `);
  const state = { runId: "run-1", runGeneration: 1, revision: 7, code: "ROLL23", phase: "revealed" };
  sliceOne.prepare(`
    INSERT INTO game_runs (id, session_code, state, created_at, updated_at)
    VALUES ('run-1', 'ROLL23', ?, ?, ?)
  `).run(JSON.stringify(state), now, now);
  sliceOne.close();

  process.env.CANNABEATS_DATABASE_PATH = databasePath;
  const bridged = database();
  assert.equal(bridged.prepare("SELECT revision FROM game_runs WHERE id = 'run-1'").get().revision, 7);
  assert.equal(bridged.prepare("SELECT run_generation FROM game_sessions WHERE code = 'ROLL23'").get().run_generation, 1);
  assert.equal(bridged.prepare("PRAGMA user_version").get().user_version, 1);

  state.phase = "playing";
  bridged.prepare("UPDATE game_runs SET state = ?, updated_at = ? WHERE id = 'run-1'")
    .run(JSON.stringify(state), now + 1);
  assert.equal(bridged.prepare("SELECT revision FROM game_runs WHERE id = 'run-1'").get().revision, 8);
  assert.equal(bridged.prepare(`
    SELECT COUNT(*) AS count FROM sqlite_schema
    WHERE type = 'trigger' AND name = 'game_runs_advance_revision'
  `).get().count, 1);
  assert.equal(bridged.prepare(`
    SELECT COUNT(*) AS count FROM sqlite_schema
    WHERE type = 'trigger' AND name = 'game_sessions_advance_run_generation'
  `).get().count, 1);

  const independent = new DatabaseSync(databasePath);
  independent.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 1");
  const starting = bridged.prepare("SELECT state, revision FROM game_runs WHERE id = 'run-1'").get();
  const firstState = { ...JSON.parse(starting.state), revision: starting.revision, writer: "first" };
  const staleState = { ...JSON.parse(starting.state), revision: starting.revision, writer: "stale" };
  saveGameRunState(bridged, firstState);
  assert.throws(() => saveGameRunState(independent, staleState), StaleGameStateError);
  const protectedState = bridged.prepare("SELECT state, revision FROM game_runs WHERE id = 'run-1'").get();
  assert.equal(JSON.parse(protectedState.state).writer, "first");
  assert.equal(protectedState.revision, starting.revision + 1);

  const lockedState = { ...JSON.parse(protectedState.state), revision: protectedState.revision, writer: "locked" };
  bridged.exec("BEGIN IMMEDIATE");
  try {
    assert.throws(() => saveGameRunState(independent, lockedState), GameStateBusyError);
  } finally {
    bridged.exec("ROLLBACK");
    independent.close();
  }

  const oldCreatedState = { runId: "run-2", runGeneration: 2, code: "ROLL23", phase: "lobby" };
  bridged.prepare(`
    INSERT INTO game_runs (id, session_code, state, created_at, updated_at)
    VALUES ('run-2', 'ROLL23', ?, ?, ?)
  `).run(JSON.stringify(oldCreatedState), now + 2, now + 2);
  bridged.prepare("UPDATE game_sessions SET active_run_id = 'run-2' WHERE code = 'ROLL23'").run();
  assert.equal(bridged.prepare("SELECT run_generation FROM game_sessions WHERE code = 'ROLL23'").get().run_generation, 2);
  assert.equal(bridged.prepare("SELECT revision FROM game_runs WHERE id = 'run-2'").get().revision, 0);
  oldCreatedState.phase = "ready";
  bridged.prepare("UPDATE game_runs SET state = ?, updated_at = ? WHERE id = 'run-2'")
    .run(JSON.stringify(oldCreatedState), now + 3);
  assert.equal(bridged.prepare("SELECT revision FROM game_runs WHERE id = 'run-2'").get().revision, 1);
  const runTwoBeforeStaleSave = bridged.prepare("SELECT state, revision FROM game_runs WHERE id = 'run-2'").get();
  const staleRunOneState = {
    ...JSON.parse(bridged.prepare("SELECT state FROM game_runs WHERE id = 'run-1'").get().state),
    runId: "run-1",
    code: "ROLL23",
    revision: runTwoBeforeStaleSave.revision,
    writer: "stale-cross-run",
  };
  assert.throws(() => saveGameRunState(bridged, staleRunOneState), StaleGameStateError);
  assert.deepEqual(
    bridged.prepare("SELECT state, revision FROM game_runs WHERE id = 'run-2'").get(),
    runTwoBeforeStaleSave,
  );
  const runOneBeforeReactivation = bridged.prepare("SELECT state, revision FROM game_runs WHERE id = 'run-1'").get();
  const staleRunOneGeneration = {
    ...JSON.parse(runOneBeforeReactivation.state),
    runId: "run-1",
    runGeneration: 1,
    revision: runOneBeforeReactivation.revision,
    writer: "stale-reactivation",
  };
  bridged.prepare("UPDATE game_sessions SET active_run_id = 'run-1' WHERE code = 'ROLL23'").run();
  assert.equal(bridged.prepare("SELECT run_generation FROM game_sessions WHERE code = 'ROLL23'").get().run_generation, 3);
  assert.throws(() => saveGameRunState(bridged, staleRunOneGeneration), StaleGameStateError);
  assert.deepEqual(
    bridged.prepare("SELECT state, revision FROM game_runs WHERE id = 'run-1'").get(),
    runOneBeforeReactivation,
  );
  assert.equal(database().prepare("SELECT revision FROM game_runs WHERE id = 'run-2'").get().revision, 1);
});

test("the game initializer retries cleanly after access creates a fresh database", () => {
  const databasePath = join(root, "initializer-order.sqlite");
  process.env.CANNABEATS_DATABASE_PATH = databasePath;
  assert.throws(() => database(), /no such table: game_sessions/i);

  const untouched = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal(untouched.prepare("PRAGMA user_version").get().user_version, 0);
  assert.equal(untouched.prepare(`
    SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table' AND name = 'game_runs'
  `).get().count, 0);
  untouched.close();

  openDatabase(databasePath).close();
  const retried = database();
  assert.equal(retried.prepare("PRAGMA user_version").get().user_version, 1);
  assert.equal(retried.prepare(`
    SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table' AND name = 'game_action_receipts'
  `).get().count, 1);
});

test("a writer-lock timeout never publishes an unmigrated game database handle", () => {
  const databasePath = join(root, "initializer-lock-timeout.sqlite");
  openDatabase(databasePath).close();
  const blocker = new DatabaseSync(databasePath);
  blocker.exec("PRAGMA journal_mode = WAL; BEGIN IMMEDIATE");
  process.env.CANNABEATS_DATABASE_PATH = databasePath;
  process.env.CANNABEATS_DATABASE_BUSY_TIMEOUT_MS = "1";
  try {
    assert.throws(() => database(), /database is locked/i);
  } finally {
    blocker.exec("ROLLBACK");
    blocker.close();
    delete process.env.CANNABEATS_DATABASE_BUSY_TIMEOUT_MS;
  }

  const retried = database();
  assert.equal(retried.prepare(`
    SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table' AND name = 'game_runs'
  `).get().count, 1);
  assert.equal(retried.prepare(`
    SELECT COUNT(*) AS count FROM sqlite_schema
    WHERE type = 'trigger' AND name = 'game_runs_advance_revision'
  `).get().count, 1);
});

test("the legacy actor receipt migration preserves populated run-scoped evidence", () => {
  const databasePath = join(root, "legacy-receipts.sqlite");
  const legacy = openDatabase(databasePath);
  const now = Date.now();
  legacy.exec(`
    INSERT INTO users (id, display_name, role, created_at)
    VALUES ('host-legacy', 'Host', 'host', ${now}), ('actor-legacy', 'Guest', 'player', ${now});
    INSERT INTO game_sessions (code, host_user_id, status, active_run_id, created_at, updated_at)
    VALUES ('LEG234', 'host-legacy', 'playing', 'run-legacy', ${now}, ${now});
    CREATE TABLE game_runs (
      id TEXT PRIMARY KEY,
      session_code TEXT NOT NULL REFERENCES game_sessions(code) ON DELETE CASCADE,
      state TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      ended_at INTEGER
    );
    CREATE TABLE game_action_receipts (
      run_id TEXT NOT NULL REFERENCES game_runs(id) ON DELETE CASCADE,
      actor_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      action_id TEXT NOT NULL,
      action TEXT NOT NULL,
      request_fingerprint TEXT NOT NULL,
      accepted_at INTEGER NOT NULL,
      PRIMARY KEY (run_id, actor_id, action_id)
    );
    CREATE INDEX game_action_receipts_accepted_at ON game_action_receipts(accepted_at);
  `);
  legacy.prepare(`
    INSERT INTO game_runs (id, session_code, state, created_at, updated_at)
    VALUES ('run-legacy', 'LEG234', ?, ?, ?)
  `).run(JSON.stringify({ runId: "run-legacy", code: "LEG234", revision: 4 }), now, now);
  legacy.prepare(`
    INSERT INTO game_action_receipts
      (run_id, actor_id, action_id, action, request_fingerprint, accepted_at)
    VALUES ('run-legacy', 'actor-legacy', 'action-legacy', 'place', 'fingerprint', ?)
  `).run(now);
  legacy.close();

  process.env.CANNABEATS_DATABASE_PATH = databasePath;
  const migrated = database();
  assert.equal(migrated.prepare("SELECT action FROM game_action_receipts").get().action, "place");
  assert.deepEqual(
    migrated.prepare("PRAGMA foreign_key_list(game_action_receipts)").all()
      .map((foreignKey) => [foreignKey.from, foreignKey.table]),
    [["run_id", "game_runs"]],
  );
  assert.equal(migrated.prepare(`
    SELECT COUNT(*) AS count FROM sqlite_schema
    WHERE type = 'index' AND name = 'game_action_receipts_accepted_at'
  `).get().count, 1);
  assert.equal(migrated.prepare("PRAGMA user_version").get().user_version, 1);
  assert.deepEqual(migrated.prepare("PRAGMA foreign_key_check").all(), []);

  migrated.prepare("DELETE FROM users WHERE id = 'actor-legacy'").run();
  assert.equal(migrated.prepare("SELECT actor_id FROM game_action_receipts").get().actor_id, "actor-legacy");
  migrated.prepare("DELETE FROM game_runs WHERE id = 'run-legacy'").run();
  assert.equal(migrated.prepare("SELECT COUNT(*) AS count FROM game_action_receipts").get().count, 0);
});

test("a failed legacy receipt rebuild restores the original table and schema version", () => {
  const databasePath = join(root, "legacy-receipt-failure.sqlite");
  const legacy = openDatabase(databasePath);
  const now = Date.now();
  legacy.prepare("INSERT INTO users (id, display_name, role, created_at) VALUES ('actor-orphan', 'Guest', 'player', ?)")
    .run(now);
  legacy.exec(`
    CREATE TABLE game_runs (
      id TEXT PRIMARY KEY,
      session_code TEXT NOT NULL REFERENCES game_sessions(code) ON DELETE CASCADE,
      state TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      ended_at INTEGER
    );
    CREATE TABLE game_action_receipts (
      run_id TEXT NOT NULL REFERENCES game_runs(id) ON DELETE CASCADE,
      actor_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      action_id TEXT NOT NULL,
      action TEXT NOT NULL,
      request_fingerprint TEXT NOT NULL,
      accepted_at INTEGER NOT NULL,
      PRIMARY KEY (run_id, actor_id, action_id)
    );
  `);
  legacy.exec("PRAGMA foreign_keys = OFF");
  legacy.prepare(`
    INSERT INTO game_action_receipts
      (run_id, actor_id, action_id, action, request_fingerprint, accepted_at)
    VALUES ('missing-run', 'actor-orphan', 'orphan-action', 'place', 'fingerprint', ?)
  `).run(now);
  legacy.close();

  process.env.CANNABEATS_DATABASE_PATH = databasePath;
  assert.throws(() => database(), /foreign key constraint failed/i);

  const inspected = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal(inspected.prepare("PRAGMA user_version").get().user_version, 1);
  assert.equal(inspected.prepare("SELECT action_id FROM game_action_receipts").get().action_id, "orphan-action");
  assert.equal(inspected.prepare(`
    SELECT COUNT(*) AS count FROM pragma_foreign_key_list('game_action_receipts')
    WHERE "from" = 'actor_id' AND "table" = 'users'
  `).get().count, 1);
  assert.equal(inspected.prepare(`
    SELECT COUNT(*) AS count FROM pragma_table_info('game_runs') WHERE name = 'revision'
  `).get().count, 0);
  assert.equal(inspected.prepare(`
    SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'game_action_receipts_run_scoped'
  `).get().count, 0);
  inspected.close();
});
