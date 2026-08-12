import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, linkSync, openSync, rmSync, statSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  acquireStateOwnership, closeStateStore, createStateStore, validateStateStoreSchema,
} from "./store.mjs";
import { STATE_SCHEMA_GENERATION } from "./schema.mjs";
import { validateStateDatabase } from "./invariants.mjs";
import { candidateAuthorityDigest } from "./attestation.mjs";
import { redactRoomStateForRetention } from "./game-domain.mjs";

const REQUIRED_TABLES = [
  "game_sessions", "game_session_members", "game_runs", "game_action_receipts",
  "game_event_coverage", "game_events", "managed_audio_sources",
  "managed_audio_commands", "managed_audio_command_outcomes", "cannabeats_feature_migrations",
];
const SUPPORTED_SOURCE_FEATURES = new Map([
  ["game_events_canonical_v2", "d9227b3e053b7fd7a44943e437cd689864583f8c868f037ab1c82d0b6d90a39c"],
  ["history_lifecycle_v4", "6b4db8b8d6a7e4c8cef42f47a6270d54a3e6659cfeb4980ee2008ecf23ecdf96"],
  ["history_purge_guards_v5", "2e47816541089bf9862777af8af50ff3e05c15670d5ea99471b01c251d55e636"],
  ["managed_audio_protocol_v4", "39349c8d63f1869f4c72ebf3f7dafefb02304ba6a85c90ceb3ec475ef9fcba77"],
  ["managed_audio_purge_guards_v5", "9a09545cf7e22643a13398feeaa948f45f607b90f4b721cc7b4d9548140c294f"],
]);
const SOURCE_FEATURE_OBJECTS = new Map([
  ["game_events_canonical_v2", ["game_events"]],
  ["history_lifecycle_v4", [
    "game_event_coverage", "game_history_terminal_evidence", "game_events_history_write_guard",
    "game_event_coverage_lifecycle_guard", "game_event_coverage_initial_guard",
    "game_event_coverage_identity_guard", "game_events_immutable_update",
    "game_events_sealed_delete_guard",
  ]],
  ["history_purge_guards_v5", [
    "game_event_coverage_purged_immutable", "game_action_receipts_purged_write_guard",
    "game_runs_purged_delete_guard",
  ]],
  ["managed_audio_protocol_v4", [
    "managed_audio_commands", "managed_audio_command_outcomes",
    "managed_audio_command_state_insert_guard", "managed_audio_command_state_update_guard",
    "managed_audio_command_identity_guard", "managed_audio_command_intent_guard",
    "managed_audio_lease_delete_transition", "managed_audio_source_delete_guard",
    "managed_audio_command_outcome_delete_guard",
  ]],
  ["managed_audio_purge_guards_v5", [
    "managed_audio_outcomes_purged_insert_guard", "managed_audio_outcomes_purged_update_guard",
  ]],
]);

function normalizedSchemaSql(sql) {
  return sql.replace(/\bIF\s+NOT\s+EXISTS\b/gi, "").replace(/\s+/g, " ").trim().toLowerCase();
}

function sourceObjectsDigest(source, names) {
  const objects = source.prepare(`SELECT type,name,sql FROM sqlite_schema
    WHERE name IN (${names.map(() => "?").join(",")}) ORDER BY type,name`).all(...names);
  if (objects.length !== names.length) return null;
  return createHash("sha256").update(objects.map((object) => [
    object.type,object.name,normalizedSchemaSql(object.sql ?? ""),
  ].join(":")).join("\n")).digest("hex");
}

function assertSupportedSource(source) {
  if (source.prepare("PRAGMA integrity_check").get().integrity_check !== "ok"
      || source.prepare("PRAGMA foreign_key_check").all().length) {
    throw new Error("Source database integrity or foreign keys are invalid.");
  }
  if (source.prepare("PRAGMA user_version").get().user_version !== 1) {
    throw new Error("Source database schema version is not supported for state migration.");
  }
  const capabilities = source.prepare(`SELECT name,digest FROM cannabeats_feature_migrations
    WHERE name IN (${[...SUPPORTED_SOURCE_FEATURES].map(() => "?").join(",")})
    ORDER BY name`).all(...SUPPORTED_SOURCE_FEATURES.keys());
  if (capabilities.length !== SUPPORTED_SOURCE_FEATURES.size
      || capabilities.some((row) => SUPPORTED_SOURCE_FEATURES.get(row.name) !== row.digest)) {
    throw new Error("Source database lacks the supported v4 state capability contract.");
  }
  for (const [feature,objects] of SOURCE_FEATURE_OBJECTS) {
    const actual = feature === "game_events_canonical_v2"
      ? createHash("sha256").update(normalizedSchemaSql(source.prepare(`SELECT sql
        FROM sqlite_schema WHERE type='table' AND name='game_events'`).get()?.sql ?? "")).digest("hex")
      : sourceObjectsDigest(source,objects);
    if (actual !== SUPPORTED_SOURCE_FEATURES.get(feature)) {
      throw new Error(`Source feature ${feature} does not match its canonical object contract.`);
    }
  }
  for (const trigger of [
    "cannabeats_feature_migrations_immutable_update",
    "cannabeats_feature_migrations_immutable_delete",
  ]) {
    const sql = source.prepare(`SELECT sql FROM sqlite_schema
      WHERE type='trigger' AND name=?`).get(trigger)?.sql;
    const expected = `CREATE TRIGGER ${trigger}
      BEFORE ${trigger.endsWith("update") ? "UPDATE" : "DELETE"} ON cannabeats_feature_migrations
      BEGIN SELECT RAISE(ABORT, 'feature migration records are immutable'); END`;
    if (!sql || normalizedSchemaSql(sql) !== normalizedSchemaSql(expected)) {
      throw new Error("Source feature capability ledger is not immutable.");
    }
  }
}

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
      c.created_at,o.source_id AS outcome_source_id,o.run_id,o.command_state,o.claim_generation,
      o.completion_fingerprint,o.completed_at
      FROM managed_audio_commands c
      JOIN managed_audio_command_outcomes o ON o.command_id=c.id
      JOIN game_sessions s ON s.code=c.session_code
      ORDER BY c.source_id,c.session_code,c.created_at,c.id`),
  };
  const outcomeCount = source.prepare("SELECT COUNT(*) AS count FROM managed_audio_command_outcomes").get().count;
  const intentCount = source.prepare("SELECT COUNT(*) AS count FROM managed_audio_commands").get().count;
  if (snapshot.commands.length !== outcomeCount || snapshot.commands.length !== intentCount) {
    throw new Error("Every legacy managed command must have exactly one retained outcome and intent.");
  }
  for (const command of snapshot.commands) {
    const run = snapshot.runs.find((candidate) => candidate.id === command.run_id);
    const lobby = snapshot.lobbies.find((candidate) => candidate.code === command.session_code);
    const runState = run ? JSON.parse(run.state) : null;
    if (command.outcome_source_id !== command.source_id || !run
        || run.session_code !== command.session_code || !lobby
        || runState?.code !== command.session_code
        || !Number.isSafeInteger(runState?.runGeneration)
        || runState.runGeneration < 0) {
      throw new Error(`Legacy managed command ${command.id} has contradictory run or source authority.`);
    }
    command.run_generation = runState.runGeneration;
  }
  return snapshot;
}

function expectedReadProjection(snapshot) {
  return {
    lobbies: snapshot.lobbies.map((lobby) => ({
      code: lobby.code,
      hostPrincipalId: lobby.host_user_id,
      status: lobby.status,
      activeRunId: lobby.active_run_id,
      runGeneration: lobby.run_generation,
      audioMode: lobby.audio_mode,
      members: snapshot.members.filter((member) => member.session_code === lobby.code)
        .map((member) => member.user_id),
    })),
    runs: snapshot.runs.map((run) => ({
      id: run.id, lobbyCode: run.session_code,
      state: snapshot.coverage.find((entry) => entry.run_id === run.id)?.lifecycle_state === "purged"
        ? redactRoomStateForRetention(JSON.parse(run.state)) : JSON.parse(run.state),
      revision: run.revision, endedAt: run.ended_at, terminalOutcome: run.terminal_outcome,
      history: (() => {
        const coverage = snapshot.coverage.find((entry) => entry.run_id === run.id);
        return coverage ? {
          baselineRevision: coverage.baseline_revision,
          lastRecordedRevision: coverage.last_recorded_revision,
          lifecycle: coverage.lifecycle_state,
          purgedAt: coverage.purged_at,
          eventCount: snapshot.events.filter((event) => event.run_id === run.id).length,
          receiptCount: snapshot.receipts.filter((receipt) => receipt.run_id === run.id).length,
        } : null;
      })(),
    })),
    sources: snapshot.sources.map((source) => ({
      id: source.id, displayName: source.display_name, enabled: source.enabled,
      lastSeenAt: source.last_seen_at,
      lastErrorCategory: source.last_error ? "managed_source_error" : null,
    })),
    commands: snapshot.commands.map((command) => ({
      id: command.id, sourceId: command.source_id, lobbyCode: command.session_code,
      runId: command.run_id, runGeneration: command.run_generation,
      protocolVersion: 3, kind: command.kind, state: command.command_state,
      claimGeneration: command.claim_generation,
      outcomeFingerprint: ["completed", "failed"].includes(command.command_state)
        ? contentDigest(JSON.parse(command.completion_fingerprint)) : null,
    })),
  };
}

function candidateReadProjection(destination) {
  const lobbies = rows(destination, `SELECT code,host_principal_id,status,active_run_id,
    run_generation,audio_mode FROM lobbies ORDER BY code`);
  const members = rows(destination, `SELECT lobby_code,principal_id
    FROM lobby_members ORDER BY lobby_code,principal_id`);
  const streams = rows(destination, `SELECT run_id,baseline_revision,last_recorded_revision,
    lifecycle,purged_at FROM history_streams ORDER BY run_id`);
  return {
    lobbies: lobbies.map((lobby) => ({
      code: lobby.code,
      hostPrincipalId: lobby.host_principal_id,
      status: lobby.status,
      activeRunId: lobby.active_run_id,
      runGeneration: lobby.run_generation,
      audioMode: lobby.audio_mode,
      members: members.filter((member) => member.lobby_code === lobby.code)
        .map((member) => member.principal_id),
    })),
    runs: rows(destination, `SELECT id,lobby_code,state,revision,ended_at,terminal_outcome
      FROM game_runs ORDER BY id`).map((run) => {
      const stream = streams.find((entry) => entry.run_id === run.id);
      return {
        id: run.id, lobbyCode: run.lobby_code, state: JSON.parse(run.state),
        revision: run.revision, endedAt: run.ended_at, terminalOutcome: run.terminal_outcome,
        history: stream ? {
          baselineRevision: stream.baseline_revision,
          lastRecordedRevision: stream.last_recorded_revision,
          lifecycle: stream.lifecycle,
          purgedAt: stream.purged_at,
          eventCount: destination.prepare("SELECT COUNT(*) AS count FROM game_events WHERE run_id=?")
            .get(run.id).count,
          receiptCount: destination.prepare("SELECT COUNT(*) AS count FROM action_receipts WHERE run_id=?")
            .get(run.id).count,
        } : null,
      };
    }),
    sources: rows(destination, `SELECT id,display_name,enabled,last_seen_at,last_error_category
      FROM managed_sources ORDER BY id`).map((source) => ({
      id: source.id, displayName: source.display_name, enabled: source.enabled,
      lastSeenAt: source.last_seen_at, lastErrorCategory: source.last_error_category,
    })),
    commands: rows(destination, `SELECT id,source_id,lobby_code,run_id,run_generation,
      protocol_version,kind,command_state,claim_generation,outcome_fingerprint
      FROM managed_command_current ORDER BY source_id,lobby_code,dispatch_sequence`).map((command) => ({
      id: command.id, sourceId: command.source_id, lobbyCode: command.lobby_code,
      runId: command.run_id, runGeneration: command.run_generation,
      protocolVersion: command.protocol_version, kind: command.kind, state: command.command_state,
      claimGeneration: command.claim_generation, outcomeFingerprint: command.outcome_fingerprint,
    })),
  };
}

function expectedPrivateProjection(snapshot) {
  return {
    sources: snapshot.sources.map((source) => ({ id: source.id, tokenHash: source.token_hash })),
    payloads: snapshot.commands
      .filter((command) => snapshot.coverage.find((entry) => entry.run_id === command.run_id)
        ?.lifecycle_state !== "purged")
      .map((command) => ({
        commandId: command.id, trackUri: command.track_uri,
        requestedByPrincipalId: command.requested_by,
      })),
  };
}

function candidatePrivateProjection(destination) {
  return {
    sources: rows(destination, "SELECT id,token_hash FROM managed_sources ORDER BY id")
      .map((source) => ({ id: source.id, tokenHash: source.token_hash })),
    payloads: rows(destination, `SELECT payload.command_id,payload.track_uri,
      payload.requested_by_principal_id FROM managed_command_payloads payload
      JOIN managed_command_intents command ON command.id=payload.command_id
      ORDER BY command.source_id,command.lobby_code,command.dispatch_sequence`).map((payload) => ({
      commandId: payload.command_id, trackUri: payload.track_uri,
      requestedByPrincipalId: payload.requested_by_principal_id,
    })),
  };
}

export function migrateMonolith({
  sourcePath, destinationPath, now = Date.now(), lockDirectory,
}) {
  const sourceFile = resolve(sourcePath);
  const destinationFile = resolve(destinationPath);
  if (sourceFile === destinationFile) throw new Error("Source and destination databases must differ.");
  if (!statSync(sourceFile).isFile()) throw new Error("Source database was not found.");
  const releaseDestinationOwnership = acquireStateOwnership(destinationFile, { lockDirectory });
  let source = null;
  try {
    source = new DatabaseSync(sourceFile, { readOnly: true });
    source.exec("PRAGMA query_only=ON; PRAGMA foreign_keys=ON");
    source.exec("BEGIN");
    for (const table of REQUIRED_TABLES) {
      if (!tableExists(source, table)) throw new Error(`Source database lacks required table ${table}.`);
    }
    assertSupportedSource(source);
    assertDrained(source);
    const snapshot = legacySnapshot(source);
    const expectedProjection = expectedReadProjection(snapshot);
    const expectedPrivate = expectedPrivateProjection(snapshot);
    const privateDigest = contentDigest(expectedPrivate);
    const sourceContract = rows(source, `SELECT name,sql FROM sqlite_schema
      WHERE type='table' AND name IN (${REQUIRED_TABLES.map(() => "?").join(",")})
      ORDER BY name`, ...REQUIRED_TABLES);
    const sourceDatabaseDigest = contentDigest({ sourceContract, snapshot });
    const digest = contentDigest(expectedProjection);
    const rowCounts = Object.fromEntries(
      Object.entries(snapshot).map(([name, values]) => [name, values.length]),
    );
    const destinationExisted = existsSync(destinationFile);
    if (destinationExisted) {
      const existing = new DatabaseSync(destinationFile, { readOnly: true });
      try {
        validateStateStoreSchema(existing);
        validateStateDatabase(existing, { requireCandidate: true });
        const hasManifest = existing.prepare(`SELECT 1 FROM sqlite_schema
          WHERE type='table' AND name='migration_manifests'`).get()
          && existing.prepare(`SELECT 1 FROM migration_manifests
            WHERE source_database_digest=?`).get(sourceDatabaseDigest);
        if (!hasManifest) {
          throw new Error("Existing destination is not a published replay of this source snapshot.");
        }
      } finally {
        existing.close();
      }
    }
    const candidateFile = destinationExisted
      ? destinationFile
      : `${destinationFile}.candidate-${randomUUID()}`;
    let destination = createStateStore(candidateFile, {
      now, ownershipAlreadyHeld: destinationExisted,
    });
    let published = destinationExisted;
    let publishedCandidateDigest = null;
    try {
      const prior = destination.prepare(`SELECT content_digest,private_digest,candidate_digest,row_counts
        FROM migration_manifests WHERE source_database_digest=?`).get(sourceDatabaseDigest);
      if (prior) {
        if (prior.content_digest !== digest || prior.private_digest !== privateDigest
            || prior.row_counts !== JSON.stringify(rowCounts)) {
          throw new Error("Existing migration manifest conflicts with this source snapshot.");
        }
        validateStateDatabase(destination, { requireCandidate: true });
        if (JSON.stringify(candidateReadProjection(destination)) !== JSON.stringify(expectedProjection)) {
          throw new Error("Existing migration candidate no longer matches its source projection.");
        }
        if (JSON.stringify(candidatePrivateProjection(destination)) !== JSON.stringify(expectedPrivate)) {
          throw new Error("Existing migration candidate no longer matches its private authority projection.");
        }
        if (prior.candidate_digest !== candidateAuthorityDigest(destination)) {
          throw new Error("Existing migration candidate no longer matches its immutable authority attestation.");
        }
        return {
          sourceDatabaseDigest, candidateDigest: prior.candidate_digest,
          schemaGeneration: STATE_SCHEMA_GENERATION, protocolVersion: 3,
          contentDigest: digest, rowCounts, replayed: true,
        };
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
        const legacyPurgedRunIds = new Set(snapshot.coverage
          .filter((coverage) => coverage.lifecycle_state === "purged").map((coverage) => coverage.run_id));
        for (const row of snapshot.runs) insertRun.run(
          row.id,row.session_code,legacyPurgedRunIds.has(row.id)
            ? JSON.stringify(redactRoomStateForRetention(JSON.parse(row.state))) : row.state,
          row.revision,row.created_at,row.updated_at,
          row.ended_at,row.terminal_outcome,
        );
        const insertReceipt = destination.prepare(`INSERT INTO action_receipts
          (run_id,actor_principal_id,action_id,action,request_fingerprint,result,revision,accepted_at)
          VALUES (?,?,?,?,?,?,NULL,?)`);
        for (const row of snapshot.receipts) insertReceipt.run(
          row.run_id,row.actor_id,row.action_id,row.action,row.request_fingerprint,
          JSON.stringify({ actionId: row.action_id, accepted: true, legacy: true }),row.accepted_at,
        );
        const insertStream = destination.prepare(`INSERT INTO history_streams
          (run_id,baseline_revision,last_recorded_revision,lifecycle,started_at,purged_at)
          VALUES (?,?,?,?,?,?)`);
        const insertHistoryTransition = destination.prepare(`INSERT INTO history_transitions
          (run_id,sequence,from_state,to_state,reason,occurred_at) VALUES (?,?,?,?,?,?)`);
        const insertTombstone = destination.prepare(`INSERT INTO purge_tombstones
          (run_id,final_revision,terminal_outcome,purged_at,manifest_digest)
          VALUES (?,?,?,?,?)`);
        const insertSanitization = destination.prepare(`INSERT INTO purge_sanitization
          (run_id,status,completed_at) VALUES (?,'complete',?)`);
        const purgedRuns = new Set();
        for (const row of snapshot.coverage) {
          if (row.lifecycle_state === "purging") {
            throw new Error(`Legacy run ${row.run_id} is mid-purge and cannot be migrated.`);
          }
          insertStream.run(row.run_id,row.baseline_revision,row.last_recorded_revision,row.lifecycle_state,
            row.started_at,row.purged_at);
          const historyPath = {
            recording: ["recording"],
            terminal_pending: ["recording", "terminal_pending"],
            sealed: ["recording", "terminal_pending", "sealed"],
            purged: ["recording", "terminal_pending", "sealed", "purging", "purged"],
          }[row.lifecycle_state];
          if (!historyPath) throw new Error(`Legacy run ${row.run_id} has an unsupported lifecycle.`);
          for (const [index, state] of historyPath.entries()) {
            insertHistoryTransition.run(
              row.run_id,index + 1,index === 0 ? null : historyPath[index - 1],state,
              "legacy_migration",state === "purged" ? row.purged_at : row.started_at,
            );
          }
          if (row.lifecycle_state === "purged") {
            const run = snapshot.runs.find((candidate) => candidate.id === row.run_id);
            const retainedEvents = snapshot.events.filter((event) => event.run_id === row.run_id);
            const retainedReceipts = snapshot.receipts.filter((receipt) => receipt.run_id === row.run_id);
            if (!row.purged_at || !run?.ended_at
                || !["completed", "abandoned"].includes(run.terminal_outcome)
                || retainedEvents.length || retainedReceipts.length) {
              throw new Error(`Legacy run ${row.run_id} lacks a provable purge boundary.`);
            }
            purgedRuns.add(row.run_id);
            insertTombstone.run(
              row.run_id,run.revision,run.terminal_outcome,row.purged_at,
              contentDigest({
                contract: "legacy-purge-v1", runId: row.run_id,
                finalRevision: run.revision, terminalOutcome: run.terminal_outcome,
                purgedAt: row.purged_at,
              }),
            );
            insertSanitization.run(row.run_id,row.purged_at);
          }
        }
        const insertEvent = destination.prepare(`INSERT INTO game_events
          (run_id,sequence,revision,event_type,outcome,actor_type,actor_ref,action_id,command_ref,
           round,detail_code,detail_value,reason_code,occurred_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
        for (const row of snapshot.events) insertEvent.run(
          row.run_id,row.sequence,
          snapshot.runs.find((run) => run.id === row.run_id)?.revision ?? 0,
          row.event_type,row.outcome,row.actor_type,row.actor_ref,
          row.action_id ?? row.command_ref ?? null,row.command_ref,row.round,row.detail_code,
          row.detail_value,row.reason_code,row.occurred_at,
        );
        const insertSource = destination.prepare(`INSERT INTO managed_sources
          (id,display_name,token_hash,enabled,created_at,last_seen_at,last_error_category)
          VALUES (?,?,?,?,?,?,?)`);
        for (const row of snapshot.sources) insertSource.run(
          row.id,row.display_name,row.token_hash,row.enabled,row.created_at,row.last_seen_at,
          row.last_error ? "managed_source_error" : null,
        );
        const insertIntent = destination.prepare(`INSERT INTO managed_command_intents
          (id,source_id,lobby_code,run_id,run_generation,protocol_version,kind,
           action_id,dispatch_sequence,created_at)
          VALUES (?,?,?,?,?,3,?,?,?,?)`);
        const insertPayload = destination.prepare(`INSERT INTO managed_command_payloads
          (command_id,track_uri,requested_by_principal_id) VALUES (?,?,?)`);
        const insertCommandTransition = destination.prepare(`INSERT INTO managed_command_transitions
          (command_id,sequence,from_state,to_state,claim_generation,outcome_fingerprint,
           playback_status,error_category,reason_code,occurred_at)
          VALUES (?,?,?,?,?,?,?,?,?,?)`);
        const transitionPath = (state) => ({
          queued: ["queued"],
          claimed: ["queued", "claimed"],
          executing: ["queued", "claimed", "executing"],
          completed: ["queued", "claimed", "executing", "completed"],
          failed: ["queued", "claimed", "executing", "failed"],
          outcome_unknown: ["queued", "claimed", "outcome_unknown"],
          cancelled: ["queued", "cancelled"],
        })[state];
        const dispatchSequences = new Map();
        for (const row of snapshot.commands) {
          const dispatchKey = `${row.source_id}\u0000${row.session_code}`;
          const dispatchSequence = (dispatchSequences.get(dispatchKey) ?? 0) + 1;
          dispatchSequences.set(dispatchKey,dispatchSequence);
          const requestedEvent = snapshot.events.find((event) => event.command_ref === row.id
            && event.event_type === "audio_command_requested");
          const actionId = requestedEvent?.action_id ?? row.id;
          insertIntent.run(row.id,row.source_id,row.session_code,row.run_id,row.run_generation,
            row.kind,actionId,dispatchSequence,row.created_at);
          if (!purgedRuns.has(row.run_id)) insertPayload.run(row.id,row.track_uri,row.requested_by);
          const path = transitionPath(row.command_state);
          if (!path) throw new Error(`Legacy command ${row.id} has an unsupported state.`);
          const claimGeneration = row.claim_generation || randomUUID();
          for (const [index, state] of path.entries()) {
            const priorState = index === 0 ? null : path[index - 1];
            const terminal = ["completed", "failed"].includes(state);
            insertCommandTransition.run(
              row.id,index + 1,priorState,state,
              ["queued","cancelled"].includes(state) ? null : claimGeneration,
              terminal ? contentDigest(JSON.parse(row.completion_fingerprint)) : null,
              state === "completed" ? (row.kind === "pause" ? "paused" : "playing")
                : state === "failed" ? "error" : null,
              state === "failed" ? "managed_playback_failed" : null,
              ["failed","outcome_unknown","cancelled"].includes(state)
                ? (state === "failed" ? "managed_playback_failed" : "unrecognized_reason") : null,
              terminal ? (row.completed_at || row.created_at) : row.created_at,
            );
          }
        }
        validateStateDatabase(destination, { requireCandidate: true });
        const actualProjection = candidateReadProjection(destination);
        if (JSON.stringify(actualProjection) !== JSON.stringify(expectedProjection)) {
          throw new Error("Migrated state database does not match the canonical source projection.");
        }
        if (JSON.stringify(candidatePrivateProjection(destination)) !== JSON.stringify(expectedPrivate)) {
          throw new Error("Migrated state database does not match the private authority projection.");
        }
        const candidateDigest = candidateAuthorityDigest(destination);
        publishedCandidateDigest = candidateDigest;
        destination.prepare(`INSERT INTO migration_manifests
          (source_database_digest,destination_generation,content_digest,private_digest,
           candidate_digest,row_counts,created_at)
          VALUES (?,?,?,?,?,?,?)`).run(
          sourceDatabaseDigest,STATE_SCHEMA_GENERATION,digest,privateDigest,candidateDigest,
          JSON.stringify(rowCounts),now,
        );
        destination.exec("COMMIT");
      } catch (error) {
        if (destination.isTransaction) destination.exec("ROLLBACK");
        throw error;
      }
      if (!destinationExisted) {
        const checkpoint = destination.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
        if (checkpoint.busy !== 0 || checkpoint.log !== checkpoint.checkpointed) {
          throw new Error("Candidate WAL could not be fully checkpointed for publication.");
        }
        closeStateStore(destination);
        destination = null;
        linkSync(candidateFile, destinationFile);
        published = true;
        const publishedFd = openSync(destinationFile, "r");
        try { fsyncSync(publishedFd); } finally { closeSync(publishedFd); }
        const directoryFd = openSync(dirname(destinationFile), "r");
        try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
        unlinkSync(candidateFile);
        const cleanupDirectoryFd = openSync(dirname(destinationFile), "r");
        try { fsyncSync(cleanupDirectoryFd); } finally { closeSync(cleanupDirectoryFd); }
      }
      return {
        sourceDatabaseDigest,
        candidateDigest: publishedCandidateDigest,
        schemaGeneration: STATE_SCHEMA_GENERATION, protocolVersion: 3,
        contentDigest: digest, rowCounts, replayed: false,
      };
    } finally {
      if (destination) closeStateStore(destination);
      if (!published) {
        rmSync(candidateFile, { force: true });
        rmSync(`${candidateFile}-wal`, { force: true });
        rmSync(`${candidateFile}-shm`, { force: true });
      }
    }
  } finally {
    if (source?.isTransaction) source.exec("ROLLBACK");
    source?.close();
    releaseDestinationOwnership();
  }
}
