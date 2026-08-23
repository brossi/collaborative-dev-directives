import assert from 'node:assert/strict';
import {
  generateKeyPairSync, randomBytes, randomUUID, sign,
} from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import test from 'node:test';

import { loadCatalogArtifacts } from '../../web/lib/server/release/catalog.mjs';
import { DEFAULT_RULES } from '../../web/lib/server/release/game-state.mjs';
import { hostProofBytes } from '../../web/lib/server/release/host-authority.mjs';
import { createReleaseStore } from '../../web/lib/server/release/store.mjs';
import { createAudioRelay } from '../relay/server.mjs';

const releaseRoot = resolve(fileURLToPath(new URL('..', import.meta.url)), '..');
const webRoot = resolve(releaseRoot, 'web');
const standaloneRoot = resolve(webRoot, '.next/standalone');
const serverPath = resolve(standaloneRoot, 'server.js');

async function availablePort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const { port } = server.address();
  await new Promise((resolveClose) => server.close(resolveClose));
  return port;
}

async function waitFor(origin, path) {
  const deadline = Date.now() + 20_000;
  let last = 'no response';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}${path}`);
      const body = await response.json();
      return { response, body };
    } catch (error) {
      last = String(error);
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
  }
  throw new Error(`standalone runtime did not answer (${last})`);
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  let deadline;
  await Promise.race([
    once(child, 'exit'),
    new Promise((resolveStop) => { deadline = setTimeout(resolveStop, 2_000); }),
  ]).finally(() => clearTimeout(deadline));
  if (child.exitCode === null) {
    child.kill('SIGKILL');
    await once(child, 'exit');
  }
}

test('standalone Next isolates native-rate audio while preserving unified authority', async () => {
  const build = spawnSync('npm', ['run', 'build:do'], {
    cwd: webRoot,
    env: { ...process.env, NEXT_PUBLIC_CANNABEATS_BASE_PATH: '' },
    encoding: 'utf8',
  });
  assert.equal(build.status, 0, `${build.stdout}\n${build.stderr}`);
  const temporary = mkdtempSync(join(tmpdir(), 'cannabeats-next-runtime-'));
  const databasePath = join(temporary, 'cannabeats.sqlite3');
  const sourceCatalog = loadCatalogArtifacts({
    catalogPath: resolve(webRoot, 'data/catalog.json'),
    manifestPath: resolve(webRoot, 'data/catalog-manifest.json'),
  });
  const seedNow = Date.now();
  const seeded = createReleaseStore(databasePath, { catalog: sourceCatalog, now: seedNow });
  const relayIngestToken = randomBytes(24).toString('base64url');
  const relayListenToken = randomBytes(24).toString('base64url');
  const relayIngestPath = join(temporary, 'relay-ingest-token');
  const relayListenPath = join(temporary, 'relay-listen-token');
  writeFileSync(relayIngestPath, `${relayIngestToken}\n`, { mode: 0o400 });
  writeFileSync(relayListenPath, `${relayListenToken}\n`, { mode: 0o400 });
  const relay = createAudioRelay({
    ingestToken: relayIngestToken, listenToken: relayListenToken,
  });
  relay.listen(0, '127.0.0.1');
  await once(relay, 'listening');
  const relayOrigin = `http://127.0.0.1:${relay.address().port}`;
  const enrollmentCode = randomBytes(24).toString('base64url');
  const deviceId = randomUUID();
  const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publicKey = keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  seeded.issueEnrollment({ enrollmentCode, requestId: randomUUID(), now: seedNow + 1 });
  const challenge = randomBytes(24).toString('base64url');
  const sessionToken = randomBytes(24).toString('base64url');
  seeded.close();
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  let output = '';
  const child = spawn(process.execPath, [serverPath], {
    cwd: standaloneRoot,
    env: {
      ...process.env,
      HOSTNAME: '127.0.0.1',
      PORT: String(port),
      CANNABEATS_RUNTIME: 'unified',
      CANNABEATS_DATABASE_PATH: databasePath,
      CANNABEATS_RELAY_ORIGIN: relayOrigin,
      CANNABEATS_RELAY_INGEST_SECRET_FILE: relayIngestPath,
      CANNABEATS_RELAY_LISTEN_SECRET_FILE: relayListenPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  let audioRequest = null;
  let audioListenerReader = null;
  try {
    const health = await waitFor(origin, '/api/health');
    assert.equal(health.response.status, 200, output);
    assert.deepEqual(health.body, { ok: true, service: 'cannabeats' });
    const readiness = await waitFor(origin, '/api/ready');
    assert.equal(readiness.response.status, 200, `${JSON.stringify(readiness.body)}\n${output}`);
    assert.equal(readiness.body.ready, true);
    assert.equal(readiness.body.reason, 'ready');
    assert.equal(readiness.body.schemaGeneration, 1);
    assert.match(readiness.body.catalogVersion, /^sha256:[0-9a-f]{64}$/u);

    const malformedRedeem = await fetch(`${origin}/api/host/enrollments/redeem`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        enrollmentCode: 'XyxodeQysWzf4WPf7MB0wxz', requestId: randomUUID(),
        deviceId: randomUUID(), publicKey, label: 'Standalone Host',
      }),
    });
    const malformedRedeemBody = await malformedRedeem.json();
    assert.equal(malformedRedeem.status, 400, JSON.stringify(malformedRedeemBody));
    assert.deepEqual(malformedRedeemBody, { ok: false, code: 'invalid_request' });

    const redeem = await fetch(`${origin}/api/host/enrollments/redeem`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        enrollmentCode, requestId: randomUUID(), deviceId, publicKey, label: 'Standalone Host',
      }),
    });
    const redeemBody = await redeem.json();
    assert.equal(redeem.status, 201, JSON.stringify(redeemBody));
    assert.equal(redeemBody.code, 'device_enrolled');

    const challengeIssue = await fetch(`${origin}/api/host/challenges/issue`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ challenge, deviceId, requestId: randomUUID() }),
    });
    const challengeBody = await challengeIssue.json();
    assert.equal(challengeIssue.status, 201, JSON.stringify(challengeBody));
    const challengeProve = await fetch(`${origin}/api/host/challenges/prove`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        deviceId, challenge, sessionToken, requestId: randomUUID(),
        signature: sign('sha256', hostProofBytes({
          challenge, deviceId, origin: 'https://play.cannabeats.social',
        }), keys.privateKey).toString('base64'),
      }),
    });
    const proofBody = await challengeProve.json();
    assert.equal(challengeProve.status, 201, JSON.stringify(proofBody));
    assert.equal(proofBody.code, 'session_created');

    const hostReadiness = await fetch(`${origin}/api/host/readiness`, {
      headers: {
        authorization: `Bearer ${sessionToken}`, 'x-cannabeats-host-contract': '1',
      },
    });
    const hostReadinessBody = await hostReadiness.json();
    assert.equal(hostReadiness.status, 200, JSON.stringify(hostReadinessBody));
    assert.deepEqual(hostReadinessBody, {
      code: 'host_readiness', hostContract: '1', activeGame: null,
      relay: { state: 'ready', reason: 'ready' },
    });

    const devices = await fetch(`${origin}/api/host/devices`, {
      headers: { authorization: `Bearer ${sessionToken}` },
    });
    const deviceBody = await devices.json();
    assert.equal(devices.status, 200, JSON.stringify(deviceBody));
    assert.equal(deviceBody.devices.length, 1);
    assert.equal(deviceBody.devices[0].deviceId, deviceId);
    assert.equal(deviceBody.devices[0].label, 'Standalone Host');
    assert.equal(deviceBody.devices[0].authorizedAt, redeemBody.authorizedAt);
    assert.ok(Number.isSafeInteger(deviceBody.devices[0].lastProvedAt));
    assert.equal(deviceBody.devices[0].revokedAt, null);

    const ticket = randomBytes(24).toString('base64url');
    const ticketIssue = await fetch(`${origin}/api/host/web-tickets/issue`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${sessionToken}`, 'content-type': 'application/json',
        'x-cannabeats-host-contract': '1',
      },
      body: JSON.stringify({ ticket, requestId: randomUUID() }),
    });
    const ticketIssueBody = await ticketIssue.json();
    assert.equal(ticketIssue.status, 201, JSON.stringify(ticketIssueBody));
    const exchange = await fetch(`${origin}/api/host/web-tickets/exchange`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ticket }),
    });
    const exchangeBody = await exchange.json();
    assert.equal(exchange.status, 200, JSON.stringify(exchangeBody));
    const hostSetCookie = exchange.headers.get('set-cookie');
    assert.match(hostSetCookie,
      /^__Host-cannabeats-host=.*; Path=\/; Max-Age=\d+; Secure; HttpOnly; SameSite=Strict$/u);
    const hostCookie = hostSetCookie.split(';', 1)[0];

    const gameId = randomUUID();
    const create = await fetch(`${origin}/api/games`, {
      method: 'POST', headers: { cookie: hostCookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        catalogVersion: sourceCatalog.version, gameId, requestId: randomUUID(),
        rules: DEFAULT_RULES,
      }),
    });
    const createBody = await create.json();
    assert.equal(create.status, 201, JSON.stringify(createBody));
    assert.equal(createBody.gameId, gameId);
    assert.equal(createBody.revision, 0);

    const diagnosticId = randomUUID();
    const diagnostic = await fetch(`${origin}/api/games/${gameId}/diagnostics`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${sessionToken}`, 'content-type': 'application/json',
        'x-cannabeats-host-contract': '1',
      },
      body: JSON.stringify({
        recordId: diagnosticId, kind: 'host', code: 'readiness_blocked', metricValue: 1,
      }),
    });
    const diagnosticBody = await diagnostic.json();
    assert.equal(diagnostic.status, 201, JSON.stringify(diagnosticBody));
    assert.equal(diagnosticBody.record.recordId, diagnosticId);
    const diagnosticExport = await fetch(
      `${origin}/api/games/${gameId}/diagnostics/export`,
      { headers: {
        authorization: `Bearer ${sessionToken}`, 'x-cannabeats-host-contract': '1',
      } },
    );
    const diagnosticExportText = await diagnosticExport.text();
    assert.equal(diagnosticExport.status, 200, diagnosticExportText);
    assert.equal(diagnosticExportText.includes(gameId), false);
    assert.equal(diagnosticExportText.includes(deviceId), false);
    assert.equal(diagnosticExportText.includes(sessionToken), false);

    const inviteToken = randomBytes(24).toString('base64url');
    const invitation = await fetch(`${origin}/api/games/${gameId}/invitations`, {
      method: 'POST', headers: { cookie: hostCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: 0, inviteToken, requestId: randomUUID() }),
    });
    const invitationBody = await invitation.json();
    assert.equal(invitation.status, 201, JSON.stringify(invitationBody));
    assert.equal(JSON.stringify(invitationBody).includes(inviteToken), false);

    const participantId = randomUUID();
    const participantToken = randomBytes(24).toString('base64url');
    const admission = await fetch(`${origin}/api/games/${gameId}/participants`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        displayName: 'Standalone Player', inviteToken, participantId,
        requestId: randomUUID(), sessionToken: participantToken,
      }),
    });
    const admissionBody = await admission.json();
    assert.equal(admission.status, 201, JSON.stringify(admissionBody));
    const participantSetCookie = admission.headers.get('set-cookie');
    assert.match(participantSetCookie,
      /^__Host-cannabeats-participant=.*; Path=\/; Max-Age=34560000; Secure; HttpOnly; SameSite=Strict$/u);
    const participantCookie = participantSetCookie.split(';', 1)[0];

    async function action(role, cookie, expectedRevision, operation, payload = {}) {
      const response = await fetch(`${origin}/api/games/${gameId}/actions`, {
        method: 'POST',
        headers: {
          cookie, 'content-type': 'application/json',
          'x-cannabeats-client-contract': '3', 'x-cannabeats-game-role': role,
        },
        body: JSON.stringify({ expectedRevision, operation, payload, requestId: randomUUID() }),
      });
      const value = await response.json();
      assert.equal(response.status, 200, JSON.stringify(value));
      return value;
    }

    const started = await action('host', hostCookie, 2, 'start_game');
    assert.equal(started.state.phase, 'ready');

    const audioSessionId = randomUUID();
    const audioOpen = await fetch(`${origin}/api/games/${gameId}/audio/sessions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${sessionToken}`, 'content-type': 'application/json',
        'x-cannabeats-audio-contract': '1',
      },
      body: JSON.stringify({ audioSessionId, requestId: randomUUID() }),
    });
    const audioOpenBody = await audioOpen.json();
    assert.equal(audioOpen.status, 200, JSON.stringify(audioOpenBody));
    assert.equal(audioOpenBody.session.state, 'starting');

    const audioConnectionId = randomUUID();
    const audioIngestPromise = new Promise((resolveIngest, rejectIngest) => {
      audioRequest = httpRequest(
        `${origin}/api/games/${gameId}/audio/sessions/${audioSessionId}/ingest`,
        {
          method: 'POST',
          headers: {
          authorization: `Bearer ${sessionToken}`,
          'content-type': 'application/octet-stream',
          'x-cannabeats-audio-contract': '1',
          'x-cannabeats-audio-connection': audioConnectionId,
          'x-cannabeats-audio-rate': '48000',
          'x-cannabeats-audio-channels': '2',
          'x-cannabeats-audio-encoding': 's16le',
        },
        },
        resolveIngest,
      );
      audioRequest.once('error', rejectIngest);
    });
    const packet = new Uint8Array(480 * 2 * 2);
    let awaitingHeaders = true;
    const publishUntilHeaders = (async () => {
      while (awaitingHeaders) {
        if (!audioRequest.write(packet)) await once(audioRequest, 'drain');
        await new Promise((resolvePacket) => setTimeout(resolvePacket, 10));
      }
    })();
    let audioIngest;
    try {
      audioIngest = await Promise.race([
        audioIngestPromise,
        new Promise((_, reject) => setTimeout(
          () => reject(new Error(`standalone audio ingest did not return headers\n${output}`)), 5_000,
        )),
      ]);
    } finally {
      awaitingHeaders = false;
      await publishUntilHeaders;
    }
    assert.equal(audioIngest.statusCode, 200);
    let ingestResponseBytes = 0;
    audioIngest.on('data', (chunk) => { ingestResponseBytes += chunk.length; });

    const audioListener = await fetch(
      `${origin}/api/games/${gameId}/audio/sessions/${audioSessionId}/listen`,
      {
        headers: {
          authorization: `Bearer ${sessionToken}`,
          'x-cannabeats-audio-contract': '1',
        },
        signal: AbortSignal.timeout(10_000),
      },
    );
    assert.equal(audioListener.status, 200);
    audioListenerReader = audioListener.body.getReader();
    let listenerBytes = 0;
    const consumeListener = (async () => {
      while (listenerBytes < packet.byteLength * 500) {
        const item = await audioListenerReader.read();
        if (item.done) break;
        listenerBytes += item.value.byteLength;
      }
    })();

    let maximumProbeMs = 0;
    const probes = [
      { path: '/api/ready', headers: {} },
      {
        path: '/api/host/readiness',
        headers: {
          authorization: `Bearer ${sessionToken}`,
          'x-cannabeats-host-contract': '1',
        },
      },
      { path: `/api/games/${gameId}/host-snapshot`, headers: { cookie: hostCookie } },
    ];
    const probe = async () => {
      for (let index = 0; index < 24; index += 1) {
        const selected = probes[index % probes.length];
        const startedAt = performance.now();
        const response = await fetch(`${origin}${selected.path}`, {
          headers: selected.headers,
          signal: AbortSignal.timeout(750),
        });
        assert.equal(response.status, 200);
        await response.arrayBuffer();
        maximumProbeMs = Math.max(maximumProbeMs, performance.now() - startedAt);
        await new Promise((resolveProbe) => setTimeout(resolveProbe, 250));
      }
    };
    const publish = async () => {
      for (let index = 1; index < 600; index += 1) {
        if (!audioRequest.write(packet)) await once(audioRequest, 'drain');
        await new Promise((resolvePacket) => setTimeout(resolvePacket, 10));
      }
    };
    await Promise.all([probe(), publish(), consumeListener]);
    assert.ok(maximumProbeMs < 750, `maximum ordinary probe ${maximumProbeMs} ms`);
    assert.ok(listenerBytes >= packet.byteLength * 500, `${listenerBytes} listener bytes`);
    assert.equal(ingestResponseBytes, 0);
    await audioListenerReader.cancel();
    audioListenerReader = null;

    const preReveal = await fetch(`${origin}/api/games/${gameId}/snapshot`, {
      headers: { cookie: participantCookie },
    });
    const preRevealBody = await preReveal.json();
    assert.equal(preReveal.status, 200, JSON.stringify(preRevealBody));
    assert.equal('currentSong' in preRevealBody.state, false);
    assert.equal('placement' in preRevealBody.state, false);
    assert.equal('result' in preRevealBody.state, false);

    const begun = await action('host', hostCookie, started.revision, 'begin_round');
    audioRequest.end();
    for await (const _chunk of audioIngest) {}
    assert.equal(ingestResponseBytes, 0);
    const placed = await action('participant', participantCookie, begun.revision, 'place_song', {
      index: 0,
    });
    assert.equal('currentSong' in placed.state, false);
    const revealed = await action('host', hostCookie, placed.revision, 'reveal_answer');
    assert.equal(revealed.state.phase, 'revealed');
    const recovered = await fetch(`${origin}/api/games/participant-recovery`, {
      headers: { cookie: participantCookie },
    });
    const recoveredBody = await recovered.json();
    assert.equal(recovered.status, 200, JSON.stringify(recoveredBody));
    assert.equal(recoveredBody.gameId, gameId);
    assert.equal(recoveredBody.participantId, participantId);
    assert.equal(recoveredBody.state.currentSong.uri, revealed.state.currentSong.uri);
  } finally {
    await audioListenerReader?.cancel().catch(() => {});
    audioRequest?.destroy();
    await stopChild(child);
    relay.closeAllConnections();
    await new Promise((resolveClose) => relay.close(resolveClose));
    rmSync(temporary, { recursive: true, force: true });
  }
});
