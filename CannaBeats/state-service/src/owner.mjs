import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,existsSync,fsyncSync,mkdirSync,openSync,readFileSync,rmSync,writeFileSync,
} from "node:fs";
import { dirname,join,resolve } from "node:path";
import { closeStateStore, createStateStore, openStateStoreReadOnly } from "./store.mjs";
import {
  initialRoomState, projectRoomState, redactRoomStateForRetention,
  reduceGameCommand, validateRoomState,
} from "./game-domain.mjs";
import { validateStateDatabase } from "./invariants.mjs";
import { candidateAuthorityDigest } from "./attestation.mjs";
import { projectStateHistory } from "./history-projection.mjs";
import { resolveSessionRecovery } from "./recovery-contract.mjs";

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
  #rollbackFloorPath;

  constructor(path, {
    selectSong = null, selectStartingPlayer = null,
    allowDevelopmentActivation = false, ...storeOptions
  } = {}) {
    this.#db = createStateStore(path, storeOptions);
    this.#selectSong = selectSong;
    this.#selectStartingPlayer = selectStartingPlayer;
    this.#allowDevelopmentActivation = allowDevelopmentActivation;
    this.#rollbackFloorPath = resolve(storeOptions.rollbackFloorPath ?? `${path}.rollback-floor.json`);
    try {
      if (this.authorityStatus().status === "active") {
        this.#reconcileRollbackFloor();
        validateStateDatabase(this.#db);
        this.resumePendingSanitization({ now: Date.now() });
      }
    } catch (error) {
      closeStateStore(this.#db);
      throw error;
    }
  }

  #rollbackFloor() {
    if (!existsSync(this.#rollbackFloorPath)) return null;
    const floor = JSON.parse(readFileSync(this.#rollbackFloorPath,"utf8"));
    if (floor?.version !== 1 || typeof floor.releaseEpoch !== "string"
        || !floor.releaseEpoch || !Number.isSafeInteger(floor.firstAdmittedAt)
        || floor.firstAdmittedAt <= 0) {
      throw new Error("State rollback-floor record is invalid.");
    }
    return floor;
  }

  #writeRollbackFloor(firstAdmittedAt) {
    const authority = this.authorityStatus();
    const existing = this.#rollbackFloor();
    if (existing) {
      if (existing.releaseEpoch !== authority.release_epoch
          || existing.firstAdmittedAt !== firstAdmittedAt) {
        throw new Error("State rollback-floor record conflicts with active authority.");
      }
      return existing;
    }
    mkdirSync(dirname(this.#rollbackFloorPath),{ recursive: true,mode: 0o700 });
    const floor = {
      version: 1,releaseEpoch: authority.release_epoch,firstAdmittedAt,
    };
    writeFileSync(this.#rollbackFloorPath,`${JSON.stringify(floor)}\n`,{
      flag: "wx",mode: 0o600,
    });
    const file = openSync(this.#rollbackFloorPath,"r");
    try { fsyncSync(file); } finally { closeSync(file); }
    const directory = openSync(dirname(this.#rollbackFloorPath),"r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
    return floor;
  }

  #reconcileRollbackFloor() {
    const authority = this.authorityStatus();
    const floor = this.#rollbackFloor();
    if (!floor && authority.first_admitted_at !== null) {
      this.#writeRollbackFloor(authority.first_admitted_at);
      return;
    }
    if (!floor) return;
    if (floor.releaseEpoch !== authority.release_epoch) {
      throw new Error("State rollback-floor release epoch conflicts with active authority.");
    }
    if (authority.first_admitted_at === null) {
      this.#db.prepare(`UPDATE state_authority SET first_admitted_at=?
        WHERE singleton='state' AND first_admitted_at IS NULL`).run(floor.firstAdmittedAt);
    } else if (authority.first_admitted_at !== floor.firstAdmittedAt) {
      throw new Error("State rollback-floor timestamp conflicts with active authority.");
    }
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

  #admissionStatus() {
    const authority = this.#db.prepare(`SELECT status,release_epoch
      FROM state_authority WHERE singleton='state'`).get();
    const latest = this.#db.prepare(`SELECT result FROM state_commands
      WHERE command_type='set_admission'
      ORDER BY CAST(json_extract(result,'$.generation') AS INTEGER) DESC LIMIT 1`).get();
    if (latest) {
      const result = JSON.parse(latest.result);
      return { open: result.open === true,generation: result.generation };
    }
    return {
      open: authority.status === "active" && authority.release_epoch === "development",
      generation: 0,
    };
  }

  authorityStatus() {
    const authority = { ...this.#db.prepare(`SELECT status,activated_at,first_admitted_at,
      source_digest,candidate_digest,schema_generation,protocol_version,release_epoch
      FROM state_authority WHERE singleton='state'`).get() };
    return { ...authority,admission: this.#admissionStatus() };
  }

  readiness() {
    const authority = this.authorityStatus();
    const database = this.#db.prepare("SELECT 1 AS ok").get();
    if (database?.ok !== 1) throw new Error("State database readiness failed.");
    const sanitizationPending = this.#db.prepare(`SELECT COUNT(*) AS count
      FROM purge_sanitization WHERE status='pending'`).get().count;
    return { authority, sanitizationPending };
  }

  exportSnapshot({ directory }) {
    this.#assertActive();
    validateStateDatabase(this.#db);
    const pending = this.#db.prepare(`SELECT COUNT(*) AS count
      FROM purge_sanitization WHERE status='pending'`).get().count;
    if (pending !== 0) {
      throw new Error("State export is unavailable while purge sanitization is pending.");
    }
    mkdirSync(directory,{ recursive: true,mode: 0o700 });
    const path = join(directory,`state-export-${randomUUID()}.sqlite`);
    try {
      this.#db.prepare("VACUUM INTO ?").run(path);
      const exported = openStateStoreReadOnly(path);
      try {
        validateStateDatabase(exported);
      } finally {
        exported.close();
      }
      const snapshot = readFileSync(path);
      const authority = this.authorityStatus();
      return {
        snapshot,
        digest: createHash("sha256").update(snapshot).digest("hex"),
        authority,
      };
    } finally {
      rmSync(path,{ force: true });
    }
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

  setAdmission({ commandId,open,expectedGeneration,now = Date.now() }) {
    if (typeof open !== "boolean" || !Number.isSafeInteger(expectedGeneration)
        || expectedGeneration < 0) {
      throw new Error("Admission control request is invalid.");
    }
    return this.#once(commandId,"set_admission",{ open,expectedGeneration },now,() => {
      this.#assertActive();
      const current = this.#admissionStatus();
      if (current.generation !== expectedGeneration) {
        throw new Error("Admission control generation is stale.");
      }
      return { open,generation: current.generation + 1 };
    });
  }

  #assertActive() {
    if (this.authorityStatus().status !== "active") {
      throw new Error("State database is a candidate and cannot accept runtime commands.");
    }
  }

  #assertAdmissionOpen() {
    if (!this.#admissionStatus().open) throw new Error("State admission is closed.");
  }

  createLobby({ commandId = randomUUID(), code, hostPrincipalId, now = Date.now() }) {
    const request = { code, hostPrincipalId };
    return this.#once(commandId, "create_lobby", request, now, () => {
      this.#assertActive();
      this.#assertAdmissionOpen();
      if (!/^[A-Z0-9]{6}$/.test(code)) throw new Error("Lobby code is invalid.");
      if (!hostPrincipalId) throw new Error("Host principal is required.");
      this.#db.prepare(`INSERT INTO lobbies
        (code,host_principal_id,status,created_at,updated_at) VALUES (?,?,'lobby',?,?)`)
        .run(code,hostPrincipalId,now,now);
      this.#db.prepare(`INSERT INTO lobby_members
        (lobby_code,principal_id,joined_at,last_seen_at) VALUES (?,?,?,?)`)
        .run(code,hostPrincipalId,now,now);
      const firstAdmittedAt = this.authorityStatus().first_admitted_at ?? now;
      const rollbackFloor = this.#writeRollbackFloor(firstAdmittedAt);
      this.#db.prepare(`UPDATE state_authority SET first_admitted_at=COALESCE(first_admitted_at,?)
        WHERE singleton='state' AND first_admitted_at IS NULL`).run(rollbackFloor.firstAdmittedAt);
      return { code, status: "lobby" };
    });
  }

  addLobbyMember({
    commandId = randomUUID(), lobbyCode, principalId, admittedByPrincipalId, now = Date.now(),
  }) {
    const request = { lobbyCode, principalId, admittedByPrincipalId };
    return this.#once(commandId, "add_lobby_member", request, now, () => {
      this.#assertActive();
      this.#assertAdmissionOpen();
      if (!principalId) throw new Error("Lobby member principal is required.");
      const lobby = this.#db.prepare(`SELECT status FROM lobbies WHERE code=?`).get(lobbyCode);
      if (!lobby) throw new Error("Lobby was not found.");
      if (lobby.status === "ended") throw new Error("Run has ended.");
      const prior = this.#db.prepare(`SELECT joined_at FROM lobby_members
        WHERE lobby_code=? AND principal_id=?`).get(lobbyCode,principalId);
      if (!prior) {
        this.#db.prepare(`INSERT INTO lobby_members
          (lobby_code,principal_id,joined_at,last_seen_at) VALUES (?,?,?,?)`)
          .run(lobbyCode,principalId,now,now);
      }
      return { lobbyCode, principalId, joinedAt: prior?.joined_at ?? now, admitted: !prior };
    });
  }

  accessLobby({ lobbyCode, principalId }) {
    const lobby = this.#db.prepare(`SELECT l.code,l.host_principal_id,l.status,l.run_generation,
        l.created_at,l.updated_at,r.state
      FROM lobbies l LEFT JOIN game_runs r ON r.id=l.active_run_id
      WHERE l.code=? AND EXISTS(
        SELECT 1 FROM lobby_members WHERE lobby_code=l.code AND principal_id=?)`)
      .get(lobbyCode,principalId);
    if (!lobby) throw new Error("Lobby membership was not found.");
    const members = this.#db.prepare(`SELECT principal_id,joined_at
      FROM lobby_members WHERE lobby_code=? ORDER BY joined_at,principal_id`).all(lobbyCode);
    let admissionOpen = false;
    if (lobby.state) {
      admissionOpen = validateRoomState(JSON.parse(lobby.state)).phase === "lobby";
    }
    return {
      code: lobby.code, status: lobby.status, hostPrincipalId: lobby.host_principal_id,
      runGeneration: lobby.run_generation, admissionOpen,
      members: members.map((member) => ({
        principalId: member.principal_id, joinedAt: member.joined_at,
      })),
      createdAt: lobby.created_at, updatedAt: lobby.updated_at,
    };
  }

  accessLobbies({ principalId }) {
    return this.#db.prepare(`SELECT l.code,l.status,l.host_principal_id,l.run_generation,
        l.created_at,l.updated_at
      FROM lobbies l JOIN lobby_members m ON m.lobby_code=l.code
      WHERE m.principal_id=? AND l.status<>'ended'
      ORDER BY m.last_seen_at DESC,l.code`).all(principalId).map((lobby) => ({
        code: lobby.code, status: lobby.status, hostPrincipalId: lobby.host_principal_id,
        runGeneration: lobby.run_generation,
        createdAt: lobby.created_at, updatedAt: lobby.updated_at,
      }));
  }

  recoverPrincipal({ principalId, preferredLobbyCode = null, pendingActionLobbyCode = null }) {
    if (typeof principalId !== "string" || !principalId) {
      throw new Error("Recovery principal is required.");
    }
    const rows = this.#db.prepare(`SELECT l.code,l.status,l.host_principal_id,
        l.active_run_id,l.run_generation,r.revision,r.state
      FROM lobbies l JOIN lobby_members m ON m.lobby_code=l.code
      LEFT JOIN game_runs r ON r.id=l.active_run_id
      WHERE m.principal_id=? ORDER BY l.updated_at DESC,l.code`).all(principalId);
    const resolution = resolveSessionRecovery({
      authenticated: true,preferredLobbyCode,pendingActionLobbyCode,
      memberships: rows.map((row) => ({
        code: row.code,status: row.status,isHost: row.host_principal_id === principalId,
      })),
    });
    const byCode = new Map(rows.map((row) => [row.code,row]));
    return {
      outcome: resolution.outcome,
      lobbies: resolution.lobbies.map((entry) => {
        const row = byCode.get(entry.code);
        let seatPlayerId = null;
        if (row.state) {
          const state = validateRoomState(JSON.parse(row.state));
          seatPlayerId = state.players.find((player) =>
            player.control === "phone" && player.id === principalId)?.id ?? null;
        }
        return {
          ...entry,runId: row.active_run_id ?? null,runGeneration: row.run_generation,
          revision: row.revision ?? null,seatPlayerId,
        };
      }),
    };
  }

  accessAdmissionContext({ lobbyCode }) {
    const row = this.#db.prepare(`SELECT l.active_run_id AS run_id,l.run_generation,r.revision,r.state
      FROM lobbies l JOIN game_runs r ON r.id=l.active_run_id
      WHERE l.code=? AND l.status='playing'`).get(lobbyCode);
    if (!row) throw new Error("Active run was not found.");
    const room = validateRoomState(JSON.parse(row.state));
    if (room.phase !== "lobby") throw new Error("Players are locked after the game starts.");
    return {
      runId: row.run_id, runGeneration: row.run_generation,
      revision: row.revision, admissionOpen: true,
    };
  }

  memberHistory({ runId, principalId, limit = 500 }) {
    if (!UUID_PATTERN.test(runId)) throw new Error("Run ID must be a canonical UUID.");
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error("History limit is invalid.");
    const run = this.#db.prepare(`SELECT r.id,r.lobby_code,r.state,r.revision,r.updated_at,
        r.ended_at,r.terminal_outcome
      FROM game_runs r WHERE r.id=? AND EXISTS(
        SELECT 1 FROM lobby_members m WHERE m.lobby_code=r.lobby_code AND m.principal_id=?)`)
      .get(runId,principalId);
    if (!run) throw new Error("Game run was not found.");
    const stream = this.#db.prepare(`SELECT baseline_revision,last_recorded_revision,lifecycle,purged_at
      FROM history_streams WHERE run_id=?`).get(runId);
    if (!stream) throw new Error("Game history was not found.");
    const events = this.#db.prepare(`SELECT sequence,event_type,outcome,actor_type,actor_ref,
        action_id,command_ref,round,detail_code,detail_value,reason_code,occurred_at
      FROM game_events WHERE run_id=? ORDER BY sequence LIMIT ?`).all(runId,limit);
    const total = this.#db.prepare("SELECT COUNT(*) AS count FROM game_events WHERE run_id=?")
      .get(runId).count;
    let state = {};
    try { state = JSON.parse(run.state); } catch { /* Invalid fields project to null. */ }
    return projectStateHistory({ run,stream,state,events,total });
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
      const context = this.#db.prepare(`SELECT l.active_run_id,l.run_generation,
          l.host_principal_id,r.revision,r.ended_at,r.terminal_outcome,r.state,
          EXISTS(SELECT 1 FROM lobby_members m
            WHERE m.lobby_code=l.code AND m.principal_id=?) AS is_member
        FROM lobbies l JOIN game_runs r ON r.id=l.active_run_id AND r.lobby_code=l.code
        WHERE l.code=?`).get(actorPrincipalId,lobbyCode);
      if (!context) throw new Error("Active run membership was not found.");
      const receipt = this.#db.prepare(`SELECT action,request_fingerprint,result
        FROM action_receipts WHERE run_id=? AND actor_principal_id=? AND action_id=?`)
        .get(expectedRunId,actorPrincipalId,actionId);
      if (receipt) {
        if (receipt.action !== command.type || receipt.request_fingerprint !== requestFingerprint) {
          throw new Error("Action identity conflicts with its prior request.");
        }
        if (!context.is_member) throw new Error("Active run membership was not found.");
        const prior = JSON.parse(receipt.result);
        return {
          ...prior, runId: context.active_run_id,runGeneration: context.run_generation,
          revision: context.revision,
          state: projectRoomState(validateRoomState(JSON.parse(context.state)), {
            isHost: context.host_principal_id === actorPrincipalId,
          }),
          terminalOutcome: context.terminal_outcome ?? null,replayed: true,
        };
      }
      if (allowAdmission) this.#assertAdmissionOpen();
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
      if (!Array.isArray(reduced.events)) throw new Error("Game events are invalid.");
      for (const event of reduced.events) {
        this.#recordGameEvent(expectedRunId, revision, actionId, actorPrincipalId, event, now);
      }
      const managedCommands = this.#applyGameEffects({
        effects: reduced.effects ?? [], lobbyCode, runId: expectedRunId,
        runGeneration: expectedRunGeneration, requestedByPrincipalId: actorPrincipalId,
        actionId, now,
      });
      const eventCount = this.#db.prepare(`SELECT COUNT(*) AS count FROM game_events
        WHERE run_id=? AND revision=? AND action_id=?`).get(expectedRunId,revision,actionId).count;
      if (eventCount < 1) {
        throw new Error("Every game mutation must derive at least one canonical event.");
      }
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

  retentionCandidates({ eligibleBefore }) {
    safeNonnegative(eligibleBefore,"Retention eligibility boundary");
    return this.#db.prepare(`SELECT r.id AS run_id,r.ended_at,h.lifecycle
      FROM game_runs r JOIN history_streams h ON h.run_id=r.id
      WHERE r.ended_at IS NOT NULL AND r.ended_at<=?
        AND h.lifecycle IN ('terminal_pending','sealed')
      ORDER BY r.ended_at,r.id`).all(eligibleBefore).map((row) => ({
      runId: row.run_id,endedAt: row.ended_at,lifecycle: row.lifecycle,
    }));
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
      event.actorType === "system" ? null : (actorPrincipalId ?? event.actorRef ?? null),
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
      if (!UUID_PATTERN.test(sourceId)) throw new Error("Managed source ID must be a canonical UUID.");
      const normalizedName = typeof displayName === "string" ? displayName.trim() : "";
      if (!normalizedName || normalizedName.length > 80) {
        throw new Error("Managed source display name must be 1-80 characters.");
      }
      if (!/^[0-9a-f]{64}$/.test(tokenHash ?? "")) {
        throw new Error("Managed source token hash must be a lowercase SHA-256 digest.");
      }
      this.#db.prepare(`INSERT INTO managed_sources
        (id,display_name,token_hash,enabled,created_at) VALUES (?,?,?,1,?)`)
        .run(sourceId,normalizedName,tokenHash,now);
      return { sourceId, enabled: true };
    });
  }

  managedSources() {
    return this.#db.prepare(`SELECT id,display_name,enabled,created_at,last_seen_at,last_error_category
      FROM managed_sources ORDER BY created_at,id`).all().map((source) => ({
      sourceId: source.id,displayName: source.display_name,enabled: Boolean(source.enabled),
      createdAt: source.created_at,lastSeenAt: source.last_seen_at,
      errorCategory: source.last_error_category,
    }));
  }

  operatorReport({ sinceHours = 24, now = Date.now() } = {}) {
    if (!Number.isInteger(sinceHours) || sinceHours < 1 || sinceHours > 24 * 31) {
      throw new Error("Operator report window is invalid.");
    }
    const cutoff = now - sinceHours * 60 * 60 * 1000;
    const sessions = this.#db.prepare(`SELECT l.code,l.status,l.run_generation,l.updated_at,
        r.id AS run_id,r.revision,r.state,r.ended_at,r.terminal_outcome,
        h.lifecycle,h.baseline_revision,h.last_recorded_revision,h.purged_at,
        lease.id AS lease_id,lease.playback_status,lease.expires_at,
        source.id AS source_id,source.last_seen_at,source.last_error_category
      FROM lobbies l
      LEFT JOIN game_runs r ON r.id=l.active_run_id
      LEFT JOIN history_streams h ON h.run_id=r.id
      LEFT JOIN managed_leases lease ON lease.lobby_code=l.code
      LEFT JOIN managed_sources source ON source.id=lease.source_id
      WHERE l.updated_at>=? OR r.updated_at>=? OR r.ended_at>=?
      ORDER BY COALESCE(r.updated_at,l.updated_at) DESC,l.code`).all(cutoff,cutoff,cutoff);
    return {
      generatedAt: now,sinceHours,authority: this.authorityStatus(),
      sanitizationPending: this.readiness().sanitizationPending,
      sources: this.managedSources(),
      sessions: sessions.map((row) => {
        let phase = null;
        try { phase = validateRoomState(JSON.parse(row.state)).phase; } catch { /* report null */ }
        return {
          code: row.code,status: row.status,runGeneration: row.run_generation,
          updatedAt: row.updated_at,runId: row.run_id,revision: row.revision,phase,
          endedAt: row.ended_at,terminalOutcome: row.terminal_outcome,
          history: row.run_id ? {
            lifecycle: row.lifecycle,baselineRevision: row.baseline_revision,
            lastRecordedRevision: row.last_recorded_revision,purgedAt: row.purged_at,
            complete: row.last_recorded_revision === row.revision,
          } : null,
          audio: row.lease_id ? {
            leaseId: row.lease_id,sourceId: row.source_id,
            playbackStatus: row.playback_status,expiresAt: row.expires_at,
            sourceLastSeenAt: row.last_seen_at,errorCategory: row.last_error_category,
          } : null,
        };
      }),
    };
  }

  updateManagedSource({
    commandId = randomUUID(), sourceId, action, tokenHash = null, now = Date.now(),
  }) {
    if (!['rotate','disable'].includes(action)) throw new Error("Managed source update is invalid.");
    const request = { sourceId,action,tokenHash };
    return this.#once(commandId,`managed_source_${action}`,request,now,() => {
      this.#assertActive();
      const source = this.#db.prepare("SELECT id FROM managed_sources WHERE id=?").get(sourceId);
      if (!source) throw new Error("Managed source was not found.");
      const lease = this.#db.prepare(`SELECT id,source_id,lobby_code FROM managed_leases
        WHERE source_id=?`).get(sourceId);
      let transitions = [];
      if (lease) {
        transitions = this.#forfeitLease(lease,"explicit_release",now);
        this.#recordLeaseEvent({
          lobbyCode: lease.lobby_code,actionId: commandId,actorPrincipalId: null,
          type: "audio_lease_released",outcome: "completed",detailCode: "managed",
          reasonCode: "explicit_release",now,
        });
      }
      if (action === 'rotate') {
        if (typeof tokenHash !== "string" || !/^[0-9a-f]{64}$/i.test(tokenHash)) {
          throw new Error("Managed source token hash is invalid.");
        }
        this.#db.prepare(`UPDATE managed_sources SET token_hash=?,enabled=1,
          last_seen_at=NULL,last_error_category=NULL WHERE id=?`).run(tokenHash,sourceId);
      } else {
        if (tokenHash !== null) throw new Error("Managed source disable cannot carry a token hash.");
        this.#db.prepare(`UPDATE managed_sources SET enabled=0,last_seen_at=NULL,
          last_error_category=NULL WHERE id=?`).run(sourceId);
      }
      return { sourceId,enabled: action === 'rotate',activeLeaseReleased: Boolean(lease),transitions };
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
    this.#db.prepare("UPDATE managed_sources SET last_seen_at=? WHERE id=? AND enabled=1")
      .run(now,authenticatedSourceId);
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

  audioView({ lobbyCode, now = Date.now() }) {
    const row = this.#db.prepare(`SELECT l.audio_mode,lease.id AS lease_id,
        lease.expires_at,lease.playback_status,lease.last_error_category,
        source.display_name,source.last_seen_at
      FROM lobbies l
      LEFT JOIN managed_leases lease ON lease.lobby_code=l.code AND lease.expires_at>?
      LEFT JOIN managed_sources source ON source.id=lease.source_id
      WHERE l.code=?`).get(now,lobbyCode);
    if (!row) throw new Error("Lobby was not found.");
    if (row.audio_mode === "local") {
      return { selection: "local", mode: "local", sourceOnline: false, status: "disconnected" };
    }
    if (!row.lease_id) {
      return { selection: "managed", mode: "local", sourceOnline: false, status: "disconnected" };
    }
    return {
      selection: "managed", mode: "managed", leaseId: row.lease_id,
      sourceName: row.display_name,
      sourceOnline: Number.isSafeInteger(row.last_seen_at) && row.last_seen_at > now - 90_000,
      status: row.playback_status,
      ...(row.last_error_category ? { error: row.last_error_category } : {}),
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
      if (effect?.type === "select_audio") {
        this.#db.prepare("UPDATE lobbies SET audio_mode=?,updated_at=? WHERE code=?")
          .run(effect.mode,now,lobbyCode);
        const existing = this.#db.prepare(`SELECT id,source_id,lobby_code FROM managed_leases
          WHERE lobby_code=?`).get(lobbyCode);
        if (effect.mode === "local") {
          if (existing) {
            this.#forfeitLease(existing,"source_selected_local",now);
            this.#recordLeaseEvent({
              lobbyCode,actionId,actorPrincipalId: requestedByPrincipalId,
              type: "audio_lease_released",outcome: "completed",detailCode: "managed",
              reasonCode: "source_selected_local",now,
            });
          }
          continue;
        }
        if (existing) {
          const expiresAt = now + 120_000;
          this.#db.prepare("UPDATE managed_leases SET renewed_at=?,expires_at=? WHERE id=?")
            .run(now,expiresAt,existing.id);
          this.#recordLeaseEvent({
            lobbyCode,actionId,actorPrincipalId: requestedByPrincipalId,
            type: "audio_lease_renewed",outcome: "accepted",detailCode: "managed",now,
          });
          continue;
        }
        const source = this.#db.prepare(`SELECT source.id FROM managed_sources source
          LEFT JOIN managed_leases lease ON lease.source_id=source.id
          WHERE source.enabled=1 AND source.last_seen_at>? AND lease.id IS NULL
          ORDER BY source.last_seen_at DESC,source.id LIMIT 1`).get(now - 90_000);
        if (!source) throw new Error("Managed playback authority is unavailable.");
        const leaseId = randomUUID();
        this.#db.prepare(`INSERT INTO managed_leases
          (id,source_id,lobby_code,acquired_by_principal_id,acquired_at,renewed_at,
           expires_at,playback_status) VALUES (?,?,?,?,?,?,?,'ready')`)
          .run(leaseId,source.id,lobbyCode,requestedByPrincipalId,now,now,now + 120_000);
        this.#recordLeaseEvent({
          lobbyCode,actionId,actorPrincipalId: requestedByPrincipalId,
          type: "audio_lease_acquired",outcome: "accepted",detailCode: "managed",now,
        });
        continue;
      }
      if (effect?.type === "release_audio") {
        const lease = this.#db.prepare(`SELECT id,source_id,lobby_code FROM managed_leases
          WHERE lobby_code=?`).get(lobbyCode);
        if (!lease) throw new Error("Managed lease is stale or unavailable.");
        this.#forfeitLease(lease,"explicit_release",now);
        this.#recordLeaseEvent({
          lobbyCode,actionId,actorPrincipalId: requestedByPrincipalId,
          type: "audio_lease_released",outcome: "completed",detailCode: "managed",
          reasonCode: "explicit_release",now,
        });
        continue;
      }
      if (effect?.type === "control_audio") {
        const lease = this.#db.prepare(`SELECT source_id FROM managed_leases
          WHERE lobby_code=? AND expires_at>?`).get(lobbyCode,now);
        if (!lease) throw new Error("Managed playback authority is unavailable.");
        results.push(this.#insertManagedCommand({
          commandId: randomUUID(),sourceId: lease.source_id,lobbyCode,runId,runGeneration,
          kind: effect.kind,trackUri: null,requestedByPrincipalId,actionId,now,
        }));
        continue;
      }
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
        command.action_id,lobby.host_principal_id,
        payload.requested_by_principal_id,run.revision,stream.lifecycle
      FROM managed_command_intents command
      LEFT JOIN managed_command_payloads payload ON payload.command_id=command.id
      JOIN game_runs run ON run.id=command.run_id
      JOIN lobbies lobby ON lobby.code=command.lobby_code
      JOIN history_streams stream ON stream.run_id=run.id
      WHERE command.id=?`).get(commandId);
    if (!command || !["recording", "terminal_pending"].includes(command.lifecycle)) {
      throw new Error("Managed command history is closed.");
    }
    const mapping = {
      queued: ["audio_command_requested", "accepted",
        command.requested_by_principal_id === command.host_principal_id ? "host" : "player",
        command.requested_by_principal_id],
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
