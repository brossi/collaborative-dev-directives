import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';

import {
  PARTICIPANT_COOKIE, PARTICIPANT_COOKIE_MAX_AGE, gameCreateRoute,
  hostGameSnapshotRoute, invitationIssueRoute, participantAdmissionRoute,
  participantSnapshotRoute,
} from '../../web/lib/server/release/game-admission-routes.mjs';
import { ReleaseStoreError } from '../../web/lib/server/release/store.mjs';

function token() { return randomBytes(24).toString('base64url'); }

function request(value, { authorization, cookie, headers = {}, method = 'POST' } = {}) {
  return new Request('https://play.cannabeats.social/api/games/test', {
    method,
    headers: {
      ...(value === undefined ? {} : { 'content-type': 'application/json' }),
      ...(authorization ? { authorization: `Bearer ${authorization}` } : {}),
      ...(cookie ? { cookie } : {}),
      ...headers,
    },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
  });
}

test('Host game and invitation routes forward only their bounded authenticated inputs', async () => {
  const hostToken = token();
  const gameId = randomUUID();
  const gameInput = {
    catalogVersion: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    gameId, requestId: randomUUID(), rules: { preset: 'family' },
  };
  let createdInput;
  const created = await gameCreateRoute(request(gameInput, { authorization: hostToken }), {
    createAuthorizedGame(input) {
      createdInput = input;
      return { code: 'created', gameId, revision: 0 };
    },
  }, 10_000);
  assert.equal(created.status, 201);
  assert.deepEqual(createdInput, { ...gameInput, applicationSessionToken: hostToken, now: 10_000 });

  const inviteToken = token();
  const inviteInput = { expectedRevision: 0, inviteToken, requestId: randomUUID() };
  let issuedInput;
  const issued = await invitationIssueRoute(
    request(inviteInput, { authorization: hostToken }),
    { issueGameInvitation(input) {
      issuedInput = input;
      return { code: 'accepted', value: { code: 'invitation_issued', expiresAt: 99_000 } };
    } },
    gameId,
    11_000,
  );
  assert.equal(issued.status, 201);
  assert.deepEqual(issuedInput, {
    ...inviteInput, applicationSessionToken: hostToken, gameId, now: 11_000,
  });
  assert.equal((await issued.text()).includes(inviteToken), false);
});

test('admission installs a persistent game credential and snapshot refreshes its retention', async () => {
  const gameId = randomUUID();
  const sessionToken = token();
  const input = {
    displayName: 'Sibling', inviteToken: token(), participantId: randomUUID(),
    requestId: randomUUID(), sessionToken,
  };
  let admittedInput;
  const admitted = await participantAdmissionRoute(request(input), {
    admitParticipant(value) {
      admittedInput = value;
      return { code: 'accepted', gameId, value: {
        code: 'participant_admitted', participantId: input.participantId,
      } };
    },
  }, gameId, 20_000);
  assert.equal(admitted.status, 201);
  assert.deepEqual(admittedInput, { ...input, gameId, now: 20_000 });
  assert.equal((await admitted.clone().text()).includes(input.inviteToken), false);
  const expectedCookie = `${PARTICIPANT_COOKIE}=${sessionToken}; Path=/; Max-Age=${PARTICIPANT_COOKIE_MAX_AGE}; Secure; HttpOnly; SameSite=Strict`;
  assert.equal(admitted.headers.get('set-cookie'), expectedCookie);
  assert.doesNotMatch(expectedCookie, /Domain=/iu);

  let snapshotInput;
  const snapshot = await participantSnapshotRoute(request(undefined, {
    cookie: `${PARTICIPANT_COOKIE}=${sessionToken}`, method: 'GET',
  }), { participantSnapshot(value) {
    snapshotInput = value;
    return { code: 'snapshot', gameId, participantId: input.participantId, state: {} };
  } }, gameId, 30_000);
  assert.equal(snapshot.status, 200);
  assert.deepEqual(snapshotInput, { token: sessionToken, gameId, now: 30_000 });
  assert.equal(snapshot.headers.get('set-cookie'), expectedCookie);
});

test('Host snapshot uses the application bearer and returns the owner projection', async () => {
  const gameId = randomUUID();
  const hostToken = token();
  let received;
  const response = await hostGameSnapshotRoute(request(undefined, {
    authorization: hostToken, method: 'GET',
  }), { hostGameSnapshot(value) {
    received = value;
    return { code: 'snapshot', gameId, lifecycle: 'lobby', revision: 2, state: { players: [] } };
  } }, gameId, 40_000);
  assert.equal(response.status, 200);
  assert.deepEqual(received, {
    applicationSessionToken: hostToken, gameId, now: 40_000,
  });
  assert.deepEqual(await response.json(), {
    code: 'snapshot', gameId, lifecycle: 'lobby', revision: 2, state: { players: [] },
  });
});

test('route failures are finite, reject ambiguous cookies, and never reflect secrets', async () => {
  const gameId = randomUUID();
  const secret = token();
  const malformed = await participantAdmissionRoute(request({
    displayName: 'Sibling', inviteToken: secret, participantId: randomUUID(),
    requestId: randomUUID(), sessionToken: token(), extra: secret,
  }), { admitParticipant: () => assert.fail('invalid body must not reach owner') }, gameId);
  assert.equal(malformed.status, 400);
  assert.deepEqual(await malformed.json(), { ok: false, code: 'invalid_request' });

  const ambiguous = await participantSnapshotRoute(request(undefined, {
    cookie: `${PARTICIPANT_COOKIE}=${secret}; ${PARTICIPANT_COOKIE}=${token()}`,
    method: 'GET',
  }), { participantSnapshot: () => assert.fail('ambiguous cookie must not authorize') }, gameId);
  assert.equal(ambiguous.status, 401);

  const native = await participantAdmissionRoute(request({
    displayName: 'Sibling', inviteToken: secret, participantId: randomUUID(),
    requestId: randomUUID(), sessionToken: token(),
  }), { admitParticipant: () => { throw new Error(`SQLite /private/${secret}`); } }, gameId);
  assert.equal(native.status, 503);
  const text = await native.text();
  assert.equal(text.includes(secret), false);
  assert.equal(text.includes('SQLite'), false);

  const finite = await participantAdmissionRoute(request({
    displayName: 'Sibling', inviteToken: secret, participantId: randomUUID(),
    requestId: randomUUID(), sessionToken: token(),
  }), { admitParticipant: () => { throw new ReleaseStoreError('duplicate_name'); } }, gameId);
  assert.equal(finite.status, 409);
  assert.deepEqual(await finite.json(), { ok: false, code: 'duplicate_name' });
});
