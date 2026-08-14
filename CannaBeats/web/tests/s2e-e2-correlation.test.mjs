import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  E2ContractError,
  acceptSynchronizationSample,
  classifyTimebaseRelation,
  composeUploadedEnvelope,
  createServerContextFixtureForTest,
  createSynchronizationIssuanceFixtureForTest,
  mapMeasurementAlignment,
  uploadedEnvelopeIdentity,
} from '../lib/s2e-e2-correlation.mjs';
import {
  canonicalMeasurementBytes,
  validateMeasurementJson,
} from '../lib/s2e-e1-contract.mjs';

const INSTANCE = '123e4567-e89b-42d3-a456-426614174000';
const SAMPLE = '223e4567-e89b-42d3-a456-426614174000';
const TIMEBASE = '323e4567-e89b-42d3-a456-426614174000';
const TRACE = '423e4567-e89b-42d3-a456-426614174000';
const RUN = '523e4567-e89b-42d3-a456-426614174000';
const SEGMENT = '623e4567-e89b-42d3-a456-426614174000';
const LEASE = '723e4567-e89b-42d3-a456-426614174000';
const SOURCE = '823e4567-e89b-42d3-a456-426614174000';
const bytes = (value) => Buffer.from(JSON.stringify(value));

function base(kind, measurements, overrides = {}) {
  return {
    schemaVersion: 1,
    kind,
    instanceId: INSTANCE,
    sequence: 0,
    monotonicStartMs: 120,
    durationMs: kind.endsWith('_transition') ? 0 : 10_000,
    measurements,
    ...overrides,
  };
}

function listenerWindow(overrides = {}) {
  return base('listener_window', {
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
    underrunCount: 0,
    underrunDurationMs: 0,
    reprimeCount: 0,
    windowStartedInUnderrun: false,
    overflowCount: 0,
    discardedFrames: 0,
    resetCount: 0,
    sourceSampleRate: 48000,
    sourceChannels: 2,
    outputSampleRate: 48000,
    nominalRateRatio: 1,
    audioContextState: 'running',
    baseLatencyMs: { status: 'observed', value: 12 },
    outputLatencyMs: { status: 'unsupported' },
    visibilityState: 'visible',
    suspensionCount: 0,
    longTasks: { status: 'observed', count: 0, maxDurationMs: 0 },
    signalPresence: 'present',
    clippingSeverity: 'none',
    browserFamily: 'safari',
    browserMajor: { status: 'observed', value: 18 },
    osFamily: 'ios',
    displayMode: 'browser',
    implementationVersion: 1,
  }, overrides);
}

function sourceWindow() {
  return base('source_window', {
    sampleRate: 48000, channels: 2, encoding: 's16le', capturedFrames: 48000,
    enqueuedFrames: 48000, publishedFrames: 48000, publishedBytes: 192000,
    captureGapCount: 0, droppedUploadCount: 0, reconnectCount: 0,
    publisherRestartCount: 0, publisherState: 'publishing',
    playbackObservation: 'playing',
  });
}

function listenerTransition() {
  return base('listener_transition', {
    type: 'request_started', category: 'observed',
    connectionAttemptSequence: 0, elapsedMs: 0,
  });
}

function sourceTransition() {
  return base('source_transition', {
    type: 'capture_started', category: 'observed',
  });
}

function relayWindow() {
  return base('relay_window', {
    sampleRate: 48000, channels: 2, encoding: 's16le', ingressFrames: 48000,
    ingressBytes: 192000, ingressGapCount: 0, rejectedIngressCount: 0,
    droppedIngressCount: 0, acceptedListenerCount: 2, closedListenerCount: 1,
    deliveredBytes: 192000, backpressureClosureCount: 0,
    generationFenceDisconnectCount: 1, activeListenerCount: 1,
  });
}

function relayTransition() {
  return base('relay_transition', {
    type: 'process_started', category: 'observed',
  });
}

function report(value = listenerWindow()) {
  return validateMeasurementJson(bytes(value));
}

function issuance(overrides = {}) {
  return createSynchronizationIssuanceFixtureForTest(bytes({
    sampleId: SAMPLE,
    timebaseId: TIMEBASE,
    instanceId: INSTANCE,
    serverReceiveMs: 1000,
    serverSendMs: 1005,
    ...overrides,
  }));
}

function sample(overrides = {}, issued = issuance()) {
  return acceptSynchronizationSample(bytes({
    sampleId: SAMPLE,
    instanceId: INSTANCE,
    localSendMs: 100,
    localReceiveMs: 120,
    ...overrides,
  }), issued);
}

function context(kind, overrides = {}) {
  const suffix = kind === 'listener'
    ? { authorityKind: 'listener', role: 'member', listenerInstanceId: INSTANCE }
    : kind === 'source'
      ? { authorityKind: 'source', role: 'source', sourceId: SOURCE, sourceInstanceId: INSTANCE }
      : { authorityKind: 'relay', role: 'relay', relayGenerationId: INSTANCE };
  return createServerContextFixtureForTest(bytes({
    contextVersion: 1,
    traceId: TRACE,
    runId: RUN,
    runGeneration: 1,
    correlationSegmentId: SEGMENT,
    leaseId: LEASE,
    ...suffix,
    ...overrides,
  }));
}

function expectCode(code, action) {
  assert.throws(action, (error) => error instanceof E2ContractError && error.code === code);
}

test('physical sample uses ordered offset bounds without repairing impossible timing', () => {
  const accepted = sample();
  assert.deepEqual({
    local: [accepted.localSendMs, accepted.localReceiveMs],
    server: [accepted.serverReceiveMs, accepted.serverSendMs],
  }, { local: [100, 120], server: [1000, 1005] });

  expectCode('sample_invalid', () => sample({ localReceiveMs: 99 }));
  expectCode('sample_invalid', () => sample({ localReceiveMs: 2100.0001 }));
  expectCode('sample_invalid', () => sample({}, issuance({ serverSendMs: 1025 })));
  expectCode('sample_invalid', () => sample({}, issuance({ serverReceiveMs: 1010, serverSendMs: 1005 })));
});

test('sample provenance rejects caller server labels, mismatched identity, and forged records', () => {
  expectCode('sample_invalid', () => acceptSynchronizationSample(bytes({
    sampleId: SAMPLE, instanceId: INSTANCE, localSendMs: 100, localReceiveMs: 120,
    serverReceiveMs: 1000,
  }), issuance()));
  expectCode('sample_invalid', () => sample({ sampleId: TRACE }));
  expectCode('sample_invalid', () => acceptSynchronizationSample(bytes({
    sampleId: SAMPLE, instanceId: INSTANCE, localSendMs: 100, localReceiveMs: 120,
  }), Object.freeze({})));
});

test('alignment maps subsequent report intervals and fails closed at validity bounds', () => {
  const normalized = report();
  const aligned = mapMeasurementAlignment(normalized, sample());
  assert.equal(aligned.offsetLowerMs, 885);
  assert.equal(aligned.offsetUpperMs, 900);
  assert.equal(aligned.mappingUncertaintyMs, 7.5);
  assert.equal(aligned.mappedStartEarliestMs, 1005);
  assert.equal(aligned.mappedEndLatestMs, 11020);

  expectCode('sample_expired', () => mapMeasurementAlignment(
    report(listenerWindow({ monotonicStartMs: 119 })), sample(),
  ));
  expectCode('sample_expired', () => mapMeasurementAlignment(
    report(listenerWindow({ monotonicStartMs: 50200, durationMs: 10000 })), sample(),
  ));
});

test('all six E1 kinds preserve their core and derive family-specific authority', () => {
  for (const [fixture, family] of [
    [listenerWindow(), 'listener'], [listenerTransition(), 'listener'],
    [sourceWindow(), 'source'], [sourceTransition(), 'source'],
    [relayWindow(), 'relay'], [relayTransition(), 'relay'],
  ]) {
    const normalized = report(fixture);
    const before = canonicalMeasurementBytes(normalized);
    const aligned = mapMeasurementAlignment(normalized, sample());
    const envelope = composeUploadedEnvelope(normalized, aligned, context(family));
    assert.strictEqual(envelope.measurementCore, normalized);
    assert.deepEqual(canonicalMeasurementBytes(envelope.measurementCore), before);
    assert.equal(uploadedEnvelopeIdentity(envelope), `${TRACE}:${INSTANCE}:0`);
    assert.equal(Object.isFrozen(envelope), true);
  }

  const normalized = report();
  expectCode('authority_invalid', () => composeUploadedEnvelope(
    normalized, mapMeasurementAlignment(normalized, sample()), context('source'),
  ));
  expectCode('authority_invalid', () => composeUploadedEnvelope(
    normalized, mapMeasurementAlignment(normalized, sample()), Object.freeze({}),
  ));
});

test('different server timebases remain explicitly unrelated', () => {
  const normalized = report();
  const first = mapMeasurementAlignment(normalized, sample());
  const second = mapMeasurementAlignment(normalized, sample({}, issuance({
    timebaseId: '923e4567-e89b-42d3-a456-426614174000',
  })));
  assert.equal(classifyTimebaseRelation(first, first), 'same_timebase');
  assert.equal(classifyTimebaseRelation(first, second), 'unrelated_timebase');
});

test('E2 dependency firewall imports E1 only and contains no later boundary', async () => {
  const source = await readFile(new URL('../lib/s2e-e2-correlation.mjs', import.meta.url), 'utf8');
  const imports = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((match) => match[1]);
  assert.deepEqual(imports, ['./s2e-e1-contract.mjs']);
  assert.doesNotMatch(source, /sqlite|fetch\s*\(|react|audio.?worklet|collector|state-service/i);
});
