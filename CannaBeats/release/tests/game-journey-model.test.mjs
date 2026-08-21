import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import {
  normalizeGameJourneyCommand, projectGameState, reduceGameJourneyCommand,
} from '../../web/lib/server/release/game-journey.mjs';
import { createInitialGameState, normalizeRules } from '../../web/lib/server/release/game-state.mjs';

const catalogVersion = `sha256:${'a'.repeat(64)}`;
const hostId = randomUUID();

function catalog(count = 30, year = null) {
  return new Map(Array.from({ length: count }, (_, index) => {
    const song = {
      artist: `Artist ${index}`, title: `Song ${index}`,
      uri: `spotify:track:${String(index).padStart(22, '0')}`,
      year: year ?? 1920 + index * 3,
    };
    return [song.uri, song];
  }));
}

function harness({ songs = catalog(), rules = {} } = {}) {
  let state = createInitialGameState({
    gameId: randomUUID(), catalogVersion, rules,
  });
  return {
    songs,
    get state() { return state; },
    run(operation, payload = {}, actor = { id: hostId, type: 'host' }, requestId = randomUUID()) {
      const reduced = reduceGameJourneyCommand({
        state, operation, payload, actor, catalogSongs: songs, requestId,
      });
      state = { ...reduced.state, revision: state.revision + 1 };
      return reduced;
    },
  };
}

test('lobby roster operations enforce normalized uniqueness, control, and the fixed total capacity', () => {
  const game = harness();
  const first = randomUUID();
  game.run('add_host_player', { name: 'Host One', playerId: first });
  assert.throws(() => game.run('add_host_player', {
    name: 'host one', playerId: randomUUID(),
  }), /duplicate_name/u);
  assert.throws(() => game.run('remove_host_player', { playerId: first }, {
    id: randomUUID(), type: 'participant',
  }), /unauthorized/u);
  game.run('remove_host_player', { playerId: first });
  assert.equal(game.state.players.length, 0);
  for (let index = 0; index < 8; index += 1) {
    game.run('add_host_player', { name: `Host ${index}`, playerId: randomUUID() });
  }
  assert.throws(() => game.run('add_host_player', {
    name: 'Host 9', playerId: randomUUID(),
  }), /capacity_reached/u);
});

test('start and placement boundaries accept 1/7/8 and 0/length but reject outside values', () => {
  const empty = harness();
  assert.throws(() => empty.run('start_game'), /operation_rejected/u);
  for (const playerCount of [1, 7, 8]) {
    const game = harness();
    for (let index = 0; index < playerCount; index += 1) {
      game.run('add_host_player', { name: `Player ${index + 1}`, playerId: randomUUID() });
    }
    game.run('start_game');
    assert.equal(game.state.players.length, playerCount);
    assert.equal(game.state.usedUris.length, playerCount + 1);
  }

  const placement = harness();
  placement.run('add_host_player', { name: 'Boundary', playerId: randomUUID() });
  placement.run('start_game');
  placement.run('begin_round');
  const prior = structuredClone(placement.state);
  const run = (index) => reduceGameJourneyCommand({
    state: structuredClone(prior), operation: 'place_song', payload: { index },
    actor: { id: hostId, type: 'host' }, catalogSongs: placement.songs,
    requestId: randomUUID(),
  });
  assert.equal(run(0).state.placement, 0);
  assert.equal(run(prior.players[0].timeline.length).state.placement, 1);
  assert.throws(() => run(-1), /operation_rejected/u);
  assert.throws(() => run(prior.players[0].timeline.length + 1), /operation_rejected/u);
});

test('each fixed journey command rejects a wrong authority or phase before mutation', () => {
  const game = harness();
  const playerId = randomUUID();
  game.run('add_host_player', { name: 'Authority', playerId });
  const lobby = structuredClone(game.state);
  const participant = { id: randomUUID(), type: 'participant' };
  const attempt = (state, operation, payload = {}, actor = { id: hostId, type: 'host' }) =>
    reduceGameJourneyCommand({
      state: structuredClone(state), operation, payload, actor,
      catalogSongs: game.songs, requestId: randomUUID(),
    });
  for (const [operation, payload] of [
    ['configure_game', { rules: lobby.rules }],
    ['add_host_player', { name: 'Other', playerId: randomUUID() }],
    ['remove_host_player', { playerId }], ['start_game', {}],
  ]) assert.throws(() => attempt(lobby, operation, payload, participant), /unauthorized/u);
  for (const operation of ['begin_round', 'place_song', 'retract_placement',
    'reveal_answer', 'advance_round', 'skip_track']) {
    const payload = operation === 'place_song' ? { index: 0 } : {};
    assert.throws(() => attempt(lobby, operation, payload), /operation_rejected/u);
  }

  game.run('start_game');
  const ready = structuredClone(game.state);
  assert.throws(() => attempt(ready, 'begin_round', {}, participant), /unauthorized/u);
  for (const [operation, payload] of [
    ['configure_game', { rules: ready.rules }],
    ['add_host_player', { name: 'Late', playerId: randomUUID() }],
    ['remove_host_player', { playerId }], ['start_game', {}],
  ]) assert.throws(() => attempt(ready, operation, payload), /operation_rejected/u);

  game.run('begin_round');
  const playing = structuredClone(game.state);
  assert.throws(() => attempt(playing, 'place_song', { index: 0 }, participant), /unauthorized/u);
  assert.throws(() => attempt(playing, 'skip_track', {}, participant), /unauthorized/u);
  game.run('place_song', { index: 0 });
  const placed = structuredClone(game.state);
  assert.throws(() => attempt(placed, 'retract_placement', {}, participant), /unauthorized/u);
  assert.throws(() => attempt(placed, 'reveal_answer', {}, participant), /unauthorized/u);
  game.run('reveal_answer');
  assert.throws(() => attempt(game.state, 'advance_round', {}, participant), /unauthorized/u);
});

test('catalog and starting-player draws are deterministic, filtered, unique, and exhaustion is atomic', () => {
  const game = harness({ rules: normalizeRules({ minYear: 1950, maxYear: 1980 }) });
  game.run('add_host_player', { name: 'A', playerId: randomUUID() });
  game.run('add_host_player', { name: 'B', playerId: randomUUID() });
  const prior = structuredClone(game.state);
  const requestId = randomUUID();
  const left = reduceGameJourneyCommand({
    state: prior, operation: 'start_game', payload: {},
    actor: { id: hostId, type: 'host' }, catalogSongs: game.songs, requestId,
  });
  const right = reduceGameJourneyCommand({
    state: prior, operation: 'start_game', payload: {},
    actor: { id: hostId, type: 'host' }, catalogSongs: game.songs, requestId,
  });
  assert.deepEqual(left, right);
  assert.equal(left.state.usedUris.length, 3);
  assert.equal(new Set(left.state.usedUris).size, 3);
  assert.equal(left.state.usedUris.every((uri) => {
    const year = game.songs.get(uri).year;
    return year >= 1950 && year <= 1980;
  }), true);

  const exhausted = harness({ songs: catalog(1) });
  exhausted.run('add_host_player', { name: 'Only', playerId: randomUUID() });
  const unchanged = structuredClone(exhausted.state);
  assert.throws(() => exhausted.run('start_game'), /catalog_exhausted/u);
  assert.deepEqual(exhausted.state, unchanged);
});

test('equal-year placement, skip, and disabled retraction preserve the finite phase rules', () => {
  const game = harness({
    songs: catalog(8, 2000), rules: normalizeRules({ allowRetraction: false, targetScore: 3 }),
  });
  const playerId = randomUUID();
  game.run('add_host_player', { name: 'Timeline', playerId });
  game.run('start_game');
  game.run('begin_round');
  game.run('place_song', { index: 0 });
  assert.throws(() => game.run('retract_placement'), /operation_rejected/u);
  game.run('reveal_answer');
  assert.deepEqual(game.state.result, { correct: true, index: 0 });
  game.run('advance_round');
  const beforeSkip = game.state.currentSong.uri;
  game.run('skip_track');
  assert.equal(game.state.phase, 'playing');
  assert.equal(game.state.round, 3);
  assert.notEqual(game.state.currentSong.uri, beforeSkip);
  assert.equal(game.state.placement, null);
});

test('participant projections omit answer keys before reveal and command payloads are exact', () => {
  const game = harness();
  const playerId = randomUUID();
  game.run('add_host_player', { name: 'Host', playerId });
  game.run('start_game');
  for (const key of ['currentSong', 'placement', 'result']) {
    assert.equal(key in projectGameState(game.state, 'participant'), false);
  }
  assert.throws(() => normalizeGameJourneyCommand('place_song', { index: 0, playerId }),
    /invalid_request/u);
  assert.throws(() => normalizeGameJourneyCommand('begin_round', { unexpected: true }),
    /invalid_request/u);
  assert.throws(() => normalizeGameJourneyCommand('unknown', {}), /invalid_request/u);
});
