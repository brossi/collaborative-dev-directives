import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  classifyStateHttpError,
  GAME_COMMAND_TYPES,
  STATE_HTTP_ERROR_CODES,
  STATE_SERVICE_CONTRACT,
} from "../src/contract.mjs";
import {
  initialRoomState,
  reduceGameCommand,
  validateRoomState,
} from "../src/game-domain.mjs";

const PHASES = ["lobby", "ready", "playing", "placed", "revealed", "finished"];

function song(key) {
  return { title: `Song ${key}`, artist: "Artist", year: 2000, uri: `spotify:track:${key}` };
}

function roomForPhase(phase, control = "host") {
  const playerId = "player-1";
  const state = initialRoomState({
    runId: randomUUID(), lobbyCode: "ABC123", runGeneration: 1,
  });
  state.players = [{ id: playerId, name: "Player", control, timeline: [song("seed")] }];
  if (phase !== "lobby") {
    state.phase = phase;
    state.activePlayerId = playerId;
    state.activePlayerIndex = 0;
    state.round = 1;
    state.currentSong = song("current");
  }
  if (["placed", "revealed", "finished"].includes(phase)) state.placement = 1;
  if (["revealed", "finished"].includes(phase)) state.result = { correct: false, index: 1 };
  if (phase === "finished") state.winnerId = playerId;
  return validateRoomState(state);
}

const COMMANDS = {
  add_host_player: { type: "add_host_player", name: "Second" },
  remove_player: { type: "remove_player", playerId: "player-1" },
  configure_rules: { type: "configure_rules", rules: { targetScore: 8 } },
  start_game: { type: "start_game" },
  begin_round: { type: "begin_round" },
  place_song: { type: "place_song", playerId: "player-1", index: 1 },
  retract_placement: { type: "retract_placement", playerId: "player-1" },
  reveal_answer: { type: "reveal_answer" },
  advance_round: { type: "advance_round" },
  skip_track: { type: "skip_track" },
  select_audio: { type: "select_audio", mode: "managed" },
  release_audio: { type: "release_audio" },
  control_audio: { type: "control_audio", kind: "pause" },
  abandon_game: { type: "abandon_game" },
};

const HOST_ALLOWED = {
  add_host_player: ["lobby"],
  remove_player: ["lobby"],
  configure_rules: ["lobby"],
  start_game: ["lobby"],
  begin_round: ["ready"],
  place_song: ["playing"],
  retract_placement: ["placed"],
  reveal_answer: ["placed"],
  advance_round: ["revealed"],
  skip_track: ["playing", "placed"],
  select_audio: ["lobby", "ready", "playing", "placed", "revealed"],
  release_audio: ["lobby", "ready", "playing", "placed", "revealed"],
  control_audio: ["playing", "placed"],
  abandon_game: ["lobby", "ready", "playing", "placed", "revealed"],
};

const PHONE_ALLOWED = {
  add_host_player: [],
  remove_player: [],
  configure_rules: [],
  start_game: [],
  begin_round: [],
  place_song: ["playing"],
  retract_placement: ["placed"],
  reveal_answer: [],
  advance_round: [],
  skip_track: [],
  select_audio: [],
  release_audio: [],
  control_audio: ["playing", "placed"],
  abandon_game: [],
};

function exercise({ commandType, phase, role }) {
  let songNumber = 0;
  const control = role === "phone" ? "phone" : "host";
  const state = roomForPhase(phase, control);
  return reduceGameCommand({
    state,
    command: COMMANDS[commandType],
    actor: {
      principalId: role === "phone" ? "player-1" : "host-1",
      isHost: role === "host", isMember: true,
    },
    selectSong: () => song(`selected-${songNumber++}`),
    selectStartingPlayer: () => 0,
  });
}

test("contract publishes one stable status for every external error code", () => {
  assert.equal(STATE_SERVICE_CONTRACT.httpContractVersion, 1);
  assert.deepEqual(STATE_SERVICE_CONTRACT.recovery.sourceHandoffStates,[
    "clear","stop_required","stop_claimed","stop_executing","quarantined",
  ]);
  assert.equal(STATE_SERVICE_CONTRACT.protocolVersion, 4);
  assert.deepEqual(STATE_SERVICE_CONTRACT.gameCommands, GAME_COMMAND_TYPES);
  for (const [code, status] of Object.entries(STATE_HTTP_ERROR_CODES)) {
    assert.match(code, /^[a-z][a-z0-9_]+$/);
    assert.ok(Number.isInteger(status) && status >= 400 && status < 600);
  }
});

test("error classification is stable and does not expose internal messages", () => {
  const cases = [
    [new SyntaxError("secret parser detail"), { status: 400, code: "invalid_json" }],
    [new Error("Request body is too large."), { status: 413, code: "payload_too_large" }],
    [Object.assign(new Error("locked detail"), { code: "SQLITE_BUSY" }),
      { status: 503, code: "database_busy" }],
    [new Error("Action identity conflicts with its prior request."),
      { status: 409, code: "idempotency_conflict" }],
    [new Error("Host authority is required for this game command."),
      { status: 403, code: "forbidden" }],
    [new Error("Lobby was not found."), { status: 404, code: "not_found" }],
    [new Error("Run mutation context is stale."), { status: 409, code: "stale_context" }],
    [new Error("Action ID must be a canonical UUID."), { status: 400, code: "invalid_request" }],
    [new Error("Run has ended."), { status: 409, code: "state_conflict" }],
    [new Error("private filesystem path and provider token"), { status: 500, code: "internal_error" }],
  ];
  for (const [error, expected] of cases) assert.deepEqual(classifyStateHttpError(error), expected);
});

test("host role by phase matrix is exhaustive for every public typed game command", () => {
  assert.deepEqual(Object.keys(COMMANDS).sort(), [...GAME_COMMAND_TYPES].sort());
  for (const commandType of GAME_COMMAND_TYPES) {
    for (const phase of PHASES) {
      const allowed = HOST_ALLOWED[commandType].includes(phase);
      if (allowed) {
        const result = exercise({ commandType, phase, role: "host" });
        validateRoomState(result.state);
        assert.ok(result.events?.length || result.effects?.length,
          `${commandType}/${phase} must derive history or an authoritative effect`);
      } else {
        assert.throws(() => exercise({ commandType, phase, role: "host" }), undefined,
          `${commandType}/${phase} must be rejected`);
      }
    }
  }
});

test("phone role by phase matrix permits only its active placement lifecycle", () => {
  for (const commandType of GAME_COMMAND_TYPES) {
    for (const phase of PHASES) {
      const allowed = PHONE_ALLOWED[commandType].includes(phase);
      if (allowed) {
        const result = exercise({ commandType, phase, role: "phone" });
        validateRoomState(result.state);
        assert.ok(result.events?.length || result.effects?.length,
          `${commandType}/${phase} must derive history or an authoritative effect`);
      } else {
        assert.throws(() => exercise({ commandType, phase, role: "phone" }), undefined,
          `${commandType}/${phase} must be rejected`);
      }
    }
  }
});

test("access admission command is isolated to lobby phase", () => {
  for (const phase of PHASES) {
    const state = roomForPhase(phase, "host");
    const invoke = () => reduceGameCommand({
      state,
      command: { type: "join_player", name: "Phone" },
      actor: { principalId: "phone-2", isHost: false },
    });
    if (phase === "lobby") {
      const result = invoke();
      assert.equal(result.admitPrincipal, true);
      validateRoomState(result.state);
    } else {
      assert.throws(invoke, /locked/i);
    }
  }
});
