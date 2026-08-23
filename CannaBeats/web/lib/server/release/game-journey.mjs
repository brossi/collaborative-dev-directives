import { createHash } from 'node:crypto';

import { UUID_PATTERN, canonicalJson } from './canonical.mjs';
import {
  MAX_GAME_PLAYERS, normalizePlayerName, normalizeRules, validateGameState,
} from './game-state.mjs';

export const GAME_JOURNEY_OPERATIONS = Object.freeze([
  'configure_game', 'add_host_player', 'remove_host_player', 'start_game',
  'begin_round', 'place_song', 'retract_placement', 'reveal_answer',
  'advance_round', 'skip_track', 'pause_playback', 'resume_playback',
]);

const OPERATIONS = new Set(GAME_JOURNEY_OPERATIONS);
const ERA_BUCKETS = Object.freeze([
  { id: 'early', min: 1920, max: 1949 },
  { id: 'midcentury', min: 1950, max: 1969 },
  { id: 'classics', min: 1970, max: 1989 },
  { id: 'millennial', min: 1990, max: 2009 },
  { id: 'current', min: 2010, max: 2026 },
]);
const STAGE_AND_SCREEN = new Set([
  'film-soundtracks', 'oscar-songs', 'tony-musicals', 'tv-soundtracks',
]);

function reject(code = 'operation_rejected') {
  throw new Error(code);
}

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}

function emptyPayload(payload) {
  if (!exactKeys(payload, [])) reject('invalid_request');
  return {};
}

export function normalizeGameJourneyCommand(operation, payload) {
  if (!OPERATIONS.has(operation)) reject('invalid_request');
  if (operation === 'configure_game') {
    if (!exactKeys(payload, ['rules'])) reject('invalid_request');
    const rules = normalizeRules(payload.rules);
    if (canonicalJson(rules) !== canonicalJson(payload.rules)) reject('invalid_request');
    return Object.freeze({ operation, payload: { rules } });
  }
  if (operation === 'add_host_player') {
    if (!exactKeys(payload, ['name', 'playerId']) || !UUID_PATTERN.test(payload.playerId)) {
      reject('invalid_request');
    }
    const name = normalizePlayerName(payload.name);
    if (name !== payload.name) reject('invalid_request');
    return Object.freeze({ operation, payload: { name, playerId: payload.playerId } });
  }
  if (operation === 'remove_host_player') {
    if (!exactKeys(payload, ['playerId']) || !UUID_PATTERN.test(payload.playerId)) {
      reject('invalid_request');
    }
    return Object.freeze({ operation, payload: { playerId: payload.playerId } });
  }
  if (operation === 'place_song') {
    if (!exactKeys(payload, ['index']) || !Number.isSafeInteger(payload.index)) {
      reject('invalid_request');
    }
    return Object.freeze({ operation, payload: { index: payload.index } });
  }
  return Object.freeze({ operation, payload: emptyPayload(payload) });
}

function requireHost(actor) {
  if (actor.type !== 'host') reject('unauthorized');
}

function requirePhase(state, phases) {
  if (!phases.includes(state.phase)) reject();
}

function activePlayer(state) {
  const player = state.players[state.activePlayerIndex];
  if (!player || player.id !== state.activePlayerId) reject();
  return player;
}

function requireActivePlayer(state, actor) {
  const player = activePlayer(state);
  const permitted = player.control === 'host'
    ? actor.type === 'host'
    : actor.type === 'participant' && actor.id === player.id;
  if (!permitted) reject('unauthorized');
  return player;
}

function draw(gameId, requestId, purpose) {
  const digest = createHash('sha256').update(
    canonicalJson({ gameId, purpose, requestId }),
  ).digest('hex');
  return Number.parseInt(digest.slice(0, 13), 16) / 0x10_0000_0000_0000;
}

function selectSong(state, catalogSongs, requestId, purpose) {
  const available = [...catalogSongs.values()].filter((song) =>
    !state.usedUris.includes(song.uri)
      && song.year >= state.rules.minYear && song.year <= state.rules.maxYear
      && (state.rules.catalogScope === 'all'
        || song.themes?.some((theme) => STAGE_AND_SCREEN.has(theme))))
    .sort((left, right) => left.uri.localeCompare(right.uri));
  if (!available.length) reject('catalog_exhausted');
  const weighted = ERA_BUCKETS.map((era) => ({
    songs: available.filter((song) => song.year >= era.min && song.year <= era.max),
    weight: state.rules.eraWeights[era.id],
  })).filter(({ songs, weight }) => songs.length > 0 && weight > 0);
  let candidates = available;
  const totalWeight = weighted.reduce((total, { weight }) => total + weight, 0);
  if (totalWeight > 0) {
    let bucketDraw = draw(state.gameId, requestId, `${purpose}:era`) * totalWeight;
    candidates = (weighted.find(({ weight }) => {
      bucketDraw -= weight;
      return bucketDraw < 0;
    }) ?? weighted.at(-1)).songs;
  }
  const song = structuredClone(candidates[Math.floor(
    draw(state.gameId, requestId, `${purpose}:song`) * candidates.length,
  )]);
  state.usedUris.push(song.uri);
  return song;
}

function event(type, detail, outcome = 'accepted') {
  return { detail, outcome, type };
}

function reveal(state) {
  const player = activePlayer(state);
  const previous = player.timeline[state.placement - 1];
  const following = player.timeline[state.placement];
  const correct = (!previous || previous.year <= state.currentSong.year)
    && (!following || state.currentSong.year <= following.year);
  state.result = { correct, index: state.placement };
  if (correct) player.timeline.splice(state.placement, 0, state.currentSong);
  if (player.timeline.length >= state.rules.targetScore) state.winnerId = player.id;
  state.phase = 'revealed';
}

export function reduceGameJourneyCommand({
  state, operation, payload, actor, catalogSongs, requestId,
}) {
  const command = normalizeGameJourneyCommand(operation, payload);
  if (!actor || !['host', 'participant'].includes(actor.type)
      || !UUID_PATTERN.test(actor.id) || !(catalogSongs instanceof Map)
      || !UUID_PATTERN.test(requestId)) reject('invalid_request');
  validateGameState(state, { catalogSongs });
  const next = structuredClone(state);
  let lifecycle = state.phase === 'lobby' ? 'lobby' : 'active';
  let events;

  switch (command.operation) {
    case 'configure_game':
      requireHost(actor); requirePhase(next, ['lobby']);
      next.rules = command.payload.rules;
      events = [event('game_configured', { rules: next.rules })];
      break;
    case 'add_host_player': {
      requireHost(actor); requirePhase(next, ['lobby']);
      if (next.players.length >= MAX_GAME_PLAYERS) reject('capacity_reached');
      if (next.players.some(({ id }) => id === command.payload.playerId)) reject('request_conflict');
      const normalizedName = command.payload.name.toLocaleLowerCase('en-US');
      if (next.players.some(({ name }) => name.toLocaleLowerCase('en-US') === normalizedName)) {
        reject('duplicate_name');
      }
      next.players.push({
        control: 'host', id: command.payload.playerId, name: command.payload.name, timeline: [],
      });
      events = [event('game_configured', {
        change: 'add_host_player', name: command.payload.name,
        playerId: command.payload.playerId,
      })];
      break;
    }
    case 'remove_host_player': {
      requireHost(actor); requirePhase(next, ['lobby']);
      const player = next.players.find(({ id }) => id === command.payload.playerId);
      if (!player || player.control !== 'host') reject();
      next.players = next.players.filter(({ id }) => id !== command.payload.playerId);
      events = [event('game_configured', {
        change: 'remove_host_player', playerId: command.payload.playerId,
      })];
      break;
    }
    case 'start_game': {
      requireHost(actor); requirePhase(next, ['lobby']);
      if (!next.players.length) reject();
      for (let index = 0; index < next.players.length; index += 1) {
        next.players[index].timeline = [selectSong(
          next, catalogSongs, requestId, `initial:${index}`,
        )];
      }
      next.activePlayerIndex = Math.floor(
        draw(next.gameId, requestId, 'starting_player') * next.players.length,
      );
      next.activePlayerId = next.players[next.activePlayerIndex].id;
      next.currentSong = selectSong(next, catalogSongs, requestId, 'round:1');
      next.round = 1;
      next.retractionUsed = false;
      next.phase = 'ready';
      lifecycle = 'active';
      events = [event('game_started', {
        activePlayerId: next.activePlayerId, playerCount: next.players.length,
      })];
      break;
    }
    case 'begin_round':
      requireHost(actor); requirePhase(next, ['ready']);
      next.phase = 'playing';
      events = [event('track_requested', { round: next.round, trackUri: next.currentSong.uri })];
      break;
    case 'place_song': {
      requirePhase(next, ['playing']);
      const player = requireActivePlayer(next, actor);
      if (command.payload.index < 0 || command.payload.index > player.timeline.length) reject();
      next.placement = command.payload.index;
      next.phase = 'placed';
      events = [event('placement_locked', {
        index: next.placement, playerId: player.id, round: next.round,
      })];
      break;
    }
    case 'retract_placement': {
      requirePhase(next, ['placed']);
      const player = requireActivePlayer(next, actor);
      if (!next.rules.allowRetraction || next.retractionUsed) reject();
      next.placement = null;
      next.retractionUsed = true;
      next.phase = 'playing';
      events = [event('placement_retracted', { playerId: player.id, round: next.round })];
      break;
    }
    case 'reveal_answer':
      requireHost(actor); requirePhase(next, ['placed']);
      reveal(next);
      events = [event('answer_revealed', {
        correct: next.result.correct, index: next.result.index, round: next.round,
      })];
      break;
    case 'advance_round':
      requireHost(actor); requirePhase(next, ['revealed']);
      if (next.winnerId !== null) {
        next.phase = 'finished';
        lifecycle = 'completed';
        events = [event('game_completed', {
          round: next.round, winnerId: next.winnerId,
        }, 'completed')];
        break;
      }
      next.activePlayerIndex = (next.activePlayerIndex + 1) % next.players.length;
      next.activePlayerId = next.players[next.activePlayerIndex].id;
      next.placement = null;
      next.retractionUsed = false;
      next.result = null;
      next.round += 1;
      next.currentSong = selectSong(next, catalogSongs, requestId, `round:${next.round}`);
      next.phase = 'playing';
      events = [
        event('round_advanced', { activePlayerId: next.activePlayerId, round: next.round }),
        event('track_requested', { round: next.round, trackUri: next.currentSong.uri }),
      ];
      break;
    case 'skip_track': {
      requireHost(actor); requirePhase(next, ['playing', 'placed']);
      const skippedUri = next.currentSong.uri;
      next.placement = null;
      next.retractionUsed = false;
      next.result = null;
      next.round += 1;
      next.currentSong = selectSong(next, catalogSongs, requestId, `round:${next.round}`);
      next.phase = 'playing';
      events = [
        event('track_skipped', { round: next.round, skippedUri }),
        event('track_requested', { round: next.round, trackUri: next.currentSong.uri }),
      ];
      break;
    }
    case 'pause_playback':
      requireHost(actor); requirePhase(next, ['playing', 'placed', 'revealed']);
      events = [event('playback_requested', { kind: 'pause' })];
      break;
    case 'resume_playback':
      requireHost(actor); requirePhase(next, ['playing', 'placed', 'revealed']);
      events = [event('playback_requested', { kind: 'play' })];
      break;
    default:
      reject('invalid_request');
  }

  validateGameState(next, { catalogSongs, lifecycle });
  return Object.freeze({ events, lifecycle, state: next });
}

export function projectGameState(state, actorType) {
  validateGameState(state);
  if (actorType === 'host') return structuredClone(state);
  if (actorType !== 'participant') reject('invalid_request');
  const revealed = ['revealed', 'finished'].includes(state.phase);
  return {
    activePlayerId: state.activePlayerId,
    catalogVersion: state.catalogVersion,
    gameId: state.gameId,
    phase: state.phase,
    players: structuredClone(state.players),
    retractionUsed: state.retractionUsed,
    revision: state.revision,
    round: state.round,
    rules: structuredClone(state.rules),
    winnerId: state.winnerId,
    ...(revealed ? {
      currentSong: structuredClone(state.currentSong),
      placement: state.placement,
      result: structuredClone(state.result),
    } : {}),
  };
}

export function compactGameResult(state) {
  validateGameState(state, { lifecycle: 'completed' });
  return {
    catalogVersion: state.catalogVersion,
    finalRevision: state.revision,
    gameId: state.gameId,
    players: state.players.map(({ control, id, name, timeline }) => ({
      control, id, name, score: timeline.length,
    })),
    round: state.round,
    rules: structuredClone(state.rules),
    winnerId: state.winnerId,
  };
}
