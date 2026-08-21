import { CATALOG_VERSION_PATTERN, assertUuid, canonicalJson } from './canonical.mjs';

export const DEFAULT_RULES = Object.freeze({
  preset: 'family',
  minYear: 1920,
  maxYear: 2026,
  eraWeights: Object.freeze({ early: 5, midcentury: 10, classics: 25, millennial: 30, current: 30 }),
  targetScore: 10,
  allowRetraction: true,
  catalogScope: 'all',
});

const STATE_KEYS = Object.freeze([
  'activePlayerId', 'activePlayerIndex', 'catalogVersion', 'currentSong', 'gameId',
  'phase', 'placement', 'players', 'result', 'retractionUsed', 'revision', 'round',
  'rules', 'schemaVersion', 'usedUris', 'winnerId',
].sort());

function boundedInteger(value, fallback, minimum, maximum) {
  return Number.isSafeInteger(value) ? Math.min(maximum, Math.max(minimum, value)) : fallback;
}

export function normalizeRules(value) {
  const candidate = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const minimum = boundedInteger(candidate.minYear, DEFAULT_RULES.minYear, 1920, 2026);
  const weights = candidate.eraWeights && typeof candidate.eraWeights === 'object'
    && !Array.isArray(candidate.eraWeights) ? candidate.eraWeights : {};
  return {
    allowRetraction: candidate.allowRetraction !== false,
    catalogScope: candidate.catalogScope === 'broadway-tv-movies'
      ? 'broadway-tv-movies' : 'all',
    eraWeights: Object.fromEntries(Object.entries(DEFAULT_RULES.eraWeights).map(([key, fallback]) => [
      key, boundedInteger(weights[key], fallback, 0, 100),
    ])),
    maxYear: boundedInteger(candidate.maxYear, DEFAULT_RULES.maxYear, minimum, 2026),
    minYear: minimum,
    preset: ['family', 'all-eras', 'modern', 'younger', 'broadway-tv-movies', 'custom']
      .includes(candidate.preset) ? candidate.preset : 'custom',
    targetScore: boundedInteger(candidate.targetScore, DEFAULT_RULES.targetScore, 3, 20),
  };
}

function validSong(song, rules, catalogSongs) {
  const keys = song && typeof song === 'object' && !Array.isArray(song)
    ? Object.keys(song).sort() : [];
  const allowed = new Set(['artist', 'releaseYear', 'themes', 'title', 'uri', 'year']);
  return song && typeof song === 'object' && !Array.isArray(song)
    && keys.every((key) => allowed.has(key))
    && typeof song.title === 'string' && song.title.length > 0
    && typeof song.artist === 'string' && song.artist.length > 0
    && Number.isSafeInteger(song.year) && song.year >= rules.minYear && song.year <= rules.maxYear
    && typeof song.uri === 'string' && /^spotify:track:[0-9A-Za-z]{22}$/u.test(song.uri)
    && (song.releaseYear === undefined || (Number.isSafeInteger(song.releaseYear)
      && song.releaseYear >= 1870 && song.releaseYear <= 2100))
    && (song.themes === undefined || (Array.isArray(song.themes)
      && new Set(song.themes).size === song.themes.length
      && song.themes.every((theme) => typeof theme === 'string' && theme.length > 0)))
    && (catalogSongs === undefined || (catalogSongs.has(song.uri)
      && canonicalJson(catalogSongs.get(song.uri)) === canonicalJson(song)));
}

export function createInitialGameState({ gameId, catalogVersion, rules = DEFAULT_RULES }) {
  assertUuid(gameId, 'invalid_game_id');
  if (!CATALOG_VERSION_PATTERN.test(catalogVersion)) throw new Error('invalid_catalog_version');
  return {
    activePlayerId: null,
    activePlayerIndex: 0,
    catalogVersion,
    currentSong: null,
    gameId,
    phase: 'lobby',
    placement: null,
    players: [],
    result: null,
    retractionUsed: false,
    revision: 0,
    round: 0,
    rules: normalizeRules(rules),
    schemaVersion: 1,
    usedUris: [],
    winnerId: null,
  };
}

export function validateGameState(state, {
  gameId, catalogVersion, revision, lifecycle, requireCanonicalText, catalogSongs,
} = {}) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('invalid_game_state');
  if (Object.keys(state).sort().join('\0') !== STATE_KEYS.join('\0')) throw new Error('invalid_game_state');
  assertUuid(state.gameId, 'invalid_game_state');
  if (gameId !== undefined && state.gameId !== gameId) throw new Error('invalid_game_state');
  if (!CATALOG_VERSION_PATTERN.test(state.catalogVersion)
      || (catalogVersion !== undefined && state.catalogVersion !== catalogVersion)
      || state.schemaVersion !== 1 || !Number.isSafeInteger(state.revision) || state.revision < 0
      || (revision !== undefined && state.revision !== revision)
      || !['lobby', 'ready', 'playing', 'placed', 'revealed', 'finished'].includes(state.phase)
      || !Array.isArray(state.players) || !Number.isSafeInteger(state.activePlayerIndex)
      || state.activePlayerIndex < 0 || !Number.isSafeInteger(state.round) || state.round < 0
      || typeof state.retractionUsed !== 'boolean' || !Array.isArray(state.usedUris)) {
    throw new Error('invalid_game_state');
  }
  const normalized = normalizeRules(state.rules);
  if (canonicalJson(normalized) !== canonicalJson(state.rules)) throw new Error('invalid_game_state');
  const playerIds = new Set();
  const retainedSongUris = [];
  for (const player of state.players) {
    if (!player || typeof player !== 'object' || Array.isArray(player)
        || Object.keys(player).sort().join('\0') !== ['control', 'id', 'name', 'timeline'].join('\0')
        || !/^.{1,24}$/u.test(player.name) || !['host', 'phone'].includes(player.control)
        || !Array.isArray(player.timeline)
        || !player.timeline.every((song) => validSong(song, normalized, catalogSongs))) {
      throw new Error('invalid_game_state');
    }
    assertUuid(player.id, 'invalid_game_state');
    if (playerIds.has(player.id)) throw new Error('invalid_game_state');
    playerIds.add(player.id);
    retainedSongUris.push(...player.timeline.map(({ uri }) => uri));
  }
  if (new Set(state.usedUris).size !== state.usedUris.length
      || state.usedUris.some((uri) => typeof uri !== 'string'
        || !/^spotify:track:[0-9A-Za-z]{22}$/u.test(uri)
        || (catalogSongs !== undefined && !catalogSongs.has(uri)))) {
    throw new Error('invalid_game_state');
  }
  if (state.currentSong !== null && !validSong(state.currentSong, normalized, catalogSongs)) {
    throw new Error('invalid_game_state');
  }
  if (state.currentSong) retainedSongUris.push(state.currentSong.uri);
  if (new Set(retainedSongUris).size !== retainedSongUris.length
      || retainedSongUris.some((uri) => !state.usedUris.includes(uri))) {
    throw new Error('invalid_game_state');
  }
  if (state.placement !== null && (!Number.isSafeInteger(state.placement) || state.placement < 0)) {
    throw new Error('invalid_game_state');
  }
  if (state.result !== null && (!state.result || typeof state.result !== 'object'
      || Object.keys(state.result).sort().join('\0') !== ['correct', 'index'].join('\0')
      || typeof state.result.correct !== 'boolean' || !Number.isSafeInteger(state.result.index)
      || state.result.index < 0)) throw new Error('invalid_game_state');
  if (state.winnerId !== null && !playerIds.has(state.winnerId)) throw new Error('invalid_game_state');

  if (state.phase === 'lobby') {
    if (state.activePlayerId !== null || state.activePlayerIndex !== 0
        || state.round !== 0 || state.currentSong !== null
        || state.placement !== null || state.result !== null || state.winnerId !== null) {
      throw new Error('invalid_game_state');
    }
  } else {
    if (!state.players.length || !playerIds.has(state.activePlayerId)
        || state.players[state.activePlayerIndex]?.id !== state.activePlayerId
        || !state.currentSong || state.round < 1) throw new Error('invalid_game_state');
    if (state.phase === 'playing' && (state.placement !== null || state.result !== null)) {
      throw new Error('invalid_game_state');
    }
    if (state.phase === 'placed' && (state.placement === null || state.result !== null)) {
      throw new Error('invalid_game_state');
    }
    if (['revealed', 'finished'].includes(state.phase)
        && (state.placement === null || state.result === null)) throw new Error('invalid_game_state');
    if (state.phase === 'finished' && state.winnerId === null) throw new Error('invalid_game_state');
  }
  if (lifecycle === 'lobby' && state.phase !== 'lobby') throw new Error('invalid_game_state');
  if (lifecycle === 'active' && !['ready', 'playing', 'placed', 'revealed'].includes(state.phase)) {
    throw new Error('invalid_game_state');
  }
  if (lifecycle === 'completed' && state.phase !== 'finished') throw new Error('invalid_game_state');
  if (lifecycle === 'abandoned' && state.phase === 'finished') throw new Error('invalid_game_state');
  if (requireCanonicalText !== undefined && canonicalJson(state) !== requireCanonicalText) {
    throw new Error('invalid_game_state');
  }
  return state;
}
