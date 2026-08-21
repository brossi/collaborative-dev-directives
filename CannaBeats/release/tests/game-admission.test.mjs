import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, test } from 'node:test';

import { loadCatalogArtifacts } from '../../web/lib/server/release/catalog.mjs';
import { canonicalJson, sha256 } from '../../web/lib/server/release/canonical.mjs';
import { ADMISSION_LIMITS } from '../../web/lib/server/release/game-admission.mjs';
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

function bearer() { return randomBytes(24).toString('base64url'); }
function expectCode(work, code) {
  assert.throws(work, (error) => error instanceof ReleaseStoreError && error.code === code);
}

function setupGame() {
  const root = mkdtempSync(join(tmpdir(), 'cannabeats-fr3-'));
  roots.push(root);
  const path = join(root, 'cannabeats.sqlite3');
  const store = createReleaseStore(path, { catalog, now: 1_000 });
  const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publicKey = keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const enrollmentCode = bearer();
  const deviceId = randomUUID();
  store.issueEnrollment({ enrollmentCode, requestId: randomUUID(), now: 1_100 });
  store.redeemEnrollment({
    enrollmentCode, requestId: randomUUID(), deviceId, publicKey, label: 'Game Host', now: 1_101,
  });
  const challenge = bearer();
  store.issueHostChallenge({ deviceId, challenge, requestId: randomUUID(), now: 1_200 });
  const hostToken = bearer();
  store.proveHostChallenge({
    deviceId, challenge, sessionToken: hostToken, requestId: randomUUID(), now: 1_201,
    signature: sign('sha256', hostProofBytes({
      challenge, deviceId, origin: 'https://play.cannabeats.social',
    }), keys.privateKey).toString('base64'),
  });
  const gameId = randomUUID();
  const createAction = {
    applicationSessionToken: hostToken, gameId, requestId: randomUUID(),
    catalogVersion: catalog.version, rules: { preset: 'family' }, now: 2_000,
  };
  const created = store.createAuthorizedGame(createAction);
  return { root, path, store, deviceId, hostToken, gameId, createAction, created };
}

function issueInvite(setup, now = 3_000) {
  const inviteToken = bearer();
  const action = {
    applicationSessionToken: setup.hostToken, gameId: setup.gameId, inviteToken,
    requestId: randomUUID(), expectedRevision: setup.store.gameSnapshot(setup.gameId).revision, now,
  };
  return { inviteToken, action, result: setup.store.issueGameInvitation(action) };
}

function participantAction(setup, inviteToken, name, now) {
  const participantId = randomUUID();
  const sessionToken = bearer();
  const action = {
    gameId: setup.gameId, inviteToken, participantId, sessionToken, displayName: name,
    requestId: randomUUID(), now,
  };
  return { participantId, sessionToken, action };
}

function joinParticipant(setup, inviteToken, name, now) {
  const pending = participantAction(setup, inviteToken, name, now);
  const { action } = pending;
  return { ...pending, result: setup.store.admitParticipant(action) };
}

function withoutTriggers(database, names, work) {
  const definitions = names.map((name) => database.prepare(`SELECT sql FROM sqlite_schema
    WHERE type='trigger' AND name=?`).get(name)?.sql);
  assert.equal(definitions.every(Boolean), true);
  for (const name of names) database.exec(`DROP TRIGGER ${name}`);
  try { work(); } finally {
    for (const definition of definitions) database.exec(definition);
  }
}

test('Host creation, hashed invitation, admission, refresh, and restart retain one seat', () => {
  const setup = setupGame();
  assert.equal(setup.created.code, 'created');
  const invite = issueInvite(setup);
  assert.equal(invite.result.value.code, 'invitation_issued');
  assert.deepEqual(setup.store.issueGameInvitation(invite.action), invite.result);
  const joined = joinParticipant(setup, invite.inviteToken, '  Family   Player  ', 3_100);
  assert.equal(joined.result.value.code, 'participant_admitted');
  assert.deepEqual(setup.store.admitParticipant(joined.action), joined.result);
  const snapshot = setup.store.participantSnapshot({
    token: joined.sessionToken, gameId: setup.gameId, now: 3_200,
  });
  assert.equal(snapshot.participantId, joined.participantId);
  assert.equal(snapshot.state.players[0].name, 'Family Player');
  assert.equal('currentSong' in snapshot.state, false);
  setup.store.close();
  const reopened = createReleaseStore(setup.path, { catalog });
  assert.equal(reopened.participantSnapshot({
    token: joined.sessionToken, gameId: setup.gameId, now: 3_201,
  }).participantId, joined.participantId);
  reopened.close();
});

test('invitation expiry uses before, equality, and after boundaries while participant authority follows the game lifecycle', () => {
  for (const offset of [-1, 0, 1]) {
    const setup = setupGame();
    const invite = issueInvite(setup, 3_000);
    const work = () => joinParticipant(
      setup, invite.inviteToken, `Player ${offset}`, 3_000 + ADMISSION_LIMITS.invitationTtl + offset,
    );
    if (offset < 0) assert.equal(work().result.value.code, 'participant_admitted');
    else expectCode(work, 'expired');
    setup.store.close();
  }
  const setup = setupGame();
  const invite = issueInvite(setup);
  const joined = joinParticipant(setup, invite.inviteToken, 'Session Player', 3_100);
  assert.equal(setup.store.authorizeParticipantSession({
    token: joined.sessionToken, gameId: setup.gameId, now: 3_100 + (30 * 24 * 60 * 60 * 1_000),
  }).participantId, joined.participantId);
  setup.store.close();
});

test('eight active seats close admission, removal revokes recovery, and the slot is reusable', () => {
  const setup = setupGame();
  const invite = issueInvite(setup);
  const joined = [];
  for (let index = 0; index < ADMISSION_LIMITS.participants - 1; index += 1) {
    joined.push(joinParticipant(setup, invite.inviteToken, `Player ${index + 1}`, 3_100 + index));
  }
  const finalSeat = participantAction(setup, invite.inviteToken, 'Player 8', 3_107);
  const competingSeat = participantAction(setup, invite.inviteToken, 'Player 9', 3_107);
  joined.push({ ...finalSeat, result: setup.store.admitParticipant(finalSeat.action) });
  assert.equal(joined.at(-1).result.value.code, 'participant_admitted');
  expectCode(() => setup.store.admitParticipant(competingSeat.action), 'capacity_reached');
  expectCode(() => issueInvite(setup, 3_201), 'capacity_reached');
  const removed = joined[3];
  const revision = setup.store.gameSnapshot(setup.gameId).revision;
  setup.store.removeParticipant({
    applicationSessionToken: setup.hostToken, gameId: setup.gameId,
    targetParticipantId: removed.participantId, requestId: randomUUID(),
    expectedRevision: revision, now: 3_300,
  });
  expectCode(() => setup.store.authorizeParticipantSession({
    token: removed.sessionToken, gameId: setup.gameId, now: 3_301,
  }), 'unauthorized');
  const replacementInvite = issueInvite(setup, 3_400);
  const replacement = joinParticipant(
    setup, replacementInvite.inviteToken, 'Replacement', 3_401,
  );
  assert.equal(replacement.result.value.code, 'participant_admitted');
  setup.store.close();
  const database = new DatabaseSync(setup.path, { readOnly: true });
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM participants').get().count, 9);
  assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM participants
    WHERE removed_at IS NULL`).get().count, 8);
  assert.equal(database.prepare(`SELECT join_order FROM participants
    WHERE participant_id=?`).get(replacement.participantId).join_order, 4);
  database.close();
});

test('normalized names are presentation-only unique values and identity conflicts stay distinct', () => {
  const setup = setupGame();
  const invite = issueInvite(setup);
  const first = joinParticipant(setup, invite.inviteToken, 'Ｆａｍｉｌｙ   Player', 3_100);
  expectCode(() => joinParticipant(setup, invite.inviteToken, 'family player', 3_101),
    'duplicate_name');
  expectCode(() => setup.store.admitParticipant({
    gameId: setup.gameId, inviteToken: invite.inviteToken,
    participantId: first.participantId, sessionToken: bearer(), displayName: 'Another',
    requestId: randomUUID(), expectedRevision: setup.store.gameSnapshot(setup.gameId).revision,
    now: 3_102,
  }), 'request_conflict');
  for (const displayName of ['', 'a'.repeat(25), 'bad\u0000name']) {
    expectCode(() => joinParticipant(setup, invite.inviteToken, displayName, 3_103),
      'invalid_request');
  }
  setup.store.close();
});

test('invitation regeneration and revocation retain replay before later Host revocation', () => {
  const setup = setupGame();
  const first = issueInvite(setup, 3_000);
  const second = issueInvite(setup, 3_100);
  expectCode(() => joinParticipant(setup, first.inviteToken, 'Old Link', 3_101), 'unauthorized');
  const revokeAction = {
    applicationSessionToken: setup.hostToken, gameId: setup.gameId,
    requestId: randomUUID(), expectedRevision: setup.store.gameSnapshot(setup.gameId).revision,
    now: 3_200,
  };
  const revoked = setup.store.revokeGameInvitation(revokeAction);
  assert.deepEqual(setup.store.revokeGameInvitation(revokeAction), revoked);
  expectCode(() => joinParticipant(setup, second.inviteToken, 'Revoked Link', 3_201), 'unauthorized');
  setup.store.revokeHostDevice({
    applicationSessionToken: setup.hostToken, targetDeviceId: setup.deviceId,
    requestId: randomUUID(), now: 3_300,
  });
  assert.deepEqual(setup.store.issueGameInvitation(first.action), first.result);
  expectCode(() => setup.store.issueGameInvitation({
    ...first.action, requestId: randomUUID(), inviteToken: bearer(), now: 3_301,
  }), 'unauthorized');
  setup.store.close();
});

test('game creation reopens the active game and exact replay survives Host revocation', () => {
  const setup = setupGame();
  const otherAction = {
    applicationSessionToken: setup.hostToken, gameId: randomUUID(), requestId: randomUUID(),
    catalogVersion: catalog.version, rules: { preset: 'modern' }, now: 2_100,
  };
  const other = setup.store.createAuthorizedGame(otherAction);
  assert.deepEqual(other, { code: 'active_game_exists', gameId: setup.gameId });
  expectCode(() => setup.store.createAuthorizedGame({
    ...otherAction, rules: { preset: 'younger' },
  }), 'request_conflict');
  setup.store.terminateGame({
    applicationSessionToken: setup.hostToken, gameId: setup.gameId,
    requestId: randomUUID(), expectedRevision: 0, now: 2_150,
  });
  assert.deepEqual(setup.store.createAuthorizedGame(otherAction), other);
  setup.store.revokeHostDevice({
    applicationSessionToken: setup.hostToken, targetDeviceId: setup.deviceId,
    requestId: randomUUID(), now: 2_200,
  });
  const replay = setup.store.createAuthorizedGame(setup.createAction);
  assert.equal(replay.code, 'created');
  expectCode(() => setup.store.createAuthorizedGame({
    applicationSessionToken: setup.hostToken, gameId: randomUUID(), requestId: randomUUID(),
    catalogVersion: catalog.version, rules: {}, now: 2_201,
  }), 'unauthorized');
  setup.store.close();
  const reopened = createReleaseStore(setup.path, { catalog });
  assert.deepEqual(reopened.createAuthorizedGame(otherAction), other);
  assert.equal(reopened.createAuthorizedGame(setup.createAction).code, 'created');
  reopened.close();
});

test('start closes admission, participant projection hides the answer, and termination is explicit', () => {
  const setup = setupGame();
  const invite = issueInvite(setup);
  const joined = joinParticipant(setup, invite.inviteToken, 'Listener', 3_100);
  const current = setup.store.gameSnapshot(setup.gameId);
  const started = setup.store.applyHostGameAction({
    applicationSessionToken: setup.hostToken, gameId: setup.gameId,
    requestId: randomUUID(), operation: 'start_game', payload: {},
    expectedRevision: current.revision, now: 3_200,
  });
  expectCode(() => joinParticipant(setup, invite.inviteToken, 'Too Late', 3_201), 'game_started');
  const snapshot = setup.store.participantSnapshot({
    token: joined.sessionToken, gameId: setup.gameId, now: 3_202,
  });
  assert.equal(snapshot.state.phase, 'ready');
  for (const key of ['currentSong', 'placement', 'result']) {
    assert.equal(key in snapshot.state, false);
  }
  assert.equal(JSON.stringify(snapshot).includes(started.state.currentSong.title), false);
  const recovered = setup.store.recoverHostGame({
    applicationSessionToken: setup.hostToken, now: 3_203,
  }).game;
  assert.equal(recovered.gameId, setup.gameId);
  assert.equal(recovered.state.players[0].name, 'Listener');
  assert.deepEqual(setup.store.hostGameSnapshot({
    applicationSessionToken: setup.hostToken, gameId: setup.gameId, now: 3_204,
  }).state, recovered.state);
  expectCode(() => setup.store.admitParticipant({
    gameId: setup.gameId, inviteToken: invite.inviteToken,
    participantId: joined.participantId, sessionToken: bearer(), displayName: 'Collision',
    requestId: randomUUID(), now: 3_205,
  }), 'request_conflict');
  expectCode(() => setup.store.admitParticipant({
    gameId: setup.gameId, inviteToken: invite.inviteToken,
    participantId: randomUUID(), sessionToken: joined.sessionToken, displayName: 'Collision',
    requestId: randomUUID(), now: 3_206,
  }), 'request_conflict');
  const terminated = setup.store.terminateGame({
    applicationSessionToken: setup.hostToken, gameId: setup.gameId,
    requestId: randomUUID(), expectedRevision: snapshot.revision, now: 3_300,
  });
  assert.equal(terminated.value.code, 'game_terminated');
  expectCode(() => setup.store.authorizeParticipantSession({
    token: joined.sessionToken, gameId: setup.gameId, now: 4_101,
  }), 'unauthorized');
  assert.equal(setup.store.recoverHostGame({
    applicationSessionToken: setup.hostToken, now: 3_301,
  }).game, null);
  setup.store.close();
});

test('invitation closure remains bound to its earliest causal event', () => {
  const setup = setupGame();
  const first = issueInvite(setup, 3_000);
  const second = issueInvite(setup, 3_100);
  const joined = joinParticipant(setup, second.inviteToken, 'Listener', 3_200);
  const current = setup.store.gameSnapshot(setup.gameId);
  setup.store.applyHostGameAction({
    applicationSessionToken: setup.hostToken, gameId: setup.gameId,
    requestId: randomUUID(), operation: 'start_game', payload: {},
    expectedRevision: current.revision, now: 3_300,
  });
  setup.store.close();
  const database = new DatabaseSync(setup.path);
  withoutTriggers(database, ['game_invites_closure_immutable'], () => {
    database.prepare(`UPDATE game_invites SET closed_at=3300,close_reason='started'
      WHERE invite_hash=?`).run(sha256(first.inviteToken));
  });
  database.close();
  expectCode(() => createReleaseStore(setup.path, { catalog }), 'database_corrupt');
});

test('retained invitation, removal, and revocation terminals are write-once', () => {
  const setup = setupGame();
  const first = issueInvite(setup, 3_000);
  const joined = joinParticipant(setup, first.inviteToken, 'Removed', 3_050);
  issueInvite(setup, 3_100);
  setup.store.removeParticipant({
    applicationSessionToken: setup.hostToken, gameId: setup.gameId,
    targetParticipantId: joined.participantId, requestId: randomUUID(),
    expectedRevision: setup.store.gameSnapshot(setup.gameId).revision, now: 3_200,
  });
  setup.store.close();
  const database = new DatabaseSync(setup.path);
  assert.throws(() => database.prepare(`UPDATE game_invites SET close_reason='started'
    WHERE invite_hash=?`).run(sha256(first.inviteToken)));
  assert.throws(() => database.prepare('UPDATE participants SET removed_at=removed_at+1').run());
  assert.throws(() => database.prepare('UPDATE participant_sessions SET revoked_at=revoked_at+1').run());
  database.close();
});

test('relationship-preserving admission corruptions fail closed on restart', () => {
  const corruptions = [
    (database, setup, joined) => {
      database.prepare(`UPDATE game_invites SET closed_at=?,close_reason='revoked'
        WHERE game_id=? AND closed_at IS NULL`).run(3_200, setup.gameId);
    },
    (database, setup, joined) => withoutTriggers(
      database, ['participant_sessions_identity_immutable'],
      () => database.prepare('UPDATE participant_sessions SET issued_at=issued_at+1 WHERE participant_id=?')
        .run(joined[0].participantId),
    ),
    (database, setup, joined) => withoutTriggers(
      database, ['participants_identity_immutable'],
      () => database.prepare('UPDATE participants SET join_order=3 WHERE participant_id=?')
        .run(joined[0].participantId),
    ),
    (database, setup, joined) => withoutTriggers(
      database, ['participant_sessions_immutable_delete'],
      () => database.prepare('DELETE FROM participant_sessions WHERE participant_id=?')
        .run(joined[0].participantId),
    ),
    (database, setup, joined) => {
      database.prepare('UPDATE participants SET removed_at=3200 WHERE participant_id=?')
        .run(joined[0].participantId);
      database.prepare('UPDATE participant_sessions SET revoked_at=3200 WHERE participant_id=?')
        .run(joined[0].participantId);
    },
    (database, setup, joined) => withoutTriggers(
      database, ['action_receipts_immutable_update'],
      () => {
        const row = database.prepare(`SELECT request FROM action_receipts
          WHERE operation='join_participant' AND actor_id=?`).get(joined[0].participantId);
        const request = JSON.parse(row.request);
        request.payload.displayName = 'Altered';
        request.payload.normalizedName = 'altered';
        const text = canonicalJson(request);
        database.prepare(`UPDATE action_receipts SET request=?,request_hash=?
          WHERE operation='join_participant' AND actor_id=?`).run(
          text, sha256(text), joined[0].participantId,
        );
      },
    ),
    (database, setup) => withoutTriggers(
      database, ['action_receipts_immutable_update'],
      () => {
        const game = database.prepare('SELECT state,revision FROM games WHERE game_id=?')
          .get(setup.gameId);
        const state = JSON.parse(game.state);
        state.players.reverse();
        const stateText = canonicalJson(state);
        database.prepare('UPDATE games SET state=? WHERE game_id=?').run(stateText, setup.gameId);
        const receipt = database.prepare(`SELECT actor_type,actor_id,request_id,result
          FROM action_receipts WHERE game_id=? AND revision=?`).get(setup.gameId, game.revision);
        const result = JSON.parse(receipt.result);
        result.state = state;
        database.prepare(`UPDATE action_receipts SET result=? WHERE game_id=? AND actor_type=?
          AND actor_id=? AND request_id=?`).run(
          canonicalJson(result), setup.gameId, receipt.actor_type, receipt.actor_id, receipt.request_id,
        );
      },
    ),
  ];
  for (const corrupt of corruptions) {
    const setup = setupGame();
    const invite = issueInvite(setup);
    const joined = [
      joinParticipant(setup, invite.inviteToken, 'One', 3_100),
      joinParticipant(setup, invite.inviteToken, 'Two', 3_101),
    ];
    setup.store.close();
    const database = new DatabaseSync(setup.path);
    corrupt(database, setup, joined);
    database.close();
    expectCode(() => createReleaseStore(setup.path, { catalog }), 'database_corrupt');
  }
});
