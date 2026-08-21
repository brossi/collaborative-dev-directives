import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, test } from 'node:test';

import { canonicalJson, sha256 } from '../../web/lib/server/release/canonical.mjs';
import { loadCatalogArtifacts } from '../../web/lib/server/release/catalog.mjs';
import { HOST_LIMITS, hostProofBytes } from '../../web/lib/server/release/host-authority.mjs';
import {
  MAX_PLAYBACK_COMMANDS_PER_GAME, MAX_PLAYBACK_TRANSITIONS_PER_COMMAND,
  appendTrackPlaybackCommand,
} from '../../web/lib/server/release/playback-commands.mjs';
import { RELEASE_SCHEMA_SQL } from '../../web/lib/server/release/schema.mjs';
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
  const root = mkdtempSync(join(tmpdir(), 'cannabeats-fr5-'));
  roots.push(root);
  const path = join(root, 'cannabeats.sqlite3');
  const store = createReleaseStore(path, { catalog, now: 1_000 });
  const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publicKey = keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const enrollmentCode = token();
  const deviceId = randomUUID();
  store.issueEnrollment({ enrollmentCode, requestId: randomUUID(), now: 1_100 });
  store.redeemEnrollment({
    enrollmentCode, requestId: randomUUID(), deviceId, publicKey, label: 'Playback Host',
    now: 1_101,
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
    catalogVersion: catalog.version, rules: { preset: 'family', targetScore: 3 }, now: 2_000,
  });
  const setup = { deviceId, gameId, hostToken, now: 2_100, path, store };
  hostAction(setup, 'add_host_player', { playerId: randomUUID(), name: 'Host Player' });
  hostAction(setup, 'start_game');
  return setup;
}

function hostAction(setup, operation, payload = {}, overrides = {}) {
  setup.now = overrides.now ?? setup.now + 100;
  return setup.store.applyHostGameAction({
    applicationSessionToken: setup.hostToken, gameId: setup.gameId,
    requestId: overrides.requestId ?? randomUUID(),
    expectedRevision: overrides.expectedRevision ?? setup.store.gameSnapshot(setup.gameId).revision,
    operation, payload, now: setup.now,
  });
}

function next(setup, now = setup.now + 1) {
  return setup.store.nextPlaybackCommand({
    applicationSessionToken: setup.hostToken, gameId: setup.gameId, now,
  });
}

function transition(setup, commandId, claimGeneration, targetState, {
  outcome = null, outcomeHash = null, reasonCode = null, now = setup.now + 1,
} = {}) {
  return setup.store.transitionPlaybackCommand({
    applicationSessionToken: setup.hostToken, gameId: setup.gameId, commandId,
    claimGeneration, targetState, outcome, outcomeHash, reasonCode, now,
  });
}

function restart(setup) {
  setup.store.close();
  setup.store = createReleaseStore(setup.path, { catalog });
}

function placementIndex(state) {
  const timeline = state.players[state.activePlayerIndex].timeline;
  const index = timeline.findIndex(({ year }) => year > state.currentSong.year);
  return index === -1 ? timeline.length : index;
}

function mutateWithoutTrigger(database, triggerName, work) {
  const definition = database.prepare(`SELECT sql FROM sqlite_schema
    WHERE type='trigger' AND name=?`).get(triggerName)?.sql;
  assert.ok(definition);
  database.exec(`DROP TRIGGER ${triggerName}`);
  try { work(); } finally { database.exec(definition); }
}

test('each retained track request atomically creates one command and a newer track supersedes it', () => {
  const setup = setupGame();
  const requestId = randomUUID();
  const begun = hostAction(setup, 'begin_round', {}, { requestId });
  const first = next(setup);
  assert.equal(first.code, 'command');
  assert.equal(first.command.state, 'queued');
  assert.equal(first.command.trackUri, begun.state.currentSong.uri);
  assert.deepEqual(hostAction(setup, 'begin_round', {}, {
    requestId, expectedRevision: begun.revision - 1, now: setup.now,
  }), begun);
  assert.equal(next(setup).command.commandId, first.command.commandId);

  hostAction(setup, 'place_song', { index: 0 });
  hostAction(setup, 'reveal_answer');
  const advanced = hostAction(setup, 'advance_round');
  const second = next(setup);
  assert.notEqual(second.command.commandId, first.command.commandId);
  assert.equal(second.command.trackUri, advanced.state.currentSong.uri);

  setup.store.close();
  const database = new DatabaseSync(setup.path);
  const commands = database.prepare(`SELECT command_id,state FROM playback_commands
    ORDER BY created_at`).all();
  assert.deepEqual(commands.map(({ state }) => state), ['cancelled', 'queued']);
  assert.equal(database.prepare(`SELECT reason_code FROM playback_command_transitions
    WHERE command_id=? ORDER BY sequence DESC LIMIT 1`).get(commands[0].command_id).reason_code,
  'superseded');
  database.close();
});

test('claim response loss replays exactly and explicit takeover fences every unseen old outcome', () => {
  const setup = setupGame();
  hostAction(setup, 'begin_round');
  const command = next(setup).command;
  const oldGeneration = randomUUID();
  const claimed = transition(setup, command.commandId, oldGeneration, 'claimed');
  assert.equal(claimed.reconcileRequired, false);
  assert.deepEqual(transition(setup, command.commandId, oldGeneration, 'claimed'), claimed);
  transition(setup, command.commandId, oldGeneration, 'executing');
  transition(setup, command.commandId, oldGeneration, 'outcome_unknown', {
    reasonCode: 'response_lost',
  });

  const newGeneration = randomUUID();
  const takeover = transition(setup, command.commandId, newGeneration, 'claimed');
  assert.equal(takeover.reconcileRequired, true);
  expectCode(() => transition(setup, command.commandId, oldGeneration, 'completed', {
    outcome: { playerState: 'playing', positionMilliseconds: 1_000, trackUri: command.trackUri },
    outcomeHash: sha256(canonicalJson({
      playerState: 'playing', positionMilliseconds: 1_000, trackUri: command.trackUri,
    })),
  }), 'stale_claim');
  const outcome = {
    playerState: 'playing', positionMilliseconds: 1_000, trackUri: command.trackUri,
  };
  const hash = sha256(canonicalJson(outcome));
  const wrongTrack = {
    playerState: 'playing', positionMilliseconds: 1_000,
    trackUri: 'spotify:track:AAAAAAAAAAAAAAAAAAAAAA',
  };
  expectCode(() => transition(setup, command.commandId, newGeneration, 'completed', {
    outcome: wrongTrack, outcomeHash: sha256(canonicalJson(wrongTrack)),
  }), 'invalid_request');
  expectCode(() => transition(setup, command.commandId, newGeneration, 'completed', {
    outcome, outcomeHash: '0'.repeat(64),
  }), 'invalid_request');
  const completed = transition(setup, command.commandId, newGeneration, 'completed', {
    outcome, outcomeHash: hash,
  });
  assert.equal(completed.command.state, 'completed');
  assert.deepEqual(transition(setup, command.commandId, newGeneration, 'completed', {
    outcome, outcomeHash: hash,
  }), completed);
  expectCode(() => transition(setup, command.commandId, newGeneration, 'completed', {
    outcome, outcomeHash: '0'.repeat(64),
  }), 'request_conflict');
  assert.deepEqual(next(setup), { code: 'idle' });
});

test('one foreground generation claims sequential commands without cross-command conflict', () => {
  const setup = setupGame();
  hostAction(setup, 'begin_round');
  const generation = randomUUID();
  const first = next(setup).command;
  transition(setup, first.commandId, generation, 'claimed');
  const firstOutcome = {
    playerState: 'playing', positionMilliseconds: 1_000, trackUri: first.trackUri,
  };
  transition(setup, first.commandId, generation, 'completed', {
    outcome: firstOutcome, outcomeHash: sha256(canonicalJson(firstOutcome)),
  });
  hostAction(setup, 'place_song', {
    index: placementIndex(setup.store.gameSnapshot(setup.gameId).state),
  });
  hostAction(setup, 'reveal_answer');
  hostAction(setup, 'advance_round');
  const second = next(setup).command;
  assert.notEqual(second.commandId, first.commandId);
  assert.equal(transition(setup, second.commandId, generation, 'claimed').command.state, 'claimed');
  restart(setup);
  assert.equal(setup.store.readiness().ready, true);
});

test('an ambiguous Apple Event blocks supersession until retained readback reconciles it', () => {
  const setup = setupGame();
  hostAction(setup, 'begin_round');
  const command = next(setup).command;
  const generation = randomUUID();
  transition(setup, command.commandId, generation, 'claimed');
  transition(setup, command.commandId, generation, 'executing');
  transition(setup, command.commandId, generation, 'outcome_unknown', {
    reasonCode: 'command_timeout',
  });
  const before = setup.store.gameSnapshot(setup.gameId);
  expectCode(() => hostAction(setup, 'skip_track'), 'operation_rejected');
  assert.deepEqual(setup.store.gameSnapshot(setup.gameId), before);
  assert.equal(next(setup).command.commandId, command.commandId);

  const outcome = {
    playerState: 'playing', positionMilliseconds: 1_000, trackUri: command.trackUri,
  };
  transition(setup, command.commandId, generation, 'completed', {
    outcome, outcomeHash: sha256(canonicalJson(outcome)),
  });
  const skipped = hostAction(setup, 'skip_track');
  assert.equal(next(setup).command.trackUri, skipped.state.currentSong.uri);
});

test('exact retained transition replay precedes Host expiry while unseen work remains unauthorized', () => {
  const setup = setupGame();
  hostAction(setup, 'begin_round');
  const command = next(setup).command;
  const generation = randomUUID();
  const claimed = transition(setup, command.commandId, generation, 'claimed');
  const expiredAt = 1_201 + HOST_LIMITS.applicationSessionTtl;
  assert.deepEqual(transition(setup, command.commandId, generation, 'claimed', {
    now: expiredAt,
  }), claimed);
  expectCode(() => transition(setup, command.commandId, generation, 'executing', {
    now: expiredAt,
  }), 'unauthorized');
  expectCode(() => next(setup, expiredAt), 'unauthorized');
});

test('explicit game termination cancels the open command and survives restart', () => {
  const setup = setupGame();
  hostAction(setup, 'begin_round');
  const command = next(setup).command;
  const terminated = setup.store.terminateGame({
    applicationSessionToken: setup.hostToken, gameId: setup.gameId,
    requestId: randomUUID(), expectedRevision: setup.store.gameSnapshot(setup.gameId).revision,
    now: setup.now + 100,
  });
  assert.equal(terminated.value.code, 'game_terminated');
  assert.deepEqual(next(setup, setup.now + 101), { code: 'idle' });
  restart(setup);
  assert.equal(setup.store.readiness().ready, true);
  setup.store.close();
  const database = new DatabaseSync(setup.path);
  assert.deepEqual({ ...database.prepare(`SELECT state FROM playback_commands
    WHERE command_id=?`).get(command.commandId) }, { state: 'cancelled' });
  assert.equal(database.prepare(`SELECT reason_code FROM playback_command_transitions
    WHERE command_id=? ORDER BY sequence DESC LIMIT 1`).get(command.commandId).reason_code,
  'game_ended');
  database.close();
});

test('ordinary game completion cancels the final open playback command in its transaction', () => {
  const setup = setupGame();
  hostAction(setup, 'begin_round');
  hostAction(setup, 'place_song', { index: placementIndex(setup.store.gameSnapshot(setup.gameId).state) });
  hostAction(setup, 'reveal_answer');
  hostAction(setup, 'advance_round');
  const finalCommand = next(setup).command;
  hostAction(setup, 'place_song', { index: placementIndex(setup.store.gameSnapshot(setup.gameId).state) });
  hostAction(setup, 'reveal_answer');
  const completed = hostAction(setup, 'advance_round');
  assert.equal(completed.state.phase, 'finished');
  assert.deepEqual(next(setup), { code: 'idle' });
  setup.store.close();
  const database = new DatabaseSync(setup.path);
  const terminal = database.prepare(`SELECT terminal_at FROM games WHERE game_id=?`).get(setup.gameId);
  const cancellation = database.prepare(`SELECT reason_code,occurred_at
    FROM playback_command_transitions WHERE command_id=? ORDER BY sequence DESC LIMIT 1`)
    .get(finalCommand.commandId);
  assert.deepEqual({ ...cancellation }, { reason_code: 'game_ended', occurred_at: terminal.terminal_at });
  database.close();
});

test('the transition reserve rejects another open edge but retains the final terminal edge', () => {
  const setup = setupGame();
  hostAction(setup, 'begin_round');
  const command = next(setup).command;
  const generations = Array.from({ length: 4 }, () => randomUUID());
  transition(setup, command.commandId, generations[0], 'claimed');
  transition(setup, command.commandId, generations[0], 'executing');
  transition(setup, command.commandId, generations[0], 'outcome_unknown', {
    reasonCode: 'command_timeout',
  });
  transition(setup, command.commandId, generations[1], 'claimed');
  transition(setup, command.commandId, generations[1], 'executing');
  transition(setup, command.commandId, generations[1], 'outcome_unknown', {
    reasonCode: 'response_lost',
  });
  expectCode(() => transition(setup, command.commandId, generations[2], 'claimed'),
    'transition_capacity');
  const failed = transition(setup, command.commandId, generations[1], 'failed', {
    reasonCode: 'unrecognized',
  });
  assert.equal(failed.transition.sequence, MAX_PLAYBACK_TRANSITIONS_PER_COMMAND);
  assert.equal(failed.command.state, 'failed');
});

test('restart rejects gap, head, desired-track, generation, outcome, and cancellation-cause corruption', () => {
  const corruptions = [
    ['transition gap', (database, command) => mutateWithoutTrigger(
      database, 'playback_transitions_immutable_update',
      () => database.prepare(`UPDATE playback_command_transitions SET sequence=3
        WHERE command_id=? AND sequence=2`).run(command.commandId),
    )],
    ['head mismatch', (database, command) => database.prepare(`UPDATE playback_commands
      SET state='executing', execution_ambiguous=1 WHERE command_id=?`).run(command.commandId)],
    ['ambiguity head mismatch', (database, command) => database.prepare(`UPDATE playback_commands
      SET execution_ambiguous=1 WHERE command_id=?`).run(command.commandId)],
    ['desired track mismatch', (database, command) => mutateWithoutTrigger(
      database, 'playback_commands_identity_immutable',
      () => database.prepare(`UPDATE playback_commands
        SET track_uri='spotify:track:AAAAAAAAAAAAAAAAAAAAAA' WHERE command_id=?`)
        .run(command.commandId),
    )],
    ['generation mismatch', (database, command) => mutateWithoutTrigger(
      database, 'playback_transitions_immutable_update',
      () => database.prepare(`UPDATE playback_command_transitions SET claim_generation=?
        WHERE command_id=? AND sequence=2`).run(randomUUID(), command.commandId),
    )],
    ['outcome mismatch', (database, command) => mutateWithoutTrigger(
      database, 'playback_transitions_immutable_update',
      () => database.prepare(`UPDATE playback_command_transitions
        SET outcome=json_set(outcome,'$.positionMilliseconds',9999)
        WHERE command_id=? AND to_state='completed'`).run(command.commandId),
    )],
    ['cancellation cause mismatch', (database, command) => mutateWithoutTrigger(
      database, 'playback_transitions_immutable_update',
      () => database.prepare(`UPDATE playback_command_transitions SET reason_code='game_ended'
        WHERE command_id=? AND to_state='cancelled'`).run(command.commandId),
    )],
  ];
  for (const [name, corrupt] of corruptions) {
    const setup = setupGame();
    hostAction(setup, 'begin_round');
    const command = next(setup).command;
    const generation = randomUUID();
    transition(setup, command.commandId, generation, 'claimed');
    if (name === 'outcome mismatch') {
      const outcome = {
        playerState: 'playing', positionMilliseconds: 1_000, trackUri: command.trackUri,
      };
      transition(setup, command.commandId, generation, 'completed', {
        outcome, outcomeHash: sha256(canonicalJson(outcome)),
      });
    }
    if (name === 'cancellation cause mismatch') {
      hostAction(setup, 'skip_track');
    }
    setup.store.close();
    const database = new DatabaseSync(setup.path);
    corrupt(database, command);
    database.close();
    expectCode(() => createReleaseStore(setup.path, { catalog }), 'database_corrupt');
  }
});

test('restart binds supersession to the immediate successor and rejects forged terminal causality', () => {
  const setup = setupGame();
  hostAction(setup, 'begin_round');
  const first = next(setup).command;
  hostAction(setup, 'skip_track');
  setup.store.terminateGame({
    applicationSessionToken: setup.hostToken, gameId: setup.gameId,
    requestId: randomUUID(), expectedRevision: setup.store.gameSnapshot(setup.gameId).revision,
    now: setup.now + 100,
  });
  setup.store.close();
  const database = new DatabaseSync(setup.path);
  const terminalAt = database.prepare(`SELECT terminal_at FROM games WHERE game_id=?`)
    .get(setup.gameId).terminal_at;
  mutateWithoutTrigger(database, 'playback_transitions_immutable_update', () => {
    database.prepare(`UPDATE playback_command_transitions
      SET reason_code='game_ended',occurred_at=?
      WHERE command_id=? AND to_state='cancelled'`).run(terminalAt, first.commandId);
  });
  database.prepare(`UPDATE playback_commands SET updated_at=? WHERE command_id=?`)
    .run(terminalAt, first.commandId);
  database.close();
  expectCode(() => createReleaseStore(setup.path, { catalog }), 'database_corrupt');
});

test('retained command capacity accepts max-minus-one and max but atomically rejects max-plus-one', () => {
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys=OFF');
  database.exec(RELEASE_SCHEMA_SQL);
  const gameId = randomUUID();
  const actorId = randomUUID();
  const catalogVersion = `sha256:${'0'.repeat(64)}`;
  database.prepare(`INSERT INTO games
    (game_id,host_device_id,catalog_version,lifecycle,state,revision,created_at,updated_at)
    VALUES (?,?,?,'active','{}',0,1,1)`).run(gameId, actorId, catalogVersion);
  const insertEvent = database.prepare(`INSERT INTO game_events
    (game_id,sequence,revision,event_type,outcome,actor_type,actor_id,request_id,detail,occurred_at)
    VALUES (?, ?,0,'track_requested','accepted','host',?,?,?,?)`);
  let lastRequestId;
  for (let index = 0; index < MAX_PLAYBACK_COMMANDS_PER_GAME; index += 1) {
    const requestId = randomUUID();
    const now = index + 2;
    const trackUri = `spotify:track:${String(index).padStart(22, '0')}`;
    insertEvent.run(gameId, index + 1, actorId, requestId, canonicalJson({ trackUri }), now);
    appendTrackPlaybackCommand(database, { gameId, requestId, trackUri, now });
    if (index === MAX_PLAYBACK_COMMANDS_PER_GAME - 2) {
      assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM playback_commands`).get().count,
        MAX_PLAYBACK_COMMANDS_PER_GAME - 1);
    }
    lastRequestId = requestId;
  }
  assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM playback_commands`).get().count,
    MAX_PLAYBACK_COMMANDS_PER_GAME);
  assert.equal(database.prepare(`SELECT state FROM playback_commands WHERE request_id=?`)
    .get(lastRequestId).state, 'queued');

  database.exec('BEGIN IMMEDIATE');
  const overflowRequestId = randomUUID();
  try {
    insertEvent.run(gameId, MAX_PLAYBACK_COMMANDS_PER_GAME + 1, actorId, overflowRequestId,
      canonicalJson({ trackUri: 'spotify:track:AAAAAAAAAAAAAAAAAAAAAA' }),
      MAX_PLAYBACK_COMMANDS_PER_GAME + 2);
    assert.throws(() => appendTrackPlaybackCommand(database, {
      gameId, requestId: overflowRequestId,
      trackUri: 'spotify:track:AAAAAAAAAAAAAAAAAAAAAA',
      now: MAX_PLAYBACK_COMMANDS_PER_GAME + 2,
    }), /playback_capacity/u);
  } finally {
    database.exec('ROLLBACK');
  }
  assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM game_events`).get().count,
    MAX_PLAYBACK_COMMANDS_PER_GAME);
  assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM playback_commands`).get().count,
    MAX_PLAYBACK_COMMANDS_PER_GAME);
  database.close();
});
