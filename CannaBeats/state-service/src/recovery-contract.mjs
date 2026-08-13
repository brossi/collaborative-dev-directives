export const SESSION_RECOVERY_OUTCOMES = Object.freeze([
  "authentication_required",
  "credential_expired",
  "client_upgrade_required",
  "action_reconciliation_required",
  "none",
  "choose",
  "resume",
]);

export const SOURCE_HANDOFF_OUTCOMES = Object.freeze([
  "available",
  "owned",
  "busy",
  "recovering",
  "quarantined",
]);

export const SOURCE_HANDOFF_STATES = Object.freeze([
  "clear",
  "stop_required",
  "stop_claimed",
  "stop_executing",
  "quarantined",
]);

const SOURCE_HANDOFF_EDGES = new Map([
  ["clear:release_safe", "clear"],
  ["clear:release_playing", "stop_required"],
  ["clear:release_inflight", "quarantined"],
  ["stop_required:claim", "stop_claimed"],
  ["stop_claimed:begin", "stop_executing"],
  ["stop_claimed:lose_authority", "quarantined"],
  ["stop_executing:complete_paused", "clear"],
  ["stop_executing:fail", "quarantined"],
  ["stop_executing:lose_authority", "quarantined"],
  ["quarantined:reconcile_paused", "clear"],
]);

export function transitionSourceHandoff(state, action) {
  if (!SOURCE_HANDOFF_STATES.includes(state)) throw new Error("Source handoff state is invalid.");
  const next = SOURCE_HANDOFF_EDGES.get(`${state}:${action}`);
  if (!next) throw new Error(`Source handoff transition ${state}:${action} is forbidden.`);
  return next;
}

function lobby(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || typeof value.code !== "string" || !/^[A-Z2-9]{6}$/.test(value.code)
      || !["lobby", "playing", "ended"].includes(value.status)
      || typeof value.isHost !== "boolean") {
    throw new Error("Recovery membership is invalid.");
  }
  return { code: value.code, status: value.status, isHost: value.isHost };
}

export function resolveSessionRecovery({
  authenticated,
  credentialExpired = false,
  contractCompatible = true,
  pendingActionLobbyCode = null,
  preferredLobbyCode = null,
  memberships = [],
} = {}) {
  if (typeof authenticated !== "boolean" || typeof credentialExpired !== "boolean"
      || typeof contractCompatible !== "boolean" || !Array.isArray(memberships)) {
    throw new Error("Recovery input is invalid.");
  }
  const active = memberships.map(lobby).filter((entry) => entry.status !== "ended");
  const preferred = preferredLobbyCode === null ? null : String(preferredLobbyCode).toUpperCase();
  const pending = pendingActionLobbyCode === null ? null : String(pendingActionLobbyCode).toUpperCase();

  if (!contractCompatible) return { outcome: "client_upgrade_required", lobbies: [] };
  if (!authenticated) {
    return { outcome: credentialExpired ? "credential_expired" : "authentication_required", lobbies: [] };
  }
  if (pending) {
    const target = active.find((entry) => entry.code === pending) ?? null;
    return { outcome: "action_reconciliation_required", lobbies: target ? [target] : [] };
  }
  const preferredLobby = preferred ? active.find((entry) => entry.code === preferred) : null;
  if (preferredLobby) return { outcome: "resume", lobbies: [preferredLobby] };
  if (active.length === 0) return { outcome: "none", lobbies: [] };
  if (active.length === 1) return { outcome: "resume", lobbies: active };
  return { outcome: "choose", lobbies: active.sort((left, right) => left.code.localeCompare(right.code)) };
}

export function resolveSourceHandoff({
  requestedLobbyCode,
  leaseLobbyCode = null,
  unresolvedLobbyCode = null,
} = {}) {
  const requested = String(requestedLobbyCode ?? "").toUpperCase();
  if (!/^[A-Z2-9]{6}$/.test(requested)) throw new Error("Requested lobby is invalid.");
  for (const value of [leaseLobbyCode, unresolvedLobbyCode]) {
    if (value !== null && !/^[A-Z2-9]{6}$/.test(String(value).toUpperCase())) {
      throw new Error("Source handoff authority is invalid.");
    }
  }
  const lease = leaseLobbyCode === null ? null : String(leaseLobbyCode).toUpperCase();
  const unresolved = unresolvedLobbyCode === null ? null : String(unresolvedLobbyCode).toUpperCase();

  if (lease === requested && unresolved === null) {
    return { outcome: "owned", mayAcquire: false, mayListen: true, localFallback: true };
  }
  if (lease !== null && lease !== requested) {
    return { outcome: "busy", mayAcquire: false, mayListen: false, localFallback: true };
  }
  if (unresolved === requested) {
    return { outcome: "recovering", mayAcquire: false, mayListen: false, localFallback: true };
  }
  if (unresolved !== null) {
    return { outcome: "quarantined", mayAcquire: false, mayListen: false, localFallback: true };
  }
  return { outcome: "available", mayAcquire: true, mayListen: false, localFallback: true };
}
