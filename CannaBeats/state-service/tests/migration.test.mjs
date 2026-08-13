import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync, linkSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { migrateMonolith } from "../src/migrate-monolith.mjs";
import { openStateStoreReadOnly } from "../src/store.mjs";
import { initialRoomState } from "../src/game-domain.mjs";
import { StateOwner } from "../src/owner.mjs";

const root = mkdtempSync(join(tmpdir(), "cannabeats-state-migration-"));
const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
after(() => rmSync(root, { recursive: true, force: true }));
const developmentOwner = (path, options = {}) => new StateOwner(path, {
  ...options, allowDevelopmentActivation: true,
});

function digest(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function legacyFixture(name, { status = "ended" } = {}) {
  const path = join(root, `${name}.sqlite`);
  execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
    const access = await import('./spikes/access-spotify-poc/db.mjs');
    access.openDatabase(process.env.CANNABEATS_DATABASE_PATH).close();
    const game = await import('./web/lib/server/database.ts');
    game.database();
  `], { cwd: repositoryRoot, env: { ...process.env, CANNABEATS_DATABASE_PATH: path } });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys=ON");
  const now = Date.parse("2026-08-12T16:00:00Z");
  const host = randomUUID();
  const run = randomUUID();
  const action = randomUUID();
  const source = randomUUID();
  const command = randomUUID();
  db.prepare(`INSERT INTO users (id,display_name,role,created_at)
    VALUES (?,'Host','host',?)`).run(host,now);
  db.prepare(`INSERT INTO game_sessions
    (code,host_user_id,status,active_run_id,run_generation,audio_mode,created_at,updated_at)
    VALUES ('ABC234',?,?,?,?,?,?,?)`).run(
    host,status,run,1,"managed",now,now,
  );
  db.prepare(`INSERT INTO game_session_members VALUES ('ABC234',?,?,?)`)
    .run(host,now,now);
  const song = {
    title: "Legacy song", artist: "Legacy artist", year: 1990,
    uri: "spotify:track:legacy",
  };
  const state = initialRoomState({ runId: run, lobbyCode: "ABC234", runGeneration: 1 });
  Object.assign(state, {
    revision: 2, phase: "finished", players: [{
      id: host, name: "Host", control: "host", timeline: [song],
    }], activePlayerId: host, activePlayerIndex: 0, round: 2,
    currentSong: song, result: { correct: true, index: 0 }, winnerId: host,
    usedUris: [song.uri],
  });
  db.prepare(`INSERT INTO game_runs
    (id,session_code,state,revision,created_at,updated_at,ended_at,terminal_outcome)
    VALUES (?,'ABC234',?,2,?,?,?,?)`).run(
    run,JSON.stringify(state),now,now,status === "ended" ? now : null,
    status === "ended" ? "completed" : null,
  );
  const requestFingerprint = createHash("sha256").update("legacy-request").digest("hex");
  db.prepare(`INSERT INTO game_action_receipts
    (run_id,actor_id,action_id,action,request_fingerprint,accepted_at)
    VALUES (?,?,?,'advance',?,?)`)
    .run(run,host,action,requestFingerprint,now);
  db.prepare(`INSERT INTO game_events
    (run_id,sequence,event_type,outcome,actor_type,actor_ref,action_id,command_ref,
     round,detail_code,detail_value,reason_code,occurred_at) VALUES (
    ?,4,'game_completed','completed','system',NULL,NULL,NULL,2,NULL,NULL,NULL,?
  )`).run(run,now);
  db.prepare(`INSERT INTO managed_audio_sources
    (id,display_name,token_hash,enabled,created_at,last_seen_at,last_error)
    VALUES (?,'Source','hash',1,?,NULL,NULL)`)
    .run(source,now);
  db.prepare(`INSERT INTO managed_audio_commands
    (id,source_id,session_code,kind,track_uri,requested_by,created_at)
    VALUES (?,?,'ABC234','pause',NULL,?,?
  )`).run(command,source,host,now);
  db.prepare(`INSERT INTO managed_audio_command_outcomes
    (command_id,source_id,run_id,command_state,claim_generation,completion_fingerprint,completed_at)
    VALUES (?,?,?,'completed',?,'{"ok":true,"playbackStatus":"paused","error":null}',?)
  `).run(command,source,run,randomUUID(),now);
  db.prepare(`INSERT INTO game_events
    (run_id,sequence,event_type,outcome,actor_type,actor_ref,action_id,command_ref,
     round,detail_code,detail_value,reason_code,occurred_at) VALUES
    (?,1,'audio_command_requested','accepted','host',?,NULL,?,NULL,'pause',NULL,NULL,?),
    (?,2,'audio_command_delivered','accepted','source',?,NULL,?,NULL,'pause',NULL,NULL,?),
    (?,3,'audio_command_completed','completed','source',?,NULL,?,NULL,'pause',NULL,NULL,?)`)
    .run(run,host,command,now,run,source,command,now,run,source,command,now);
  if (status === "ended") {
    db.prepare(`UPDATE game_event_coverage SET baseline_revision=0,last_recorded_revision=2,
      lifecycle_state='terminal_pending' WHERE run_id=?`).run(run);
    db.prepare(`UPDATE game_event_coverage SET lifecycle_state='sealed' WHERE run_id=?`).run(run);
  }
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
    events: 4, sources: 1, commands: 1,
  });
  const state = openStateStoreReadOnly(destination);
  assert.equal(state.prepare("PRAGMA foreign_key_check").all().length, 0);
  assert.deepEqual({ ...state.prepare(`SELECT status,activated_at,first_admitted_at
    FROM state_authority WHERE singleton='state'`).get() }, {
    status: "candidate", activated_at: null, first_admitted_at: null,
  });
  assert.equal(state.prepare("SELECT lifecycle FROM history_streams WHERE run_id=?")
    .get(legacy.run).lifecycle, "sealed");
  assert.equal(state.prepare(`SELECT command_state FROM managed_command_current
    WHERE id=?`).get(legacy.command).command_state, "completed");
  assert.deepEqual(state.prepare(`SELECT from_state,to_state FROM managed_command_transitions
    WHERE command_id=? ORDER BY sequence`).all(legacy.command).map((row) => ({ ...row })), [
    { from_state: null, to_state: "queued" },
    { from_state: "queued", to_state: "claimed" },
    { from_state: "claimed", to_state: "executing" },
    { from_state: "executing", to_state: "completed" },
  ]);
  assert.throws(() => state.prepare("DELETE FROM managed_command_transitions").run(), /read.?only/i);
  state.close();
  const replay = migrateMonolith({ sourcePath: legacy.path, destinationPath: destination });
  assert.equal(replay.replayed, true);
  assert.equal(replay.contentDigest, first.contentDigest);
  const activator = developmentOwner(destination);
  assert.equal(activator.activate({
    commandId: randomUUID(), expectedSourceDigest: first.sourceDatabaseDigest,
    expectedCandidateDigest: first.candidateDigest,
    expectedSchemaGeneration: first.schemaGeneration,
    expectedProtocolVersion: first.protocolVersion,
    releaseEpoch: "migration-test", now: legacy.now + 2,
  }).status, "active");
  activator.close();
});

test("migration requires a fully checkpointed immutable source", () => {
  const legacy = legacyFixture("source-with-wal");
  const source = new DatabaseSync(legacy.path);
  source.exec("PRAGMA wal_autocheckpoint=0");
  source.prepare("UPDATE users SET display_name='Checkpoint required' WHERE id=?").run(legacy.host);
  assert.equal(existsSync(`${legacy.path}-wal`),true);
  assert.throws(() => migrateMonolith({
    sourcePath: legacy.path,destinationPath: join(root,"source-with-wal-state.sqlite"),
  }),/must be checkpointed/i);
  source.close();
});

test("migration refuses a source with a rollback journal requiring recovery", () => {
  const legacy = legacyFixture("source-with-hot-journal");
  writeFileSync(`${legacy.path}-journal`,Buffer.alloc(512,0x5a));
  assert.throws(() => migrateMonolith({
    sourcePath: legacy.path,destinationPath: join(root,"source-with-journal-state.sqlite"),
  }),/checkpointed and recovered/i);
});

test("migration replay recovers when publication left both names for one candidate inode", () => {
  const legacy = legacyFixture("publication-recovery");
  const destination = join(root, "publication-recovery-state.sqlite");
  const first = migrateMonolith({ sourcePath: legacy.path, destinationPath: destination });
  const leftoverCandidate = `${destination}.candidate-interrupted`;
  linkSync(destination,leftoverCandidate);
  const replay = migrateMonolith({ sourcePath: legacy.path, destinationPath: destination });
  assert.equal(replay.replayed, true);
  assert.equal(replay.candidateDigest, first.candidateDigest);
  const owner = developmentOwner(destination);
  owner.close();
  rmSync(leftoverCandidate);
});

test("migration compares multiple commands in durable dispatch order", () => {
  const legacy = legacyFixture("dispatch-order");
  const source = new DatabaseSync(legacy.path);
  const first = legacy.command;
  const second = "00000000-0000-4000-8000-000000000001";
  const immutableEventTrigger = source.prepare(`SELECT sql FROM sqlite_schema
    WHERE type='trigger' AND name='game_events_immutable_update'`).get().sql;
  source.exec("DROP TRIGGER game_events_immutable_update");
  source.prepare(`UPDATE game_events SET sequence=7,occurred_at=occurred_at+2
    WHERE run_id=? AND sequence=4`).run(legacy.run);
  source.exec(immutableEventTrigger);
  source.prepare(`INSERT INTO managed_audio_commands
    (id,source_id,session_code,kind,track_uri,requested_by,created_at)
    SELECT ?,source_id,session_code,'pause',NULL,requested_by,created_at+1
    FROM managed_audio_commands WHERE id=?`).run(second,first);
  source.prepare(`INSERT INTO managed_audio_command_outcomes
    (command_id,source_id,run_id,command_state,claim_generation,completion_fingerprint,completed_at)
    SELECT ?,source_id,run_id,command_state,?,completion_fingerprint,completed_at+1
    FROM managed_audio_command_outcomes WHERE command_id=?`).run(second,randomUUID(),first);
  const sealedEventGuard = source.prepare(`SELECT name,sql FROM sqlite_schema
    WHERE type='trigger' AND tbl_name='game_events' AND sql LIKE '%sealed or purged%'`).get();
  source.exec(`DROP TRIGGER ${sealedEventGuard.name}`);
  source.prepare(`INSERT INTO game_events
    (run_id,sequence,event_type,outcome,actor_type,actor_ref,action_id,command_ref,
     round,detail_code,detail_value,reason_code,occurred_at)
    SELECT run_id,sequence+3,event_type,outcome,actor_type,actor_ref,action_id,?,round,
      detail_code,detail_value,reason_code,occurred_at+1 FROM game_events
    WHERE command_ref=?`).run(second,first);
  source.exec(sealedEventGuard.sql);
  source.close();
  const destination = join(root, "dispatch-order-state.sqlite");
  const migrated = migrateMonolith({ sourcePath: legacy.path, destinationPath: destination });
  assert.equal(migrated.rowCounts.commands, 2);
  const state = openStateStoreReadOnly(destination);
  assert.deepEqual(state.prepare(`SELECT id FROM managed_command_intents
    ORDER BY dispatch_sequence`).all().map((row) => row.id), [first,second]);
  state.close();
});

test("migration rejects an active run whose durable generation disagrees with its lobby", () => {
  const legacy = legacyFixture("run-generation-mismatch");
  const source = new DatabaseSync(legacy.path);
  source.prepare("UPDATE game_sessions SET run_generation=2 WHERE code='ABC234'").run();
  source.close();
  assert.throws(() => migrateMonolith({
    sourcePath: legacy.path,
    destinationPath: join(root, "run-generation-mismatch-state.sqlite"),
  }), /snapshot identity is inconsistent|run authority is inconsistent/i);
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
  source.prepare("UPDATE game_event_coverage SET last_recorded_revision=3").run();
  source.close();
  const before = digest(legacy.path);
  const destination = join(root, "invalid-history-state.sqlite");
  assert.throws(() => migrateMonolith({
    sourcePath: legacy.path, destinationPath: destination,
  }), /history exceeds|revision|coverage/i);
  assert.equal(digest(legacy.path), before);
  assert.equal(existsSync(destination), false);
  assert.equal(readdirSync(root).some((name) =>
    name.startsWith("invalid-history-state.sqlite.candidate-")), false);
});

test("migration rejects orphan command intent instead of omitting it from equivalence", () => {
  const legacy = legacyFixture("orphan-command");
  const source = new DatabaseSync(legacy.path);
  source.prepare(`INSERT INTO managed_audio_commands
    (id,source_id,session_code,kind,track_uri,requested_by,created_at)
    SELECT ?,source_id,session_code,'pause',NULL,requested_by,created_at
    FROM managed_audio_commands LIMIT 1`).run(randomUUID());
  source.close();
  const destination = join(root, "orphan-command-state.sqlite");
  assert.throws(() => migrateMonolith({
    sourcePath: legacy.path, destinationPath: destination,
  }), /exactly one retained outcome and intent/i);
  assert.equal(existsSync(destination), false);
});

test("migration constructs a tombstone only for a provably purged legacy run", () => {
  const legacy = legacyFixture("legacy-purged");
  const source = new DatabaseSync(legacy.path);
  source.prepare(`UPDATE game_event_coverage SET lifecycle_state='purging'
    WHERE run_id=?`).run(legacy.run);
  source.prepare("DELETE FROM game_events WHERE run_id=?").run(legacy.run);
  source.prepare("DELETE FROM game_action_receipts WHERE run_id=?").run(legacy.run);
  source.prepare("DELETE FROM managed_audio_command_outcomes WHERE run_id=?").run(legacy.run);
  source.prepare("DELETE FROM managed_audio_commands WHERE id=?").run(legacy.command);
  source.prepare(`UPDATE game_event_coverage
    SET lifecycle_state='purged',purged_at=? WHERE run_id=?`).run(legacy.now + 1,legacy.run);
  source.close();
  const destination = join(root, "legacy-purged-state.sqlite");
  migrateMonolith({ sourcePath: legacy.path, destinationPath: destination, now: legacy.now + 2 });
  const state = openStateStoreReadOnly(destination);
  assert.equal(state.prepare("SELECT COUNT(*) AS count FROM purge_tombstones WHERE run_id=?")
    .get(legacy.run).count, 1);
  assert.equal(state.prepare(`SELECT COUNT(*) AS count FROM managed_command_payloads payload
    JOIN managed_command_intents command ON command.id=payload.command_id WHERE command.run_id=?`)
    .get(legacy.run).count, 0);
  state.close();
});

test("migration replay revalidates candidate authority and canonical content", () => {
  const legacy = legacyFixture("replay-validation");
  const destination = join(root, "replay-validation-state.sqlite");
  migrateMonolith({ sourcePath: legacy.path, destinationPath: destination, now: legacy.now + 1 });
  const changed = new DatabaseSync(destination);
  changed.prepare("UPDATE lobbies SET host_principal_id='tampered'").run();
  changed.close();
  const poisoned = developmentOwner(destination);
  assert.throws(() => poisoned.activate({ commandId: randomUUID() }),
    /attestation is invalid|invariant validation failed/i);
  poisoned.close();
  assert.throws(() => migrateMonolith({
    sourcePath: legacy.path, destinationPath: destination,
  }), /no longer matches|invariant validation failed/i);
});

test("migration requires the supported immutable source contract and exclusive publication lock", () => {
  const unsupported = legacyFixture("unsupported-source-contract");
  const source = new DatabaseSync(unsupported.path);
  source.exec("DROP TRIGGER cannabeats_feature_migrations_immutable_delete");
  source.prepare("DELETE FROM cannabeats_feature_migrations WHERE name='history_lifecycle_v4'").run();
  source.close();
  assert.throws(() => migrateMonolith({
    sourcePath: unsupported.path, destinationPath: join(root, "unsupported-state.sqlite"),
  }), /supported v4 state capability contract/i);

  const supported = legacyFixture("publication-lock");
  const destination = join(root, "publication-lock-state.sqlite");
  const liveOwner = developmentOwner(destination);
  assert.throws(() => migrateMonolith({
    sourcePath: supported.path, destinationPath: destination,
  }), /exist|operating-system owner/i);
  assert.throws(() => developmentOwner(destination), /operating-system owner/i);
  liveOwner.close();

  const weakenedLedger = legacyFixture("weakened-ledger-trigger");
  const weakened = new DatabaseSync(weakenedLedger.path);
  weakened.exec(`DROP TRIGGER cannabeats_feature_migrations_immutable_update;
    CREATE TRIGGER cannabeats_feature_migrations_immutable_update
    BEFORE UPDATE ON cannabeats_feature_migrations BEGIN SELECT 1; END;`);
  weakened.close();
  assert.throws(() => migrateMonolith({
    sourcePath: weakenedLedger.path,
    destinationPath: join(root, "weakened-ledger-state.sqlite"),
  }), /ledger is not immutable/i);
});

test("migration replay attests private source authority and command payloads", () => {
  const legacy = legacyFixture("private-replay-validation");
  const destination = join(root, "private-replay-validation-state.sqlite");
  migrateMonolith({ sourcePath: legacy.path, destinationPath: destination, now: legacy.now + 1 });
  const changed = new DatabaseSync(destination);
  changed.prepare("UPDATE managed_sources SET token_hash='attacker-controlled-hash'").run();
  changed.close();
  assert.throws(() => migrateMonolith({
    sourcePath: legacy.path, destinationPath: destination,
  }), /private authority projection/i);
});

test("migration never adopts or mutates an existing foreign destination", () => {
  const legacy = legacyFixture("foreign-destination-source");
  const destination = join(root, "foreign-destination.sqlite");
  const foreign = new DatabaseSync(destination);
  foreign.exec("CREATE TABLE foreign_authority (sentinel TEXT NOT NULL)");
  foreign.prepare("INSERT INTO foreign_authority VALUES ('DO_NOT_MUTATE')").run();
  foreign.close();
  const before = digest(destination);
  assert.throws(() => migrateMonolith({
    sourcePath: legacy.path, destinationPath: destination,
  }), /state_schema_generations|generation is not compatible/i);
  assert.equal(digest(destination), before);
});
