import { createHash, randomUUID } from "node:crypto";
import { existsSync, renameSync, rmSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createStateStore } from "./store.mjs";
import { STATE_SCHEMA_GENERATION } from "./schema.mjs";

const REQUIRED_TABLES = [
  "game_sessions", "game_session_members", "game_runs", "game_action_receipts",
  "game_event_coverage", "game_events", "managed_audio_sources",
  "managed_audio_commands", "managed_audio_command_outcomes",
];

function tableExists(db, name) {
  return Boolean(db.prepare(`SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?`).get(name));
}

function rows(db, sql, ...values) {
  return db.prepare(sql).all(...values).map((row) => ({ ...row }));
}

function contentDigest(payload) {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function assertDrained(source) {
  const active = source.prepare(`SELECT COUNT(*) AS count FROM game_sessions
    WHERE status <> 'ended'`).get().count;
  const leases = source.prepare("SELECT COUNT(*) AS count FROM managed_audio_leases").get().count;
  const unresolved = source.prepare(`SELECT COUNT(*) AS count FROM managed_audio_command_outcomes
    WHERE command_state IN ('queued','claimed','executing','outcome_unknown')`).get().count;
  if (active || leases || unresolved) {
    throw new Error(
      `State migration requires a drained source (active=${active}, leases=${leases}, unresolved=${unresolved}).`,
    );
  }
}

function legacySnapshot(source) {
  const snapshot = {
    lobbies: rows(source, `SELECT code,host_user_id,status,active_run_id,
      COALESCE(run_generation,0) AS run_generation,COALESCE(audio_mode,'managed') AS audio_mode,
      created_at,updated_at FROM game_sessions ORDER BY code`),
    members: rows(source, `SELECT session_code,user_id,joined_at,last_seen_at
      FROM game_session_members ORDER BY session_code,user_id`),
    runs: rows(source, `SELECT id,session_code,state,COALESCE(revision,0) AS revision,
      created_at,updated_at,ended_at,terminal_outcome FROM game_runs ORDER BY id`),
    receipts: rows(source, `SELECT run_id,actor_id,action_id,action,request_fingerprint,accepted_at
      FROM game_action_receipts ORDER BY run_id,actor_id,action_id`),
    coverage: rows(source, `SELECT run_id,baseline_revision,last_recorded_revision,started_at,
      purged_at,COALESCE(lifecycle_state,
        CASE WHEN purged_at IS NULL THEN 'recording' ELSE 'purged' END) AS lifecycle_state
      FROM game_event_coverage ORDER BY run_id`),
    events: rows(source, `SELECT run_id,sequence,event_type,outcome,actor_type,actor_ref,
      action_id,command_ref,round,detail_code,detail_value,reason_code,occurred_at
      FROM game_events ORDER BY run_id,sequence`),
    sources: rows(source, `SELECT id,display_name,token_hash,enabled,created_at,last_seen_at,last_error
      FROM managed_audio_sources ORDER BY id`),
    commands: rows(source, `SELECT c.id,c.source_id,c.session_code,c.kind,c.track_uri,c.requested_by,
      c.created_at,o.run_id,o.command_state,o.claim_generation,o.completion_fingerprint,o.completed_at,
      COALESCE(s.run_generation,0) AS run_generation
      FROM managed_audio_commands c
      JOIN managed_audio_command_outcomes o ON o.command_id=c.id
      JOIN game_sessions s ON s.code=c.session_code
      ORDER BY c.id`),
  };
  const outcomeCount = source.prepare("SELECT COUNT(*) AS count FROM managed_audio_command_outcomes").get().count;
  if (snapshot.commands.length !== outcomeCount) {
    throw new Error("Every legacy command outcome must retain its command intent before migration.");
  }
  return snapshot;
}

export function migrateMonolith({ sourcePath, destinationPath, now = Date.now() }) {
  const sourceFile = resolve(sourcePath);
  const destinationFile = resolve(destinationPath);
  if (sourceFile === destinationFile) throw new Error("Source and destination databases must differ.");
  if (!statSync(sourceFile).isFile()) throw new Error("Source database was not found.");
  const source = new DatabaseSync(sourceFile, { readOnly: true });
  source.exec("PRAGMA query_only=ON; PRAGMA foreign_keys=ON");
  try {
    for (const table of REQUIRED_TABLES) {
      if (!tableExists(source, table)) throw new Error(`Source database lacks required table ${table}.`);
    }
    assertDrained(source);
    const snapshot = legacySnapshot(source);
    const sourceContract = rows(source, `SELECT name,sql FROM sqlite_schema
      WHERE type='table' AND name IN (${REQUIRED_TABLES.map(() => "?").join(",")})
      ORDER BY name`, ...REQUIRED_TABLES);
    const sourceDatabaseDigest = contentDigest({ sourceContract, snapshot });
    const digest = contentDigest(snapshot);
    const rowCounts = Object.fromEntries(
      Object.entries(snapshot).map(([name, values]) => [name, values.length]),
    );
    const destinationExisted = existsSync(destinationFile);
    const candidateFile = destinationExisted
      ? destinationFile
      : `${destinationFile}.candidate-${randomUUID()}`;
    let destination = createStateStore(candidateFile, { now });
    let published = destinationExisted;
    try {
      const prior = destination.prepare(`SELECT content_digest,row_counts
        FROM migration_manifests WHERE source_database_digest=?`).get(sourceDatabaseDigest);
      if (prior) {
        if (prior.content_digest !== digest || prior.row_counts !== JSON.stringify(rowCounts)) {
          throw new Error("Existing migration manifest conflicts with this source snapshot.");
        }
        return { sourceDatabaseDigest, contentDigest: digest, rowCounts, replayed: true };
      }
      const occupied = destination.prepare("SELECT COUNT(*) AS count FROM lobbies").get().count;
      if (occupied) throw new Error("Destination state database is not empty.");
      destination.exec("BEGIN IMMEDIATE");
      try {
        const insertLobby = destination.prepare(`INSERT INTO lobbies
          (code,host_principal_id,status,active_run_id,run_generation,audio_mode,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?)`);
        for (const row of snapshot.lobbies) insertLobby.run(
          row.code,row.host_user_id,row.status,row.active_run_id,row.run_generation,row.audio_mode,
          row.created_at,row.updated_at,
        );
        const insertMember = destination.prepare(`INSERT INTO lobby_members
          (lobby_code,principal_id,joined_at,last_seen_at) VALUES (?,?,?,?)`);
        for (const row of snapshot.members) insertMember.run(
          row.session_code,row.user_id,row.joined_at,row.last_seen_at,
        );
        const insertRun = destination.prepare(`INSERT INTO game_runs
          (id,lobby_code,state,revision,created_at,updated_at,ended_at,terminal_outcome)
          VALUES (?,?,?,?,?,?,?,?)`);
        for (const row of snapshot.runs) insertRun.run(
          row.id,row.session_code,row.state,row.revision,row.created_at,row.updated_at,
          row.ended_at,row.terminal_outcome,
        );
        const insertReceipt = destination.prepare(`INSERT INTO action_receipts
          (run_id,actor_principal_id,action_id,action,request_fingerprint,accepted_at)
          VALUES (?,?,?,?,?,?)`);
        for (const row of snapshot.receipts) insertReceipt.run(
          row.run_id,row.actor_id,row.action_id,row.action,row.request_fingerprint,row.accepted_at,
        );
        const insertStream = destination.prepare(`INSERT INTO history_streams
          (run_id,baseline_revision,last_recorded_revision,lifecycle,started_at,purged_at)
          VALUES (?,?,?,?,?,?)`);
        const insertHistoryTransition = destination.prepare(`INSERT INTO history_transitions
          (run_id,sequence,from_state,to_state,reason,occurred_at) VALUES (?,1,NULL,?,?,?)`);
        for (const row of snapshot.coverage) {
          const lifecycle = row.lifecycle_state === "purging" ? "sealed" : row.lifecycle_state;
          insertStream.run(row.run_id,row.baseline_revision,row.last_recorded_revision,lifecycle,
            row.started_at,row.purged_at);
          insertHistoryTransition.run(row.run_id,lifecycle,"legacy_migration",row.started_at);
        }
        const insertEvent = destination.prepare(`INSERT INTO game_events
          (run_id,sequence,event_type,outcome,actor_type,actor_ref,action_id,command_ref,
           round,detail_code,detail_value,reason_code,occurred_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
        for (const row of snapshot.events) insertEvent.run(...Object.values(row));
        const insertSource = destination.prepare(`INSERT INTO managed_sources
          (id,display_name,token_hash,enabled,created_at,last_seen_at,last_error_category)
          VALUES (?,?,?,?,?,?,?)`);
        for (const row of snapshot.sources) insertSource.run(
          row.id,row.display_name,row.token_hash,row.enabled,row.created_at,row.last_seen_at,
          row.last_error ? "managed_source_error" : null,
        );
        const insertIntent = destination.prepare(`INSERT INTO managed_command_intents
          (id,source_id,lobby_code,run_id,run_generation,protocol_version,kind,track_uri,
           requested_by_principal_id,created_at) VALUES (?,?,?,?,?,2,?,?,?,?)`);
        const insertCommandTransition = destination.prepare(`INSERT INTO managed_command_transitions
          (command_id,sequence,from_state,to_state,claim_generation,outcome_fingerprint,
           reason_code,occurred_at) VALUES (?,1,NULL,?,?,?,?,?)`);
        for (const row of snapshot.commands) {
          insertIntent.run(row.id,row.source_id,row.session_code,row.run_id,row.run_generation,
            row.kind,row.track_uri,row.requested_by,row.created_at);
          insertCommandTransition.run(row.id,row.command_state,row.claim_generation,
            row.completion_fingerprint,null,row.completed_at || row.created_at);
        }
        destination.prepare(`INSERT INTO migration_manifests
          (source_database_digest,destination_generation,content_digest,row_counts,created_at)
          VALUES (?,?,?,?,?)`).run(
          sourceDatabaseDigest,STATE_SCHEMA_GENERATION,digest,JSON.stringify(rowCounts),now,
        );
        const foreignKeys = destination.prepare("PRAGMA foreign_key_check").all();
        if (foreignKeys.length) throw new Error("Migrated state database failed foreign-key validation.");
        destination.exec("COMMIT");
      } catch (error) {
        if (destination.isTransaction) destination.exec("ROLLBACK");
        throw error;
      }
      if (!destinationExisted) {
        destination.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        destination.close();
        destination = null;
        renameSync(candidateFile, destinationFile);
        published = true;
      }
      return { sourceDatabaseDigest, contentDigest: digest, rowCounts, replayed: false };
    } finally {
      destination?.close();
      if (!published) {
        rmSync(candidateFile, { force: true });
        rmSync(`${candidateFile}-wal`, { force: true });
        rmSync(`${candidateFile}-shm`, { force: true });
      }
    }
  } finally {
    source.close();
  }
}
