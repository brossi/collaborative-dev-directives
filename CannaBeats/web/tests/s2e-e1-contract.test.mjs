import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  E1ContractError,
  canonicalLocalDiagnosticExportBytes,
  canonicalMeasurementBytes,
  classifyMeasurementReplay,
  classifySignalWindow,
  measurementIdentity,
  projectMemberMeasurementJson,
  projectOperatorMeasurementJson,
  projectRetainedMeasurementJson,
  validateLocalDiagnosticExportJson,
  validateMeasurementJson,
  validateMeasurementSeries,
} from '../lib/s2e-e1-contract.mjs';

const INSTANCE = '123e4567-e89b-42d3-a456-426614174000';
const INSTANCE_2 = '123e4567-e89b-42d3-a456-426614174001';
const bytes = (value) => Buffer.from(JSON.stringify(value));

function base(kind, sequence = 0, overrides = {}) {
  return {
    schemaVersion: 1,
    kind,
    instanceId: INSTANCE,
    sequence,
    monotonicStartMs: sequence * 10_000,
    durationMs: kind.endsWith('_transition') ? 0 : 10_000,
    ...overrides,
  };
}

function listenerWindow(sequence = 0, overrides = {}) {
  const value = base('listener_window', sequence, {
    measurements: {
      connectionAttemptSequence: 0,
      receivedBytes: 192_000,
      receivedFrames: 48_000,
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
      sourceSampleRate: 48_000,
      sourceChannels: 2,
      outputSampleRate: 48_000,
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
    },
  });
  return { ...value, ...overrides, measurements: { ...value.measurements, ...overrides.measurements } };
}

function listenerTransition(sequence = 0, type = 'request_started', extra = {}) {
  return base('listener_transition', sequence, {
    measurements: {
      type,
      category: 'observed',
      connectionAttemptSequence: 0,
      ...(type === 'request_started' ? { elapsedMs: 0 } : {}),
      ...extra,
    },
  });
}

function sourceWindow(sequence = 0, overrides = {}) {
  const value = base('source_window', sequence, {
    measurements: {
      sampleRate: 48_000,
      channels: 2,
      encoding: 's16le',
      capturedFrames: 48_000,
      enqueuedFrames: 48_000,
      publishedFrames: 48_000,
      publishedBytes: 192_000,
      captureGapCount: 0,
      droppedUploadCount: 0,
      reconnectCount: 0,
      publisherRestartCount: 0,
      publisherState: 'publishing',
      playbackObservation: 'playing',
    },
  });
  return { ...value, ...overrides, measurements: { ...value.measurements, ...overrides.measurements } };
}

function sourceTransition(sequence = 0) {
  return base('source_transition', sequence, {
    measurements: { type: 'capture_started', category: 'observed' },
  });
}

function relayWindow(sequence = 0, overrides = {}) {
  const value = base('relay_window', sequence, {
    measurements: {
      sampleRate: 48_000,
      channels: 2,
      encoding: 's16le',
      ingressFrames: 48_000,
      ingressBytes: 192_000,
      ingressGapCount: 0,
      rejectedIngressCount: 0,
      droppedIngressCount: 0,
      acceptedListenerCount: 2,
      closedListenerCount: 1,
      deliveredBytes: 192_000,
      backpressureClosureCount: 0,
      generationFenceDisconnectCount: 1,
      activeListenerCount: 1,
    },
  });
  return { ...value, ...overrides, measurements: { ...value.measurements, ...overrides.measurements } };
}

function relayTransition(sequence = 0) {
  return base('relay_transition', sequence, {
    measurements: { type: 'process_started', category: 'observed' },
  });
}

const FIXTURES = [
  listenerWindow(), listenerTransition(), sourceWindow(), sourceTransition(),
  relayWindow(), relayTransition(),
];

function expectCode(code, action) {
  assert.throws(action, (error) => error instanceof E1ContractError && error.code === code);
}

test('all six exact report shapes validate and normalize deeply frozen records', () => {
  for (const fixture of FIXTURES) {
    const report = validateMeasurementJson(bytes(fixture));
    assert.equal(report.kind, fixture.kind);
    assert.equal(Object.getPrototypeOf(report), null);
    assert.equal(Object.getPrototypeOf(report.measurements), null);
    assert.equal(Object.isFrozen(report), true);
    assert.equal(Object.isFrozen(report.measurements), true);
  }
});

test('all six shapes reject missing and unknown fields', () => {
  for (const fixture of FIXTURES) {
    const unknown = structuredClone(fixture);
    unknown.measurements.prohibited = true;
    expectCode('report_invalid', () => validateMeasurementJson(bytes(unknown)));

    const missing = structuredClone(fixture);
    delete missing.measurements.type;
    if (!fixture.kind.endsWith('_transition')) delete missing.measurements[Object.keys(missing.measurements)[0]];
    expectCode('report_invalid', () => validateMeasurementJson(bytes(missing)));
  }
});

test('every transition type has one exact accepted tuple', () => {
  const listenerCases = [
    ['request_started', { elapsedMs: 0 }],
    ['response_headers', { elapsedMs: 1 }],
    ['first_pcm_bytes', { elapsedMs: 2 }],
    ['buffer_primed', { elapsedMs: 3 }],
    ['first_rendered_quantum', { elapsedMs: 4 }],
    ['underrun', {}], ['reset', {}], ['reconnect', {}],
    ['context_suspended', {}], ['context_resumed', {}],
    ['stream_failed', { category: 'error', reason: 'no_response' }],
    ['stream_ended', { reason: 'eof' }],
    ['listener_stopped', { reason: 'page_teardown' }],
  ];
  for (const [type, extra] of listenerCases) {
    assert.equal(validateMeasurementJson(bytes(listenerTransition(0, type, extra))).measurements.type, type);
  }

  const sourceCases = [
    ['capture_started', 'observed', {}], ['publisher_started', 'observed', {}],
    ['capture_stopped', 'error', { reason: 'input_unavailable' }],
    ['publisher_stopped', 'observed', { reason: 'authority_lost' }],
    ['publisher_restarted', 'unknown', { reason: 'unknown' }],
    ['playback_changed', 'observed', { playbackObservation: 'paused' }],
  ];
  for (const [type, category, extra] of sourceCases) {
    const value = base('source_transition', 0, { measurements: { type, category, ...extra } });
    assert.equal(validateMeasurementJson(bytes(value)).measurements.type, type);
  }

  const relayCases = [
    ['process_started', 'observed', {}], ['generation_started', 'observed', {}],
    ['process_stopped', 'observed', { reason: 'process_restart' }],
    ['generation_stopped', 'observed', { reason: 'publisher_closed' }],
    ['generation_fenced', 'error', { reason: 'backpressure' }],
  ];
  for (const [type, category, extra] of relayCases) {
    const value = base('relay_transition', 0, { measurements: { type, category, ...extra } });
    assert.equal(validateMeasurementJson(bytes(value)).measurements.type, type);
  }
});

test('bounded byte boundary and exact shape reject predictable malformed inputs', () => {
  expectCode('report_invalid', () => validateMeasurementJson({}));
  expectCode('report_invalid', () => validateMeasurementJson(Buffer.from('{')));
  expectCode('report_invalid', () => validateMeasurementJson(Buffer.alloc(8193, 32)));

  for (const mutate of [
    (v) => { v.unknown = true; },
    (v) => { delete v.schemaVersion; },
    (v) => { v.instanceId = v.instanceId.toUpperCase(); },
    (v) => { v.durationMs = 10_001; },
  ]) {
    const value = listenerWindow();
    mutate(value);
    expectCode('report_invalid', () => validateMeasurementJson(bytes(value)));
  }
  const negativeZero = Buffer.from(JSON.stringify(listenerWindow()).replace('"sequence":0', '"sequence":-0'));
  expectCode('report_invalid', () => validateMeasurementJson(negativeZero));
});

test('canonical bytes are independent of caller property order', () => {
  const value = listenerWindow();
  const reversed = Object.fromEntries(Object.entries(value).reverse());
  reversed.measurements = Object.fromEntries(Object.entries(value.measurements).reverse());
  const a = validateMeasurementJson(bytes(value));
  const b = validateMeasurementJson(bytes(reversed));
  assert.deepEqual(canonicalMeasurementBytes(a), canonicalMeasurementBytes(b));
  assert.equal(measurementIdentity(a), `${INSTANCE}:0`);
});

test('all six kinds implement accepted, replayed, conflict, and distinct identity', () => {
  for (const fixture of FIXTURES) {
    const report = validateMeasurementJson(bytes(fixture));
    assert.equal(classifyMeasurementReplay(null, report), 'accepted');
    assert.equal(classifyMeasurementReplay(report, report), 'replayed');

    const conflictValue = structuredClone(fixture);
    conflictValue.monotonicStartMs += 1;
    const conflict = validateMeasurementJson(bytes(conflictValue));
    assert.equal(classifyMeasurementReplay(report, conflict), 'report_conflict');

    const distinctValue = structuredClone(fixture);
    distinctValue.instanceId = INSTANCE_2;
    const distinct = validateMeasurementJson(bytes(distinctValue));
    assert.equal(classifyMeasurementReplay(report, distinct), 'distinct');
  }
  expectCode('report_invalid', () => classifyMeasurementReplay(undefined, validateMeasurementJson(bytes(listenerWindow()))));
});

test('cross-field truth tables reject impossible listener, source, and relay values', () => {
  const impossible = [
    listenerWindow(0, { measurements: { receivedFrames: 1, receivedBytes: 4, chunkCount: 2 } }),
    listenerWindow(0, { measurements: { receivedFrames: 0, receivedBytes: 0, chunkCount: 0, signalPresence: 'present' } }),
    sourceWindow(0, { measurements: { publishedFrames: 48_001 } }),
    relayWindow(0, { measurements: { activeListenerCount: 2 } }),
    relayWindow(0, { measurements: { deliveredBytes: 3 } }),
  ];
  for (const value of impossible) {
    expectCode('report_invalid', () => validateMeasurementJson(bytes(value)));
  }
});

test('signal classifier covers zero, silent, present, isolated, and sustained windows', () => {
  assert.deepEqual(classifySignalWindow({ observedFrames: 0, silentFrames: 0, clippedFrames: 0, sourceChannels: 2 }), { signalPresence: 'unknown', clippingSeverity: 'unknown' });
  assert.deepEqual(classifySignalWindow({ observedFrames: 100, silentFrames: 100, clippedFrames: 0, sourceChannels: 2 }), { signalPresence: 'silent', clippingSeverity: 'none' });
  assert.deepEqual(classifySignalWindow({ observedFrames: 100, silentFrames: 0, clippedFrames: 0, sourceChannels: 2 }), { signalPresence: 'present', clippingSeverity: 'none' });
  assert.deepEqual(classifySignalWindow({ observedFrames: 1000, silentFrames: 0, clippedFrames: 1, sourceChannels: 2 }), { signalPresence: 'present', clippingSeverity: 'isolated' });
  assert.deepEqual(classifySignalWindow({ observedFrames: 100, silentFrames: 0, clippedFrames: 1, sourceChannels: 2 }), { signalPresence: 'present', clippingSeverity: 'sustained' });
  expectCode('report_invalid', () => classifySignalWindow({ observedFrames: 1, silentFrames: 1, clippedFrames: 1, sourceChannels: 2 }));
});

test('series validation enforces family, constants, cumulative values, and 256 bound', () => {
  const first = validateMeasurementJson(bytes(sourceWindow(0)));
  const second = validateMeasurementJson(bytes(sourceWindow(1, {
    measurements: {
      capturedFrames: 96_000, enqueuedFrames: 96_000, publishedFrames: 96_000,
      publishedBytes: 384_000,
    },
  })));
  assert.equal(validateMeasurementSeries([first, second]), undefined);

  const decreased = validateMeasurementJson(bytes(sourceWindow(1, {
    measurements: { capturedFrames: 47_999, enqueuedFrames: 47_999, publishedFrames: 47_999, publishedBytes: 191_996 },
  })));
  expectCode('report_invalid', () => validateMeasurementSeries([first, decreased]));
  expectCode('report_invalid', () => validateMeasurementSeries([first, validateMeasurementJson(bytes(listenerWindow(1)))]));
  expectCode('report_invalid', () => validateMeasurementSeries([]));

  const max = Array.from({ length: 256 }, (_, sequence) => validateMeasurementJson(bytes(sourceTransition(sequence))));
  assert.equal(validateMeasurementSeries(max), undefined);
  expectCode('report_invalid', () => validateMeasurementSeries([...max, validateMeasurementJson(bytes(sourceTransition(256)))]));
});

test('listener milestone series enforces once, precedence, and terminal/stop ordering', () => {
  const reports = [
    listenerTransition(0, 'request_started'),
    listenerTransition(1, 'response_headers', { elapsedMs: 10 }),
    listenerTransition(2, 'first_pcm_bytes', { elapsedMs: 20 }),
    listenerTransition(3, 'stream_ended', { reason: 'eof' }),
    listenerTransition(4, 'listener_stopped', { reason: 'requested' }),
  ].map((value) => validateMeasurementJson(bytes(value)));
  assert.equal(validateMeasurementSeries(reports), undefined);
  expectCode('report_invalid', () => validateMeasurementSeries([reports[0], reports[0]]));

  const failed = validateMeasurementJson(bytes(listenerTransition(4, 'stream_failed', { category: 'error', reason: 'stream_error' })));
  expectCode('report_invalid', () => validateMeasurementSeries([...reports.slice(0, 4), failed]));
  expectCode('report_invalid', () => validateMeasurementSeries([reports[0], reports[4], failed]));

  const invalidStop = listenerTransition(5, 'listener_stopped', { category: 'error', reason: 'requested' });
  expectCode('report_invalid', () => validateMeasurementJson(bytes(invalidStop)));
});

test('privacy projection is exact for listeners and denies source/relay members', () => {
  const listenerBytes = bytes(listenerWindow());
  assert.deepEqual(projectMemberMeasurementJson(listenerBytes), validateMeasurementJson(listenerBytes));
  assert.deepEqual(projectOperatorMeasurementJson(listenerBytes), validateMeasurementJson(listenerBytes));
  expectCode('not_authorized', () => projectMemberMeasurementJson(bytes(sourceWindow())));
  assert.equal(projectOperatorMeasurementJson(bytes(sourceWindow())).kind, 'source_window');

  const sentinel = projectRetainedMeasurementJson(Buffer.from('{'), 'member');
  assert.deepEqual(sentinel, { status: 'unavailable', reason: 'invalid_retained_report' });
  expectCode('not_authorized', () => projectRetainedMeasurementJson(bytes(listenerWindow()), 'someone'));
});

test('local export is exact, member-only, canonical, and series-validated', () => {
  const first = listenerWindow(0);
  const second = listenerWindow(1);
  const wrapper = {
    schemaVersion: 1,
    status: 'local_only',
    uploadState: 'disabled',
    generatedAtMonotonicMs: 20_000,
    instanceId: INSTANCE,
    summaries: [first, second],
  };
  const normalized = validateLocalDiagnosticExportJson(bytes(wrapper));
  assert.equal(normalized.summaries.length, 2);
  assert.deepEqual(validateLocalDiagnosticExportJson(canonicalLocalDiagnosticExportBytes(normalized)), normalized);

  expectCode('report_invalid', () => validateLocalDiagnosticExportJson(bytes({ ...wrapper, summaries: [] })));
  expectCode('report_invalid', () => validateLocalDiagnosticExportJson(bytes({ ...wrapper, summaries: [sourceWindow()] })));
  expectCode('report_invalid', () => validateLocalDiagnosticExportJson(bytes({ ...wrapper, generatedAtMonotonicMs: 1 })));

  const compact = Array.from({ length: 257 }, (_, sequence) => listenerTransition(sequence));
  expectCode('report_invalid', () => validateLocalDiagnosticExportJson(bytes({ ...wrapper, generatedAtMonotonicMs: 3_000_000, summaries: compact })));

  const large = Array.from({ length: 256 }, (_, sequence) => listenerWindow(sequence));
  expectCode('report_too_large', () => validateLocalDiagnosticExportJson(bytes({ ...wrapper, generatedAtMonotonicMs: 2_560_000, summaries: large })));
});

test('E1 module has no later-checkpoint imports', async () => {
  const source = await readFile(new URL('../lib/s2e-e1-contract.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /s2e-e[2-9]|alignment|collector|sqlite|react|audio-worklet/i);
});
