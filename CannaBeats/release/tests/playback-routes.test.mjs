import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';

import {
  PLAYBACK_CLIENT_CONTRACT, PLAYBACK_CLIENT_HEADER, nextPlaybackCommandRoute,
  playbackTransitionRoute,
} from '../../web/lib/server/release/playback-routes.mjs';
import { ReleaseStoreError } from '../../web/lib/server/release/store.mjs';

const gameId = randomUUID();
const commandId = randomUUID();
const hostToken = randomBytes(24).toString('base64url');
const transition = Object.freeze({
  claimGeneration: randomUUID(), outcome: null, outcomeHash: null, reasonCode: null,
  targetState: 'claimed',
});

function request(path, {
  body, contract = PLAYBACK_CLIENT_CONTRACT, token = hostToken, method = 'GET',
} = {}) {
  const headers = new Headers({ [PLAYBACK_CLIENT_HEADER]: contract });
  if (token !== null) headers.set('authorization', `Bearer ${token}`);
  if (body !== undefined) headers.set('content-type', 'application/json');
  return new Request(`https://play.cannabeats.social${path}`, {
    method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

test('native playback routes derive application authority and forward only fixed inputs', async () => {
  const calls = [];
  const runtime = {
    nextPlaybackCommand(input) {
      calls.push(['next', input]);
      return { code: 'idle' };
    },
    transitionPlaybackCommand(input) {
      calls.push(['transition', input]);
      return { code: 'accepted' };
    },
  };
  const polled = await nextPlaybackCommandRoute(request(
    `/api/games/${gameId}/playback/commands/next`,
  ), runtime, gameId, 9_000);
  assert.equal(polled.status, 200);
  assert.deepEqual(await polled.json(), { code: 'idle' });
  assert.deepEqual(calls.shift(), ['next', {
    applicationSessionToken: hostToken, gameId, now: 9_000,
  }]);

  const posted = await playbackTransitionRoute(request(
    `/api/games/${gameId}/playback/commands/${commandId}/transitions`,
    { body: transition, method: 'POST' },
  ), runtime, gameId, commandId, 9_001);
  assert.equal(posted.status, 200);
  assert.deepEqual(await posted.json(), { code: 'accepted' });
  assert.deepEqual(calls.shift(), ['transition', {
    ...transition, applicationSessionToken: hostToken, commandId, gameId, now: 9_001,
  }]);
});

test('playback routes reject missing bearer, incompatible clients, and expanded bodies', async () => {
  let calls = 0;
  const runtime = {
    nextPlaybackCommand() { calls += 1; },
    transitionPlaybackCommand() { calls += 1; },
  };
  const missing = await nextPlaybackCommandRoute(request(
    `/api/games/${gameId}/playback/commands/next`, { token: null },
  ), runtime, gameId);
  assert.equal(missing.status, 401);
  assert.deepEqual(await missing.json(), { ok: false, code: 'unauthorized' });

  const incompatible = await nextPlaybackCommandRoute(request(
    `/api/games/${gameId}/playback/commands/next`, { contract: '0' },
  ), runtime, gameId);
  assert.equal(incompatible.status, 409);
  assert.deepEqual(await incompatible.json(), { ok: false, code: 'incompatible_client' });

  const expanded = await playbackTransitionRoute(request(
    `/api/games/${gameId}/playback/commands/${commandId}/transitions`,
    { body: { ...transition, deviceId: randomUUID() }, method: 'POST' },
  ), runtime, gameId, commandId);
  assert.equal(expanded.status, 400);
  assert.deepEqual(await expanded.json(), { ok: false, code: 'invalid_request' });
  assert.equal(calls, 0);
});

test('every playback failure is finite and native error text is never reflected', async () => {
  const cases = [
    ['stale_claim', 409], ['command_not_found', 404], ['game_ended', 410],
    ['database_corrupt', 503],
  ];
  for (const [code, status] of cases) {
    const response = await playbackTransitionRoute(request(
      `/api/games/${gameId}/playback/commands/${commandId}/transitions`,
      { body: transition, method: 'POST' },
    ), {
      transitionPlaybackCommand() { throw new ReleaseStoreError(code); },
    }, gameId, commandId);
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), { ok: false, code });
  }
  const secret = `native-path-secret-${randomUUID()}`;
  const unknown = await playbackTransitionRoute(request(
    `/api/games/${gameId}/playback/commands/${commandId}/transitions`,
    { body: transition, method: 'POST' },
  ), {
    transitionPlaybackCommand() { throw new Error(secret); },
  }, gameId, commandId);
  assert.equal(unknown.status, 503);
  const text = await unknown.text();
  assert.equal(text.includes(secret), false);
  assert.deepEqual(JSON.parse(text), { ok: false, code: 'database_unavailable' });
});
