import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';

import {
  diagnosticExportRoute, diagnosticRecordRoute, hostReadinessRoute,
  probeRelayReadiness,
} from '../../web/lib/server/release/host-experience-routes.mjs';
import { HOST_CLIENT_HEADER } from '../../web/lib/server/release/host-routes.mjs';
import { ReleaseStoreError } from '../../web/lib/server/release/store.mjs';

function token() { return randomBytes(24).toString('base64url'); }

function request(value, { contract = '1', bearer = token(), method = 'POST' } = {}) {
  return new Request('https://play.cannabeats.social/api/host/test', {
    method,
    headers: {
      ...(value === undefined ? {} : { 'content-type': 'application/json' }),
      ...(contract === null ? {} : { [HOST_CLIENT_HEADER]: contract }),
      ...(bearer === null ? {} : { authorization: `Bearer ${bearer}` }),
    },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
  });
}

test('Host readiness validates compatibility and authority before a finite projection', async () => {
  const applicationSessionToken = token();
  const gameId = randomUUID();
  const calls = [];
  const runtime = {
    authorizeHostSession(input) { calls.push(['authorize', input]); },
    recoverHostGame(input) {
      calls.push(['recover', input]);
      return { game: {
        gameId, lifecycle: 'active', revision: 19,
        state: { privateAnswer: 'must not escape' }, audio: null,
      } };
    },
  };
  const response = await hostReadinessRoute(request(undefined, {
    bearer: applicationSessionToken, method: 'GET',
  }), runtime, 8_000, () => ({ state: 'ready', reason: 'ready' }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    code: 'host_readiness', hostContract: '1',
    relay: { state: 'ready', reason: 'ready' },
    activeGame: { gameId, lifecycle: 'active', revision: 19 },
  });
  assert.deepEqual(calls, [
    ['authorize', { token: applicationSessionToken, kind: 'application', now: 8_000 }],
    ['recover', {
      hostSessionKind: 'application', hostSessionToken: applicationSessionToken, now: 8_000,
    }],
  ]);

  const malformedRelay = await hostReadinessRoute(request(undefined, {
    bearer: applicationSessionToken, method: 'GET',
  }), runtime, 8_001, () => ({ state: 'maybe', reason: 'caller-authored' }));
  assert.equal(malformedRelay.status, 200);
  assert.deepEqual((await malformedRelay.json()).relay, {
    state: 'blocked', reason: 'relay_unavailable',
  });

  for (const contract of [null, '0', '1, 2']) {
    const incompatible = await hostReadinessRoute(request(undefined, {
      bearer: applicationSessionToken, contract, method: 'GET',
    }), { authorizeHostSession: () => assert.fail('incompatible build must not authorize') });
    assert.equal(incompatible.status, 409);
    assert.deepEqual(await incompatible.json(), { ok: false, code: 'upgrade_required' });
  }
});

test('relay readiness normalizes configuration, malformed output, and success', async () => {
  const unavailable = await probeRelayReadiness({ environment: {} });
  assert.deepEqual(unavailable, { state: 'blocked', reason: 'relay_unavailable' });

  const malformed = await probeRelayReadiness({
    environment: { CANNABEATS_RELAY_ORIGIN: 'http://relay:8090' },
    fetchImpl: async () => new Response(JSON.stringify({ ok: true, listeners: 'private' }), {
      headers: { 'content-type': 'application/json' },
    }),
  });
  assert.deepEqual(malformed, { state: 'blocked', reason: 'relay_unavailable' });

  const oversized = await probeRelayReadiness({
    environment: { CANNABEATS_RELAY_ORIGIN: 'http://relay:8090' },
    fetchImpl: async () => new Response(`{"ok":true,"padding":"${'x'.repeat(4_096)}"}`, {
      headers: { 'content-type': 'application/json' },
    }),
  });
  assert.deepEqual(oversized, { state: 'blocked', reason: 'relay_unavailable' });

  const timedOut = await probeRelayReadiness({
    environment: { CANNABEATS_RELAY_ORIGIN: 'http://relay:8090' }, timeoutMs: 1,
    fetchImpl: async (_url, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('caller detail')), {
        once: true,
      });
    }),
  });
  assert.deepEqual(timedOut, { state: 'blocked', reason: 'relay_unavailable' });

  let received;
  const ready = await probeRelayReadiness({
    environment: { CANNABEATS_RELAY_ORIGIN: 'http://relay:8090' },
    fetchImpl: async (url, options) => {
      received = { url, contract: options.headers['x-cannabeats-audio-contract'] };
      return new Response(JSON.stringify({ ok: true, listeners: 0, publisherActive: false }), {
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  assert.deepEqual(ready, { state: 'ready', reason: 'ready' });
  assert.deepEqual(received, { url: 'http://relay:8090/health', contract: '1' });
});

test('diagnostic record and export routes forward only bounded application authority', async () => {
  const applicationSessionToken = token();
  const gameId = randomUUID();
  const input = {
    recordId: randomUUID(), kind: 'audio', code: 'buffer_dropped', metricValue: 3,
  };
  let recorded;
  const runtime = {
    recordDiagnostic(value) {
      recorded = value;
      return { code: 'diagnostic_recorded', record: { ...input, gameId } };
    },
    exportDiagnostics(value) {
      assert.deepEqual(value, { gameId, applicationSessionToken, now: 10_001 });
      return { code: 'diagnostic_export', generatedAt: 10_001, game: {},
        gameEvents: [], playback: [], audio: [], diagnostics: [] };
    },
  };
  const created = await diagnosticRecordRoute(request(input, {
    bearer: applicationSessionToken,
  }), runtime, gameId, 10_000);
  assert.equal(created.status, 201);
  assert.deepEqual(recorded, { ...input, gameId, applicationSessionToken, now: 10_000 });

  const exported = await diagnosticExportRoute(request(undefined, {
    bearer: applicationSessionToken, method: 'GET',
  }), runtime, gameId, 10_001);
  assert.equal(exported.status, 200);
  assert.equal((await exported.text()).includes(applicationSessionToken), false);
});

test('Host experience failures stay finite and do not reflect native or supplied content', async () => {
  const secret = token();
  const gameId = randomUUID();
  const malformed = await diagnosticRecordRoute(request({
    recordId: randomUUID(), kind: 'host', code: 'readiness_blocked', metricValue: 1,
    extra: secret,
  }), { recordDiagnostic: () => assert.fail('invalid body must not reach the owner') }, gameId);
  assert.equal(malformed.status, 400);

  const capacity = await diagnosticRecordRoute(request({
    recordId: randomUUID(), kind: 'host', code: 'readiness_blocked', metricValue: 1,
  }), { recordDiagnostic: () => { throw new ReleaseStoreError('diagnostic_capacity'); } }, gameId);
  assert.equal(capacity.status, 409);
  assert.deepEqual(await capacity.json(), { ok: false, code: 'diagnostic_capacity' });

  const native = await diagnosticExportRoute(request(undefined, { method: 'GET' }), {
    exportDiagnostics: () => { throw new Error(`SQLite /private/${secret}`); },
  }, gameId);
  assert.equal(native.status, 503);
  const text = await native.text();
  assert.equal(text.includes(secret), false);
  assert.equal(text.includes('SQLite'), false);
});
