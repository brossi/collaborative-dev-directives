import { createHash, randomUUID } from "node:crypto";
import { createStateStore } from "./store.mjs";

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

export class StateOwner {
  #db;

  constructor(path, options) {
    this.#db = createStateStore(path, options);
  }

  close() {
    this.#db.close();
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
    return { ...this.#db.prepare(`SELECT status,activated_at,first_admitted_at
      FROM state_authority WHERE singleton='state'`).get() };
  }

  activate({ commandId = randomUUID(), now = Date.now() } = {}) {
    return this.#once(commandId, "activate_state_authority", {}, now, () => {
      const authority = this.authorityStatus();
      if (authority.status !== "candidate") throw new Error("State authority is already active.");
      this.#db.prepare(`UPDATE state_authority SET status='active',activated_at=?
        WHERE singleton='state' AND status='candidate'`).run(now);
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
      if (!Number.isSafeInteger(runGeneration) || runGeneration < 0) {
        throw new Error("Run generation is invalid.");
      }
      this.#db.prepare(`INSERT INTO managed_command_intents
        (id,source_id,lobby_code,run_id,run_generation,protocol_version,kind,track_uri,
         requested_by_principal_id,created_at) VALUES (?,?,?,?,?,2,?,?,?,?)`)
        .run(commandId,sourceId,lobbyCode,runId,runGeneration,kind,trackUri,
          requestedByPrincipalId,now);
      this.#db.prepare(`INSERT INTO managed_command_transitions
        (command_id,sequence,from_state,to_state,occurred_at)
        VALUES (?,1,NULL,'queued',?)`).run(commandId,now);
      return { commandId, protocolVersion: 2, state: "queued" };
    });
  }

  transitionManagedCommand({
    requestId = randomUUID(), commandId, action, claimGeneration = null,
    outcomeFingerprint = null, reasonCode = null, now = Date.now(),
  }) {
    const request = { commandId, action, claimGeneration, outcomeFingerprint, reasonCode };
    return this.#once(requestId, "transition_managed_command", request, now, () => {
      this.#assertActive();
      const current = this.#db.prepare(`SELECT command_state,claim_generation
        FROM managed_command_current WHERE id=?`).get(commandId);
      if (!current) throw new Error("Managed command was not found.");
      const next = COMMAND_EDGES.get(`${current.command_state}:${action}`);
      if (!next) throw new Error(`Managed command transition ${current.command_state}:${action} is forbidden.`);
      const generation = action === "claim" ? randomUUID() : claimGeneration;
      if (action !== "cancel" && (!generation
          || (current.claim_generation && current.claim_generation !== generation))) {
        throw new Error("Managed command claim generation is invalid.");
      }
      if (["completed", "failed"].includes(next) && !outcomeFingerprint) {
        throw new Error("Managed command terminal outcome fingerprint is required.");
      }
      const sequence = this.#db.prepare(`SELECT MAX(sequence)+1 AS sequence
        FROM managed_command_transitions WHERE command_id=?`).get(commandId).sequence;
      this.#db.prepare(`INSERT INTO managed_command_transitions
        (command_id,sequence,from_state,to_state,claim_generation,outcome_fingerprint,
         reason_code,occurred_at) VALUES (?,?,?,?,?,?,?,?)`).run(
        commandId,sequence,current.command_state,next,generation,outcomeFingerprint,reasonCode,now,
      );
      return { commandId, protocolVersion: 2, state: next, claimGeneration: generation };
    });
  }
}
