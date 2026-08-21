import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, test } from 'node:test';

import {
  MAX_AUDIO_SESSIONS_PER_GAME, MAX_AUDIO_TRANSITIONS_PER_SESSION,
} from '../../web/lib/server/release/audio-sessions.mjs';
import { loadCatalogArtifacts } from '../../web/lib/server/release/catalog.mjs';
import { hostProofBytes } from '../../web/lib/server/release/host-authority.mjs';
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

function setupGame({ participant = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cannabeats-fr6-'));
  roots.push(root);
  const path = join(root, 'cannabeats.sqlite3');
  const store = createReleaseStore(path, { catalog, now: 1_000 });
  const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publicKey = keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const deviceId = randomUUID();
  const enrollmentCode = token();
  store.issueEnrollment({ enrollmentCode, requestId: randomUUID(), now: 1_100 });
  store.redeemEnrollment({
    enrollmentCode, requestId: randomUUID(), deviceId, publicKey,
    label: 'Audio Host', now: 1_101,
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
    catalogVersion: catalog.version, rules: { preset: 'family' }, now: 2_000,
  });
  const setup = { deviceId, gameId, hostToken, now: 2_100, path, store };
  if (participant) {
    const inviteToken = token();
    store.issueGameInvitation({
      applicationSessionToken: hostToken, gameId, inviteToken, requestId: randomUUID(),
      expectedRevision: store.gameSnapshot(gameId).revision, now: 2_010,
    });
    setup.participantId = randomUUID();
    setup.participantToken = token();
    store.admitParticipant({
      gameId, inviteToken, participantId: setup.participantId,
      sessionToken: setup.participantToken, displayName: 'Listener',
      requestId: randomUUID(), now: 2_020,
    });
  }
  hostAction(setup, 'add_host_player', { playerId: randomUUID(), name: 'Host' });
  hostAction(setup, 'start_game');
  return setup;
}

function hostAction(setup, operation, payload = {}) {
  setup.now += 100;
  return setup.store.applyHostGameAction({
    applicationSessionToken: setup.hostToken, gameId: setup.gameId,
    requestId: randomUUID(), expectedRevision: setup.store.gameSnapshot(setup.gameId).revision,
    operation, payload, now: setup.now,
  });
}

function open(setup, { audioSessionId = randomUUID(), requestId = randomUUID() } = {}) {
  setup.now += 1;
  const input = {
    applicationSessionToken: setup.hostToken, gameId: setup.gameId,
    audioSessionId, requestId, now: setup.now,
  };
  return { input, result: setup.store.openAudioSession(input) };
}

function connect(setup, audioSessionId, connectionId = randomUUID()) {
  setup.now += 1;
  setup.store.claimAudioIngest({
    applicationSessionToken: setup.hostToken, gameId: setup.gameId,
    audioSessionId, connectionId, now: setup.now,
  });
  setup.now += 1;
  const result = setup.store.activateAudioIngest({
    applicationSessionToken: setup.hostToken, gameId: setup.gameId,
    audioSessionId, connectionId, now: setup.now,
  });
  return { connectionId, result };
}

function interrupt(setup, audioSessionId, connectionId, reasonCode = 'ingest_lost') {
  setup.now += 1;
  return setup.store.interruptAudioIngest({
    gameId: setup.gameId, audioSessionId, connectionId, reasonCode, now: setup.now,
  });
}

function restart(setup, now = setup.now + 100) {
  setup.store.close();
  setup.now = now;
  setup.store = createReleaseStore(setup.path, { catalog, now });
}

test('audio session identity replays exactly while conflicts, one-open, and generation order fail closed', () => {
  const setup = setupGame();
  const first = open(setup);
  assert.equal(first.result.session.generation, 1);
  assert.deepEqual(setup.store.openAudioSession(first.input), first.result);
  expectCode(() => setup.store.openAudioSession({
    ...first.input, audioSessionId: randomUUID(),
  }), 'request_conflict');
  expectCode(() => setup.store.openAudioSession({
    ...first.input, requestId: randomUUID(),
  }), 'request_conflict');
  expectCode(() => open(setup), 'audio_session_open');

  const active = connect(setup, first.input.audioSessionId);
  assert.deepEqual(setup.store.openAudioSession(first.input), first.result);
  interrupt(setup, first.input.audioSessionId, active.connectionId);
  assert.deepEqual(setup.store.openAudioSession(first.input), first.result);
  restart(setup);
  assert.deepEqual(setup.store.openAudioSession(first.input), first.result);

  const endInput = {
    applicationSessionToken: setup.hostToken, gameId: setup.gameId,
    audioSessionId: first.input.audioSessionId, requestId: randomUUID(), now: setup.now + 1,
  };
  const ended = setup.store.endAudioSession(endInput);
  assert.equal(ended.session.state, 'ended');
  assert.deepEqual(setup.store.endAudioSession(endInput), ended);
  assert.deepEqual(setup.store.openAudioSession(first.input), first.result);
  const second = open(setup);
  assert.equal(second.result.session.generation, 2);
  setup.store.revokeHostDevice({
    applicationSessionToken: setup.hostToken, targetDeviceId: setup.deviceId,
    requestId: randomUUID(), now: ++setup.now,
  });
  assert.deepEqual(setup.store.openAudioSession(first.input), first.result);
  setup.store.close();
});

test('only the current connection and admitted game members can cross the active stream boundary', () => {
  const setup = setupGame({ participant: true });
  const session = open(setup).result.session;
  expectCode(() => setup.store.authorizeAudioParticipantStream({
    participantSessionToken: setup.participantToken, gameId: setup.gameId,
    audioSessionId: session.audioSessionId, now: setup.now + 1,
  }), 'unauthorized');
  const firstConnection = randomUUID();
  setup.store.claimAudioIngest({
    applicationSessionToken: setup.hostToken, gameId: setup.gameId,
    audioSessionId: session.audioSessionId, connectionId: firstConnection,
    now: ++setup.now,
  });
  expectCode(() => setup.store.activateAudioIngest({
    applicationSessionToken: setup.hostToken, gameId: setup.gameId,
    audioSessionId: session.audioSessionId, connectionId: randomUUID(),
    now: setup.now + 1,
  }), 'stale_generation');
  setup.store.activateAudioIngest({
    applicationSessionToken: setup.hostToken, gameId: setup.gameId,
    audioSessionId: session.audioSessionId, connectionId: firstConnection,
    now: ++setup.now,
  });
  assert.deepEqual(setup.store.participantSnapshot({
    token: setup.participantToken, gameId: setup.gameId, now: setup.now + 1,
  }).audio, {
    audioSessionId: session.audioSessionId, generation: 1, state: 'active',
  });
  assert.deepEqual(setup.store.hostGameSnapshot({
    applicationSessionToken: setup.hostToken, gameId: setup.gameId, now: setup.now + 1,
  }).audio, {
    audioSessionId: session.audioSessionId, generation: 1, state: 'active',
  });
  assert.deepEqual(setup.store.recoverHostGame({
    applicationSessionToken: setup.hostToken, now: setup.now + 1,
  }).game.audio, {
    audioSessionId: session.audioSessionId, generation: 1, state: 'active',
  });
  assert.equal(setup.store.authorizeAudioParticipantStream({
    participantSessionToken: setup.participantToken, gameId: setup.gameId,
    audioSessionId: session.audioSessionId, now: setup.now + 1,
  }).generation, 1);
  assert.equal(setup.store.authorizeAudioHostStream({
    applicationSessionToken: setup.hostToken, gameId: setup.gameId,
    audioSessionId: session.audioSessionId, connectionId: firstConnection,
    requireActive: true, now: setup.now + 1,
  }).state, 'active');
  assert.equal(interrupt(setup, session.audioSessionId, randomUUID()).code, 'stale');
  assert.equal(interrupt(setup, session.audioSessionId, firstConnection).code, 'interrupted');
  assert.equal(setup.store.participantSnapshot({
    token: setup.participantToken, gameId: setup.gameId, now: setup.now + 1,
  }).audio, null);
  assert.equal(interrupt(setup, session.audioSessionId, randomUUID()).code, 'stale');
  expectCode(() => setup.store.authorizeAudioParticipantStream({
    participantSessionToken: setup.participantToken, gameId: setup.gameId,
    audioSessionId: session.audioSessionId, now: setup.now + 1,
  }), 'unauthorized');
  const secondConnection = connect(setup, session.audioSessionId).connectionId;
  assert.equal(interrupt(setup, session.audioSessionId, firstConnection).code, 'stale');
  assert.equal(setup.store.authorizeAudioHostStream({
    applicationSessionToken: setup.hostToken, gameId: setup.gameId,
    audioSessionId: session.audioSessionId, connectionId: secondConnection,
    requireActive: true, now: setup.now + 1,
  }).connectionId, secondConnection);
  setup.store.close();
});

test('process restart interrupts the retained generation before it can authorize another listener', () => {
  const setup = setupGame({ participant: true });
  const session = open(setup).result.session;
  connect(setup, session.audioSessionId);
  restart(setup);
  assert.equal(setup.store.currentAudioSession({
    applicationSessionToken: setup.hostToken, gameId: setup.gameId, now: setup.now + 1,
  }).session.state, 'interrupted');
  expectCode(() => setup.store.authorizeAudioParticipantStream({
    participantSessionToken: setup.participantToken, gameId: setup.gameId,
    audioSessionId: session.audioSessionId, now: setup.now + 1,
  }), 'unauthorized');
  const recovered = connect(setup, session.audioSessionId);
  assert.equal(recovered.result.session.generation, 1);
  setup.store.close();
  const database = new DatabaseSync(setup.path);
  assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM audio_session_transitions
    WHERE audio_session_id=? AND reason_code='process_restart'`).get(
    session.audioSessionId,
  ).count, 1);
  database.close();
});

test('playback execution is fenced until audio is active and is fenced again after interruption', () => {
  const setup = setupGame();
  hostAction(setup, 'begin_round');
  const command = setup.store.nextPlaybackCommand({
    applicationSessionToken: setup.hostToken, gameId: setup.gameId, now: setup.now + 1,
  }).command;
  const claimGeneration = randomUUID();
  expectCode(() => setup.store.transitionPlaybackCommand({
    applicationSessionToken: setup.hostToken, gameId: setup.gameId,
    commandId: command.commandId, claimGeneration, targetState: 'claimed', now: setup.now + 1,
  }), 'audio_not_ready');
  const session = open(setup).result.session;
  const connection = connect(setup, session.audioSessionId);
  setup.store.transitionPlaybackCommand({
    applicationSessionToken: setup.hostToken, gameId: setup.gameId,
    commandId: command.commandId, claimGeneration, targetState: 'claimed', now: ++setup.now,
  });
  interrupt(setup, session.audioSessionId, connection.connectionId);
  expectCode(() => setup.store.transitionPlaybackCommand({
    applicationSessionToken: setup.hostToken, gameId: setup.gameId,
    commandId: command.commandId, claimGeneration, targetState: 'executing', now: setup.now + 1,
  }), 'audio_not_ready');
  setup.store.close();
});

test('game termination atomically ends its audio generation and removes listener authority', () => {
  const setup = setupGame({ participant: true });
  const session = open(setup).result.session;
  connect(setup, session.audioSessionId);
  const terminalAt = setup.now + 10;
  setup.store.terminateGame({
    applicationSessionToken: setup.hostToken, gameId: setup.gameId,
    requestId: randomUUID(), expectedRevision: setup.store.gameSnapshot(setup.gameId).revision,
    now: terminalAt,
  });
  expectCode(() => setup.store.authorizeAudioParticipantStream({
    participantSessionToken: setup.participantToken, gameId: setup.gameId,
    audioSessionId: session.audioSessionId, now: terminalAt + 1,
  }), 'unauthorized');
  setup.store.close();
  const database = new DatabaseSync(setup.path);
  assert.deepEqual({ ...database.prepare(`SELECT state,ended_at FROM audio_sessions
    WHERE audio_session_id=?`).get(session.audioSessionId) }, {
    state: 'ended', ended_at: terminalAt,
  });
  assert.equal(database.prepare(`SELECT reason_code FROM audio_session_transitions
    WHERE audio_session_id=? ORDER BY sequence DESC LIMIT 1`).get(
    session.audioSessionId,
  ).reason_code, 'game_ended');
  database.close();
});

test('Host-device revocation ends every open generation owned by that device', () => {
  const setup = setupGame({ participant: true });
  const session = open(setup).result.session;
  connect(setup, session.audioSessionId);
  const revokedAt = setup.now + 10;
  setup.store.revokeHostDevice({
    applicationSessionToken: setup.hostToken, targetDeviceId: setup.deviceId,
    requestId: randomUUID(), now: revokedAt,
  });
  expectCode(() => setup.store.authorizeAudioParticipantStream({
    participantSessionToken: setup.participantToken, gameId: setup.gameId,
    audioSessionId: session.audioSessionId, now: revokedAt + 1,
  }), 'unauthorized');
  setup.store.close();
  const database = new DatabaseSync(setup.path);
  assert.deepEqual({ ...database.prepare(`SELECT state,ended_at FROM audio_sessions
    WHERE audio_session_id=?`).get(session.audioSessionId) }, {
    state: 'ended', ended_at: revokedAt,
  });
  assert.equal(database.prepare(`SELECT reason_code FROM audio_session_transitions
    WHERE audio_session_id=? ORDER BY sequence DESC LIMIT 1`).get(
    session.audioSessionId,
  ).reason_code, 'host_revoked');
  database.close();
});

test('transition capacity preserves its terminal reserve and ends an exhausted recovery generation', () => {
  const setup = setupGame();
  const session = open(setup).result.session;
  let final;
  while (true) {
    const connection = connect(setup, session.audioSessionId);
    final = interrupt(setup, session.audioSessionId, connection.connectionId);
    if (final.code === 'ended') break;
  }
  assert.equal(final.session.state, 'ended');
  setup.store.close();
  const database = new DatabaseSync(setup.path);
  assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM audio_session_transitions
    WHERE audio_session_id=?`).get(session.audioSessionId).count,
  MAX_AUDIO_TRANSITIONS_PER_SESSION);
  assert.equal(database.prepare(`SELECT reason_code FROM audio_session_transitions
    WHERE audio_session_id=? ORDER BY sequence DESC LIMIT 1`).get(
    session.audioSessionId,
  ).reason_code, 'recovery_exhausted');
  database.close();
});

test('retained session capacity accepts max-minus-one and max but rejects max-plus-one', () => {
  const setup = setupGame();
  setup.store.close();
  const database = new DatabaseSync(setup.path);
  const insertSession = database.prepare(`INSERT INTO audio_sessions
    (audio_session_id,game_id,request_id,generation,state,created_at,updated_at,ended_at)
    VALUES (?,?,?,?,'ended',?,?,?)`);
  const insertStart = database.prepare(`INSERT INTO audio_session_transitions
    (audio_session_id,sequence,from_state,to_state,request_id,occurred_at)
    VALUES (?,1,NULL,'starting',?,?)`);
  const insertEnd = database.prepare(`INSERT INTO audio_session_transitions
    (audio_session_id,sequence,from_state,to_state,request_id,reason_code,occurred_at)
    VALUES (?,2,'starting','ended',?,'host_stopped',?)`);
  database.exec('BEGIN');
  for (let generation = 1; generation < MAX_AUDIO_SESSIONS_PER_GAME; generation += 1) {
    const audioSessionId = randomUUID();
    const requestId = randomUUID();
    const createdAt = 3_000 + generation * 2;
    insertSession.run(audioSessionId, setup.gameId, requestId, generation,
      createdAt, createdAt + 1, createdAt + 1);
    insertStart.run(audioSessionId, requestId, createdAt);
    insertEnd.run(audioSessionId, randomUUID(), createdAt + 1);
  }
  database.exec('COMMIT');
  database.close();
  setup.now = 5_000;
  setup.store = createReleaseStore(setup.path, { catalog, now: setup.now });
  const maximum = open(setup);
  assert.equal(maximum.result.session.generation, MAX_AUDIO_SESSIONS_PER_GAME);
  setup.store.endAudioSession({
    applicationSessionToken: setup.hostToken, gameId: setup.gameId,
    audioSessionId: maximum.result.session.audioSessionId,
    requestId: randomUUID(), now: ++setup.now,
  });
  expectCode(() => open(setup), 'audio_capacity');
  setup.store.close();
});

test('restart rejects transition gaps, forged heads, generation gaps, and reordered time', () => {
  const mutations = [
    (database, session) => {
      const trigger = database.prepare(`SELECT sql FROM sqlite_schema
        WHERE type='trigger' AND name='audio_session_transitions_immutable_delete'`).get().sql;
      database.exec('DROP TRIGGER audio_session_transitions_immutable_delete');
      database.prepare(`DELETE FROM audio_session_transitions
        WHERE audio_session_id=? AND sequence=2`).run(session.audioSessionId);
      database.exec(trigger);
    },
    (database, session) => database.prepare(`UPDATE audio_sessions
      SET state='interrupted',connection_id=NULL WHERE audio_session_id=?`).run(
      session.audioSessionId,
    ),
    (database, session) => {
      const trigger = database.prepare(`SELECT sql FROM sqlite_schema
        WHERE type='trigger' AND name='audio_sessions_identity_immutable'`).get().sql;
      database.exec('DROP TRIGGER audio_sessions_identity_immutable');
      database.prepare(`UPDATE audio_sessions SET generation=2
        WHERE audio_session_id=?`).run(session.audioSessionId);
      database.exec(trigger);
    },
    (database, session) => {
      const trigger = database.prepare(`SELECT sql FROM sqlite_schema
        WHERE type='trigger' AND name='audio_session_transitions_immutable_update'`).get().sql;
      database.exec('DROP TRIGGER audio_session_transitions_immutable_update');
      database.prepare(`UPDATE audio_session_transitions SET occurred_at=1
        WHERE audio_session_id=? AND sequence=3`).run(session.audioSessionId);
      database.exec(trigger);
    },
  ];
  for (const mutate of mutations) {
    const setup = setupGame();
    const session = open(setup).result.session;
    connect(setup, session.audioSessionId);
    setup.store.close();
    const database = new DatabaseSync(setup.path);
    mutate(database, session);
    database.close();
    expectCode(() => createReleaseStore(setup.path, { catalog, now: 5_000 }),
      'database_corrupt');
  }
});

test('restart rejects runtime-impossible recovery exhaustion and Host revocation causes', () => {
  {
    const setup = setupGame();
    const session = open(setup).result.session;
    setup.store.close();
    const database = new DatabaseSync(setup.path);
    const endedAt = setup.now + 10;
    database.prepare(`INSERT INTO audio_session_transitions
      (audio_session_id,sequence,from_state,to_state,reason_code,occurred_at)
      VALUES (?,2,'starting','ended','recovery_exhausted',?)`).run(
      session.audioSessionId, endedAt,
    );
    database.prepare(`UPDATE audio_sessions SET state='ended',updated_at=?,ended_at=?
      WHERE audio_session_id=?`).run(endedAt, endedAt, session.audioSessionId);
    database.close();
    expectCode(() => createReleaseStore(setup.path, { catalog, now: endedAt + 1 }),
      'database_corrupt');
  }
  {
    const setup = setupGame();
    const session = open(setup).result.session;
    const revokedAt = setup.now + 10;
    setup.store.revokeHostDevice({
      applicationSessionToken: setup.hostToken, targetDeviceId: setup.deviceId,
      requestId: randomUUID(), now: revokedAt,
    });
    setup.store.close();
    const database = new DatabaseSync(setup.path);
    const trigger = database.prepare(`SELECT sql FROM sqlite_schema
      WHERE type='trigger' AND name='audio_session_transitions_immutable_update'`).get().sql;
    database.exec('DROP TRIGGER audio_session_transitions_immutable_update');
    database.prepare(`UPDATE audio_session_transitions SET occurred_at=?
      WHERE audio_session_id=? AND reason_code='host_revoked'`).run(
      revokedAt + 1, session.audioSessionId,
    );
    database.exec(trigger);
    database.prepare(`UPDATE audio_sessions SET updated_at=?,ended_at=?
      WHERE audio_session_id=?`).run(revokedAt + 1, revokedAt + 1, session.audioSessionId);
    database.close();
    expectCode(() => createReleaseStore(setup.path, { catalog, now: revokedAt + 2 }),
      'database_corrupt');
  }
});
