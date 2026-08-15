import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  E2ContractError,
  acceptSynchronizationSample,
  bindRelayGeneration,
  canonicalConsentStateBytes,
  canonicalE2OperationReceiptBytes,
  canonicalRelayBindingBytes,
  canonicalSynchronizationIssuanceBytes,
  canonicalTraceStateBytes,
  canonicalUploadedEnvelopeBytes,
  classifyDiagnosticReportIngest,
  classifyTimebaseRelation,
  composeUploadedEnvelope,
  createOperationAuthorityFixtureForTest,
  createServerContextFixtureForTest,
  createSynchronizationIssuanceFixtureForTest,
  endDiagnosticTrace,
  expireDiagnosticTrace,
  mapMeasurementAlignment,
  optInDiagnosticSharing,
  restoreE2OperationReceiptFromTrustedStore,
  restoreConsentStateFromTrustedStore,
  restoreRelayBindingFromTrustedStore,
  restoreSynchronizationIssuanceFromTrustedStore,
  restoreTraceStateFromTrustedStore,
  restoreUploadedEnvelopeFromTrustedStore,
  rotateCorrelationSegment,
  startDiagnosticTrace,
  stopDiagnosticSharing,
  uploadedEnvelopeIdentity,
  validateE2OperationCommandJson,
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
const TRACE_2 = '923e4567-e89b-42d3-a456-426614174000';
const SEGMENT_2 = 'a23e4567-e89b-42d3-a456-426614174000';
const LEASE_2 = 'b23e4567-e89b-42d3-a456-426614174000';
const REQUEST_1 = 'c23e4567-e89b-42d3-a456-426614174000';
const REQUEST_2 = 'd23e4567-e89b-42d3-a456-426614174000';
const REQUEST_3 = 'e23e4567-e89b-42d3-a456-426614174000';
const REQUEST_4 = 'f23e4567-e89b-42d3-a456-426614174000';
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

function sourceWindow(overrides = {}) {
  const value = base('source_window', {
    sampleRate: 48000, channels: 2, encoding: 's16le', capturedFrames: 48000,
    enqueuedFrames: 48000, publishedFrames: 48000, publishedBytes: 192000,
    captureGapCount: 0, droppedUploadCount: 0, reconnectCount: 0,
    publisherRestartCount: 0, publisherState: 'publishing',
    playbackObservation: 'playing',
  });
  return {
    ...value,
    ...overrides,
    measurements: { ...value.measurements, ...overrides.measurements },
  };
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

function command(operation, parameters = {}, requestId = REQUEST_1) {
  return validateE2OperationCommandJson(bytes({ requestId, operation, parameters }));
}

function operationAuthority(value) {
  return createOperationAuthorityFixtureForTest(bytes({ authorityVersion: 1, ...value }));
}

function startAuthority(overrides = {}) {
  return operationAuthority({
    operation: 'trace_start', nowMs: 1000, isHost: true, runId: RUN,
    runGeneration: 1, leaseId: LEASE, issuedTraceId: TRACE,
    issuedSegmentId: SEGMENT, ...overrides,
  });
}

function envelope(value = listenerWindow(), contextOverrides = {}) {
  const normalized = report(value);
  return composeUploadedEnvelope(
    normalized,
    mapMeasurementAlignment(normalized, sample()),
    context('listener', contextOverrides),
  );
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

  const exactMaximum = sample(
    { localReceiveMs: 2100 }, issuance({ serverReceiveMs: 1000, serverSendMs: 1000 }),
  );
  const lower = exactMaximum.serverSendMs - exactMaximum.localReceiveMs;
  const upper = exactMaximum.serverReceiveMs - exactMaximum.localSendMs;
  assert.equal((upper - lower) / 2, 1000);
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
  assert.equal(mapMeasurementAlignment(
    report(listenerWindow({ monotonicStartMs: 50120, durationMs: 10000 })), sample(),
  ).mappedEndLatestMs, 61020);
  expectCode('alignment_invalid', () => mapMeasurementAlignment(
    report(),
    sample({}, issuance({
      serverReceiveMs: Number.MAX_SAFE_INTEGER - 10,
      serverSendMs: Number.MAX_SAFE_INTEGER - 10,
    })),
  ));
});

test('alignment provenance cannot be reused by another same-instance report', () => {
  const first = report(listenerWindow());
  const aligned = mapMeasurementAlignment(first, sample());
  const later = report(listenerWindow({ sequence: 1, monotonicStartMs: 50000 }));
  expectCode('alignment_invalid', () => composeUploadedEnvelope(
    later, aligned, context('listener'),
  ));
  expectCode('alignment_invalid', () => composeUploadedEnvelope(
    report(listenerTransition()), aligned, context('listener'),
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
  expectCode('authority_invalid', () => context('listener', { prohibited: true }));
  expectCode('authority_invalid', () => composeUploadedEnvelope(
    normalized,
    mapMeasurementAlignment(normalized, sample()),
    context('listener', { listenerInstanceId: TRACE_2 }),
  ));
});

test('complete uploaded envelopes canonically restore all six families', () => {
  for (const [fixture, family] of [
    [listenerWindow(), 'listener'], [listenerTransition(), 'listener'],
    [sourceWindow(), 'source'], [sourceTransition(), 'source'],
    [relayWindow(), 'relay'], [relayTransition(), 'relay'],
  ]) {
    const normalized = report(fixture);
    const original = composeUploadedEnvelope(
      normalized, mapMeasurementAlignment(normalized, sample()), context(family),
    );
    const canonical = canonicalUploadedEnvelopeBytes(original);
    assert.ok(canonical.byteLength <= 4096);
    const restored = restoreUploadedEnvelopeFromTrustedStore(canonical);
    assert.deepEqual(canonicalUploadedEnvelopeBytes(restored), canonical);
    assert.equal(uploadedEnvelopeIdentity(restored), uploadedEnvelopeIdentity(original));
  }

  const valid = canonicalUploadedEnvelopeBytes(envelope());
  const tampered = JSON.parse(Buffer.from(valid).toString('utf8'));
  tampered.alignment.mappedStartEarliestMs += 1;
  expectCode('report_invalid', () => restoreUploadedEnvelopeFromTrustedStore(bytes(tampered)));
  const reordered = JSON.parse(Buffer.from(valid).toString('utf8'));
  expectCode('report_invalid', () => restoreUploadedEnvelopeFromTrustedStore(bytes({
    serverContext: reordered.serverContext,
    alignment: reordered.alignment,
    measurementCore: reordered.measurementCore,
    uploadVersion: 1,
  })));
  expectCode('report_too_large', () => restoreUploadedEnvelopeFromTrustedStore(
    Buffer.alloc(4097, 0x20),
  ));
});

test('trusted-store restoration recovers E2 state and deterministic expiry', () => {
  const issued = issuance();
  assert.deepEqual(
    restoreSynchronizationIssuanceFromTrustedStore(
      canonicalSynchronizationIssuanceBytes(issued),
    ),
    issued,
  );

  const started = startDiagnosticTrace(null, command('trace_start'), startAuthority()).state;
  const rotated = rotateCorrelationSegment(started, operationAuthority({
    operation: 'segment_rotate', nowMs: 2000, traceId: TRACE,
    priorLeaseId: LEASE, leaseId: LEASE_2, issuedSegmentId: SEGMENT_2,
  }));
  const restoredTrace = restoreTraceStateFromTrustedStore(canonicalTraceStateBytes(rotated));
  assert.deepEqual(restoredTrace, rotated);
  const expired = expireDiagnosticTrace(restoredTrace);
  assert.equal(expired.ended.endedAtMs, restoredTrace.expiresAtMs);
  assert.deepEqual(
    restoreTraceStateFromTrustedStore(canonicalTraceStateBytes(expired)), expired,
  );

  const consent = optInDiagnosticSharing(
    null,
    command('consent_opt_in', {
      listenerInstanceId: INSTANCE, firstAllowedSequence: 1,
      localConsentStartedMs: 120,
    }, REQUEST_2),
    operationAuthority({
      operation: 'consent_opt_in', nowMs: 1000, traceId: TRACE,
      listenerInstanceId: INSTANCE,
    }),
  ).state;
  assert.deepEqual(
    restoreConsentStateFromTrustedStore(canonicalConsentStateBytes(consent)), consent,
  );

  const binding = bindRelayGeneration(
    started, null,
    command('relay_bind', { relayGenerationId: INSTANCE }, REQUEST_3),
    operationAuthority({
      operation: 'relay_bind', traceId: TRACE, segmentId: SEGMENT,
      leaseId: LEASE, relayGenerationId: INSTANCE,
    }),
  ).state;
  assert.deepEqual(
    restoreRelayBindingFromTrustedStore(canonicalRelayBindingBytes(binding)), binding,
  );
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

test('trace lifecycle is fixed, monotonic, replay-safe, and single-active', () => {
  const start = command('trace_start');
  const created = startDiagnosticTrace(null, start, startAuthority());
  assert.equal(created.status, 'accepted');
  assert.equal(created.state.status, 'active');
  assert.equal(created.state.expiresAtMs, 21601000);

  const replayed = startDiagnosticTrace(
    null, command('trace_start'), startAuthority({ issuedTraceId: TRACE_2 }), created.receipt,
  );
  assert.equal(replayed.status, 'replayed');
  assert.strictEqual(replayed.state, created.state);
  const restoredReceipt = restoreE2OperationReceiptFromTrustedStore(
    canonicalE2OperationReceiptBytes(created.receipt),
  );
  const restartedReplay = startDiagnosticTrace(
    null, command('trace_start'), startAuthority({ issuedTraceId: TRACE_2 }), restoredReceipt,
  );
  assert.equal(restartedReplay.status, 'replayed');
  assert.deepEqual(restartedReplay.state, created.state);
  expectCode('request_conflict', () => startDiagnosticTrace(
    null, command('trace_start', {}, REQUEST_2), startAuthority(), created.receipt,
  ));

  const busy = startDiagnosticTrace(
    created.state, command('trace_start', {}, REQUEST_2),
    startAuthority({ issuedTraceId: TRACE_2 }),
  );
  assert.equal(busy.status, 'trace_busy');
  assert.strictEqual(busy.state, created.state);

  const ended = endDiagnosticTrace(
    created.state,
    command('trace_end', {}, REQUEST_2),
    operationAuthority({
      operation: 'trace_end', nowMs: 2000, traceId: TRACE, reason: 'host_stopped',
    }),
  );
  assert.equal(ended.state.status, 'ended');
  assert.deepEqual({ ...ended.state.ended }, {
    status: 'ended', endedAtMs: 2000, reason: 'host_stopped',
  });
  assert.equal(endDiagnosticTrace(
    created.state,
    command('trace_end', {}, REQUEST_2),
    operationAuthority({
      operation: 'trace_end', nowMs: 9999, traceId: TRACE, reason: 'authority_lost',
    }),
    ended.receipt,
  ).status, 'replayed');
  expectCode('stale_correlation', () => startDiagnosticTrace(
    ended.state,
    command('trace_start', {}, REQUEST_3),
    startAuthority({ nowMs: 3000, issuedTraceId: TRACE }),
  ));
});

test('lease replacement rotates one segment and relay generation binds immutably', () => {
  const trace = startDiagnosticTrace(
    null, command('trace_start'), startAuthority(),
  ).state;
  const rotated = rotateCorrelationSegment(trace, operationAuthority({
    operation: 'segment_rotate', nowMs: 2000, traceId: TRACE,
    priorLeaseId: LEASE, leaseId: LEASE_2, issuedSegmentId: SEGMENT_2,
  }));
  assert.equal(rotated.segment.segmentId, SEGMENT_2);
  assert.equal(rotated.segment.leaseId, LEASE_2);
  assert.strictEqual(rotated, rotateCorrelationSegment(rotated, operationAuthority({
    operation: 'segment_rotate', nowMs: 2000, traceId: TRACE,
    priorLeaseId: LEASE, leaseId: LEASE_2, issuedSegmentId: SEGMENT_2,
  })));
  expectCode('stale_correlation', () => rotateCorrelationSegment(trace, operationAuthority({
    operation: 'segment_rotate', nowMs: 2000, traceId: TRACE,
    priorLeaseId: LEASE, leaseId: LEASE_2, issuedSegmentId: SEGMENT,
  })));
  expectCode('stale_correlation', () => rotateCorrelationSegment(trace, operationAuthority({
    operation: 'segment_rotate', nowMs: 2000, traceId: TRACE,
    priorLeaseId: LEASE_2, leaseId: LEASE, issuedSegmentId: SEGMENT_2,
  })));
  expectCode('stale_correlation', () => rotateCorrelationSegment(trace, operationAuthority({
    operation: 'segment_rotate', nowMs: trace.expiresAtMs, traceId: TRACE,
    priorLeaseId: LEASE, leaseId: LEASE_2, issuedSegmentId: SEGMENT_2,
  })));

  const relayCommand = command('relay_bind', { relayGenerationId: INSTANCE }, REQUEST_2);
  const binding = bindRelayGeneration(rotated, null, relayCommand, operationAuthority({
    operation: 'relay_bind', traceId: TRACE, segmentId: SEGMENT_2,
    leaseId: LEASE_2, relayGenerationId: INSTANCE,
  }));
  assert.deepEqual({ ...binding.state }, {
    relayGenerationId: INSTANCE, traceId: TRACE, segmentId: SEGMENT_2, leaseId: LEASE_2,
  });
  assert.equal(bindRelayGeneration(
    trace,
    binding.state,
    command('relay_bind', { relayGenerationId: INSTANCE }, REQUEST_2),
    operationAuthority({
      operation: 'relay_bind', traceId: TRACE, segmentId: SEGMENT,
      leaseId: LEASE, relayGenerationId: INSTANCE,
    }),
    binding.receipt,
  ).status, 'replayed');

  const firstBinding = bindRelayGeneration(
    trace,
    null,
    command('relay_bind', { relayGenerationId: INSTANCE }, REQUEST_3),
    operationAuthority({
      operation: 'relay_bind', traceId: TRACE, segmentId: SEGMENT,
      leaseId: LEASE, relayGenerationId: INSTANCE,
    }),
  );
  expectCode('stale_correlation', () => bindRelayGeneration(
    rotated,
    firstBinding.state,
    command('relay_bind', { relayGenerationId: INSTANCE }, REQUEST_4),
    operationAuthority({
      operation: 'relay_bind', traceId: TRACE, segmentId: SEGMENT_2,
      leaseId: LEASE_2, relayGenerationId: INSTANCE,
    }),
  ));
  const differentBinding = bindRelayGeneration(
    trace,
    null,
    command('relay_bind', { relayGenerationId: TRACE_2 }, REQUEST_4),
    operationAuthority({
      operation: 'relay_bind', traceId: TRACE, segmentId: SEGMENT,
      leaseId: LEASE, relayGenerationId: TRACE_2,
    }),
  );
  expectCode('stale_correlation', () => bindRelayGeneration(
    rotated,
    differentBinding.state,
    command('relay_bind', { relayGenerationId: INSTANCE }, REQUEST_1),
    operationAuthority({
      operation: 'relay_bind', traceId: TRACE, segmentId: SEGMENT_2,
      leaseId: LEASE_2, relayGenerationId: INSTANCE,
    }),
  ));
  expectCode('stale_correlation', () => endDiagnosticTrace(
    rotated,
    command('trace_end', {}, REQUEST_4),
    operationAuthority({
      operation: 'trace_end', nowMs: 1500, traceId: TRACE, reason: 'host_stopped',
    }),
  ));
  expectCode('stale_correlation', () => endDiagnosticTrace(
    rotated,
    command('trace_end', {}, REQUEST_4),
    operationAuthority({
      operation: 'trace_end', nowMs: rotated.expiresAtMs,
      traceId: TRACE, reason: 'host_stopped',
    }),
  ));
  assert.equal(endDiagnosticTrace(
    rotated,
    command('trace_end', {}, REQUEST_4),
    operationAuthority({
      operation: 'trace_end', nowMs: rotated.expiresAtMs,
      traceId: TRACE, reason: 'expired',
    }),
  ).state.ended.reason, 'expired');
});

test('consent is forward-only and stop preserves accepted replay semantics', () => {
  const optIn = optInDiagnosticSharing(
    null,
    command('consent_opt_in', {
      listenerInstanceId: INSTANCE,
      firstAllowedSequence: 1,
      localConsentStartedMs: 120,
    }),
    operationAuthority({
      operation: 'consent_opt_in', nowMs: 1000, traceId: TRACE,
      listenerInstanceId: INSTANCE,
    }),
  );
  assert.equal(optIn.state.status, 'enabled');
  assert.equal(optIn.state.generation, 1);

  const beforeBoundary = envelope(listenerWindow({ sequence: 0 }));
  assert.equal(classifyDiagnosticReportIngest({
    existingEnvelope: null, incomingEnvelope: beforeBoundary,
    consent: optIn.state, grantGeneration: 1,
  }), 'sharing_disabled');

  const eligible = envelope(listenerWindow({ sequence: 1 }));
  assert.equal(classifyDiagnosticReportIngest({
    existingEnvelope: null, incomingEnvelope: eligible,
    consent: optIn.state, grantGeneration: 1,
  }), 'accepted');

  const sourceCore = report(sourceWindow());
  const sourceEnvelope = composeUploadedEnvelope(
    sourceCore, mapMeasurementAlignment(sourceCore, sample()), context('source'),
  );
  assert.equal(classifyDiagnosticReportIngest({
    existingEnvelope: null, incomingEnvelope: sourceEnvelope,
    consent: optIn.state, grantGeneration: 1,
  }), 'accepted');

  const stopped = stopDiagnosticSharing(
    optIn.state,
    command('consent_stop', {
      listenerInstanceId: INSTANCE, expectedGeneration: 1,
    }, REQUEST_2),
    operationAuthority({
      operation: 'consent_stop', nowMs: 2000, traceId: TRACE,
      listenerInstanceId: INSTANCE,
    }),
  );
  assert.equal(stopped.state.status, 'revoked');
  assert.equal(stopped.state.generation, 2);
  expectCode('authority_invalid', () => optInDiagnosticSharing(
    stopped.state,
    command('consent_opt_in', {
      listenerInstanceId: INSTANCE,
      firstAllowedSequence: 0,
      localConsentStartedMs: 0,
    }, REQUEST_3),
    operationAuthority({
      operation: 'consent_opt_in', nowMs: 1500, traceId: TRACE,
      listenerInstanceId: INSTANCE,
    }),
  ));
  assert.equal(classifyDiagnosticReportIngest({
    existingEnvelope: null, incomingEnvelope: eligible,
    consent: stopped.state, grantGeneration: 1,
  }), 'sharing_disabled');
  assert.equal(classifyDiagnosticReportIngest({
    existingEnvelope: eligible, incomingEnvelope: eligible,
    consent: stopped.state, grantGeneration: 1,
  }), 'replayed');

  const conflict = envelope(listenerWindow({
    sequence: 1,
    measurements: { ...listenerWindow().measurements, visibilityState: 'hidden' },
  }));
  assert.equal(classifyDiagnosticReportIngest({
    existingEnvelope: eligible, incomingEnvelope: conflict,
    consent: stopped.state, grantGeneration: 1,
  }), 'report_conflict');
});

test('source and relay ingest use authority context without listener consent', () => {
  for (const [fixture, family] of [[sourceWindow(), 'source'], [relayWindow(), 'relay']]) {
    const core = report(fixture);
    const acceptedEnvelope = composeUploadedEnvelope(
      core, mapMeasurementAlignment(core, sample()), context(family),
    );
    assert.equal(classifyDiagnosticReportIngest({
      existingEnvelope: null,
      incomingEnvelope: acceptedEnvelope,
      consent: null,
      grantGeneration: null,
    }), 'accepted');
    assert.equal(classifyDiagnosticReportIngest({
      existingEnvelope: acceptedEnvelope,
      incomingEnvelope: acceptedEnvelope,
      consent: null,
      grantGeneration: null,
    }), 'replayed');
  }

  const originalCore = report(sourceWindow());
  const changedCore = report(sourceWindow({ measurements: { publisherState: 'backoff' } }));
  const original = composeUploadedEnvelope(
    originalCore, mapMeasurementAlignment(originalCore, sample()), context('source'),
  );
  const changed = composeUploadedEnvelope(
    changedCore, mapMeasurementAlignment(changedCore, sample()), context('source'),
  );
  assert.equal(classifyDiagnosticReportIngest({
    existingEnvelope: original,
    incomingEnvelope: changed,
    consent: null,
    grantGeneration: null,
  }), 'report_conflict');
});

test('trusted receipt restoration rejects operation-result contradictions', () => {
  const created = startDiagnosticTrace(
    null, command('trace_start'), startAuthority(),
  );
  const activeAsEnded = JSON.parse(Buffer.from(
    canonicalE2OperationReceiptBytes(created.receipt),
  ).toString('utf8'));
  activeAsEnded.operation = 'trace_end';
  activeAsEnded.canonicalCommand.operation = 'trace_end';
  expectCode('request_conflict', () => restoreE2OperationReceiptFromTrustedStore(
    bytes(activeAsEnded),
  ));
  const postExpirySegment = JSON.parse(Buffer.from(
    canonicalE2OperationReceiptBytes(created.receipt),
  ).toString('utf8'));
  postExpirySegment.result.segment.startedAtMs = postExpirySegment.result.expiresAtMs;
  expectCode('request_conflict', () => restoreE2OperationReceiptFromTrustedStore(
    bytes(postExpirySegment),
  ));

  const optIn = optInDiagnosticSharing(
    null,
    command('consent_opt_in', {
      listenerInstanceId: INSTANCE, firstAllowedSequence: 1,
      localConsentStartedMs: 120,
    }, REQUEST_2),
    operationAuthority({
      operation: 'consent_opt_in', nowMs: 1000, traceId: TRACE,
      listenerInstanceId: INSTANCE,
    }),
  );
  const enabledAsStopped = JSON.parse(Buffer.from(
    canonicalE2OperationReceiptBytes(optIn.receipt),
  ).toString('utf8'));
  enabledAsStopped.operation = 'consent_stop';
  enabledAsStopped.canonicalCommand.operation = 'consent_stop';
  enabledAsStopped.canonicalCommand.parameters = {
    listenerInstanceId: INSTANCE, expectedGeneration: 1,
  };
  expectCode('request_conflict', () => restoreE2OperationReceiptFromTrustedStore(
    bytes(enabledAsStopped),
  ));

  const relayCommand = command('relay_bind', { relayGenerationId: INSTANCE }, REQUEST_3);
  const relay = bindRelayGeneration(created.state, null, relayCommand, operationAuthority({
    operation: 'relay_bind', traceId: TRACE, segmentId: SEGMENT,
    leaseId: LEASE, relayGenerationId: INSTANCE,
  }));
  const mismatchedRelay = JSON.parse(Buffer.from(
    canonicalE2OperationReceiptBytes(relay.receipt),
  ).toString('utf8'));
  mismatchedRelay.result.relayGenerationId = TRACE_2;
  expectCode('request_conflict', () => restoreE2OperationReceiptFromTrustedStore(
    bytes(mismatchedRelay),
  ));
});

test('E2 dependency firewall imports E1 only and contains no later boundary', async () => {
  const source = await readFile(new URL('../lib/s2e-e2-correlation.mjs', import.meta.url), 'utf8');
  const imports = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((match) => match[1]);
  assert.deepEqual(imports, ['./s2e-e1-contract.mjs']);
  assert.doesNotMatch(source, /sqlite|fetch\s*\(|react|audio.?worklet|collector|state-service/i);
});
