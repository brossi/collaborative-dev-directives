import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { validateMeasurementJson } from '../lib/s2e-e1-contract.mjs';
import {
  acceptSynchronizationSample,
  composeUploadedEnvelope,
  createServerContextFixtureForTest,
  createSynchronizationIssuanceFixtureForTest,
  mapMeasurementAlignment,
} from '../lib/s2e-e2-correlation.mjs';
import { classifyDiagnosticEvidence } from '../lib/s2e-e3-comparison.mjs';

const TRACE = '10000000-0000-4000-8000-000000000001';
const RUN = '10000000-0000-4000-8000-000000000002';
const SEGMENT = '10000000-0000-4000-8000-000000000003';
const LEASE = '10000000-0000-4000-8000-000000000004';
const TIMEBASE = '10000000-0000-4000-8000-000000000005';
const SOURCE_ID = '10000000-0000-4000-8000-000000000006';
const bytes = (value) => Buffer.from(JSON.stringify(value));
const id = (number) => `20000000-0000-4000-8000-${String(number).padStart(12, '0')}`;

let sampleSequence = 100;

function sourceReport(instanceId, sequence, start, overrides = {}) {
  const measurements = {
    sampleRate: 48000, channels: 2, encoding: 's16le',
    capturedFrames: sequence * 48000,
    enqueuedFrames: sequence * 48000,
    publishedFrames: sequence * 48000,
    publishedBytes: sequence * 192000,
    captureGapCount: 0, droppedUploadCount: 0, reconnectCount: 0,
    publisherRestartCount: 0, publisherState: 'publishing',
    playbackObservation: 'playing',
    ...overrides,
  };
  return {
    schemaVersion: 1, kind: 'source_window', instanceId, sequence,
    monotonicStartMs: start, durationMs: 10000, measurements,
  };
}

function relayReport(instanceId, sequence, start, overrides = {}) {
  const measurements = {
    sampleRate: 48000, channels: 2, encoding: 's16le',
    ingressFrames: sequence * 48000,
    ingressBytes: sequence * 192000,
    ingressGapCount: 0, rejectedIngressCount: 0, droppedIngressCount: 0,
    acceptedListenerCount: 2, closedListenerCount: 0,
    deliveredBytes: sequence * 192000,
    backpressureClosureCount: 0, generationFenceDisconnectCount: 0,
    activeListenerCount: 2,
    ...overrides,
  };
  return {
    schemaVersion: 1, kind: 'relay_window', instanceId, sequence,
    monotonicStartMs: start, durationMs: 10000, measurements,
  };
}

function listenerReport(instanceId, start, overrides = {}) {
  const measurements = {
    connectionAttemptSequence: 0,
    receivedBytes: 192000,
    receivedFrames: 48000,
    chunkCount: 100,
    chunkGap: { status: 'observed', count: 99, meanMs: 10, maxMs: 20 },
    reconnectCount: 0,
    terminalCategory: 'open',
    bufferDepth: {
      status: 'observed', sampleCount: 10, currentMs: 400, minMs: 300,
      maxMs: 500, meanMs: 410, trendMsPerSecond: 2,
    },
    underrunCount: 0, underrunDurationMs: 0, reprimeCount: 0,
    windowStartedInUnderrun: false, overflowCount: 0, discardedFrames: 0,
    resetCount: 0, sourceSampleRate: 48000, sourceChannels: 2,
    outputSampleRate: 48000, nominalRateRatio: 1,
    audioContextState: 'running',
    baseLatencyMs: { status: 'observed', value: 12 },
    outputLatencyMs: { status: 'unsupported' },
    visibilityState: 'visible', suspensionCount: 0,
    longTasks: { status: 'observed', count: 0, maxDurationMs: 0 },
    signalPresence: 'present', clippingSeverity: 'none',
    browserFamily: 'safari', browserMajor: { status: 'observed', value: 18 },
    osFamily: 'ios', displayMode: 'browser', implementationVersion: 1,
    ...overrides,
  };
  return {
    schemaVersion: 1, kind: 'listener_window', instanceId, sequence: 1,
    monotonicStartMs: start, durationMs: 10000, measurements,
  };
}

function envelope(reportValue, family, {
  timebaseId = TIMEBASE,
  traceId = TRACE,
  segmentId = SEGMENT,
  leaseId = LEASE,
} = {}) {
  const report = validateMeasurementJson(bytes(reportValue));
  const sampleId = id(sampleSequence++);
  const issuance = createSynchronizationIssuanceFixtureForTest(bytes({
    sampleId, timebaseId, instanceId: report.instanceId,
    serverReceiveMs: report.monotonicStartMs,
    serverSendMs: report.monotonicStartMs,
  }));
  const sample = acceptSynchronizationSample(bytes({
    sampleId, instanceId: report.instanceId,
    localSendMs: report.monotonicStartMs,
    localReceiveMs: report.monotonicStartMs,
  }), issuance);
  const suffix = family === 'source'
    ? { authorityKind: 'source', role: 'source', sourceId: SOURCE_ID, sourceInstanceId: report.instanceId }
    : family === 'relay'
      ? { authorityKind: 'relay', role: 'relay', relayGenerationId: report.instanceId }
      : { authorityKind: 'listener', role: 'member', listenerInstanceId: report.instanceId };
  const context = createServerContextFixtureForTest(bytes({
    contextVersion: 1, traceId, runId: RUN, runGeneration: 1,
    correlationSegmentId: segmentId, leaseId, ...suffix,
  }));
  return composeUploadedEnvelope(report, mapMeasurementAlignment(report, sample), context);
}

function sourcePair({ anomaly = false, currentStart = 20000 } = {}) {
  const instance = id(1);
  return {
    prior: envelope(sourceReport(instance, 0, 0), 'source'),
    current: envelope(sourceReport(instance, 1, currentStart, anomaly
      ? { captureGapCount: 1 } : {}), 'source'),
  };
}

function relayPair({ anomaly = false, currentStart = 40000 } = {}) {
  const instance = id(2);
  return {
    prior: envelope(relayReport(instance, 0, 10000), 'relay'),
    current: envelope(relayReport(instance, 1, currentStart, anomaly
      ? { ingressGapCount: 1 } : {}), 'relay'),
  };
}

function listener(number, start = 60000, overrides = {}, options = {}) {
  return envelope(listenerReport(id(10 + number), start, overrides), 'listener', options);
}

function classify({ source = sourcePair(), relay = relayPair(), listeners } = {}) {
  return classifyDiagnosticEvidence({
    source,
    relay,
    listeners: listeners ?? [listener(1), listener(2)],
  });
}

const deliveryAnomaly = {
  reconnectCount: 1,
};
const bufferAnomaly = {
  bufferDepth: {
    status: 'observed', sampleCount: 10, currentMs: 99, minMs: 50,
    maxMs: 500, meanMs: 200, trendMsPerSecond: -1,
  },
};
const outputAnomaly = {
  audioContextState: 'suspended', suspensionCount: 1,
};

test('five fixed positive patterns classify with bounded references', () => {
  const cases = [
    ['source_suspected', classify({
      source: sourcePair({ anomaly: true, currentStart: 20000 }),
      relay: relayPair({ anomaly: true, currentStart: 40000 }),
      listeners: [listener(1, 60000, deliveryAnomaly), listener(2, 60000, deliveryAnomaly)],
    })],
    ['relay_suspected', classify({
      relay: relayPair({ anomaly: true, currentStart: 40000 }),
      listeners: [listener(1, 60000, deliveryAnomaly), listener(2, 60000, deliveryAnomaly)],
    })],
    ['listener_delivery_suspected', classify({
      relay: relayPair({ currentStart: 20000 }),
      listeners: [listener(1, 20000, deliveryAnomaly), listener(2, 20000)],
    })],
    ['listener_buffer_suspected', classify({
      relay: relayPair({ currentStart: 20000 }),
      listeners: [listener(1, 20000, bufferAnomaly), listener(2, 20000)],
    })],
    ['browser_output_suspected', classify({
      relay: relayPair({ currentStart: 20000 }),
      listeners: [listener(1, 20000, outputAnomaly), listener(2, 20000)],
    })],
  ];
  for (const [expected, result] of cases) {
    assert.equal(result.result, expected);
    assert.equal(result.missing.length, 0);
    assert.ok(result.contributing.length <= 12);
    assert.equal(Object.isFrozen(result), true);
    assert.equal('measurements' in result.contributing[0], false);
  }
});

test('strict precedence rejects equality and overlapping uncertainty', () => {
  const result = classify({
    source: sourcePair({ anomaly: true, currentStart: 30000 }),
    relay: relayPair({ anomaly: true, currentStart: 40000 }),
    listeners: [listener(1, 60000, deliveryAnomaly)],
  });
  assert.equal(result.result, 'insufficient_evidence');
  assert.deepEqual(result.missing, ['ordering_overlap']);
});

test('single-listener diagnoses reject multiple candidates and honor thresholds', () => {
  assert.equal(classify({
    relay: relayPair({ currentStart: 20000 }),
    listeners: [
      listener(1, 20000, { chunkGap: { status: 'observed', count: 99, meanMs: 10, maxMs: 250 } }),
      listener(2, 20000),
    ],
  }).result, 'insufficient_evidence');
  assert.equal(classify({
    relay: relayPair({ currentStart: 20000 }),
    listeners: [
      listener(1, 20000, { bufferDepth: { ...bufferAnomaly.bufferDepth, currentMs: 100 } }),
      listener(2, 20000),
    ],
  }).result, 'insufficient_evidence');
  assert.equal(classify({
    relay: relayPair({ currentStart: 20000 }),
    listeners: [
      listener(1, 20000, {
        longTasks: { status: 'observed', count: 1, maxDurationMs: 99 },
      }),
      listener(2, 20000),
    ],
  }).result, 'insufficient_evidence');
  assert.equal(classify({
    relay: relayPair({ currentStart: 20000 }),
    listeners: [
      listener(1, 20000, {
        longTasks: { status: 'observed', count: 1, maxDurationMs: 100 },
      }),
      listener(2, 20000),
    ],
  }).result, 'browser_output_suspected');
  assert.equal(classify({
    relay: relayPair({ currentStart: 20000 }),
    listeners: [
      listener(1, 20000, { chunkGap: { status: 'observed', count: 99, meanMs: 10, maxMs: 250.01 } }),
      listener(2, 20000),
    ],
  }).result, 'listener_delivery_suspected');
  assert.equal(classify({
    relay: relayPair({ currentStart: 20000 }),
    listeners: [listener(1, 20000, deliveryAnomaly), listener(2, 20000, deliveryAnomaly)],
  }).result, 'insufficient_evidence');
  assert.equal(classify({
    relay: relayPair({ currentStart: 20000 }),
    listeners: [listener(1, 20000, bufferAnomaly), listener(2, 20000, bufferAnomaly)],
  }).result, 'insufficient_evidence');
});

test('missing, mixed, duplicate, and invalid pair evidence fails finite', () => {
  assert.deepEqual(classifyDiagnosticEvidence({
    source: null, relay: relayPair(), listeners: [listener(1)],
  }).missing, ['source']);
  assert.deepEqual(classifyDiagnosticEvidence({
    source: sourcePair(), relay: relayPair(), listeners: [],
  }).missing, ['listener']);

  const duplicate = listener(1);
  assert.deepEqual(classify({ listeners: [duplicate, duplicate] }).missing, ['duplicate_listener']);
  assert.deepEqual(classify({
    listeners: [listener(1, 20000, {}, { timebaseId: id(99) })],
  }).missing, ['timebase_mismatch']);
  assert.deepEqual(classify({
    listeners: [listener(1, 20000, {}, { traceId: id(98) })],
  }).missing, ['trace_mismatch']);
  assert.deepEqual(classify({
    listeners: [listener(1, 20000, {}, { segmentId: id(97), leaseId: id(96) })],
  }).missing, ['segment_mismatch']);
  assert.deepEqual(classify({
    listeners: Array.from({ length: 9 }, (_, index) => listener(index + 1)),
  }).missing, ['listener']);

  const instance = id(30);
  const invalidSource = {
    prior: envelope(sourceReport(instance, 2, 0), 'source'),
    current: envelope(sourceReport(instance, 1, 20000), 'source'),
  };
  assert.deepEqual(classify({ source: invalidSource }).missing, ['invalid_pair']);
});

test('no anomaly and unknown states stay insufficient', () => {
  assert.deepEqual(classify({ relay: relayPair({ currentStart: 20000 }) }).missing, ['no_anomaly']);
  assert.deepEqual(classify({
    relay: relayPair({ currentStart: 20000 }),
    listeners: [listener(1, 20000, { bufferDepth: { status: 'unknown' } })],
  }).missing, ['unknown_state']);
});

test('E3 imports only verified E1 and E2 modules', async () => {
  const source = await readFile(new URL('../lib/s2e-e3-comparison.mjs', import.meta.url), 'utf8');
  const imports = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((match) => match[1]);
  assert.deepEqual(imports, ['./s2e-e1-contract.mjs', './s2e-e2-correlation.mjs']);
  assert.doesNotMatch(source, /sqlite|fetch\s*\(|react|audio.?worklet|collector|state-service/i);
});
