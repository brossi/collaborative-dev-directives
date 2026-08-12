import { createHash, randomUUID } from "node:crypto";
import { closeStateStore, createStateStore } from "./store.mjs";
import {
  initialRoomState, projectRoomState, redactRoomStateForRetention,
  reduceGameCommand, validateRoomState,
} from "./game-domain.mjs";
import { validateStateDatabase } from "./invariants.mjs";
import { candidateAuthorityDigest } from "./attestation.mjs";

const COMMAND_EDGES = new Map([
  ["queued:claim", "claimed"],
  ["queued:cancel", "cancelled"],
  ["claimed:begin", "executing"],
  ["claimed:lose_authority", "outcome_unknown"],
  ["executing:complete", "completed"],
  ["executing:fail", "failed"],
  ["executing:lose_authority", "outcome_unknown"],
  ["outcome_unknown:complete", "completed"],
  ["outcome_unknown:fail", "failed"],
]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EVENT_TYPES = new Set([
  "player_joined", "player_removed", "game_configured", "game_started", "track_requested",
  "placement_locked", "placement_retracted", "answer_revealed", "round_advanced",
  "track_skipped", "game_completed", "game_abandoned", "audio_source_selected",
  "audio_lease_acquired", "audio_lease_released", "audio_command_requested",
  "audio_command_delivered", "audio_command_completed", "audio_command_failed",
  "audio_command_interrupted", "audio_command_cancelled", "audio_command_outcome_unknown",
  "audio_lease_expired", "audio_lease_renewed", "audio_source_recovered",
]);
const EVENT_OUTCOMES = new Set([
  "accepted", "completed", "failed", "abandoned", "interrupted", "recovered", "cancelled", "unknown",
]);
const EVENT_ACTORS = new Set(["host", "player", "source", "system"]);
const EVENT_REASONS = new Set([
  "authentication_required", "browser_unavailable", "device_unavailable",
  "explicit_release", "game_abandoned", "game_api_unavailable", "game_completed",
  "lease_expired", "managed_playback_failed", "relay_unavailable",
  "source_selected_local", "spotify_unavailable", "unrecognized_reason",
]);
const PLAYBACK_ERROR_CATEGORIES = new Set([
  "authentication_required", "browser_unavailable", "device_unavailable",
  "managed_playback_failed", "relay_unavailable", "spotify_unavailable",
  "unrecognized_reason",
]);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) =>
      left.localeCompare(right)).map(([key, entry]) => [key, canonical(entry)]));
  }
  return value;
}

function fingerprint(value) {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function objectValue(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return canonical(value);
}

function safeNonnegative(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} is invalid.`);
}

export class StateOwner {
  #db;
  #selectSong;
  #selectStartingPlayer;
  #allowDevelopmentActivation;

  constructor(path, {
    selectSong = null, selectStartingPlayer = null,
    allowDevelopmentActivation = false, ...storeOptions
  } = {}) {
    this.#db = createStateStore(path, storeOptions);
    this.#selectSong = selectSong;
    this.#selectStartingPlayer = selectStartingPlayer;
    this.#allowDevelopmentActivation = allowDevelopmentActivation;
    if (this.authorityStatus().status === "active") this.resumePendingSanitization({ now: Date.now() });
  }

  close() {
    closeStateStore(this.#db);
  }

  #transaction(work) {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      if (this.#db.isTransaction) this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  #once(commandId, commandType, request, now, work) {
    if (!UUID_PATTERN.test(commandId)) throw new Error("State command ID must be a canonical UUID.");
    const requestFingerprint = fingerprint({ commandType, request });
    return this.#transaction(() => {
      const prior = this.#db.prepare(`SELECT command_type,request_fingerprint,result
        FROM state_commands WHERE command_id=?`).get(commandId);
      if (prior) {
        if (prior.command_type !== commandType || prior.request_fingerprint !== requestFingerprint) {
          throw new Error("State command identity conflicts with its prior request.");
        }
        return { ...JSON.parse(prior.result), replayed: true };
      }
      const result = work();
      this.#db.prepare(`INSERT INTO state_commands
        (command_id,command_type,request_fingerprint,result,accepted_at) VALUES (?,?,?,?,?)`)
        .run(commandId,commandType,requestFingerprint,JSON.stringify(result),now);
      return { ...result, replayed: false };
    });
  }

  authorityStatus() {
    return { ...this.#db.prepare(`SELECT status,activated_at,first_admitted_at,
      source_digest,candidate_digest,schema_generation,protocol_version,release_epoch
      FROM state_authority WHERE singleton='state'`).get() };
  }

  readiness() {
    const authority = this.authorityStatus();
    const database = this.#db.prepare("SELECT 1 AS ok").get();
    if (database?.ok !== 1) throw new Error("State database readiness failed.");
    const sanitizationPending = this.#db.prepare(`SELECT COUNT(*) AS count
      FROM purge_sanitization WHERE status='pending'`).get().count;
    return { authority, sanitizationPending };
  }

  activate({
    commandId = randomUUID(), expectedSourceDigest = null, expectedCandidateDigest = null,
    expectedSchemaGeneration = 2, expectedProtocolVersion = 3,
    releaseEpoch = "development", now = Date.now(),
  } = {}) {
    const request = {
      expectedSourceDigest, expectedCandidateDigest, expectedSchemaGeneration,
      expectedProtocolVersion, releaseEpoch,
    };
    const authorityBefore = this.authorityStatus();
    if (authorityBefore.status === "candidate") {
      const priorCommands = this.#db.prepare("SELECT COUNT(*) AS count FROM state_commands").get().count;
      if (priorCommands !== 0) {
        throw new Error("Candidate authority contains commands issued before activation.");
      }
    }
    return this.#once(commandId, "activate_state_authority", request, now, () => {
      const authority = this.authorityStatus();
      if (authority.status !== "candidate") throw new Error("State authority is already active.");
      if (expectedSchemaGeneration !== 2 || expectedProtocolVersion !== 3
          || typeof releaseEpoch !== "string" || !releaseEpoch.trim()) {
        throw new Error("Activation contract is incompatible with this state service.");
      }
      validateStateDatabase(this.#db, { requireCandidate: true });
      const manifests = this.#db.prepare(`SELECT source_database_digest,candidate_digest,
        destination_generation FROM migration_manifests`).all();
      const developmentCandidate = manifests.length === 0
        && expectedSourceDigest === null && expectedCandidateDigest === null
        && releaseEpoch === "development" && this.#allowDevelopmentActivation;
      if (!developmentCandidate && (manifests.length !== 1
          || expectedSourceDigest !== manifests[0].source_database_digest
          || expectedCandidateDigest !== manifests[0].candidate_digest
          || expectedSchemaGeneration !== manifests[0].destination_generation
          || manifests[0].candidate_digest !== candidateAuthorityDigest(this.#db))) {
        throw new Error("Migrated candidate authority attestation is invalid.");
      }
      const durableSourceDigest = expectedSourceDigest ?? "0".repeat(64);
      const durableCandidateDigest = expectedCandidateDigest ?? candidateAuthorityDigest(this.#db);
      this.#db.prepare(`UPDATE state_authority SET status='active',activated_at=?,
        source_digest=?,candidate_digest=?,schema_generation=?,protocol_version=?,release_epoch=?
        WHERE singleton='state' AND status='candidate'`).run(
        now,durableSourceDigest,durableCandidateDigest,expectedSchemaGeneration,
        expectedProtocolVersion,releaseEpoch,
      );
      return { status: "active", activatedAt: now, rollbackFloor: "pre_admission" };
    });
  }

  #assertActive() {
    if (this.authorityStatus().status !== "active") {
      throw new Error("State database is a candidate and cannot accept runtime commands.");
    }
  }

  createLobby({ commandId = randomUUID(), code, hostPrincipalId, now = Date.now() }) {
    const request = { code, hostPrincipalId };
    return this.#once(commandId, "create_lobby", request, now, () => {
      this.#assertActive();
      if (!/^[A-Z0-9]{6}$/.test(code)) throw new Error("Lobby code is invalid.");
      if (!hostPrincipalId) throw new Error("Host principal is required.");
      this.#db.prepare(`INSERT INTO lobbies
        (code,host_principal_id,status,created_at,updated_at) VALUES (?,?,'lobby',?,?)`)
        .run(code,hostPrincipalId,now,now);
      this.#db.prepare(`INSERT INTO lobby_members
        (lobby_code,principal_id,joined_at,last_seen_at) VALUES (?,?,?,?)`)
        .run(code,hostPrincipalId,now,now);
      this.#db.prepare(`UPDATE state_authority SET first_admitted_at=COALESCE(first_admitted_at,?)
        WHERE singleton='state'`).run(now);
      return { code, status: "lobby" };
    });
  }

  createRun({
    commandId = randomUUID(), lobbyCode, runId = randomUUID(), actorPrincipalId,
    rules, now = Date.now(),
  }) {
    const request = { lobbyCode, runId, actorPrincipalId, rules: canonical(rules) };
    return this.#once(commandId, "create_run", request, now, () => {
      this.#assertActive();
      const lobby = this.#db.prepare(`SELECT host_principal_id,status,active_run_id,run_generation
        FROM lobbies WHERE code=?`).get(lobbyCode);
      if (!lobby) throw new Error("Lobby was not found.");
      if (lobby.host_principal_id !== actorPrincipalId) throw new Error("Only the lobby host may create a run.");
      if (lobby.status === "ended" || lobby.active_run_id) throw new Error("Lobby cannot create another active run.");
      const runGeneration = lobby.run_generation + 1;
      safeNonnegative(runGeneration, "Run generation");
      const state = initialRoomState({ runId, lobbyCode, runGeneration, rules });
      this.#db.prepare(`INSERT INTO game_runs
        (id,lobby_code,state,revision,created_at,updated_at) VALUES (?,?,?,0,?,?)`)
        .run(runId,lobbyCode,JSON.stringify(state),now,now);
      this.#db.prepare(`INSERT INTO history_streams
        (run_id,baseline_revision,last_recorded_revision,lifecycle,started_at)
        VALUES (?,0,0,'recording',?)`).run(runId,now);
      this.#db.prepare(`INSERT INTO history_transitions
        (run_id,sequence,from_state,to_state,reason,occurred_at)
        VALUES (?,1,NULL,'recording','run_created',?)`).run(runId,now);
      this.#db.prepare(`UPDATE lobbies SET active_run_id=?,run_generation=?,status='playing',updated_at=?
        WHERE code=?`).run(runId,runGeneration,now,lobbyCode);
      return { runId, lobbyCode, runGeneration, revision: 0, state };
    });
  }

  applyGameCommand({
    lobbyCode, actorPrincipalId, actionId, expectedRunId,
    expectedRunGeneration, expectedRevision, command, now = Date.now(),
  }) {
    if (command?.type === "join_player") {
      throw new Error("Player admission requires the access-scoped admission command.");
    }
    return this.#applyGameCommand({
      lobbyCode,actorPrincipalId,actionId,expectedRunId,expectedRunGeneration,
      expectedRevision,command,now,allowAdmission: false,
    });
  }

  admitPlayer({
    lobbyCode, actorPrincipalId, actionId, expectedRunId,
    expectedRunGeneration, expectedRevision, name, now = Date.now(),
  }) {
    return this.#applyGameCommand({
      lobbyCode,actorPrincipalId,actionId,expectedRunId,expectedRunGeneration,
      expectedRevision,command: { type: "join_player", name },now,allowAdmission: true,
    });
  }

  #applyGameCommand({
    lobbyCode, actorPrincipalId, actionId, expectedRunId,
    expectedRunGeneration, expectedRevision, command, now, allowAdmission,
  }) {
    if (!UUID_PATTERN.test(actionId)) throw new Error("Action ID must be a canonical UUID.");
    if (!UUID_PATTERN.test(expectedRunId)) throw new Error("Expected run ID must be a canonical UUID.");
    safeNonnegative(expectedRunGeneration, "Expected run generation");
    safeNonnegative(expectedRevision, "Expected revision");
    const requestFingerprint = fingerprint({
      command: canonical(command), expectedRunId, expectedRunGeneration, expectedRevision,
    });
    return this.#transaction(() => {
      this.#assertActive();
      const receipt = this.#db.prepare(`SELECT action,request_fingerprint,result
        FROM action_receipts WHERE run_id=? AND actor_principal_id=? AND action_id=?`)
        .get(expectedRunId,actorPrincipalId,actionId);
      if (receipt) {
        if (receipt.action !== command.type || receipt.request_fingerprint !== requestFingerprint) {
          throw new Error("Action identity conflicts with its prior request.");
        }
        return { ...JSON.parse(receipt.result), replayed: true };
      }
      const context = this.#db.prepare(`SELECT l.active_run_id,l.run_generation,
          l.host_principal_id,r.revision,r.ended_at,r.state,
          EXISTS(SELECT 1 FROM lobby_members m
            WHERE m.lobby_code=l.code AND m.principal_id=?) AS is_member
        FROM lobbies l JOIN game_runs r ON r.id=l.active_run_id AND r.lobby_code=l.code
        WHERE l.code=?`).get(actorPrincipalId,lobbyCode);
      if (!context) throw new Error("Active run membership was not found.");
      if (context.active_run_id !== expectedRunId
          || context.run_generation !== expectedRunGeneration
          || context.revision !== expectedRevision) {
        throw new Error("Run mutation context is stale.");
      }
      if (context.ended_at !== null) throw new Error("Run has ended.");
      if (!context.is_member && !allowAdmission) {
        throw new Error("Active run membership was not found.");
      }
      const reduced = reduceGameCommand({
        state: validateRoomState(JSON.parse(context.state)), command,
        actor: {
          principalId: actorPrincipalId,
          isHost: context.host_principal_id === actorPrincipalId,
          isMember: Boolean(context.is_member),
        },
        selectSong: this.#selectSong,
        selectStartingPlayer: this.#selectStartingPlayer,
      });
      validateRoomState(reduced.state);
      if (!context.is_member && (!allowAdmission || !reduced.admitPrincipal)) {
        throw new Error("Active run membership was not found.");
      }
      if (reduced.admitPrincipal) {
        this.#db.prepare(`INSERT OR IGNORE INTO lobby_members
          (lobby_code,principal_id,joined_at,last_seen_at) VALUES (?,?,?,?)`)
          .run(lobbyCode,actorPrincipalId,now,now);
      }
      if (reduced.removePrincipalId) {
        this.#db.prepare(`DELETE FROM lobby_members
          WHERE lobby_code=? AND principal_id=? AND principal_id<>(
            SELECT host_principal_id FROM lobbies WHERE code=?)`)
          .run(lobbyCode,reduced.removePrincipalId,lobbyCode);
      }
      const revision = expectedRevision + 1;
      safeNonnegative(revision, "Next revision");
      const state = {
        ...reduced.state, runId: expectedRunId, code: lobbyCode,
        runGeneration: expectedRunGeneration, revision,
      };
      const updated = this.#db.prepare(`UPDATE game_runs SET state=?,revision=?,updated_at=?,
          ended_at=CASE WHEN ? IS NULL THEN ended_at ELSE ? END,
          terminal_outcome=CASE WHEN ? IS NULL THEN terminal_outcome ELSE ? END
        WHERE id=? AND lobby_code=? AND revision=? AND ended_at IS NULL
          AND id=(SELECT active_run_id FROM lobbies WHERE code=? AND run_generation=?)`)
        .run(JSON.stringify(state),revision,now,reduced.terminalOutcome ?? null,now,
          reduced.terminalOutcome ?? null,reduced.terminalOutcome ?? null,
          expectedRunId,lobbyCode,expectedRevision,lobbyCode,expectedRunGeneration);
      if (updated.changes !== 1) throw new Error("Run mutation context is stale.");
      if (!Array.isArray(reduced.events) || reduced.events.length === 0) {
        throw new Error("Every game mutation must derive at least one canonical event.");
      }
      for (const event of reduced.events) {
        this.#recordGameEvent(expectedRunId, revision, actionId, actorPrincipalId, event, now);
      }
      const managedCommands = this.#applyGameEffects({
        effects: reduced.effects ?? [], lobbyCode, runId: expectedRunId,
        runGeneration: expectedRunGeneration, requestedByPrincipalId: actorPrincipalId,
        actionId, now,
      });
      const coverage = this.#db.prepare(`UPDATE history_streams SET last_recorded_revision=?
        WHERE run_id=? AND lifecycle='recording' AND last_recorded_revision=?`)
        .run(revision,expectedRunId,expectedRevision);
      if (coverage.changes !== 1) throw new Error("Run history coverage is incomplete.");
      const result = {
        actionId, accepted: true, runId: expectedRunId,
        runGeneration: expectedRunGeneration, revision,
        state: projectRoomState(state, { isHost: context.host_principal_id === actorPrincipalId }),
        terminalOutcome: reduced.terminalOutcome ?? null,
        managedCommands,
      };
      this.#db.prepare(`INSERT INTO action_receipts
        (run_id,actor_principal_id,action_id,action,request_fingerprint,result,revision,accepted_at)
        VALUES (?,?,?,?,?,?,?,?)`).run(
        expectedRunId,actorPrincipalId,actionId,command.type,
        requestFingerprint,JSON.stringify(result),revision,now,
      );
      if (reduced.terminalOutcome) {
        const closed = this.#db.prepare(`UPDATE lobbies SET status='ended',updated_at=?
          WHERE code=? AND active_run_id=? AND run_generation=? AND status='playing'`)
          .run(now,lobbyCode,expectedRunId,expectedRunGeneration);
        if (closed.changes !== 1) throw new Error("Lobby terminal context is inconsistent.");
        const pending = this.#db.prepare(`UPDATE history_streams SET lifecycle='terminal_pending'
          WHERE run_id=? AND lifecycle='recording' AND last_recorded_revision=?`)
          .run(expectedRunId,revision);
        if (pending.changes !== 1) throw new Error("Run history could not enter terminal pending.");
        const transitionSequence = this.#db.prepare(`SELECT MAX(sequence)+1 AS sequence
          FROM history_transitions WHERE run_id=?`).get(expectedRunId).sequence;
        this.#db.prepare(`INSERT INTO history_transitions
          (run_id,sequence,from_state,to_state,reason,occurred_at)
          VALUES (?,?,'recording','terminal_pending',?,?)`)
          .run(expectedRunId,transitionSequence,`game_${reduced.terminalOutcome}`,now);
        this.#reconcileRunCommandsForTerminal(
          expectedRunId, actionId,
          reduced.terminalOutcome === "completed" ? "game_completed" : "game_abandoned", now,
        );
      }
      return { ...result, replayed: false };
    });
  }

  room({ lobbyCode, principalId }) {
    const row = this.#db.prepare(`SELECT l.code,l.status,l.run_generation,r.id AS run_id,
        r.revision,r.state,r.ended_at,r.terminal_outcome
      FROM lobbies l
      JOIN lobby_members m ON m.lobby_code=l.code AND m.principal_id=?
      LEFT JOIN game_runs r ON r.id=l.active_run_id
      WHERE l.code=?`).get(principalId,lobbyCode);
    if (!row) throw new Error("Lobby membership was not found.");
    return {
      lobbyCode: row.code, status: row.status, runGeneration: row.run_generation,
      runId: row.run_id ?? null, revision: row.revision ?? null,
      state: row.state ? projectRoomState(JSON.parse(row.state), {
        isHost: this.#db.prepare(`SELECT host_principal_id=? AS is_host
          FROM lobbies WHERE code=?`).get(principalId,lobbyCode).is_host === 1,
      }) : null,
      endedAt: row.ended_at ?? null, terminalOutcome: row.terminal_outcome ?? null,
    };
  }

  validate({ requireCandidate = false } = {}) {
    return validateStateDatabase(this.#db, { requireCandidate });
  }

  sealHistory({ commandId = randomUUID(), runId, now = Date.now() }) {
    const request = { runId };
    return this.#once(commandId, "seal_history", request, now, () => {
      this.#assertActive();
      const evidence = this.#db.prepare(`SELECT r.revision,r.ended_at,r.terminal_outcome,
          r.state,h.baseline_revision,h.last_recorded_revision,h.lifecycle,l.status,l.active_run_id
        FROM game_runs r
        JOIN history_streams h ON h.run_id=r.id
        JOIN lobbies l ON l.code=r.lobby_code
        WHERE r.id=?`).get(runId);
      if (!evidence || evidence.lifecycle !== "terminal_pending"
          || evidence.status !== "ended" || evidence.active_run_id !== runId
          || !evidence.ended_at || !["completed", "abandoned"].includes(evidence.terminal_outcome)
          || evidence.last_recorded_revision !== evidence.revision) {
        throw new Error("Run history terminal evidence is incomplete or contradictory.");
      }
      const terminalState = validateRoomState(JSON.parse(evidence.state));
      if ((evidence.terminal_outcome === "completed" && terminalState.phase !== "finished")
          || (evidence.terminal_outcome === "abandoned" && terminalState.phase === "finished")) {
        throw new Error("Run history terminal snapshot is contradictory.");
      }
      const terminalType = evidence.terminal_outcome === "completed"
        ? "game_completed" : "game_abandoned";
      const terminal = this.#db.prepare(`SELECT COUNT(*) AS count FROM game_events
        WHERE run_id=? AND event_type=? AND outcome=?`).get(
        runId,terminalType,evidence.terminal_outcome,
      ).count;
      const conflicting = this.#db.prepare(`SELECT COUNT(*) AS count FROM game_events
        WHERE run_id=? AND event_type IN ('game_completed','game_abandoned')
          AND NOT (event_type=? AND outcome=?)`).get(
        runId,terminalType,evidence.terminal_outcome,
      ).count;
      const unresolved = this.#db.prepare(`SELECT COUNT(*) AS count
        FROM managed_command_current WHERE run_id=?
          AND command_state IN ('queued','claimed','executing','outcome_unknown')`).get(runId).count;
      if (terminal !== 1 || conflicting || unresolved) {
        throw new Error("Run history terminal evidence is incomplete or contradictory.");
      }
      validateStateDatabase(this.#db);
      const mutationEvidence = this.#db.prepare(`SELECT
          (SELECT COUNT(*) FROM action_receipts receipt
            WHERE receipt.run_id=? AND receipt.revision>? AND receipt.revision<=?) AS receipts,
          (SELECT COUNT(*) FROM action_receipts receipt
            WHERE receipt.run_id=? AND receipt.revision>? AND receipt.revision<=?
              AND NOT EXISTS (SELECT 1 FROM game_events event
                WHERE event.run_id=receipt.run_id AND event.revision=receipt.revision
                  AND event.action_id=receipt.action_id)) AS missing_events`).get(
        runId,evidence.baseline_revision ?? 0,evidence.revision,
        runId,evidence.baseline_revision ?? 0,evidence.revision,
      );
      if (mutationEvidence.receipts !== evidence.revision - (evidence.baseline_revision ?? 0)
          || mutationEvidence.missing_events) {
        throw new Error("Run history revision evidence is incomplete.");
      }
      const changed = this.#db.prepare(`UPDATE history_streams SET lifecycle='sealed'
        WHERE run_id=? AND lifecycle='terminal_pending'`).run(runId);
      if (changed.changes !== 1) throw new Error("Run history sealing conflicted.");
      const sequence = this.#db.prepare(`SELECT MAX(sequence)+1 AS sequence
        FROM history_transitions WHERE run_id=?`).get(runId).sequence;
      this.#db.prepare(`INSERT INTO history_transitions
        (run_id,sequence,from_state,to_state,reason,occurred_at)
        VALUES (?,?,'terminal_pending','sealed','evidence_verified',?)`)
        .run(runId,sequence,now);
      return { runId, lifecycle: "sealed", revision: evidence.revision };
    });
  }

  purgeHistory({ commandId = randomUUID(), runId, eligibleBefore, now = Date.now() }) {
    safeNonnegative(eligibleBefore, "Retention eligibility boundary");
    const request = { runId, eligibleBefore };
    const result = this.#once(commandId, "purge_history", request, now, () => {
      this.#assertActive();
      const evidence = this.#db.prepare(`SELECT r.revision,r.ended_at,r.terminal_outcome,h.lifecycle
        FROM game_runs r JOIN history_streams h ON h.run_id=r.id WHERE r.id=?`).get(runId);
      if (!evidence || evidence.lifecycle !== "sealed" || !evidence.ended_at
          || evidence.ended_at > eligibleBefore
          || !["completed", "abandoned"].includes(evidence.terminal_outcome)) {
        throw new Error("Run history is not eligible for purge.");
      }
      const counts = {
        events: this.#db.prepare("SELECT COUNT(*) AS count FROM game_events WHERE run_id=?")
          .get(runId).count,
        receipts: this.#db.prepare("SELECT COUNT(*) AS count FROM action_receipts WHERE run_id=?")
          .get(runId).count,
      };
      const deletedContent = {
        events: this.#db.prepare(`SELECT revision,event_type,outcome,actor_type,actor_ref,
          action_id,command_ref,round,detail_code,detail_value,reason_code,occurred_at
          FROM game_events WHERE run_id=? ORDER BY sequence`).all(runId),
        receipts: this.#db.prepare(`SELECT actor_principal_id,action_id,action,
          request_fingerprint,result,revision,accepted_at
          FROM action_receipts WHERE run_id=? ORDER BY revision,actor_principal_id,action_id`).all(runId),
        commandPayloads: this.#db.prepare(`SELECT payload.command_id,payload.track_uri,
          payload.requested_by_principal_id
          FROM managed_command_payloads payload
          JOIN managed_command_intents command ON command.id=payload.command_id
          WHERE command.run_id=? ORDER BY payload.command_id`).all(runId),
      };
      const manifestDigest = fingerprint({
        contract: "state-purge-v1", runId, finalRevision: evidence.revision,
        terminalOutcome: evidence.terminal_outcome, deletedContent,
      });
      let sequence = this.#db.prepare(`SELECT MAX(sequence)+1 AS sequence
        FROM history_transitions WHERE run_id=?`).get(runId).sequence;
      this.#db.prepare(`INSERT INTO history_transitions
        (run_id,sequence,from_state,to_state,reason,occurred_at)
        VALUES (?,?,'sealed','purging','retention_claimed',?)`).run(runId,sequence,now);
      const claimed = this.#db.prepare(`UPDATE history_streams
        SET lifecycle='purging' WHERE run_id=? AND lifecycle='sealed'`).run(runId);
      if (claimed.changes !== 1) throw new Error("Run history purge claim conflicted.");
      this.#db.prepare("DELETE FROM game_events WHERE run_id=?").run(runId);
      this.#db.prepare("DELETE FROM action_receipts WHERE run_id=?").run(runId);
      this.#db.prepare(`DELETE FROM managed_command_payloads
        WHERE command_id IN (SELECT id FROM managed_command_intents WHERE run_id=?)`).run(runId);
      this.#db.prepare(`INSERT INTO purge_tombstones
        (run_id,final_revision,terminal_outcome,purged_at,manifest_digest)
        VALUES (?,?,?,?,?)`).run(
        runId,evidence.revision,evidence.terminal_outcome,now,manifestDigest,
      );
      this.#db.prepare(`INSERT INTO purge_sanitization
        (run_id,status,completed_at) VALUES (?,'pending',NULL)`).run(runId);
      const retainedState = redactRoomStateForRetention(JSON.parse(
        this.#db.prepare("SELECT state FROM game_runs WHERE id=?").get(runId).state,
      ));
      this.#db.prepare("UPDATE game_runs SET state=? WHERE id=?")
        .run(JSON.stringify(retainedState),runId);
      const changed = this.#db.prepare(`UPDATE history_streams
        SET lifecycle='purged',purged_at=? WHERE run_id=? AND lifecycle='purging'`)
        .run(now,runId);
      if (changed.changes !== 1) throw new Error("Run history purge conflicted.");
      sequence += 1;
      this.#db.prepare(`INSERT INTO history_transitions
        (run_id,sequence,from_state,to_state,reason,occurred_at)
        VALUES (?,?,'purging','purged','retention_completed',?)`).run(runId,sequence,now);
      return {
        runId, lifecycle: "purged", purgedAt: now, finalRevision: evidence.revision,
        terminalOutcome: evidence.terminal_outcome, counts, manifestDigest,
      };
    });
    this.resumePendingSanitization({ runId: result.runId, now });
    const sanitization = this.#db.prepare(`SELECT status,completed_at
      FROM purge_sanitization WHERE run_id=?`).get(result.runId);
    return { ...result, sanitization: {
      status: sanitization.status, completedAt: sanitization.completed_at ?? null,
    } };
  }

  resumePendingSanitization({ runId = null, now = Date.now() } = {}) {
    this.#assertActive();
    const pending = this.#db.prepare(`SELECT run_id FROM purge_sanitization
      WHERE status='pending' AND (? IS NULL OR run_id=?) ORDER BY run_id`).all(runId,runId);
    if (!pending.length) return { status: "complete", completed: [] };
    const checkpoint = this.#db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    if (checkpoint.busy !== 0) {
      return { status: "pending", completed: [], pending: pending.map((row) => row.run_id) };
    }
    const completed = this.#transaction(() => pending.filter((row) =>
      this.#db.prepare(`UPDATE purge_sanitization SET status='complete',completed_at=?
        WHERE run_id=? AND status='pending'`).run(now,row.run_id).changes === 1,
    ).map((row) => row.run_id));
    return { status: "complete", completed };
  }

  sanitizeHistory({ commandId, runId = null, now = Date.now() }) {
    if (!UUID_PATTERN.test(commandId)) throw new Error("State command ID must be a canonical UUID.");
    if (!UUID_PATTERN.test(runId ?? "")) {
      throw new Error("Sanitization requires one canonical run ID.");
    }
    const requestFingerprint = fingerprint({ commandType: "sanitize_history", request: { runId } });
    const prior = this.#db.prepare(`SELECT command_type,request_fingerprint,result
      FROM state_commands WHERE command_id=?`).get(commandId);
    if (prior) {
      if (prior.command_type !== "sanitize_history" || prior.request_fingerprint !== requestFingerprint) {
        throw new Error("State command identity conflicts with its prior request.");
      }
      return { ...JSON.parse(prior.result), replayed: true };
    }
    const result = this.resumePendingSanitization({ runId, now });
    return this.#once(commandId, "sanitize_history", { runId }, now, () => result);
  }

  #recordGameEvent(runId, revision, actionId, actorPrincipalId, event, now) {
    if (!EVENT_TYPES.has(event.type) || !EVENT_OUTCOMES.has(event.outcome)
        || !EVENT_ACTORS.has(event.actorType)) {
      throw new Error("Game event taxonomy is invalid.");
    }
    const sequence = this.#db.prepare(`SELECT COALESCE(MAX(sequence),0)+1 AS sequence
      FROM game_events WHERE run_id=?`).get(runId).sequence;
    this.#db.prepare(`INSERT INTO game_events
      (run_id,sequence,revision,event_type,outcome,actor_type,actor_ref,action_id,command_ref,
       round,detail_code,detail_value,reason_code,occurred_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      runId,sequence,revision,event.type,event.outcome,event.actorType,
      event.actorRef ?? (event.actorType === "system" ? null : actorPrincipalId),
      actionId,event.commandRef ?? null,
      event.round ?? null,event.detailCode ?? null,event.detailValue ?? null,
      event.reasonCode ?? null,now,
    );
  }

  registerManagedSource({
    commandId = randomUUID(), sourceId = randomUUID(), displayName, tokenHash,
    now = Date.now(),
  }) {
    const request = { sourceId, displayName, tokenHash };
    return this.#once(commandId, "register_managed_source", request, now, () => {
      this.#assertActive();
      if (!displayName?.trim()) throw new Error("Managed source display name is required.");
      if (!tokenHash?.trim()) throw new Error("Managed source token hash is required.");
      this.#db.prepare(`INSERT INTO managed_sources
        (id,display_name,token_hash,enabled,created_at) VALUES (?,?,?,1,?)`)
        .run(sourceId,displayName.trim(),tokenHash,now);
      return { sourceId, enabled: true };
    });
  }

  managedSourceForTokenHash(tokenHash) {
    const source = this.#db.prepare(`SELECT id FROM managed_sources
      WHERE token_hash=? AND enabled=1`).get(tokenHash);
    return source?.id ?? null;
  }

  assertManagedSourceCredentialSeparation(tokenHashes) {
    if (!Array.isArray(tokenHashes) || tokenHashes.some((value) => !/^[0-9a-f]{64}$/i.test(value))) {
      throw new Error("Service credential hashes are invalid.");
    }
    const collision = this.#db.prepare(`SELECT 1 FROM managed_sources
      WHERE token_hash IN (${tokenHashes.map(() => "?").join(",")}) LIMIT 1`).get(...tokenHashes);
    if (collision) throw new Error("Managed source credential collides with a service credential scope.");
  }

  managedSourceWork({ authenticatedSourceId, now = Date.now() }) {
    this.#assertActive();
    const lease = this.#db.prepare(`SELECT lease.id AS lease_id,lease.lobby_code,
        lease.expires_at,lease.playback_status
      FROM managed_leases lease
      JOIN managed_sources source ON source.id=lease.source_id AND source.enabled=1
      WHERE lease.source_id=? AND lease.expires_at>?`).get(authenticatedSourceId,now);
    if (!lease) return { protocolVersion: 3, lease: null, command: null };
    const inFlight = this.#db.prepare(`SELECT id,command_state FROM managed_command_current
      WHERE source_id=? AND lobby_code=?
        AND command_state IN ('claimed','executing','outcome_unknown')
      ORDER BY dispatch_sequence LIMIT 1`).get(authenticatedSourceId,lease.lobby_code);
    if (inFlight) {
      return {
        protocolVersion: 3,
        lease: {
          id: lease.lease_id, lobbyCode: lease.lobby_code,
          expiresAt: lease.expires_at, playbackStatus: lease.playback_status,
        },
        command: null,
        recovery: { commandId: inFlight.id, state: inFlight.command_state },
      };
    }
    const command = this.#db.prepare(`SELECT current.id,current.kind,payload.track_uri
      FROM managed_command_current current
      JOIN managed_command_payloads payload ON payload.command_id=current.id
      WHERE current.source_id=? AND current.lobby_code=? AND current.command_state='queued'
      ORDER BY current.dispatch_sequence LIMIT 1`).get(authenticatedSourceId,lease.lobby_code);
    return {
      protocolVersion: 3,
      lease: {
        id: lease.lease_id, lobbyCode: lease.lobby_code,
        expiresAt: lease.expires_at, playbackStatus: lease.playback_status,
      },
      command: command ? {
        id: command.id, kind: command.kind, trackUri: command.track_uri,
      } : null,
    };
  }

  acquireManagedLease({
    commandId = randomUUID(), lobbyCode, sourceId, actorPrincipalId,
    leaseDurationMs, now = Date.now(),
  }) {
    safeNonnegative(leaseDurationMs, "Lease duration");
    if (leaseDurationMs === 0) throw new Error("Lease duration must be positive.");
    const request = { lobbyCode, sourceId, actorPrincipalId, leaseDurationMs };
    return this.#once(commandId, "acquire_managed_lease", request, now, () => {
      this.#assertActive();
      const authority = this.#db.prepare(`SELECT 1 FROM lobbies l
        JOIN managed_sources s ON s.id=? AND s.enabled=1
        WHERE l.code=? AND l.status='playing' AND l.host_principal_id=?`)
        .get(sourceId,lobbyCode,actorPrincipalId);
      if (!authority) throw new Error("Managed lease authority is unavailable.");
      const conflict = this.#db.prepare(`SELECT id FROM managed_leases
        WHERE source_id=? OR lobby_code=?`).get(sourceId,lobbyCode);
      if (conflict) throw new Error("Managed source or lobby is already leased.");
      const leaseId = randomUUID();
      const expiresAt = now + leaseDurationMs;
      if (!Number.isSafeInteger(expiresAt)) throw new Error("Lease expiry is invalid.");
      this.#db.prepare(`INSERT INTO managed_leases
        (id,source_id,lobby_code,acquired_by_principal_id,acquired_at,renewed_at,
         expires_at,playback_status) VALUES (?,?,?,?,?,?,?,'ready')`)
        .run(leaseId,sourceId,lobbyCode,actorPrincipalId,now,now,expiresAt);
      this.#recordLeaseEvent({
        lobbyCode, actionId: commandId, actorPrincipalId, type: "audio_lease_acquired",
        outcome: "accepted", detailCode: "managed", now,
      });
      return { leaseId, sourceId, lobbyCode, expiresAt };
    });
  }

  renewManagedLease({
    commandId = randomUUID(), leaseId, actorPrincipalId, leaseDurationMs,
    now = Date.now(),
  }) {
    safeNonnegative(leaseDurationMs, "Lease duration");
    if (leaseDurationMs === 0) throw new Error("Lease duration must be positive.");
    const request = { leaseId, actorPrincipalId, leaseDurationMs };
    return this.#once(commandId, "renew_managed_lease", request, now, () => {
      this.#assertActive();
      const lease = this.#db.prepare(`SELECT lobby_code FROM managed_leases
        WHERE id=? AND acquired_by_principal_id=?`).get(leaseId,actorPrincipalId);
      const expiresAt = now + leaseDurationMs;
      const renewed = this.#db.prepare(`UPDATE managed_leases
        SET renewed_at=?,expires_at=?
        WHERE id=? AND acquired_by_principal_id=? AND expires_at>?`)
        .run(now,expiresAt,leaseId,actorPrincipalId,now);
      if (renewed.changes !== 1) throw new Error("Managed lease is stale or unavailable.");
      this.#recordLeaseEvent({
        lobbyCode: lease.lobby_code, actionId: commandId, actorPrincipalId,
        type: "audio_lease_renewed", outcome: "accepted", detailCode: "managed", now,
      });
      return { leaseId, expiresAt };
    });
  }

  releaseManagedLease({
    commandId = randomUUID(), leaseId, actorPrincipalId,
    reasonCode = "explicit_release", now = Date.now(),
  }) {
    const request = { leaseId, actorPrincipalId, reasonCode };
    return this.#once(commandId, "release_managed_lease", request, now, () => {
      this.#assertActive();
      const lease = this.#db.prepare(`SELECT id,source_id,lobby_code
        FROM managed_leases WHERE id=? AND acquired_by_principal_id=?`)
        .get(leaseId,actorPrincipalId);
      if (!lease) throw new Error("Managed lease is stale or unavailable.");
      const transitions = this.#forfeitLease(lease, reasonCode, now);
      this.#recordLeaseEvent({
        lobbyCode: lease.lobby_code, actionId: commandId, actorPrincipalId,
        type: "audio_lease_released", outcome: "completed", detailCode: "managed",
        reasonCode, now,
      });
      return { leaseId, released: true, transitions };
    });
  }

  expireManagedLeases({ commandId = randomUUID(), now = Date.now() } = {}) {
    return this.#once(commandId, "expire_managed_leases", {}, now, () => {
      this.#assertActive();
      const leases = this.#db.prepare(`SELECT id,source_id,lobby_code
        FROM managed_leases WHERE expires_at<=? ORDER BY id`).all(now);
      const expired = leases.map((lease) => {
        const transitions = this.#forfeitLease(lease, "lease_expired", now);
        this.#recordLeaseEvent({
          lobbyCode: lease.lobby_code, actionId: commandId, actorPrincipalId: null,
          type: "audio_lease_expired", outcome: "interrupted", detailCode: "managed",
          reasonCode: "lease_expired", now,
        });
        return { leaseId: lease.id, transitions };
      });
      return { boundary: now, expired };
    });
  }

  #forfeitLease(lease, reasonCode, now) {
    const commands = this.#db.prepare(`SELECT id,command_state,claim_generation
      FROM managed_command_current WHERE source_id=? AND lobby_code=?
        AND command_state IN ('queued','claimed','executing')`).all(
      lease.source_id,lease.lobby_code,
    );
    const transitions = [];
    for (const command of commands) {
      const next = command.command_state === "queued" ? "cancelled" : "outcome_unknown";
      this.#appendManagedCommandTransition({
        commandId: command.id, currentState: command.command_state, nextState: next,
        claimGeneration: command.claim_generation, reasonCode, now,
      });
      this.#recordManagedCommandEvent(command.id,next,reasonCode,now);
      transitions.push({ commandId: command.id, state: next });
    }
    const removed = this.#db.prepare("DELETE FROM managed_leases WHERE id=?").run(lease.id);
    if (removed.changes !== 1) throw new Error("Managed lease release conflicted.");
    return transitions;
  }

  createManagedCommand({
    commandId = randomUUID(), sourceId, lobbyCode, runId = null, runGeneration,
    kind, trackUri = null, requestedByPrincipalId, now = Date.now(),
  }) {
    const request = {
      sourceId, lobbyCode, runId, runGeneration, kind, trackUri, requestedByPrincipalId,
    };
    return this.#once(commandId, "create_managed_command", request, now, () => {
      this.#assertActive();
      if (!["play", "pause", "resume"].includes(kind)) throw new Error("Command kind is invalid.");
      if (kind === "play" && (typeof trackUri !== "string" || !trackUri)) {
        throw new Error("A play command requires an authoritative track URI.");
      }
      if (kind !== "play" && trackUri !== null) {
        throw new Error("Pause and resume commands cannot carry a track URI.");
      }
      if (!UUID_PATTERN.test(runId ?? "")) throw new Error("Managed command run ID is required.");
      if (!Number.isSafeInteger(runGeneration) || runGeneration < 0) {
        throw new Error("Run generation is invalid.");
      }
      const authority = this.#db.prepare(`SELECT 1
        FROM lobbies l
        JOIN lobby_members m ON m.lobby_code=l.code AND m.principal_id=?
        JOIN managed_sources s ON s.id=? AND s.enabled=1
        JOIN managed_leases lease ON lease.source_id=s.id AND lease.lobby_code=l.code
          AND lease.acquired_by_principal_id=? AND lease.expires_at>?
        WHERE l.code=? AND l.status='playing' AND l.active_run_id=? AND l.run_generation=?`)
        .get(requestedByPrincipalId,sourceId,requestedByPrincipalId,now,
          lobbyCode,runId,runGeneration);
      if (!authority) throw new Error("Managed command run authority is stale or unavailable.");
      return this.#insertManagedCommand({
        commandId,sourceId,lobbyCode,runId,runGeneration,kind,trackUri,
        requestedByPrincipalId,actionId: commandId,now,
      });
    });
  }

  createManagedControl(values) {
    if (!values || !["pause", "resume"].includes(values.kind) || values.trackUri != null) {
      throw new Error("Public managed controls are limited to pause and resume.");
    }
    return this.createManagedCommand({ ...values, trackUri: null });
  }

  #insertManagedCommand({
    commandId,sourceId,lobbyCode,runId,runGeneration,kind,trackUri,
    requestedByPrincipalId,actionId,now,
  }) {
    const dispatchSequence = this.#db.prepare(`SELECT COALESCE(MAX(dispatch_sequence),0)+1 AS next
      FROM managed_command_intents WHERE source_id=? AND lobby_code=?`).get(sourceId,lobbyCode).next;
    this.#db.prepare(`INSERT INTO managed_command_intents
      (id,source_id,lobby_code,run_id,run_generation,protocol_version,kind,
       action_id,dispatch_sequence,created_at)
      VALUES (?,?,?,?,?,3,?,?,?,?)`)
      .run(commandId,sourceId,lobbyCode,runId,runGeneration,kind,actionId,dispatchSequence,now);
    this.#db.prepare(`INSERT INTO managed_command_payloads
      (command_id,track_uri,requested_by_principal_id) VALUES (?,?,?)`)
      .run(commandId,trackUri,requestedByPrincipalId);
    this.#db.prepare(`INSERT INTO managed_command_transitions
      (command_id,sequence,from_state,to_state,occurred_at)
      VALUES (?,1,NULL,'queued',?)`).run(commandId,now);
    this.#recordManagedCommandEvent(commandId,"queued",null,now);
    return { commandId, protocolVersion: 3, state: "queued" };
  }

  #applyGameEffects({
    effects, lobbyCode, runId, runGeneration, requestedByPrincipalId, actionId, now,
  }) {
    if (!Array.isArray(effects)) throw new Error("Game effects are invalid.");
    const results = [];
    for (const effect of effects) {
      if (effect?.type !== "request_track" || typeof effect.uri !== "string" || !effect.uri) {
        throw new Error("Game effect is not implemented by this state-service generation.");
      }
      const lease = this.#db.prepare(`SELECT lease.source_id
        FROM managed_leases lease
        JOIN managed_sources source ON source.id=lease.source_id AND source.enabled=1
        WHERE lease.lobby_code=? AND lease.expires_at>?`).get(lobbyCode,now);
      if (!lease) {
        const mode = this.#db.prepare("SELECT audio_mode FROM lobbies WHERE code=?")
          .get(lobbyCode)?.audio_mode;
        if (mode === "local") continue;
        throw new Error("Managed playback authority is unavailable.");
      }
      results.push(this.#insertManagedCommand({
        commandId: randomUUID(),sourceId: lease.source_id,lobbyCode,runId,runGeneration,
        kind: "play",trackUri: effect.uri,requestedByPrincipalId,actionId,now,
      }));
    }
    return results;
  }

  transitionManagedCommand({
    requestId = randomUUID(), commandId, action, claimGeneration = null,
    outcomeFingerprint = null, reasonCode = null, authenticatedSourceId = null,
    now = Date.now(),
  }) {
    const request = {
      commandId, action, claimGeneration, outcomeFingerprint, reasonCode, authenticatedSourceId,
    };
    return this.#once(requestId, "transition_managed_command", request, now, () => {
      this.#assertActive();
      const current = this.#db.prepare(`SELECT command_state,claim_generation,source_id,
          run_id,run_generation,lobby_code,kind
        FROM managed_command_current WHERE id=?`).get(commandId);
      if (!current) throw new Error("Managed command was not found.");
      if (!authenticatedSourceId || current.source_id !== authenticatedSourceId) {
        throw new Error("Managed source is not authorized for this command.");
      }
      if (!["claim", "begin", "complete", "fail", "lose_authority"].includes(action)) {
        throw new Error("Managed source action is not permitted.");
      }
      if (reasonCode !== null && !EVENT_REASONS.has(reasonCode)) {
        throw new Error("Managed command reason is invalid.");
      }
      const next = COMMAND_EDGES.get(`${current.command_state}:${action}`);
      if (!next) throw new Error(`Managed command transition ${current.command_state}:${action} is forbidden.`);
      const history = this.#db.prepare("SELECT lifecycle FROM history_streams WHERE run_id=?")
        .get(current.run_id);
      if (!history || ["sealed", "purging", "purged"].includes(history.lifecycle)) {
        throw new Error("Managed command history is closed.");
      }
      const generation = claimGeneration;
      if (!generation || !UUID_PATTERN.test(generation)
          || (current.claim_generation && current.claim_generation !== generation)) {
        throw new Error("Managed command claim generation is invalid.");
      }
      if (["claim", "begin"].includes(action)
          && (outcomeFingerprint !== null || reasonCode !== null)) {
        throw new Error("Managed command authority transitions cannot carry outcome metadata.");
      }
      if (action === "complete" && reasonCode !== null) {
        throw new Error("Successful managed command completion cannot carry a failure reason.");
      }
      if (["fail", "lose_authority"].includes(action) && reasonCode === null) {
        throw new Error("Managed command failure or uncertainty requires a reason.");
      }
      if (action === "lose_authority" && outcomeFingerprint !== null) {
        throw new Error("Uncertain managed command outcomes cannot claim a terminal result.");
      }
      if (["completed", "failed"].includes(next)) {
        if (!outcomeFingerprint || typeof outcomeFingerprint !== "object"
            || Array.isArray(outcomeFingerprint)
            || Object.keys(outcomeFingerprint).sort().join(",") !== "errorCategory,ok,playbackStatus"
            || typeof outcomeFingerprint.ok !== "boolean") {
          throw new Error("Managed command terminal outcome is invalid.");
        }
        const expectedPlayback = current.kind === "pause" ? "paused" : "playing";
        if (next === "completed" && (outcomeFingerprint.ok !== true
            || outcomeFingerprint.playbackStatus !== expectedPlayback
            || outcomeFingerprint.errorCategory != null)) {
          throw new Error("Managed command success contradicts its requested playback state.");
        }
        if (next === "failed" && (outcomeFingerprint.ok !== false
            || outcomeFingerprint.playbackStatus !== "error"
            || !PLAYBACK_ERROR_CATEGORIES.has(outcomeFingerprint.errorCategory)
            || outcomeFingerprint.errorCategory !== reasonCode)) {
          throw new Error("Managed command failure outcome is invalid.");
        }
      }
      const storedOutcomeFingerprint = outcomeFingerprint ? fingerprint(outcomeFingerprint) : null;
      if (["claim", "begin"].includes(action)) {
        if (action === "claim") {
          const blocked = this.#db.prepare(`SELECT 1 FROM managed_command_current other
            JOIN managed_command_current target ON target.id=?
            WHERE other.source_id=target.source_id AND other.lobby_code=target.lobby_code
              AND other.id<>target.id AND (
                other.command_state IN ('claimed','executing','outcome_unknown') OR
                (other.command_state='queued'
                  AND other.dispatch_sequence<target.dispatch_sequence)
              ) LIMIT 1`).get(commandId);
          if (blocked) throw new Error("An earlier managed command still owns source execution.");
        }
        const liveLease = this.#db.prepare(`SELECT 1 FROM managed_command_intents command
          JOIN managed_leases lease ON lease.source_id=command.source_id
            AND lease.lobby_code=command.lobby_code AND lease.expires_at>?
          JOIN managed_sources source ON source.id=command.source_id AND source.enabled=1
          JOIN lobbies lobby ON lobby.code=command.lobby_code AND lobby.status='playing'
            AND lobby.active_run_id=command.run_id AND lobby.run_generation=command.run_generation
          WHERE command.id=? AND command.source_id=?`).get(now,commandId,authenticatedSourceId);
        if (!liveLease) throw new Error("Managed command lease authority has expired.");
      }
      this.#appendManagedCommandTransition({
        commandId, currentState: current.command_state, nextState: next,
        claimGeneration: generation, outcomeFingerprint: storedOutcomeFingerprint,
        playbackStatus: outcomeFingerprint?.playbackStatus ?? null,
        errorCategory: outcomeFingerprint?.errorCategory ?? null, reasonCode, now,
      });
      if (["completed", "failed"].includes(next) && current.command_state === "executing") {
        this.#db.prepare(`UPDATE managed_leases SET playback_status=?,last_error_category=?
          WHERE source_id=? AND lobby_code=?`).run(
          outcomeFingerprint.playbackStatus,outcomeFingerprint.errorCategory,
          current.source_id,current.lobby_code,
        );
      }
      this.#recordManagedCommandEvent(commandId,next,reasonCode,now);
      return { commandId, protocolVersion: 3, state: next, claimGeneration: generation };
    });
  }

  #appendManagedCommandTransition({
    commandId, currentState, nextState, claimGeneration = null,
    outcomeFingerprint = null, playbackStatus = null, errorCategory = null,
    reasonCode = null, now,
  }) {
    const sequence = this.#db.prepare(`SELECT MAX(sequence)+1 AS sequence
      FROM managed_command_transitions WHERE command_id=?`).get(commandId).sequence;
    this.#db.prepare(`INSERT INTO managed_command_transitions
      (command_id,sequence,from_state,to_state,claim_generation,outcome_fingerprint,
       playback_status,error_category,reason_code,occurred_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
      commandId,sequence,currentState,nextState,claimGeneration,outcomeFingerprint,
      playbackStatus,errorCategory,reasonCode,now,
    );
  }

  #recordManagedCommandEvent(commandId, state, reasonCode, now) {
    const command = this.#db.prepare(`SELECT command.id,command.run_id,command.kind,command.source_id,
        command.action_id,
        payload.requested_by_principal_id,run.revision,stream.lifecycle
      FROM managed_command_intents command
      LEFT JOIN managed_command_payloads payload ON payload.command_id=command.id
      JOIN game_runs run ON run.id=command.run_id
      JOIN history_streams stream ON stream.run_id=run.id
      WHERE command.id=?`).get(commandId);
    if (!command || !["recording", "terminal_pending"].includes(command.lifecycle)) {
      throw new Error("Managed command history is closed.");
    }
    const mapping = {
      queued: ["audio_command_requested", "accepted", "host", command.requested_by_principal_id],
      claimed: ["audio_command_delivered", "accepted", "source", command.source_id],
      completed: ["audio_command_completed", "completed", "source", command.source_id],
      failed: ["audio_command_failed", "failed", "source", command.source_id],
      outcome_unknown: ["audio_command_outcome_unknown", "unknown", "system", null],
      cancelled: ["audio_command_cancelled", "cancelled", "system", null],
    }[state];
    if (!mapping) return;
    this.#recordGameEvent(command.run_id,command.revision,command.action_id,null,{
      type: mapping[0], outcome: mapping[1], actorType: mapping[2],
      actorRef: mapping[3], commandRef: commandId, detailCode: command.kind,
      reasonCode,
    },now);
  }

  #reconcileRunCommandsForTerminal(runId, actionId, reasonCode, now) {
    const commands = this.#db.prepare(`SELECT id,command_state,claim_generation
      FROM managed_command_current WHERE run_id=?
        AND command_state IN ('queued','claimed','executing')`).all(runId);
    for (const command of commands) {
      const next = command.command_state === "queued" ? "cancelled" : "outcome_unknown";
      this.#appendManagedCommandTransition({
        commandId: command.id, currentState: command.command_state, nextState: next,
        claimGeneration: command.claim_generation, reasonCode, now,
      });
      this.#recordManagedCommandEvent(command.id,next,reasonCode,now);
    }
    const lobby = this.#db.prepare("SELECT lobby_code FROM game_runs WHERE id=?").get(runId);
    const lease = this.#db.prepare("SELECT id FROM managed_leases WHERE lobby_code=?")
      .get(lobby.lobby_code);
    if (lease) {
      this.#db.prepare("DELETE FROM managed_leases WHERE id=?").run(lease.id);
      this.#recordLeaseEvent({
        lobbyCode: lobby.lobby_code, actionId, actorPrincipalId: null,
        type: "audio_lease_released", outcome: "completed", detailCode: "managed",
        reasonCode, now,
      });
    }
  }

  #recordLeaseEvent({
    lobbyCode, actionId, actorPrincipalId, type, outcome, detailCode, reasonCode = null, now,
  }) {
    const run = this.#db.prepare(`SELECT run.id,run.revision FROM lobbies lobby
      JOIN game_runs run ON run.id=lobby.active_run_id WHERE lobby.code=?`).get(lobbyCode);
    if (!run) throw new Error("Managed lease is not bound to an active run.");
    this.#recordGameEvent(run.id,run.revision,actionId,actorPrincipalId,{
      type,outcome,actorType: actorPrincipalId ? "host" : "system",
      actorRef: actorPrincipalId,detailCode,reasonCode,
    },now);
  }
}
