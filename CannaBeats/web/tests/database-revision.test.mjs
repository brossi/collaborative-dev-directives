import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { openDatabase } from "../../spikes/access-spotify-poc/db.mjs";
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
  const state = { runId: "run-1", revision: 7, code: "ROLL23", phase: "revealed" };
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
  bridged.close();
});
