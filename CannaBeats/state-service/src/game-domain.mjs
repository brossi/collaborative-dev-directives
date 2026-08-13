import { randomUUID } from "node:crypto";

const DEFAULT_RULES = Object.freeze({
  preset: "family",
  minYear: 1920,
  maxYear: 2026,
  eraWeights: { early: 5, midcentury: 10, classics: 25, millennial: 30, current: 30 },
  targetScore: 10,
  allowRetraction: true,
  catalogScope: "all",
});

function boundedInteger(value, fallback, minimum, maximum) {
  return Number.isSafeInteger(value) ? Math.min(maximum, Math.max(minimum, value)) : fallback;
}

export function normalizeRules(value) {
  const candidate = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const minimum = boundedInteger(candidate.minYear, DEFAULT_RULES.minYear, 1920, 2026);
  const weights = candidate.eraWeights && typeof candidate.eraWeights === "object"
    ? candidate.eraWeights : {};
  return {
    preset: ["family", "all-eras", "modern", "younger", "broadway-tv-movies", "custom"]
      .includes(candidate.preset) ? candidate.preset : "custom",
    minYear: minimum,
    maxYear: boundedInteger(candidate.maxYear, DEFAULT_RULES.maxYear, minimum, 2026),
    eraWeights: Object.fromEntries(Object.entries(DEFAULT_RULES.eraWeights).map(([key, fallback]) => [
      key, boundedInteger(weights[key], fallback, 0, 100),
    ])),
    targetScore: boundedInteger(candidate.targetScore, DEFAULT_RULES.targetScore, 3, 20),
    allowRetraction: candidate.allowRetraction !== false,
    catalogScope: candidate.catalogScope === "broadway-tv-movies"
      ? "broadway-tv-movies" : "all",
  };
}

export function initialRoomState({ runId, lobbyCode, runGeneration, rules }) {
  return {
    runId,
    runGeneration,
    revision: 0,
    code: lobbyCode,
    phase: "lobby",
    players: [],
    activePlayerId: null,
    activePlayerIndex: 0,
    round: 0,
    currentSong: null,
    placement: null,
    retractionUsed: false,
    result: null,
    winnerId: null,
    rules: normalizeRules(rules ?? DEFAULT_RULES),
    usedUris: [],
  };
}

function requireHost(actor) {
  if (!actor.isHost) throw new Error("Host authority is required for this game command.");
}

function requirePhase(state, phases, message) {
  if (!phases.includes(state.phase)) throw new Error(message);
}

function activePlayer(state) {
  const player = state.players[state.activePlayerIndex];
  if (!player || player.id !== state.activePlayerId) throw new Error("The active player is invalid.");
  return player;
}

function requireActivePlayerAuthority(state, command, actor) {
  const player = activePlayer(state);
  const permitted = player.control === "host"
    ? actor.isHost
    : actor.principalId === player.id && command.playerId === player.id;
  if (!permitted) throw new Error("It is not this player's turn.");
  return player;
}

function chosenSong(selectSong, state) {
  if (typeof selectSong !== "function") throw new Error("The authoritative song selector is unavailable.");
  const song = selectSong(structuredClone(state));
  if (!song || typeof song !== "object" || typeof song.uri !== "string" || !song.uri
      || typeof song.title !== "string" || typeof song.artist !== "string"
      || !Number.isSafeInteger(song.year) || song.year < state.rules.minYear
      || song.year > state.rules.maxYear || state.usedUris.includes(song.uri)) {
    throw new Error("The authoritative song selector returned an invalid song.");
  }
  state.usedUris.push(song.uri);
  return structuredClone(song);
}

function revealPlacement(state) {
  if (!state.currentSong || state.placement === null) {
    throw new Error("The submitted placement is incomplete.");
  }
  const player = activePlayer(state);
  const previous = player.timeline[state.placement - 1];
  const following = player.timeline[state.placement];
  const correct = (!previous || previous.year <= state.currentSong.year)
    && (!following || state.currentSong.year <= following.year);
  state.result = { correct, index: state.placement };
  if (correct) player.timeline.splice(state.placement, 0, state.currentSong);
  if (player.timeline.length >= state.rules.targetScore) state.winnerId = player.id;
  state.phase = "revealed";
}

function playerName(value) {
  const name = typeof value === "string" ? value.trim().slice(0, 24) : "";
  if (!name) throw new Error("Player name is required.");
  return name;
}

function validSongShape(song) {
  return song && typeof song === "object" && !Array.isArray(song)
    && typeof song.title === "string" && song.title.length > 0
    && typeof song.artist === "string" && song.artist.length > 0
    && Number.isSafeInteger(song.year) && song.year >= 1920 && song.year <= 2026
    && typeof song.uri === "string" && song.uri.length > 0;
}

export function validateRoomState(state) {
  const violations = [];
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    throw new Error("Room state must be an object.");
  }
  if (typeof state.runId !== "string" || !state.runId) violations.push("run ID");
  if (!Number.isSafeInteger(state.runGeneration) || state.runGeneration < 0) violations.push("run generation");
  if (!Number.isSafeInteger(state.revision) || state.revision < 0) violations.push("revision");
  if (typeof state.code !== "string" || !/^[A-Z0-9]{6}$/.test(state.code)) violations.push("lobby code");
  if (!["lobby", "ready", "playing", "placed", "revealed", "finished"].includes(state.phase)) {
    violations.push("phase");
  }
  if (!Array.isArray(state.players)) violations.push("players");
  const players = Array.isArray(state.players) ? state.players : [];
  const playerIds = new Set();
  for (const player of players) {
    if (!player || typeof player !== "object" || typeof player.id !== "string" || !player.id
        || playerIds.has(player.id) || typeof player.name !== "string" || !player.name
        || !["host", "phone"].includes(player.control) || !Array.isArray(player.timeline)
        || !player.timeline.every(validSongShape)) {
      violations.push("player shape");
      break;
    }
    playerIds.add(player.id);
  }
  if (!Number.isSafeInteger(state.activePlayerIndex) || state.activePlayerIndex < 0) {
    violations.push("active player index");
  }
  if (!Number.isSafeInteger(state.round) || state.round < 0) violations.push("round");
  if (state.currentSong !== null && !validSongShape(state.currentSong)) violations.push("current song");
  if (state.placement !== null && (!Number.isSafeInteger(state.placement) || state.placement < 0)) {
    violations.push("placement");
  }
  if (typeof state.retractionUsed !== "boolean") violations.push("retraction flag");
  if (state.result !== null && (!state.result || typeof state.result.correct !== "boolean"
      || !Number.isSafeInteger(state.result.index) || state.result.index < 0)) {
    violations.push("result");
  }
  if (state.winnerId !== null && !playerIds.has(state.winnerId)) violations.push("winner");
  if (!Array.isArray(state.usedUris) || new Set(state.usedUris).size !== state.usedUris.length
      || state.usedUris.some((uri) => typeof uri !== "string" || !uri)) {
    violations.push("used song identities");
  }
  if (JSON.stringify(normalizeRules(state.rules)) !== JSON.stringify(state.rules)) violations.push("rules");
  if (state.phase === "lobby") {
    if (state.activePlayerId !== null || state.round !== 0 || state.currentSong !== null) {
      violations.push("lobby phase relationships");
    }
  } else if (!players.length || !playerIds.has(state.activePlayerId)
      || players[state.activePlayerIndex]?.id !== state.activePlayerId || !state.currentSong
      || state.round < 1) {
    violations.push("active round relationships");
  }
  if (state.phase === "placed" && state.placement === null) violations.push("placed phase");
  if (state.phase === "revealed" && state.result === null) violations.push("revealed phase");
  if (state.phase === "finished" && state.winnerId === null) violations.push("finished phase");
  if (violations.length) throw new Error(`Room state is invalid: ${[...new Set(violations)].join(", ")}.`);
  return state;
}

export function redactRoomStateForRetention(state) {
  const retainedSong = (song, key) => song ? {
    title: "Retained result", artist: "Redacted", year: song.year, uri: `retained:${key}`,
  } : null;
  const redacted = structuredClone(validateRoomState(state));
  redacted.players = redacted.players.map((player, playerIndex) => ({
    ...player, name: `Player ${playerIndex + 1}`,
    timeline: player.timeline.map((song, songIndex) =>
      retainedSong(song, `timeline:${playerIndex}:${songIndex}`)),
  }));
  redacted.currentSong = retainedSong(redacted.currentSong, "current");
  redacted.usedUris = [];
  return validateRoomState(redacted);
}

export function reduceGameCommand({ state, command, actor, selectSong, selectStartingPlayer }) {
  if (!command || typeof command !== "object" || Array.isArray(command)) {
    throw new Error("A typed game command is required.");
  }
  const next = structuredClone(state);
  switch (command.type) {
    case "join_player": {
      if (next.phase !== "lobby") throw new Error("Players are locked after the game starts.");
      if (next.players.some((player) => player.id === actor.principalId)) {
        throw new Error("This principal already controls a player.");
      }
      next.players.push({
        id: actor.principalId,
        name: playerName(command.name),
        control: "phone",
        timeline: [],
      });
      return {
        state: next,
        admitPrincipal: true,
        events: [{ type: "player_joined", outcome: "accepted", actorType: "player", round: next.round }],
      };
    }
    case "add_host_player": {
      requireHost(actor);
      if (next.phase !== "lobby") throw new Error("Players are locked after the game starts.");
      const playerId = randomUUID();
      next.players.push({ id: playerId, name: playerName(command.name), control: "host", timeline: [] });
      return {
        state: next,
        events: [{
          type: "player_joined", outcome: "accepted", actorType: "host",
          round: next.round, detailCode: "host",
        }],
      };
    }
    case "remove_player": {
      requireHost(actor);
      requirePhase(next, ["lobby"], "Players are locked after the game starts.");
      const playerId = typeof command.playerId === "string" ? command.playerId : "";
      if (!next.players.some((player) => player.id === playerId)) throw new Error("Player not found.");
      next.players = next.players.filter((player) => player.id !== playerId);
      return {
        state: next,
        removePrincipalId: playerId,
        events: [{
          type: "player_removed", outcome: "accepted", actorType: "host",
          round: next.round,
        }],
      };
    }
    case "configure_rules": {
      requireHost(actor);
      if (next.phase !== "lobby") throw new Error("Rules are locked after the game starts.");
      next.rules = normalizeRules(command.rules);
      return {
        state: next,
        events: [{ type: "game_configured", outcome: "accepted", actorType: "host", round: next.round }],
      };
    }
    case "start_game": {
      requireHost(actor);
      requirePhase(next, ["lobby"], "The game has already started.");
      if (!next.players.length) throw new Error("At least one player is required.");
      for (const player of next.players) player.timeline = [chosenSong(selectSong, next)];
      const draw = typeof selectStartingPlayer === "function"
        ? selectStartingPlayer(next.players.length) : 0;
      if (!Number.isSafeInteger(draw) || draw < 0 || draw >= next.players.length) {
        throw new Error("The starting player selection is invalid.");
      }
      next.activePlayerIndex = draw;
      next.activePlayerId = next.players[draw].id;
      next.currentSong = chosenSong(selectSong, next);
      next.round = 1;
      next.retractionUsed = false;
      next.phase = "ready";
      return {
        state: next,
        events: [{
          type: "game_started", outcome: "accepted", actorType: "host",
          round: next.round, detailValue: next.players.length,
        }],
      };
    }
    case "begin_round": {
      requireHost(actor);
      requirePhase(next, ["ready"], "The first round is not ready.");
      if (!next.currentSong) throw new Error("The current song is unavailable.");
      next.phase = "playing";
      return {
        state: next,
        effects: [{ type: "request_track", uri: next.currentSong.uri }],
        events: [{
          type: "track_requested", outcome: "accepted", actorType: "host",
          round: next.round, detailCode: "play",
        }],
      };
    }
    case "place_song": {
      requirePhase(next, ["playing"], "There is no active placement.");
      const player = requireActivePlayerAuthority(next, command, actor);
      if (!Number.isSafeInteger(command.index) || command.index < 0
          || command.index > player.timeline.length) {
        throw new Error("Choose a valid timeline position.");
      }
      next.placement = command.index;
      next.phase = "placed";
      return {
        state: next,
        events: [{
          type: "placement_locked", outcome: "accepted",
          actorType: actor.isHost ? "host" : "player",
          round: next.round, detailValue: command.index,
        }],
      };
    }
    case "retract_placement": {
      requirePhase(next, ["placed"], "There is no placement to retract.");
      const player = requireActivePlayerAuthority(next, command, actor);
      if (!next.rules.allowRetraction) throw new Error("Retractions are disabled for this game.");
      if (next.retractionUsed) throw new Error("This round's retraction has already been used.");
      next.placement = null;
      next.retractionUsed = true;
      next.phase = "playing";
      return {
        state: next,
        events: [{
          type: "placement_retracted", outcome: "accepted",
          actorType: actor.isHost ? "host" : "player", round: next.round,
        }],
      };
    }
    case "reveal_answer": {
      requireHost(actor);
      requirePhase(next, ["placed"], "Wait for the active player to lock a placement.");
      revealPlacement(next);
      return {
        state: next,
        events: [{
          type: "answer_revealed", outcome: "accepted", actorType: "host",
          round: next.round, detailCode: next.result.correct ? "correct" : "incorrect",
          detailValue: next.result.index,
        }],
      };
    }
    case "advance_round": {
      requireHost(actor);
      requirePhase(next, ["revealed"], "Reveal this round first.");
      if (next.winnerId) {
        next.phase = "finished";
        return {
          state: next,
          terminalOutcome: "completed",
          events: [{
            type: "game_completed", outcome: "completed", actorType: "host",
            round: next.round,
          }],
        };
      }
      next.activePlayerIndex = (next.activePlayerIndex + 1) % next.players.length;
      next.activePlayerId = next.players[next.activePlayerIndex].id;
      next.currentSong = chosenSong(selectSong, next);
      next.placement = null;
      next.retractionUsed = false;
      next.result = null;
      next.round += 1;
      next.phase = "playing";
      return {
        state: next,
        effects: [{ type: "request_track", uri: next.currentSong.uri }],
        events: [
          { type: "round_advanced", outcome: "accepted", actorType: "host", round: next.round },
          { type: "track_requested", outcome: "accepted", actorType: "host", round: next.round, detailCode: "play" },
        ],
      };
    }
    case "skip_track": {
      requireHost(actor);
      requirePhase(next, ["playing", "placed"], "There is no active song to skip.");
      next.currentSong = chosenSong(selectSong, next);
      next.placement = null;
      next.retractionUsed = false;
      next.result = null;
      next.phase = "playing";
      next.round += 1;
      return {
        state: next,
        effects: [{ type: "request_track", uri: next.currentSong.uri }],
        events: [
          { type: "track_skipped", outcome: "accepted", actorType: "host", round: next.round },
          { type: "track_requested", outcome: "accepted", actorType: "host", round: next.round, detailCode: "play" },
        ],
      };
    }
    case "select_audio": {
      requireHost(actor);
      if (next.phase === "finished") throw new Error("This game has already finished.");
      if (!['local', 'managed'].includes(command.mode)) throw new Error("Audio source is invalid.");
      return {
        state: next,
        effects: [{ type: "select_audio", mode: command.mode }],
        events: [{
          type: "audio_source_selected", outcome: "accepted", actorType: "host",
          round: next.round, detailCode: command.mode,
        }],
      };
    }
    case "release_audio": {
      requireHost(actor);
      if (next.phase === "finished") throw new Error("This game has already finished.");
      return { state: next, effects: [{ type: "release_audio" }], events: [] };
    }
    case "control_audio": {
      requirePhase(next, ["playing", "placed"], "Playback controls are not active for this round.");
      if (!actor.isHost && !actor.isMember) throw new Error("Lobby membership is required.");
      if (!["pause", "resume"].includes(command.kind)) throw new Error("Playback command is invalid.");
      return {
        state: next,
        effects: [{ type: "control_audio", kind: command.kind }],
        events: [],
      };
    }
    case "abandon_game": {
      requireHost(actor);
      if (next.phase === "finished") throw new Error("This game has already finished.");
      return {
        state: next,
        terminalOutcome: "abandoned",
        events: [{ type: "game_abandoned", outcome: "abandoned", actorType: "host", round: next.round }],
      };
    }
    default:
      throw new Error("Game command is not implemented by this state-service generation.");
  }
}

export function projectRoomState(state, { isHost }) {
  const { usedUris: _usedUris, ...projected } = structuredClone(validateRoomState(state));
  void _usedUris;
  if (!isHost && state.phase !== "revealed" && state.phase !== "finished") {
    projected.currentSong = null;
  }
  return { ...projected, isHost: Boolean(isHost) };
}
