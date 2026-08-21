import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { test } from 'node:test';

import {
  AUDIO_CHANNELS_HEADER, AUDIO_CLIENT_CONTRACT, AUDIO_CLIENT_HEADER,
  AUDIO_CONNECTION_HEADER, AUDIO_ENCODING_HEADER, AUDIO_GENERATION_HEADER,
  AUDIO_RATE_HEADER, AUDIO_SESSION_HEADER, audioIngestRoute, audioListenRoute,
  MAX_STREAM_CHUNK_BYTES,
  currentAudioSessionRoute, endAudioSessionRoute, openAudioSessionRoute,
} from '../../web/lib/server/release/audio-routes.mjs';
import { PARTICIPANT_COOKIE } from '../../web/lib/server/release/game-admission-routes.mjs';
import { ReleaseStoreError } from '../../web/lib/server/release/store.mjs';
import { createAudioRelay } from '../relay/server.mjs';

const hostToken = randomBytes(24).toString('base64url');
const participantToken = randomBytes(24).toString('base64url');
const ingestToken = randomBytes(24).toString('base64url');
const listenToken = randomBytes(24).toString('base64url');
const gameId = randomUUID();
const audioSessionId = randomUUID();
const connectionId = randomUUID();
const session = Object.freeze({
  audioSessionId, connectionId, gameId, generation: 4, state: 'active', updatedAt: 9_000,
});
const relay = Object.freeze({
  origin: 'http://audio-relay.test:8090', ingestToken, listenToken,
});

function jsonRequest(path, {
  body, contract = AUDIO_CLIENT_CONTRACT, method = 'GET', token = hostToken,
} = {}) {
  const headers = new Headers({ [AUDIO_CLIENT_HEADER]: contract });
  if (token !== null) headers.set('authorization', `Bearer ${token}`);
  if (body !== undefined) headers.set('content-type', 'application/json');
  return new Request(`https://play.cannabeats.social${path}`, {
    method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function ingestRequest(body, overrides = {}) {
  const headers = new Headers({
    authorization: `Bearer ${hostToken}`,
    'content-type': 'application/octet-stream',
    [AUDIO_CLIENT_HEADER]: AUDIO_CLIENT_CONTRACT,
    [AUDIO_CONNECTION_HEADER]: connectionId,
    [AUDIO_RATE_HEADER]: '48000',
    [AUDIO_CHANNELS_HEADER]: '2',
    [AUDIO_ENCODING_HEADER]: 's16le',
    ...overrides,
  });
  return new Request(`https://play.cannabeats.social/api/games/${gameId}/audio/sessions/${audioSessionId}/ingest`, {
    method: 'POST', headers, body, duplex: 'half',
  });
}

function relayResponse(value = session, rate = 48_000, body = new Uint8Array(0)) {
  return new Response(body, { status: 200, headers: {
    'content-type': 'application/octet-stream',
    [AUDIO_CLIENT_HEADER]: AUDIO_CLIENT_CONTRACT,
    [AUDIO_SESSION_HEADER]: value.audioSessionId,
    [AUDIO_GENERATION_HEADER]: String(value.generation),
    [AUDIO_RATE_HEADER]: String(rate),
    [AUDIO_CHANNELS_HEADER]: '2',
    [AUDIO_ENCODING_HEADER]: 's16le',
  } });
}

test('audio control routes derive Host authority and accept only exact bodies', async () => {
  const calls = [];
  const runtime = {
    openAudioSession(input) { calls.push(['open', input]); return { code: 'audio_session', session }; },
    currentAudioSession(input) { calls.push(['current', input]); return { code: 'audio_session', session }; },
    endAudioSession(input) { calls.push(['end', input]); return { code: 'ended', session }; },
  };
  const requestId = randomUUID();
  const opened = await openAudioSessionRoute(jsonRequest(
    `/api/games/${gameId}/audio/sessions`,
    { method: 'POST', body: { audioSessionId, requestId } },
  ), runtime, gameId, 9_000);
  assert.equal(opened.status, 200);
  assert.deepEqual(calls.shift(), ['open', {
    applicationSessionToken: hostToken, audioSessionId, gameId, requestId, now: 9_000,
  }]);
  const current = await currentAudioSessionRoute(jsonRequest(
    `/api/games/${gameId}/audio/sessions/current`,
  ), runtime, gameId, 9_001);
  assert.equal(current.status, 200);
  assert.deepEqual(calls.shift(), ['current', {
    applicationSessionToken: hostToken, gameId, now: 9_001,
  }]);
  const ended = await endAudioSessionRoute(jsonRequest(
    `/api/games/${gameId}/audio/sessions/${audioSessionId}/end`,
    { method: 'POST', body: { requestId } },
  ), runtime, gameId, audioSessionId, 9_002);
  assert.equal(ended.status, 200);
  assert.deepEqual(calls.shift(), ['end', {
    applicationSessionToken: hostToken, audioSessionId, gameId, requestId, now: 9_002,
  }]);

  const expanded = await openAudioSessionRoute(jsonRequest('/ignored', {
    method: 'POST', body: { audioSessionId, requestId, generation: 4 },
  }), runtime, gameId);
  assert.equal(expanded.status, 400);
  assert.deepEqual(await expanded.json(), { ok: false, code: 'invalid_request' });
  assert.equal(calls.length, 0);
});

test('ingest reserves authority before the private hop and activates only an exact relay response', async () => {
  const calls = [];
  let relayReader;
  const runtime = {
    claimAudioIngest(input) { calls.push(['claim', input]); return { session: { ...session, state: 'connecting' } }; },
    authorizeAudioHostStream(input) { calls.push(['authorize', input]); return session; },
    activateAudioIngest(input) { calls.push(['activate', input]); return { session }; },
    interruptAudioIngest(input) { calls.push(['interrupt', input]); return { code: 'interrupted' }; },
  };
  const source = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array([1, 2, 3, 4])); },
  });
  const response = await audioIngestRoute(
    ingestRequest(source), runtime, gameId, audioSessionId, 9_000,
    {
      relay, clock: () => 9_001,
      fetchImpl: async (url, options) => {
        assert.equal(url, `${relay.origin}/ingest`);
        assert.equal(options.headers.authorization, `Bearer ${ingestToken}`);
        assert.equal(options.headers[AUDIO_SESSION_HEADER], audioSessionId);
        assert.equal(options.headers[AUDIO_GENERATION_HEADER], '4');
        assert.equal(options.headers[AUDIO_CONNECTION_HEADER], connectionId);
        relayReader = options.body.getReader();
        assert.deepEqual((await relayReader.read()).value, new Uint8Array([1, 2, 3, 4]));
        return relayResponse();
      },
    },
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get(AUDIO_GENERATION_HEADER), '4');
  assert.equal(response.headers.has('authorization'), false);
  assert.deepEqual(calls.slice(0, 3).map(([kind]) => kind), ['claim', 'authorize', 'activate']);
  await relayReader.cancel();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.at(-1)[0], 'interrupt');
  assert.equal(calls.at(-1)[1].reasonCode, 'ingest_lost');
});

test('ingest rechunks a coalesced delivery before the private relay hop', async () => {
  const sizes = [];
  const runtime = {
    claimAudioIngest() { return { session: { ...session, state: 'connecting' } }; },
    authorizeAudioHostStream() { return session; },
    activateAudioIngest() { return { session }; },
    interruptAudioIngest() { return { code: 'interrupted' }; },
  };
  const source = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(MAX_STREAM_CHUNK_BYTES * 3));
      controller.close();
    },
  });
  const response = await audioIngestRoute(
    ingestRequest(source), runtime, gameId, audioSessionId, 9_000,
    { relay, clock: () => 9_001, fetchImpl: async (_url, options) => {
      const reader = options.body.getReader();
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        sizes.push(item.value.byteLength);
      }
      return relayResponse();
    } },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(sizes, Array(3).fill(MAX_STREAM_CHUNK_BYTES));
});

test('relay failure and malformed success interrupt the claimed ingest without reflecting detail', async () => {
  for (const scenario of ['throw', 'wrong_generation']) {
    const calls = [];
    const runtime = {
      claimAudioIngest() { return { session: { ...session, state: 'connecting' } }; },
      authorizeAudioHostStream() { return session; },
      activateAudioIngest() { calls.push(['activate']); return { session }; },
      interruptAudioIngest(input) { calls.push(['interrupt', input]); return { code: 'interrupted' }; },
    };
    const secretDetail = `relay-secret-${randomUUID()}`;
    const response = await audioIngestRoute(
      ingestRequest(new ReadableStream({ start(controller) { controller.close(); } })),
      runtime, gameId, audioSessionId, 9_000,
      { relay, clock: () => 9_001, fetchImpl: async () => {
        if (scenario === 'throw') throw new Error(secretDetail);
        return relayResponse({ ...session, generation: 5 });
      } },
    );
    assert.equal(response.status, 503);
    const text = await response.text();
    assert.equal(text.includes(secretDetail), false);
    assert.deepEqual(JSON.parse(text), { ok: false, code: 'audio_unavailable' });
    assert.equal(calls.some(([kind]) => kind === 'activate'), false);
    assert.ok(['relay_unavailable', 'malformed_relay'].includes(
      calls.find(([kind]) => kind === 'interrupt')[1].reasonCode,
    ));
  }
});

test('listen accepts exactly one authority and injects the private token only upstream', async () => {
  const calls = [];
  const runtime = {
    authorizeAudioParticipantStream(input) { calls.push(input); return session; },
  };
  const request = new Request(
    `https://play.cannabeats.social/api/games/${gameId}/audio/sessions/${audioSessionId}/listen`,
    { headers: {
      cookie: `${PARTICIPANT_COOKIE}=${participantToken}`,
      [AUDIO_CLIENT_HEADER]: AUDIO_CLIENT_CONTRACT,
    } },
  );
  const response = await audioListenRoute(request, runtime, gameId, audioSessionId, 9_000, {
    relay, clock: () => 9_001,
    fetchImpl: async (url, options) => {
      assert.equal(url, `${relay.origin}/listen`);
      assert.equal(options.headers.authorization, `Bearer ${listenToken}`);
      return relayResponse(session, 48_000, new Uint8Array([1, 2, 3, 4]));
    },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.has('authorization'), false);
  assert.equal(response.headers.get(AUDIO_SESSION_HEADER), audioSessionId);
  assert.ok(calls.length >= 2);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new Uint8Array([1, 2, 3, 4]));

  const ambiguous = new Request(request.url, { headers: {
    authorization: `Bearer ${hostToken}`,
    cookie: `${PARTICIPANT_COOKIE}=${participantToken}`,
    [AUDIO_CLIENT_HEADER]: AUDIO_CLIENT_CONTRACT,
  } });
  const rejected = await audioListenRoute(ambiguous, runtime, gameId, audioSessionId);
  assert.equal(rejected.status, 401);
  assert.deepEqual(await rejected.json(), { ok: false, code: 'unauthorized' });
});

test('open listener authority is rechecked even while the relay is silent', async () => {
  let authorized = true;
  let checks = 0;
  const runtime = {
    authorizeAudioHostStream() {
      checks += 1;
      if (!authorized) throw new ReleaseStoreError('unauthorized');
      return session;
    },
  };
  const request = new Request(
    `https://play.cannabeats.social/api/games/${gameId}/audio/sessions/${audioSessionId}/listen`,
    { headers: {
      authorization: `Bearer ${hostToken}`,
      [AUDIO_CLIENT_HEADER]: AUDIO_CLIENT_CONTRACT,
    } },
  );
  const upstream = new ReadableStream({ start() {} });
  const response = await audioListenRoute(request, runtime, gameId, audioSessionId, 9_000, {
    relay, recheckMs: 5, clock: () => 9_001,
    fetchImpl: async () => relayResponse(session, 48_000, upstream),
  });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const reading = reader.read();
  authorized = false;
  await assert.rejects(reading, /stream_interrupted/u);
  assert.ok(checks >= 3);
});

test('authenticated proxy and private relay carry paced Host plus eight listeners within bounds', async () => {
  const server = createAudioRelay({ ingestToken, listenToken });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  let sourceController;
  let active = false;
  const runtime = {
    claimAudioIngest() { return { session: { ...session, state: 'connecting' } }; },
    authorizeAudioHostStream() { return { ...session, state: active ? 'active' : 'connecting' }; },
    activateAudioIngest() { active = true; return { session }; },
    interruptAudioIngest() { active = false; return { code: 'interrupted' }; },
    authorizeAudioParticipantStream() {
      if (!active) throw new ReleaseStoreError('unauthorized');
      return session;
    },
  };
  const source = new ReadableStream({ start(controller) { sourceController = controller; } });
  // Undici starts the streaming upstream request when the first body bytes are
  // available; one silent frame establishes the publisher before listeners join.
  sourceController.enqueue(new Uint8Array(4));
  const ingest = await audioIngestRoute(
    ingestRequest(source), runtime, gameId, audioSessionId, 9_000,
    { relay: { origin, ingestToken, listenToken }, clock: () => 9_001 },
  );
  assert.equal(ingest.status, 200);
  assert.equal(ingest.headers.has('authorization'), false);
  const listenUrl = `https://play.cannabeats.social/api/games/${gameId}/audio/sessions/${audioSessionId}/listen`;
  const requests = Array.from({ length: 8 }, () => new Request(listenUrl, { headers: {
    cookie: `${PARTICIPANT_COOKIE}=${participantToken}`,
    [AUDIO_CLIENT_HEADER]: AUDIO_CLIENT_CONTRACT,
  } }));
  requests.push(new Request(listenUrl, { headers: {
    authorization: `Bearer ${hostToken}`,
    [AUDIO_CLIENT_HEADER]: AUDIO_CLIENT_CONTRACT,
  } }));
  const listens = await Promise.all(requests.map((listenRequest) => audioListenRoute(
    listenRequest, runtime, gameId, audioSessionId, 9_002,
    { relay: { origin, ingestToken, listenToken }, clock: () => 9_003 },
  )));
  assert.deepEqual(listens.map(({ status }) => status), Array(9).fill(200));
  assert.equal(listens.every((listen) => !listen.headers.has('authorization')), true);
  const readers = listens.map((listen) => listen.body.getReader());
  const packet = new Uint8Array(480 * 4);
  const expectedBytes = packet.byteLength * 100;
  const received = readers.map(async (reader) => {
    let bytes = 0;
    while (bytes < expectedBytes) {
      const item = await reader.read();
      if (item.done) break;
      bytes += item.value.byteLength;
    }
    return bytes;
  });
  const rssBefore = process.memoryUsage().rss;
  const cpuBefore = process.cpuUsage();
  for (let index = 0; index < 100; index += 1) {
    sourceController.enqueue(packet);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  let timeout;
  const totals = await Promise.race([
    Promise.all(received),
    new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error('listener_timeout')), 5_000);
    }),
  ]).finally(() => clearTimeout(timeout));
  assert.deepEqual(totals, Array(9).fill(expectedBytes));
  const cpu = process.cpuUsage(cpuBefore);
  const rssGrowth = Math.max(0, process.memoryUsage().rss - rssBefore);
  assert.ok(rssGrowth < 128 * 1_024 * 1_024, `RSS growth ${rssGrowth}`);
  assert.ok(cpu.user + cpu.system < 5_000_000,
    `CPU time ${cpu.user + cpu.system} microseconds`);
  await Promise.all(readers.map((reader) => reader.cancel()));
  sourceController.close();
  await ingest.body.cancel();
  server.closeAllConnections();
  server.close();
  await once(server, 'close');
});

test('audio routes normalize missing authority, incompatible contracts, and native errors', async () => {
  let calls = 0;
  const runtime = { currentAudioSession() { calls += 1; } };
  const missing = await currentAudioSessionRoute(jsonRequest('/ignored', { token: null }),
    runtime, gameId);
  assert.equal(missing.status, 401);
  const incompatible = await currentAudioSessionRoute(jsonRequest('/ignored', { contract: '0' }),
    runtime, gameId);
  assert.equal(incompatible.status, 409);
  assert.equal(calls, 0);

  const detail = `native-secret-${randomUUID()}`;
  const unknown = await currentAudioSessionRoute(jsonRequest('/ignored'), {
    currentAudioSession() { throw new Error(detail); },
  }, gameId);
  assert.equal(unknown.status, 503);
  const text = await unknown.text();
  assert.equal(text.includes(detail), false);
  assert.deepEqual(JSON.parse(text), { ok: false, code: 'database_unavailable' });
});
