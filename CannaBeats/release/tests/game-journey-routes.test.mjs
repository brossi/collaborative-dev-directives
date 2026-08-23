import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';

import {
  GAME_JOURNEY_CLIENT_CONTRACT, GAME_JOURNEY_CLIENT_HEADER, GAME_JOURNEY_ROLE_HEADER,
  gameActionRoute,
} from '../../web/lib/server/release/game-journey-routes.mjs';
import {
  PARTICIPANT_COOKIE, PARTICIPANT_COOKIE_MAX_AGE,
} from '../../web/lib/server/release/game-admission-routes.mjs';
import { ReleaseStoreError } from '../../web/lib/server/release/store.mjs';
import { HOST_COOKIE } from '../../web/lib/server/release/host-routes.mjs';

const gameId = randomUUID();
const hostToken = randomBytes(24).toString('base64url');
const participantToken = randomBytes(24).toString('base64url');
const input = Object.freeze({
  expectedRevision: 4, operation: 'place_song', payload: { index: 1 },
  requestId: randomUUID(),
});

function request({
  authority = 'host', body = input, contract = GAME_JOURNEY_CLIENT_CONTRACT, role,
} = {}) {
  const headers = new Headers({
    'content-type': 'application/json', [GAME_JOURNEY_CLIENT_HEADER]: contract,
  });
  if (authority === 'host' || authority === 'both') {
    headers.set('authorization', `Bearer ${hostToken}`);
  }
  if (authority === 'participant' || authority === 'both') {
    headers.set('cookie', `${PARTICIPANT_COOKIE}=${participantToken}`);
  }
  if (authority === 'host-cookie') headers.set('cookie', `${HOST_COOKIE}=${hostToken}`);
  if (authority === 'both-cookies') headers.set('cookie',
    `${HOST_COOKIE}=${hostToken}; ${PARTICIPANT_COOKIE}=${participantToken}`);
  if (role) headers.set(GAME_JOURNEY_ROLE_HEADER, role);
  return new Request(`https://play.cannabeats.social/api/games/${gameId}/actions`, {
    method: 'POST', headers, body: JSON.stringify(body),
  });
}

test('Host and participant action routes derive one authority and forward only fixed inputs', async () => {
  const calls = [];
  const runtime = {
    applyHostGameAction(value) {
      calls.push(['host', value]);
      return { code: 'accepted', gameId, revision: 5, state: { phase: 'placed' } };
    },
    applyParticipantGameAction(value) {
      calls.push(['participant', value]);
      return { code: 'accepted', gameId, revision: 5, state: { phase: 'placed' } };
    },
  };
  const host = await gameActionRoute(request(), runtime, gameId, 9_000);
  assert.equal(host.status, 200);
  assert.deepEqual(calls.shift(), ['host', {
    ...input, applicationSessionToken: hostToken, gameId, now: 9_000,
  }]);
  assert.equal(host.headers.has('set-cookie'), false);

  const webHost = await gameActionRoute(request({ authority: 'host-cookie' }), runtime, gameId, 9_000);
  assert.equal(webHost.status, 200);
  assert.deepEqual(calls.shift(), ['host', {
    ...input, hostSessionKind: 'web', hostSessionToken: hostToken, gameId, now: 9_000,
  }]);

  const participant = await gameActionRoute(
    request({ authority: 'participant' }), runtime, gameId, 9_001,
  );
  assert.equal(participant.status, 200);
  assert.deepEqual(calls.shift(), ['participant', {
    ...input, participantSessionToken: participantToken, gameId, now: 9_001,
  }]);
  assert.equal(participant.headers.get('set-cookie'),
    `${PARTICIPANT_COOKIE}=${participantToken}; Path=/; Max-Age=${PARTICIPANT_COOKIE_MAX_AGE}; Secure; HttpOnly; SameSite=Strict`);

  const selectedParticipant = await gameActionRoute(
    request({ authority: 'both-cookies', role: 'participant' }), runtime, gameId, 9_002,
  );
  assert.equal(selectedParticipant.status, 200);
  assert.deepEqual(calls.shift(), ['participant', {
    ...input, participantSessionToken: participantToken, gameId, now: 9_002,
  }]);

  const selectedHost = await gameActionRoute(
    request({ authority: 'both-cookies', role: 'host' }), runtime, gameId, 9_003,
  );
  assert.equal(selectedHost.status, 200);
  assert.deepEqual(calls.shift(), ['host', {
    ...input, hostSessionKind: 'web', hostSessionToken: hostToken, gameId, now: 9_003,
  }]);
});

test('action routes reject incompatible, missing, and ambiguous authority without dispatch', async () => {
  let calls = 0;
  const runtime = {
    applyHostGameAction() { calls += 1; },
    applyParticipantGameAction() { calls += 1; },
  };
  const incompatible = await gameActionRoute(request({ contract: '2' }), runtime, gameId);
  assert.equal(incompatible.status, 409);
  assert.deepEqual(await incompatible.json(), { ok: false, code: 'incompatible_client' });
  for (const authority of ['none', 'both']) {
    const response = await gameActionRoute(request({ authority }), runtime, gameId);
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { ok: false, code: 'unauthorized' });
  }
  assert.equal(calls, 0);
});

test('action route failures are finite and never reflect request or native error text', async () => {
  const secret = `sensitive-${randomUUID()}`;
  const malformed = await gameActionRoute(request({ body: { ...input, secret } }), {}, gameId);
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.text()).includes(secret), false);
  const runtime = {
    applyHostGameAction() { throw new ReleaseStoreError('catalog_exhausted'); },
  };
  const exhausted = await gameActionRoute(request(), runtime, gameId);
  assert.equal(exhausted.status, 409);
  assert.deepEqual(await exhausted.json(), { ok: false, code: 'catalog_exhausted' });
  const audioBlocked = await gameActionRoute(request(), {
    applyHostGameAction() { throw new ReleaseStoreError('audio_not_ready'); },
  }, gameId);
  assert.equal(audioBlocked.status, 409);
  assert.deepEqual(await audioBlocked.json(), { ok: false, code: 'audio_not_ready' });
  const playbackFull = await gameActionRoute(request(), {
    applyHostGameAction() { throw new ReleaseStoreError('playback_capacity'); },
  }, gameId);
  assert.equal(playbackFull.status, 409);
  assert.deepEqual(await playbackFull.json(), { ok: false, code: 'playback_capacity' });
  const native = await gameActionRoute(request(), {
    applyHostGameAction() { throw new Error(secret); },
  }, gameId);
  assert.equal(native.status, 503);
  assert.equal((await native.text()).includes(secret), false);
});
