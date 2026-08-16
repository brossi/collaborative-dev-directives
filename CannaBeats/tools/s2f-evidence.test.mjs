import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import {
  acceptSynchronizationSample,
  canonicalUploadedEnvelopeBytes,
  composeUploadedEnvelope,
  createServerContextFixtureForTest,
  createSynchronizationIssuanceFixtureForTest,
  mapMeasurementAlignment,
} from '../web/lib/s2e-e2-correlation.mjs';
import { validateMeasurementJson } from '../web/lib/s2e-e1-contract.mjs';
import {
  S2FEvidenceError,
  browserGapRecord,
  coverageNoticeRecords,
  createOneShotFaultProxy,
  readCompleteTrace,
  readHostSample,
  summarizeEvidence,
} from './s2f-evidence.mjs';

const bytes = (value) => Buffer.from(JSON.stringify(value));
const id = (value) => `123e4567-e89b-42d3-a456-${value.toString(16).padStart(12, '0')}`;
const TRACE = id(9000);
const RUN = id(9001);
const SEGMENT = id(9002);
const LEASE = id(9003);
const INSTANCES = Object.freeze({
  'listener-a': id(1), 'listener-b': id(2), source: id(3), relay: id(4),
});

function listenerMeasurements() {
  return {
    connectionAttemptSequence: 0, receivedBytes: 192000, receivedFrames: 48000,
    chunkCount: 100, chunkGap: { status: 'observed', count: 99, meanMs: 10, maxMs: 20 },
    reconnectCount: 0, terminalCategory: 'open',
    bufferDepth: { status: 'observed', sampleCount: 10, currentMs: 400, minMs: 300,
      maxMs: 500, meanMs: 410, trendMsPerSecond: 2 },
    underrunCount: 0, underrunDurationMs: 0, reprimeCount: 0,
    windowStartedInUnderrun: false, overflowCount: 0, discardedFrames: 0,
    resetCount: 0, sourceSampleRate: 48000, sourceChannels: 2,
    outputSampleRate: 48000, nominalRateRatio: 1, audioContextState: 'running',
    baseLatencyMs: { status: 'observed', value: 12 }, outputLatencyMs: { status: 'unsupported' },
    visibilityState: 'visible', suspensionCount: 0,
    longTasks: { status: 'observed', count: 0, maxDurationMs: 0 },
    signalPresence: 'present', clippingSeverity: 'none', browserFamily: 'safari',
    browserMajor: { status: 'observed', value: 26 }, osFamily: 'ios',
    displayMode: 'browser', implementationVersion: 1,
  };
}

function sourceMeasurements() {
  return {
    sampleRate: 48000, channels: 2, encoding: 's16le', capturedFrames: 48000,
    enqueuedFrames: 48000, publishedFrames: 48000, publishedBytes: 192000,
    captureGapCount: 0, droppedUploadCount: 0, reconnectCount: 0,
    publisherRestartCount: 0, publisherState: 'publishing', playbackObservation: 'playing',
  };
}

function relayMeasurements() {
  return {
    sampleRate: 48000, channels: 2, encoding: 's16le', ingressFrames: 48000,
    ingressBytes: 192000, ingressGapCount: 0, rejectedIngressCount: 0,
    droppedIngressCount: 0, acceptedListenerCount: 2, closedListenerCount: 1,
    deliveredBytes: 192000, backpressureClosureCount: 0,
    generationFenceDisconnectCount: 1, activeListenerCount: 1,
  };
}

function envelope(producer, sequence = 0, traceId = TRACE) {
  const instanceId = INSTANCES[producer];
  const kind = producer.startsWith('listener') ? 'listener_window' : `${producer}_window`;
  const monotonicStartMs = 120 + (sequence * 10_000);
  const measurement = validateMeasurementJson(bytes({
    schemaVersion: 1, kind, instanceId, sequence, monotonicStartMs,
    durationMs: 10_000,
    measurements: producer.startsWith('listener') ? listenerMeasurements()
      : producer === 'source' ? sourceMeasurements() : relayMeasurements(),
  }));
  const sampleId = id(100 + (Object.keys(INSTANCES).indexOf(producer) * 1000) + sequence);
  const issuance = createSynchronizationIssuanceFixtureForTest(bytes({
    sampleId, timebaseId: traceId, instanceId,
    serverReceiveMs: monotonicStartMs + 880, serverSendMs: monotonicStartMs + 885,
  }));
  const sample = acceptSynchronizationSample(bytes({
    sampleId, instanceId, localSendMs: monotonicStartMs - 20, localReceiveMs: monotonicStartMs,
  }), issuance);
  const authorityKind = producer.startsWith('listener') ? 'listener' : producer;
  const authority = authorityKind === 'listener'
    ? { authorityKind, role: 'member', listenerInstanceId: instanceId }
    : authorityKind === 'source'
      ? { authorityKind, role: 'source', sourceId: id(8000), sourceInstanceId: instanceId }
      : { authorityKind, role: 'relay', relayGenerationId: instanceId };
  const context = createServerContextFixtureForTest(bytes({
    contextVersion: 1, traceId, runId: RUN, runGeneration: 1,
    correlationSegmentId: SEGMENT, leaseId: LEASE, ...authority,
  }));
  return JSON.parse(Buffer.from(canonicalUploadedEnvelopeBytes(composeUploadedEnvelope(
    measurement, mapMeasurementAlignment(measurement, sample), context,
  ))).toString('utf8'));
}

function input(overrides = {}) {
  return {
    version: 1,
    traceId: TRACE,
    roleInstances: Object.fromEntries(Object.entries(INSTANCES).map(([key, value]) => [key, { initial: value }])),
    attempts: [
      { role: 'listener-a', routeFamily: 'listener-sync', action: 'synchronize', monotonicMs: 1 },
      { role: 'listener-b', routeFamily: 'listener-sync', action: 'synchronize', monotonicMs: 2 },
      { role: 'source', routeFamily: 'source-sync', action: 'synchronize', monotonicMs: 3 },
      { role: 'relay', routeFamily: 'relay-sync', action: 'synchronize', monotonicMs: 4 },
    ],
    reports: Object.keys(INSTANCES).map((producer) => envelope(producer)),
    browserGaps: { 'listener-a': 1, 'listener-b': 2 },
    coverageNotices: [{ role: 'source', code: 'coverage_gap' }],
    hostSamples: [
      { hostRole: 'application', monotonicMs: 0, totalCpuTicks: 100,
        processes: [{ service: 'game', cpuTicks: 10, rssBytes: 1000 }] },
      { hostRole: 'application', monotonicMs: 5000, totalCpuTicks: 200,
        processes: [{ service: 'game', cpuTicks: 20, rssBytes: 1200 }] },
      { hostRole: 'source', monotonicMs: 0, totalCpuTicks: 50,
        processes: [{ service: 'source', cpuTicks: 5, rssBytes: 800 }] },
      { hostRole: 'source', monotonicMs: 5000, totalCpuTicks: 150,
        processes: [{ service: 'source', cpuTicks: 15, rssBytes: 900 }] },
    ],
    ...overrides,
  };
}

function code(expected, action) {
  assert.throws(action, (error) => error instanceof S2FEvidenceError && error.code === expected);
}

test('sanitized summary counts restored accepted samples and fixed gap sources', () => {
  const result = summarizeEvidence(input());
  assert.deepEqual(result.producers['listener-a'], {
    attempts: 1, acceptedSampleCount: 1, acceptedWindowCount: 1,
    acceptedCoverageMs: 10_000, retainedCoverageGapCount: 0,
    lastSequence: 0, gapCount: 1, noticeCount: null,
    instances: { initial: {
      acceptedSampleCount: 1, acceptedWindowCount: 1,
      acceptedCoverageMs: 10_000, retainedCoverageGapCount: 0, lastSequence: 0,
    } },
  });
  assert.equal(result.producers.source.gapCount, 0);
  assert.equal(result.producers.source.noticeCount, 1);
  assert.equal(result.hosts.application.cpuPercent.p95, 10);
  assert.equal(result.hosts.application.rssBytes.max, 1200);
  assert.deepEqual(Object.keys(result), ['version', 'producers', 'hosts']);
  assert.equal(JSON.stringify(result).includes(INSTANCES['listener-a']), false);
  assert.equal(JSON.stringify(result).includes(TRACE), false);
});

test('HTTP attempts cannot impersonate accepted E2 samples', () => {
  const attempts = Array.from({ length: 30 }, (_, index) => ({
    role: 'listener-a', routeFamily: 'listener-sync', action: 'synchronize', monotonicMs: index,
  }));
  const reports = Array.from({ length: 24 }, (_, index) => envelope('listener-a', index));
  const result = summarizeEvidence(input({ attempts, reports }));
  assert.equal(result.producers['listener-a'].attempts, 30);
  assert.equal(result.producers['listener-a'].acceptedSampleCount, 24);
  assert.equal(result.producers['listener-a'].acceptedCoverageMs, 240_000);
});

test('instance labels keep retired and successor evidence separate without retaining UUIDs', () => {
  const successorId = id(5000);
  const result = summarizeEvidence(input({
    roleInstances: {
      ...input().roleInstances,
      'listener-a': { initial: INSTANCES['listener-a'], 'reset-1': successorId },
    },
    reports: [envelope('listener-a', 0)],
  }));
  assert.equal(result.producers['listener-a'].instances.initial.lastSequence, 0);
  assert.deepEqual(result.producers['listener-a'].instances['reset-1'], {
    acceptedSampleCount: 0, acceptedWindowCount: 0,
    acceptedCoverageMs: 0, retainedCoverageGapCount: 0, lastSequence: null,
  });
  assert.equal(JSON.stringify(result).includes(successorId), false);
});

test('coverage is the interval union and retained discontinuities are counted', () => {
  const contiguous = summarizeEvidence(input({
    reports: [envelope('source', 0), envelope('source', 1)],
  }));
  assert.equal(contiguous.producers.source.acceptedCoverageMs, 20_000);
  assert.equal(contiguous.producers.source.gapCount, 0);
  const gap = summarizeEvidence(input({
    reports: [envelope('source', 0), envelope('source', 2)],
  }));
  assert.equal(gap.producers.source.acceptedCoverageMs, 20_000);
  assert.equal(gap.producers.source.gapCount, 1);
});

test('duplicate report identity and role substitution fail closed', () => {
  const report = envelope('listener-a');
  code('report_duplicate', () => summarizeEvidence(input({ reports: [report, report] })));
  code('evidence_invalid', () => summarizeEvidence(input({
    roleInstances: { ...input().roleInstances, 'listener-b': { initial: INSTANCES['listener-a'] } },
  })));
  code('report_invalid', () => summarizeEvidence(input({ reports: [envelope('listener-a', 0, id(9999))] })));
});

test('fixed attempt, notice, host, and identity capacities reject max plus one', () => {
  for (const count of [511, 512]) {
    const accepted = summarizeEvidence(input({
      attempts: Array.from({ length: count }, (_, index) => ({
        role: 'source', routeFamily: 'source-sync', action: 'synchronize', monotonicMs: index,
      })),
    }));
    assert.equal(accepted.producers.source.attempts, count);
  }
  const attempts = Array.from({ length: 513 }, (_, index) => ({
    role: 'source', routeFamily: 'source-sync', action: 'synchronize', monotonicMs: index,
  }));
  code('evidence_invalid', () => summarizeEvidence(input({ attempts })));
  const coverageNotices = Array.from({ length: 513 }, () => ({ role: 'relay', code: 'coverage_gap' }));
  code('evidence_invalid', () => summarizeEvidence(input({ coverageNotices })));
  assert.equal(summarizeEvidence(input({
    coverageNotices: Array.from({ length: 512 }, () => ({ role: 'relay', code: 'coverage_gap' })),
  })).producers.relay.noticeCount, 512);
  code('evidence_invalid', () => summarizeEvidence(input({ hostSamples: [] })));
  const relayInstances = Object.fromEntries(
    Array.from({ length: 16 }, (_, index) => [`g-${index}`, id(6000 + index)]),
  );
  assert.equal(Object.keys(summarizeEvidence(input({
    roleInstances: { ...input().roleInstances, relay: relayInstances },
  })).producers.relay.instances).length, 16);
  code('evidence_invalid', () => summarizeEvidence(input({
    roleInstances: {
      ...input().roleInstances,
      relay: Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`g-${index}`, id(6000 + index)])),
    },
  })));
});

test('browser gap input is fixed to listener roles and safe integers', () => {
  assert.deepEqual(browserGapRecord('listener-b', 3), { role: 'listener-b', gapCount: 3 });
  code('role_invalid', () => browserGapRecord('source', 0));
  code('evidence_invalid', () => browserGapRecord('listener-a', -1));
});

test('journal filtering retains only exact source and relay coverage notices', () => {
  assert.deepEqual(coverageNoticeRecords('source', [
    'coverage_gap', 'unavailable', 'coverage_gap details',
    JSON.stringify({ service: 'managed-source-controller',
      event: 'diagnostics.reporter_unavailable', reasonCode: 'coverage_gap', private: 'ignored' }),
  ]), [
    { role: 'source', code: 'coverage_gap' },
    { role: 'source', code: 'coverage_gap' },
  ]);
  code('evidence_invalid', () => coverageNoticeRecords('listener-a', ['coverage_gap']));
});

test('host sampler reads only allowlisted proc scalars and excludes pid and paths', async () => {
  const values = new Map([
    ['/proc/stat', 'cpu  100 2 3 400 5 6 7 8 9 10\n'],
    ['/proc/42/stat', '42 (game worker) R 1 1 1 1 1 1 1 1 1 1 20 5 0 0\n'],
    ['/proc/42/status', 'Name:\tgame\nVmRSS:\t123 kB\n'],
  ]);
  const sample = await readHostSample({
    hostRole: 'application', allowlistedProcesses: new Map([['game', 42]]), monotonicMs: 5000,
    readText: async (path) => {
      if (!values.has(path)) throw new Error('unexpected');
      return values.get(path);
    },
  });
  assert.deepEqual(sample, {
    hostRole: 'application', monotonicMs: 5000, totalCpuTicks: 550,
    processes: [{ service: 'game', cpuTicks: 25, rssBytes: 125952 }],
  });
  assert.equal(JSON.stringify(sample).includes('/proc'), false);
  assert.equal(JSON.stringify(sample).includes('42'), false);
});

test('complete trace reader follows the exact cursor snapshot and rejects metadata drift', async () => {
  const first = envelope('listener-a', 0);
  const second = envelope('listener-a', 1);
  const metadata = { traceId: TRACE, status: 'active', startedAtMs: 1,
    endedAtMs: null, endReason: null, reportCount: 2 };
  let calls = 0;
  const reports = await readCompleteTrace({
    traceId: TRACE,
    collector: { readTrace: async ({ cursor }) => {
      calls += 1;
      return cursor === null
        ? { status: 'found', complete: false, metadata, reports: [first], cursor: { token: 1 } }
        : { status: 'found', complete: true, metadata, reports: [second], cursor: null };
    } },
  });
  assert.equal(calls, 2);
  assert.equal(reports.length, 2);

  await assert.rejects(readCompleteTrace({
    traceId: TRACE,
    collector: { readTrace: async ({ cursor }) => cursor === null
      ? { status: 'found', complete: false, metadata, reports: [first], cursor: { token: 1 } }
      : { status: 'found', complete: true, metadata: { ...metadata, reportCount: 3 },
        reports: [second], cursor: null } },
  }), (error) => error instanceof S2FEvidenceError && error.code === 'collector_response_invalid');
});

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

async function close(server) {
  await new Promise((resolve) => server.close(resolve));
}

test('one-shot malformed proxy is loopback-only, body-silent, and then forwards', async () => {
  const upstream = http.createServer(async (request, response) => {
    for await (const _chunk of request) { /* drain */ }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"status":"accepted"}');
  });
  const upstreamPort = await listen(upstream);
  const attempts = [];
  const proxy = createOneShotFaultProxy({
    upstreamOrigin: `http://127.0.0.1:${upstreamPort}/`, mode: 'malformed',
    routeFamily: 'listener-sync', identityRoleMap: new Map([[INSTANCES['listener-a'], 'listener-a']]),
    onAttempt: (value) => attempts.push(value),
  });
  const proxyPort = await listen(proxy);
  try {
    const body = JSON.stringify({
      action: 'synchronize', requestId: id(7000), grantId: INSTANCES['listener-a'],
    });
    const first = await fetch(`http://127.0.0.1:${proxyPort}/v1`, { method: 'POST', body });
    assert.equal(await first.text(), '{');
    const second = await fetch(`http://127.0.0.1:${proxyPort}/v1`, { method: 'POST', body });
    assert.equal(await second.text(), '{"status":"accepted"}');
    const escaped = await fetch(`http://127.0.0.1:${proxyPort}//example.com/private`, {
      method: 'POST', body,
    });
    assert.equal(escaped.status, 503);
    assert.equal(attempts.length, 2);
    assert.equal(JSON.stringify(attempts).includes(INSTANCES['listener-a']), false);
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('proxy rejects non-loopback upstream and oversized request bodies', async () => {
  code('configuration_invalid', () => createOneShotFaultProxy({
    upstreamOrigin: 'https://example.com/', mode: 'forward',
    routeFamily: 'relay-sync', identityRoleMap: new Map([[INSTANCES.relay, 'relay']]),
  }));
  const upstream = http.createServer((_request, response) => response.end('{}'));
  const upstreamPort = await listen(upstream);
  const proxy = createOneShotFaultProxy({
    upstreamOrigin: `http://127.0.0.1:${upstreamPort}/`, mode: 'forward',
    routeFamily: 'source-sync', identityRoleMap: new Map([[INSTANCES.source, 'source']]),
  });
  const proxyPort = await listen(proxy);
  try {
    const response = await fetch(`http://127.0.0.1:${proxyPort}/v1`, {
      method: 'POST', body: Buffer.alloc(8193),
    });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      error: 'Diagnostics are temporarily unavailable.', code: 'diagnostic_unavailable',
    });
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('post-response loss is one-shot and passthrough preserves authentication without logging it', async () => {
  const seen = [];
  const upstream = http.createServer(async (request, response) => {
    const body = await Array.fromAsync(request);
    seen.push({ authorization: request.headers.authorization, bytes: Buffer.concat(body).length });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"status":"accepted"}');
  });
  const upstreamPort = await listen(upstream);
  const proxy = createOneShotFaultProxy({
    upstreamOrigin: `http://127.0.0.1:${upstreamPort}/`, mode: 'drop-after-response',
    routeFamily: 'passthrough',
  });
  const proxyPort = await listen(proxy);
  try {
    await assert.rejects(fetch(`http://127.0.0.1:${proxyPort}/mutation`, {
      method: 'POST', headers: { authorization: 'Bearer private-value', 'content-type': 'application/json' },
      body: '{"operation":"commit"}',
    }));
    const retry = await fetch(`http://127.0.0.1:${proxyPort}/mutation`, {
      method: 'POST', headers: { authorization: 'Bearer private-value', 'content-type': 'application/json' },
      body: '{"operation":"commit"}',
    });
    assert.equal(await retry.text(), '{"status":"accepted"}');
    assert.deepEqual(seen, [
      { authorization: 'Bearer private-value', bytes: 22 },
      { authorization: 'Bearer private-value', bytes: 22 },
    ]);
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('collector synchronization profile binds nested instance identity to role', async () => {
  const upstream = http.createServer(async (request, response) => {
    for await (const _chunk of request) { /* drain */ }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"status":"accepted"}');
  });
  const upstreamPort = await listen(upstream);
  const attempts = [];
  const proxy = createOneShotFaultProxy({
    upstreamOrigin: `http://127.0.0.1:${upstreamPort}/`, mode: 'forward',
    routeFamily: 'collector-sync',
    identityRoleMap: new Map([[INSTANCES['listener-b'], 'listener-b']]),
    onAttempt: (value) => attempts.push(value),
  });
  const proxyPort = await listen(proxy);
  try {
    const response = await fetch(
      `http://127.0.0.1:${proxyPort}/v1/game/synchronization/issue`,
      { method: 'POST', body: JSON.stringify({
        traceId: TRACE, issuance: { instanceId: INSTANCES['listener-b'] },
      }) },
    );
    assert.equal(response.status, 200);
    assert.equal(attempts[0].role, 'listener-b');
    const wrong = await fetch(
      `http://127.0.0.1:${proxyPort}/v1/game/synchronization/issue`,
      { method: 'POST', body: JSON.stringify({ traceId: TRACE, issuance: { instanceId: id(7777) } }) },
    );
    assert.equal(wrong.status, 503);
    assert.equal(attempts.length, 1);
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('upstream deadline and response cap fail finitely', async () => {
  let heldResponse;
  const upstream = http.createServer((_request, response) => { heldResponse = response; });
  const upstreamPort = await listen(upstream);
  const proxy = createOneShotFaultProxy({
    upstreamOrigin: `http://127.0.0.1:${upstreamPort}/`, mode: 'forward',
    routeFamily: 'passthrough', deadlineMs: 20,
  });
  const proxyPort = await listen(proxy);
  try {
    const started = performance.now();
    const timedOut = await fetch(`http://127.0.0.1:${proxyPort}/held`, { method: 'POST', body: '{}' });
    assert.equal(timedOut.status, 503);
    assert.ok(performance.now() - started < 500);
  } finally {
    heldResponse?.destroy();
    await close(proxy);
    await close(upstream);
  }

  const oversized = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(Buffer.alloc(8193));
  });
  const oversizedPort = await listen(oversized);
  const bounded = createOneShotFaultProxy({
    upstreamOrigin: `http://127.0.0.1:${oversizedPort}/`, mode: 'forward',
    routeFamily: 'passthrough',
  });
  const boundedPort = await listen(bounded);
  try {
    const response = await fetch(`http://127.0.0.1:${boundedPort}/large`, { method: 'POST', body: '{}' });
    assert.equal(response.status, 503);
  } finally {
    await close(bounded);
    await close(oversized);
  }
});

test('concurrent requests consume a one-shot fault exactly once', async () => {
  const upstream = http.createServer(async (request, response) => {
    for await (const _chunk of request) { /* drain */ }
    await new Promise((resolve) => setTimeout(resolve, 10));
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"status":"accepted"}');
  });
  const upstreamPort = await listen(upstream);
  const proxy = createOneShotFaultProxy({
    upstreamOrigin: `http://127.0.0.1:${upstreamPort}/`, mode: 'malformed',
    routeFamily: 'passthrough',
  });
  const proxyPort = await listen(proxy);
  try {
    const bodies = await Promise.all([1, 2].map(async () => {
      const response = await fetch(`http://127.0.0.1:${proxyPort}/mutation`, {
        method: 'POST', body: '{}',
      });
      return response.text();
    }));
    assert.deepEqual(bodies.sort(), ['{', '{"status":"accepted"}'].sort());
  } finally {
    await close(proxy);
    await close(upstream);
  }
});
