import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { request } from 'node:http';
import { afterEach, test } from 'node:test';

import {
  AUDIO_CONTRACT, MAX_LISTENERS, MAX_PUBLISHER_CHUNK_BYTES, createAudioRelay,
} from '../relay/server.mjs';

const servers = [];
const ingestToken = randomBytes(24).toString('base64url');
const listenToken = randomBytes(24).toString('base64url');

afterEach(async () => {
  while (servers.length) {
    const server = servers.pop();
    server.closeAllConnections();
    if (server.listening) {
      server.close();
      await once(server, 'close');
    }
  }
});

async function setupRelay() {
  const server = createAudioRelay({ ingestToken, listenToken });
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { port: server.address().port, server };
}

function identity(overrides = {}) {
  return {
    sessionId: randomUUID(), generation: 1, connectionId: randomUUID(), rate: 48_000,
    ...overrides,
  };
}

function commonHeaders(value) {
  return {
    'x-cannabeats-audio-contract': AUDIO_CONTRACT,
    'x-cannabeats-audio-session': value.sessionId,
    'x-cannabeats-audio-generation': String(value.generation),
  };
}

function openPublisher(port, value, overrides = {}) {
  const headers = {
    ...commonHeaders(value),
    authorization: `Bearer ${ingestToken}`,
    'content-type': 'application/octet-stream',
    'x-cannabeats-audio-connection': value.connectionId,
    'x-cannabeats-audio-rate': String(value.rate),
    'x-cannabeats-audio-channels': '2',
    'x-cannabeats-audio-encoding': 's16le',
    ...overrides,
  };
  return new Promise((resolve, reject) => {
    const outgoing = request({ host: '127.0.0.1', port, path: '/ingest', method: 'POST', headers },
      (response) => resolve({ request: outgoing, response }));
    outgoing.once('error', reject);
    outgoing.flushHeaders();
  });
}

function openListener(port, value, overrides = {}) {
  const headers = {
    ...commonHeaders(value),
    authorization: `Bearer ${listenToken}`,
    ...overrides,
  };
  return new Promise((resolve, reject) => {
    const outgoing = request({ host: '127.0.0.1', port, path: '/listen', method: 'GET', headers },
      (response) => resolve({ request: outgoing, response }));
    outgoing.once('error', reject);
    outgoing.end();
  });
}

async function responseBody(response) {
  const chunks = [];
  for await (const chunk of response) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function health(port) {
  const response = await fetch(`http://127.0.0.1:${port}/health`, {
    headers: { 'x-cannabeats-audio-contract': AUDIO_CONTRACT },
  });
  assert.equal(response.status, 200);
  return response.json();
}

async function endPublisher(publisher) {
  const ended = once(publisher.response, 'end');
  publisher.request.end();
  publisher.response.resume();
  await ended;
}

test('relay accepts one exact publisher and fences duplicate or mismatched generations', async () => {
  const { port } = await setupRelay();
  const value = identity();
  const publisher = await openPublisher(port, value);
  assert.equal(publisher.response.statusCode, 200);
  assert.equal(publisher.response.headers['x-cannabeats-audio-session'], value.sessionId);

  const duplicate = await openPublisher(port, identity());
  assert.equal(duplicate.response.statusCode, 409);
  assert.deepEqual(JSON.parse(await responseBody(duplicate.response)), { code: 'publisher_busy' });
  const wrong = await openListener(port, { ...value, generation: 2 });
  assert.equal(wrong.response.statusCode, 409);
  assert.deepEqual(JSON.parse(await responseBody(wrong.response)), {
    code: 'generation_unavailable',
  });
  await endPublisher(publisher);

  const successor = await openPublisher(port, { ...identity(), generation: 2 });
  assert.equal(successor.response.statusCode, 200);
  await endPublisher(successor);
});

test('relay admits Host plus eight participants and rejects a tenth listener', async () => {
  const { port } = await setupRelay();
  const value = identity();
  const publisher = await openPublisher(port, value);
  const listeners = [];
  for (let index = 0; index < MAX_LISTENERS; index += 1) {
    const listener = await openListener(port, value);
    assert.equal(listener.response.statusCode, 200);
    listeners.push(listener);
  }
  assert.equal((await health(port)).listeners, 9);
  const overflow = await openListener(port, value);
  assert.equal(overflow.response.statusCode, 503);
  assert.deepEqual(JSON.parse(await responseBody(overflow.response)), {
    code: 'listener_capacity',
  });
  await endPublisher(publisher);
  for (const listener of listeners) listener.response.destroy();
});

test('split PCM frames are retained only until aligned and publisher end fences listeners', async () => {
  const { port } = await setupRelay();
  const value = identity();
  const publisher = await openPublisher(port, value);
  const listener = await openListener(port, value);
  const received = new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    listener.response.on('data', (chunk) => {
      chunks.push(chunk);
      size += chunk.length;
      if (size >= 8) resolve(Buffer.concat(chunks));
    });
  });
  publisher.request.write(Buffer.from([1, 2, 3]));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(listener.response.readableLength, 0);
  publisher.request.write(Buffer.from([4, 5, 6, 7, 8]));
  assert.deepEqual(await received, Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]));
  const closed = new Promise((resolve) => {
    listener.response.once('error', () => {});
    listener.response.once('close', resolve);
  });
  await endPublisher(publisher);
  await closed;
  assert.equal((await health(port)).listeners, 0);
});

test('coalesced publisher input is forwarded only as fixed aligned chunks', async () => {
  const { port } = await setupRelay();
  const value = identity();
  const publisher = await openPublisher(port, value);
  const listener = await openListener(port, value);
  listener.response.on('data', () => {});
  publisher.request.write(Buffer.alloc(MAX_PUBLISHER_CHUNK_BYTES * 3));
  const deadline = Date.now() + 2_000;
  while ((await health(port)).acceptedBytes < MAX_PUBLISHER_CHUNK_BYTES * 3
      && Date.now() < deadline) await new Promise((resolve) => setImmediate(resolve));
  const status = await health(port);
  assert.equal(status.acceptedBytes, MAX_PUBLISHER_CHUNK_BYTES * 3);
  assert.equal(status.maxForwardedChunkBytes, MAX_PUBLISHER_CHUNK_BYTES);
  await endPublisher(publisher);
  listener.response.destroy();
});

test('terminal partial PCM is rejected as a finite counter and never crosses a successor', async () => {
  const { port } = await setupRelay();
  const first = await openPublisher(port, identity());
  first.request.write(Buffer.from([1, 2, 3]));
  await endPublisher(first);
  assert.equal((await health(port)).malformedPublisherEnds, 1);

  const nextIdentity = identity({ generation: 2 });
  const second = await openPublisher(port, nextIdentity);
  const listener = await openListener(port, nextIdentity);
  const received = once(listener.response, 'data');
  second.request.write(Buffer.from([9, 10, 11, 12]));
  assert.deepEqual((await received)[0], Buffer.from([9, 10, 11, 12]));
  await endPublisher(second);
});

test('a listener that applies response backpressure is removed without a relay-side packet queue', async () => {
  const { port } = await setupRelay();
  const value = identity();
  const publisher = await openPublisher(port, value);
  const listener = await openListener(port, value);
  listener.response.pause();
  listener.response.once('error', () => {});
  for (let index = 0; index < 2_048; index += 1) {
    if (!publisher.request.write(Buffer.alloc(16 * 1_024))) {
      await once(publisher.request, 'drain');
    }
    if (index % 64 === 0 && (await health(port)).droppedListeners === 1) break;
  }
  const status = await health(port);
  assert.equal(status.listeners, 0);
  assert.equal(status.droppedListeners, 1);
  await endPublisher(publisher);
});

test('relay process restart begins without a retained publisher or listener generation', async () => {
  const first = await setupRelay();
  const value = identity();
  const publisher = await openPublisher(first.port, value);
  const listener = await openListener(first.port, value);
  publisher.response.once('error', () => {});
  listener.response.once('error', () => {});
  first.server.closeAllConnections();
  first.server.close();
  await once(first.server, 'close');
  servers.splice(servers.indexOf(first.server), 1);

  const second = await setupRelay();
  assert.deepEqual(await health(second.port), {
    ok: true, publisherActive: false, listeners: 0, acceptedBytes: 0,
    droppedListeners: 0, malformedPublisherEnds: 0, maxForwardedChunkBytes: 0,
    publisherConnections: 0,
  });
});

test('nine loopback listeners stay inside the fixed local relay resource envelope', async () => {
  const { port } = await setupRelay();
  const value = identity();
  const publisher = await openPublisher(port, value);
  const received = Array(MAX_LISTENERS).fill(0);
  const listeners = [];
  for (let index = 0; index < MAX_LISTENERS; index += 1) {
    const listener = await openListener(port, value);
    listener.response.on('data', (chunk) => { received[index] += chunk.length; });
    listeners.push(listener);
  }
  const rssBefore = process.memoryUsage().rss;
  const cpuBefore = process.cpuUsage();
  // 480 stereo frames are exactly 10 ms at 48 kHz. Pace the publisher at its
  // production media rate; a bulk-transfer burst is intentionally backpressure.
  const packet = Buffer.alloc(480 * 4);
  const packetCount = 100;
  for (let index = 0; index < packetCount; index += 1) {
    if (!publisher.request.write(packet)) await once(publisher.request, 'drain');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const expected = packet.length * packetCount;
  const deadline = Date.now() + 5_000;
  while (received.some((bytes) => bytes < expected) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.deepEqual(received, Array(MAX_LISTENERS).fill(expected));
  assert.equal((await health(port)).listeners, MAX_LISTENERS);
  const cpu = process.cpuUsage(cpuBefore);
  const rssGrowth = Math.max(0, process.memoryUsage().rss - rssBefore);
  assert.ok(rssGrowth < 128 * 1_024 * 1_024, `RSS growth ${rssGrowth}`);
  assert.ok(cpu.user + cpu.system < 5_000_000,
    `CPU time ${cpu.user + cpu.system} microseconds`);
  await endPublisher(publisher);
  for (const listener of listeners) listener.response.destroy();
});

test('relay rejects missing contracts, wrong secrets, malformed format, and query input finitely', async () => {
  const { port } = await setupRelay();
  const value = identity();
  for (const headers of [
    { 'x-cannabeats-audio-contract': '2' },
    { authorization: 'Bearer wrong' },
    { 'x-cannabeats-audio-rate': '96000' },
  ]) {
    const attempt = await openPublisher(port, value, headers);
    assert.notEqual(attempt.response.statusCode, 200);
    const body = JSON.parse(await responseBody(attempt.response));
    assert.ok(['invalid_request', 'unauthorized'].includes(body.code));
  }
  const queried = await new Promise((resolve, reject) => {
    const outgoing = request({
      host: '127.0.0.1', port, path: '/listen?token=forbidden', method: 'GET',
      headers: { ...commonHeaders(value), authorization: `Bearer ${listenToken}`,
        'x-cannabeats-audio-contract': AUDIO_CONTRACT },
    }, resolve);
    outgoing.once('error', reject);
    outgoing.end();
  });
  assert.equal(queried.statusCode, 400);
  assert.deepEqual(JSON.parse(await responseBody(queried)), { code: 'invalid_request' });
});
