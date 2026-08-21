import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import {
  RELEASE_AUDIO_CONTRACT_HEADER, RELEASE_AUDIO_CONTRACT_VERSION,
  createReleaseAudioBrowserSession,
} from '../../web/lib/release-audio-browser.mjs';

test('release browser audio derives its exact cookie-authenticated route without relay material', async () => {
  const gameId = randomUUID();
  const audioSessionId = randomUUID();
  const calls = [];
  class FakeSession {
    constructor(input) { this.input = input; calls.push(['construct', input]); }
    async start() { calls.push(['start']); }
    async stop(reason) { calls.push(['stop', reason]); }
  }
  const upstreamFetch = async (url, options) => {
    calls.push(['fetch', url, options]);
    return new Response(new Uint8Array(0));
  };
  const session = createReleaseAudioBrowserSession({
    gameId, audioSessionId, basePath: '/game', client: {},
    dependencies: { fetch: upstreamFetch }, onStatus() {}, Session: FakeSession,
  });
  const expected = `/game/api/games/${gameId}/audio/sessions/${audioSessionId}/listen`;
  assert.equal(session.input.streamUrl, expected);
  await session.input.dependencies.fetch(expected, { cache: 'no-store', signal: null });
  assert.deepEqual(calls.at(-1), ['fetch', expected, {
    cache: 'no-store', signal: null, credentials: 'same-origin',
    headers: { [RELEASE_AUDIO_CONTRACT_HEADER]: RELEASE_AUDIO_CONTRACT_VERSION },
  }]);
  assert.equal(JSON.stringify(calls).includes('relay'), false);
  await session.start();
  await session.stop('page_teardown');
  assert.deepEqual(calls.slice(-2), [['start'], ['stop', 'page_teardown']]);
});

test('release browser audio rejects malformed identity and expanded request headers', async () => {
  const dependencies = { fetch: async () => new Response() };
  assert.throws(() => createReleaseAudioBrowserSession({
    gameId: 'not-a-game', audioSessionId: randomUUID(), client: {}, dependencies,
  }), /release_audio_session_invalid/u);
  const gameId = randomUUID();
  const audioSessionId = randomUUID();
  const session = createReleaseAudioBrowserSession({
    gameId, audioSessionId, client: {}, dependencies,
    Session: class { constructor(input) { this.input = input; } },
  });
  assert.throws(() => session.input.dependencies.fetch(
    `/api/games/${gameId}/audio/sessions/${audioSessionId}/listen`,
    { headers: { authorization: 'forbidden' } },
  ), /release_audio_request_invalid/u);
});
