import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, test } from 'node:test';

import { loadCatalogArtifacts } from '../../web/lib/server/release/catalog.mjs';
import { hostProofBytes } from '../../web/lib/server/release/host-authority.mjs';
import { canonicalJson } from '../../web/lib/server/release/canonical.mjs';
import { ReleaseStoreError, createReleaseStore } from '../../web/lib/server/release/store.mjs';

const roots = [];
const catalog = loadCatalogArtifacts({
  catalogPath: new URL('../../web/data/catalog.json', import.meta.url),
  manifestPath: new URL('../../web/data/catalog-manifest.json', import.meta.url),
});

afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

function token() { return randomBytes(24).toString('base64url'); }
function expectCode(work, code) {
  assert.throws(work, (error) => error instanceof ReleaseStoreError && error.code === code);
}

function setupGame() {
  const root = mkdtempSync(join(tmpdir(), 'cannabeats-fr4-'));
  roots.push(root);
  const path = join(root, 'cannabeats.sqlite3');
  const store = createReleaseStore(path, { catalog, now: 1_000 });
  const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publicKey = keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const enrollmentCode = token();
  const deviceId = randomUUID();
  store.issueEnrollment({ enrollmentCode, requestId: randomUUID(), now: 1_100 });
  store.redeemEnrollment({
    enrollmentCode, requestId: randomUUID(), deviceId, publicKey, label: 'Game Host', now: 1_101,
  });
  const challenge = token();
  store.issueHostChallenge({ deviceId, challenge, requestId: randomUUID(), now: 1_200 });
  const hostToken = token();
  store.proveHostChallenge({
    deviceId, challenge, sessionToken: hostToken, requestId: randomUUID(), now: 1_201,
    signature: sign('sha256', hostProofBytes({
      challenge, deviceId, origin: 'https://play.cannabeats.social',
    }), keys.privateKey).toString('base64'),
  });
  const gameId = randomUUID();
  store.createAuthorizedGame({
    applicationSessionToken: hostToken, gameId, requestId: randomUUID(),
    catalogVersion: catalog.version,
    rules: { preset: 'family', targetScore: 3 }, now: 2_000,
  });
  const inviteToken = token();
  store.issueGameInvitation({
    applicationSessionToken: hostToken, gameId, inviteToken, requestId: randomUUID(),
    expectedRevision: 0, now: 2_100,
  });
  const participantId = randomUUID();
  const participantToken = token();
  store.admitParticipant({
    gameId, inviteToken, participantId, sessionToken: participantToken,
    displayName: 'Listener', requestId: randomUUID(), now: 2_200,
  });
  return { root, path, store, deviceId, hostToken, gameId, participantId, participantToken };
}

function hostAction(setup, operation, payload = {}, overrides = {}) {
  return setup.store.applyHostGameAction({
    applicationSessionToken: setup.hostToken, gameId: setup.gameId,
    requestId: overrides.requestId ?? randomUUID(),
    expectedRevision: overrides.expectedRevision
      ?? setup.store.gameSnapshot(setup.gameId).revision,
    operation, payload, now: overrides.now ?? 3_000,
  });
}

function participantAction(setup, operation, payload = {}, overrides = {}) {
  return setup.store.applyParticipantGameAction({
    participantSessionToken: setup.participantToken, gameId: setup.gameId,
    requestId: overrides.requestId ?? randomUUID(),
    expectedRevision: overrides.expectedRevision
      ?? setup.store.gameSnapshot(setup.gameId).revision,
    operation, payload, now: overrides.now ?? 3_000,
  });
}

function restart(setup) {
  setup.store.close();
  setup.store = createReleaseStore(setup.path, { catalog });
}

function withoutTrigger(database, name, work) {
  const definition = database.prepare(`SELECT sql FROM sqlite_schema
    WHERE type='trigger' AND name=?`).get(name)?.sql;
  assert.ok(definition);
  database.exec(`DROP TRIGGER ${name}`);
  try { work(); } finally { database.exec(definition); }
}

function chronologicalPlacement(state) {
  const timeline = state.players[state.activePlayerIndex].timeline;
  const index = timeline.findIndex(({ year }) => year > state.currentSong.year);
  return index === -1 ? timeline.length : index;
}

test('the fixed journey completes, projects safely, survives restart, and replays completion once', () => {
  const setup = setupGame();
  const start = hostAction(setup, 'start_game');
  assert.equal(start.state.phase, 'ready');
  assert.equal(start.state.activePlayerId, setup.participantId);
  const hidden = setup.store.participantSnapshot({
    token: setup.participantToken, gameId: setup.gameId, now: 86_400_000 * 20,
  });
  for (const key of ['currentSong', 'placement', 'result']) assert.equal(key in hidden.state, false);
  assert.equal(JSON.stringify(hidden).includes(start.state.currentSong.title), false);
  restart(setup);
  hostAction(setup, 'begin_round');
  restart(setup);
  expectCode(() => hostAction(setup, 'place_song', { index: 0 }), 'unauthorized');
  let full = setup.store.hostGameSnapshot({
    applicationSessionToken: setup.hostToken, gameId: setup.gameId, now: 3_001,
  }).state;
  let placed = participantAction(setup, 'place_song', { index: chronologicalPlacement(full) });
  assert.equal('currentSong' in placed.state, false);
  restart(setup);
  participantAction(setup, 'retract_placement');
  restart(setup);
  expectCode(() => participantAction(setup, 'retract_placement'), 'operation_rejected');
  full = setup.store.gameSnapshot(setup.gameId).state;
  participantAction(setup, 'place_song', { index: chronologicalPlacement(full) });
  restart(setup);
  hostAction(setup, 'reveal_answer');
  assert.equal(setup.store.participantSnapshot({
    token: setup.participantToken, gameId: setup.gameId, now: 3_002,
  }).state.result.correct, true);
  restart(setup);
  hostAction(setup, 'advance_round');
  restart(setup);
  full = setup.store.gameSnapshot(setup.gameId).state;
  participantAction(setup, 'place_song', { index: chronologicalPlacement(full) });
  restart(setup);
  hostAction(setup, 'reveal_answer');
  restart(setup);
  const completionRequest = randomUUID();
  const expectedRevision = setup.store.gameSnapshot(setup.gameId).revision;
  const completed = hostAction(setup, 'advance_round', {}, {
    requestId: completionRequest, expectedRevision, now: 4_000,
  });
  assert.equal(completed.state.phase, 'finished');
  assert.equal(completed.state.winnerId, setup.participantId);
  assert.deepEqual(hostAction(setup, 'advance_round', {}, {
    requestId: completionRequest, expectedRevision, now: 4_000,
  }), completed);
  expectCode(() => participantAction(setup, 'place_song', { index: 0 }), 'unauthorized');
  setup.store.close();

  const database = new DatabaseSync(setup.path, { readOnly: true });
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM game_results').get().count, 1);
  assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM action_receipts
    WHERE request_id=?`).get(completionRequest).count, 1);
  assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM game_events
    WHERE event_type='game_completed'`).get().count, 1);
  database.close();
  setup.store = createReleaseStore(setup.path, { catalog });
  assert.equal(setup.store.gameSnapshot(setup.gameId).lifecycle, 'completed');
  setup.store.close();
});

test('conflict precedes current state and two commands at one revision advance only once', () => {
  const setup = setupGame();
  const requestId = randomUUID();
  const expectedRevision = setup.store.gameSnapshot(setup.gameId).revision;
  const first = hostAction(setup, 'configure_game', {
    rules: setup.store.gameSnapshot(setup.gameId).state.rules,
  }, { requestId, expectedRevision, now: 3_000 });
  assert.deepEqual(hostAction(setup, 'configure_game', {
    rules: setup.store.gameSnapshot(setup.gameId).state.rules,
  }, { requestId, expectedRevision, now: 3_000 }), first);
  expectCode(() => hostAction(setup, 'start_game', {}, {
    requestId, expectedRevision: 999, now: 3_001,
  }), 'request_conflict');
  expectCode(() => hostAction(setup, 'start_game', {}, {
    expectedRevision, now: 3_001,
  }), 'stale_state');
  assert.equal(setup.store.gameSnapshot(setup.gameId).revision, expectedRevision + 1);
  setup.store.close();
});

test('an exchanged HttpOnly Host web session owns the same game without exposing the application bearer', () => {
  const setup = setupGame();
  const webToken = token();
  setup.store.issueHostWebTicket({
    applicationSessionToken: setup.hostToken, ticket: webToken,
    requestId: randomUUID(), now: 2_300,
  });
  setup.store.exchangeHostWebTicket({ ticket: webToken, now: 2_301 });
  const rules = setup.store.gameSnapshot(setup.gameId).state.rules;
  const result = setup.store.applyHostGameAction({
    hostSessionToken: webToken, hostSessionKind: 'web', gameId: setup.gameId,
    requestId: randomUUID(), expectedRevision: setup.store.gameSnapshot(setup.gameId).revision,
    operation: 'configure_game', payload: { rules }, now: 2_302,
  });
  assert.equal(result.code, 'accepted');
  assert.equal(result.state.revision, 3);
  setup.store.close();
});

test('Host-controlled players share the eight-player game capacity and close admission causally', () => {
  const setup = setupGame();
  const hostPlayers = [];
  for (let index = 0; index < 7; index += 1) {
    const playerId = randomUUID();
    hostPlayers.push(playerId);
    hostAction(setup, 'add_host_player', { name: `Local ${index + 1}`, playerId }, {
      now: 3_000 + index,
    });
  }
  assert.equal(setup.store.gameSnapshot(setup.gameId).state.players.length, 8);
  expectCode(() => setup.store.issueGameInvitation({
    applicationSessionToken: setup.hostToken, gameId: setup.gameId, inviteToken: token(),
    requestId: randomUUID(), expectedRevision: setup.store.gameSnapshot(setup.gameId).revision,
    now: 3_100,
  }), 'capacity_reached');
  hostAction(setup, 'remove_host_player', { playerId: hostPlayers[0] }, { now: 3_101 });
  const replacement = setup.store.issueGameInvitation({
    applicationSessionToken: setup.hostToken, gameId: setup.gameId, inviteToken: token(),
    requestId: randomUUID(), expectedRevision: setup.store.gameSnapshot(setup.gameId).revision,
    now: 3_102,
  });
  assert.equal(replacement.value.code, 'invitation_issued');
  setup.store.close();
  setup.store = createReleaseStore(setup.path, { catalog });
  assert.equal(setup.store.gameSnapshot(setup.gameId).state.players.length, 7);
  setup.store.close();
});

test('restart rejects a valid-looking deterministic draw substitution in an intermediate receipt', () => {
  const setup = setupGame();
  const start = hostAction(setup, 'start_game');
  hostAction(setup, 'begin_round');
  setup.store.close();
  const database = new DatabaseSync(setup.path);
  const row = database.prepare(`SELECT request_id,result FROM action_receipts
    WHERE game_id=? AND operation='start_game'`).get(setup.gameId);
  const result = JSON.parse(row.result);
  const replacement = catalog.songs.find(({ uri, year }) =>
    !result.state.usedUris.includes(uri)
      && year >= result.state.rules.minYear && year <= result.state.rules.maxYear);
  assert.ok(replacement);
  const oldUri = result.state.currentSong.uri;
  result.state.currentSong = replacement;
  result.state.usedUris = result.state.usedUris.map((uri) => uri === oldUri ? replacement.uri : uri);
  withoutTrigger(database, 'action_receipts_immutable_update', () => {
    database.prepare(`UPDATE action_receipts SET result=?
      WHERE game_id=? AND request_id=?`).run(canonicalJson(result), setup.gameId, row.request_id);
  });
  database.close();
  expectCode(() => createReleaseStore(setup.path, { catalog }), 'database_corrupt');
  assert.notEqual(start.state.currentSong.uri, replacement.uri);
});

test('restart rejects a compact terminal result that remains valid JSON but changes one score', () => {
  const setup = setupGame();
  hostAction(setup, 'start_game');
  hostAction(setup, 'begin_round');
  for (let round = 0; round < 2; round += 1) {
    const state = setup.store.gameSnapshot(setup.gameId).state;
    participantAction(setup, 'place_song', { index: chronologicalPlacement(state) });
    hostAction(setup, 'reveal_answer');
    hostAction(setup, 'advance_round');
  }
  setup.store.close();
  const database = new DatabaseSync(setup.path);
  const row = database.prepare('SELECT result_id,projection FROM game_results WHERE game_id=?')
    .get(setup.gameId);
  const projection = JSON.parse(row.projection);
  projection.players[0].score += 1;
  withoutTrigger(database, 'game_results_immutable_update', () => {
    database.prepare('UPDATE game_results SET projection=? WHERE result_id=?')
      .run(canonicalJson(projection), row.result_id);
  });
  database.close();
  expectCode(() => createReleaseStore(setup.path, { catalog }), 'database_corrupt');
});

test('completion result identity remains game-scoped when two games reuse one request UUID', () => {
  const setup = setupGame();
  const completionRequest = randomUUID();
  let clock = 3_000;
  const complete = () => {
    hostAction(setup, 'start_game', {}, { now: clock += 1 });
    hostAction(setup, 'begin_round', {}, { now: clock += 1 });
    while (true) {
      const state = setup.store.gameSnapshot(setup.gameId).state;
      const payload = { index: chronologicalPlacement(state) };
      if (state.players[state.activePlayerIndex].control === 'phone') {
        participantAction(setup, 'place_song', payload, { now: clock += 1 });
      } else hostAction(setup, 'place_song', payload, { now: clock += 1 });
      const revealed = hostAction(setup, 'reveal_answer', {}, { now: clock += 1 });
      if (revealed.state.winnerId) {
        hostAction(setup, 'advance_round', {}, {
          requestId: completionRequest, now: clock += 1,
        });
        return;
      }
      hostAction(setup, 'advance_round', {}, { now: clock += 1 });
    }
  };
  const firstGameId = setup.gameId;
  complete();

  const secondGameId = randomUUID();
  setup.store.createAuthorizedGame({
    applicationSessionToken: setup.hostToken, gameId: secondGameId,
    requestId: randomUUID(), catalogVersion: catalog.version,
    rules: { preset: 'family', targetScore: 3 }, now: 5_000,
  });
  setup.gameId = secondGameId;
  clock = 6_000;
  hostAction(setup, 'add_host_player', {
    name: 'Second Game', playerId: randomUUID(),
  }, { now: clock += 1 });
  complete();
  setup.store.close();

  const database = new DatabaseSync(setup.path, { readOnly: true });
  const results = database.prepare(`SELECT result_id,game_id FROM game_results
    ORDER BY game_id`).all().map((row) => ({ ...row }));
  assert.deepEqual(results, [firstGameId, secondGameId].sort().map((gameId) => ({
    result_id: gameId, game_id: gameId,
  })));
  assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM action_receipts
    WHERE request_id=?`).get(completionRequest).count, 2);
  database.close();

  const corrupted = new DatabaseSync(setup.path);
  withoutTrigger(corrupted, 'game_results_immutable_update', () => {
    corrupted.prepare('UPDATE game_results SET result_id=? WHERE game_id=?')
      .run(randomUUID(), firstGameId);
  });
  corrupted.close();
  expectCode(() => createReleaseStore(setup.path, { catalog }), 'database_corrupt');
});
