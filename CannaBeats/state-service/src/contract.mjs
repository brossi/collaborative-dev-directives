import { STATE_SCHEMA_GENERATION } from "./schema.mjs";

export const STATE_PROTOCOL_VERSION = 3;
export const STATE_HTTP_CONTRACT_VERSION = 1;
export const ROOM_PROJECTION_VERSION = 1;
export const HISTORY_PROJECTION_VERSION = 1;

export const GAME_COMMAND_TYPES = Object.freeze([
  "add_host_player",
  "remove_player",
  "configure_rules",
  "start_game",
  "begin_round",
  "place_song",
  "retract_placement",
  "reveal_answer",
  "advance_round",
  "skip_track",
  "select_audio",
  "release_audio",
  "control_audio",
  "abandon_game",
]);

export const STATE_HTTP_ERROR_CODES = Object.freeze({
  invalid_json: 400,
  invalid_request: 400,
  unauthorized: 401,
  forbidden: 403,
  principal_assertion_invalid: 403,
  source_forbidden: 403,
  not_found: 404,
  payload_too_large: 413,
  idempotency_conflict: 409,
  stale_context: 409,
  state_conflict: 409,
  database_busy: 503,
  internal_error: 500,
});

export const STATE_SERVICE_CONTRACT = Object.freeze({
  service: "cannabeats-state",
  httpContractVersion: STATE_HTTP_CONTRACT_VERSION,
  schemaGeneration: STATE_SCHEMA_GENERATION,
  protocolVersion: STATE_PROTOCOL_VERSION,
  projections: Object.freeze({
    room: ROOM_PROJECTION_VERSION,
    history: HISTORY_PROJECTION_VERSION,
    accessLobby: 1,
  }),
  gameCommands: GAME_COMMAND_TYPES,
  errors: STATE_HTTP_ERROR_CODES,
});

const INVALID_REQUEST = [
  /\bmust be\b/i,
  /\bis invalid\b/i,
  /\bis required\b/i,
  /\brequires\b/i,
  /\bcannot carry\b/i,
  /\btyped game command\b/i,
  /\bnot implemented by this state-service generation\b/i,
  /\bchoose a valid\b/i,
  /\bplayer name\b/i,
  /\bcommand kind\b/i,
  /\bcommand reason\b/i,
  /\bterminal outcome\b/i,
];

const FORBIDDEN = [
  /\bhost authority\b/i,
  /\bonly the lobby host\b/i,
  /\bnot this player's turn\b/i,
  /\bnot authorized\b/i,
  /\brequires the access-scoped\b/i,
];

const NOT_FOUND = [
  /\bwas not found\b/i,
  /\bnot found\b/i,
  /\bmembership was not found\b/i,
];

const STALE = [
  /\bcontext is stale\b/i,
  /\bstale or unavailable\b/i,
  /\bauthority has expired\b/i,
];

const CONFLICT = [
  /\balready\b/i,
  /\bconflict/i,
  /\bhas ended\b/i,
  /\bhas already finished\b/i,
  /\blocked after\b/i,
  /\blocked after\b/i,
  /\bis not eligible\b/i,
  /\bis closed\b/i,
  /\bis unavailable\b/i,
  /\bcannot accept runtime commands\b/i,
  /\bcannot create another active run\b/i,
  /\btransition .* is forbidden\b/i,
  /\bnot permitted\b/i,
  /\bwait for\b/i,
  /\bno active\b/i,
  /\bno placement\b/i,
  /\breveal this round\b/i,
  /\bfirst round is not ready\b/i,
  /\bretractions are disabled\b/i,
  /\bretraction has already been used\b/i,
];

export function classifyStateHttpError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof SyntaxError) return { status: 400, code: "invalid_json" };
  if (message === "Request body is too large.") return { status: 413, code: "payload_too_large" };
  if (error?.code === "SQLITE_BUSY" || error?.code === "SQLITE_LOCKED"
      || /database is (?:busy|locked)/i.test(message)) {
    return { status: 503, code: "database_busy" };
  }
  if (/identity conflicts with its prior request/i.test(message)) {
    return { status: 409, code: "idempotency_conflict" };
  }
  if (/\b(?:activation contract|candidate authority|authority attestation|migrated candidate)\b/i.test(message)) {
    return { status: 409, code: "state_conflict" };
  }
  if (FORBIDDEN.some((pattern) => pattern.test(message))) return { status: 403, code: "forbidden" };
  if (NOT_FOUND.some((pattern) => pattern.test(message))) return { status: 404, code: "not_found" };
  if (STALE.some((pattern) => pattern.test(message))) return { status: 409, code: "stale_context" };
  if (INVALID_REQUEST.some((pattern) => pattern.test(message))) {
    return { status: 400, code: "invalid_request" };
  }
  if (CONFLICT.some((pattern) => pattern.test(message))) return { status: 409, code: "state_conflict" };
  return { status: 500, code: "internal_error" };
}
