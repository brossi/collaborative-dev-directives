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

    for (const field of Object.keys(fixture)) {
      const missing = structuredClone(fixture);
      delete missing[field];
      expectCode('report_invalid', () => validateMeasurementJson(bytes(missing)));
    }
    for (const field of Object.keys(fixture.measurements)) {
      const missing = structuredClone(fixture);
      delete missing.measurements[field];
      expectCode('report_invalid', () => validateMeasurementJson(bytes(missing)));
    }
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
    const value = listenerTransition(0, type, extra);
    assert.equal(validateMeasurementJson(bytes(value)).measurements.type, type);
    value.measurements.prohibited = true;
    expectCode('report_invalid', () => validateMeasurementJson(bytes(value)));
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
    value.measurements.prohibited = true;
    expectCode('report_invalid', () => validateMeasurementJson(bytes(value)));
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
    value.measurements.prohibited = true;
    expectCode('report_invalid', () => validateMeasurementJson(bytes(value)));
  }
});

test('transition reason/category matrices reject every alternate category', () => {
  const sourceReasons = [
    ['capture_stopped', 'requested', 'observed'],
    ['capture_stopped', 'input_unavailable', 'error'],
    ['capture_stopped', 'authority_lost', 'observed'],
    ['capture_stopped', 'process_restart', 'observed'],
    ['capture_stopped', 'unknown', 'unknown'],
    ['publisher_stopped', 'publisher_unavailable', 'error'],
    ['publisher_stopped', 'requested', 'observed'],
    ['publisher_stopped', 'authority_lost', 'observed'],
    ['publisher_stopped', 'process_restart', 'observed'],
    ['publisher_stopped', 'unknown', 'unknown'],
    ['publisher_restarted', 'publisher_unavailable', 'error'],
    ['publisher_restarted', 'process_restart', 'observed'],
    ['publisher_restarted', 'unknown', 'unknown'],
  ];
  const relayReasons = [
    ['process_stopped', 'requested', 'observed'],
    ['process_stopped', 'process_restart', 'observed'],
    ['process_stopped', 'authority_lost', 'observed'],
    ['process_stopped', 'unknown', 'unknown'],
    ['generation_stopped', 'publisher_closed', 'observed'],
    ['generation_stopped', 'requested', 'observed'],
    ['generation_stopped', 'generation_replaced', 'observed'],
    ['generation_stopped', 'authority_lost', 'observed'],
    ['generation_stopped', 'process_restart', 'observed'],
    ['generation_stopped', 'unknown', 'unknown'],
    ['generation_fenced', 'generation_replaced', 'observed'],
    ['generation_fenced', 'backpressure', 'error'],
    ['generation_fenced', 'authority_lost', 'observed'],
    ['generation_fenced', 'unknown', 'unknown'],
  ];
  for (const [kind, rows] of [['source_transition', sourceReasons], ['relay_transition', relayReasons]]) {
    for (const [type, reason, expected] of rows) {
      const valid = base(kind, 0, { measurements: { type, category: expected, reason } });
      assert.equal(validateMeasurementJson(bytes(valid)).measurements.category, expected);
      for (const alternate of ['observed', 'error', 'unknown'].filter((value) => value !== expected)) {
        const invalid = base(kind, 0, { measurements: { type, category: alternate, reason } });
        expectCode('report_invalid', () => validateMeasurementJson(bytes(invalid)));
      }
    }
  }

  for (const [reason, expected] of [
    ['no_response', 'error'], ['rejected', 'error'], ['unsupported_format', 'error'],
    ['stream_error', 'error'], ['unknown', 'unknown'],
  ]) {
    for (const category of ['observed', 'error', 'unknown']) {
      const value = listenerTransition(0, 'stream_failed', { category, reason });
      if (category === expected) assert.equal(validateMeasurementJson(bytes(value)).measurements.category, expected);
      else expectCode('report_invalid', () => validateMeasurementJson(bytes(value)));
    }
  }
  for (const [reason, expected] of [
    ['requested', 'observed'], ['page_teardown', 'observed'],
    ['run_changed', 'observed'], ['unknown', 'unknown'],
  ]) {
    for (const category of ['observed', 'error', 'unknown']) {
      const value = listenerTransition(0, 'listener_stopped', { category, reason });
      if (category === expected) assert.equal(validateMeasurementJson(bytes(value)).measurements.category, expected);
      else expectCode('report_invalid', () => validateMeasurementJson(bytes(value)));
    }
  }
  for (const [observation, expected] of [
    ['playing', 'observed'], ['paused', 'observed'], ['error', 'error'], ['unknown', 'unknown'],
  ]) {
    for (const category of ['observed', 'error', 'unknown']) {
      const value = base('source_transition', 0, {
        measurements: { type: 'playback_changed', category, playbackObservation: observation },
      });
      if (category === expected) assert.equal(validateMeasurementJson(bytes(value)).measurements.category, expected);
      else expectCode('report_invalid', () => validateMeasurementJson(bytes(value)));
    }
  }

  const observedOnly = [
    ...['request_started', 'response_headers', 'first_pcm_bytes', 'buffer_primed', 'first_rendered_quantum',
      'underrun', 'reset', 'reconnect', 'context_suspended', 'context_resumed', 'stream_ended']
      .map((type) => listenerTransition(0, type, {
        ...(type === 'request_started' ? { elapsedMs: 0 } : {}),
        ...(['response_headers', 'first_pcm_bytes', 'buffer_primed', 'first_rendered_quantum'].includes(type) ? { elapsedMs: 1 } : {}),
        ...(type === 'stream_ended' ? { reason: 'eof' } : {}),
      })),
    ...['capture_started', 'publisher_started'].map((type) => base('source_transition', 0, { measurements: { type, category: 'observed' } })),
    ...['process_started', 'generation_started'].map((type) => base('relay_transition', 0, { measurements: { type, category: 'observed' } })),
  ];
  for (const value of observedOnly) {
    for (const category of ['error', 'unknown']) {
      const invalid = structuredClone(value);
      invalid.measurements.category = category;
      expectCode('report_invalid', () => validateMeasurementJson(bytes(invalid)));
    }
  }

  for (const invalid of [
    listenerTransition(0, 'request_started', { elapsedMs: 0, reason: 'eof' }),
    listenerTransition(0, 'underrun', { elapsedMs: 1 }),
    base('source_transition', 0, { measurements: { type: 'capture_started', category: 'observed', reason: 'requested' } }),
    base('source_transition', 0, { measurements: { type: 'capture_started', category: 'observed', connectionAttemptSequence: 0 } }),
    base('relay_transition', 0, { measurements: { type: 'process_started', category: 'observed', reason: 'requested' } }),
  ]) {
    expectCode('report_invalid', () => validateMeasurementJson(bytes(invalid)));
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
  expectCode('report_invalid', () => validateMeasurementJson(Uint8Array.from([0xc3, 0x28])));
  expectCode('report_invalid', () => validateMeasurementJson(Buffer.from(JSON.stringify(listenerWindow()).replace('"safari"', '"\\ud800"'))));

  for (const invalidUuid of [
    '00000000-0000-0000-0000-000000000000',
    '123e4567-e89b-42d3-7456-426614174000',
    INSTANCE.toUpperCase(),
  ]) {
    expectCode('report_invalid', () => validateMeasurementJson(bytes({ ...listenerWindow(), instanceId: invalidUuid })));
  }
});

test('hostile byte views and forged normalized objects fail with finite contract results', () => {
  const hostile = Uint8Array.from(bytes(listenerWindow()));
  let byteLengthAccessed = false;
  Object.defineProperty(hostile, 'byteLength', { get() { byteLengthAccessed = true; throw new Error('caller_secret'); } });
  assert.equal(validateMeasurementJson(hostile).kind, 'listener_window');
  assert.equal(byteLengthAccessed, false);

  const proxy = new Proxy(Uint8Array.from(bytes(listenerWindow())), {});
  expectCode('report_invalid', () => validateMeasurementJson(proxy));
  assert.deepEqual(projectRetainedMeasurementJson(proxy, 'member'), { status: 'unavailable', reason: 'invalid_retained_report' });

  let accessed = false;
  const forged = Object.create(null);
  Object.defineProperty(forged, 'schemaVersion', { enumerable: true, get() { accessed = true; return 1; } });
  Object.freeze(forged);
  expectCode('report_invalid', () => canonicalMeasurementBytes(forged));
  assert.equal(accessed, false);

  let proxyTrapAccessed = false;
  const forgedProxy = new Proxy(Object.freeze(Object.create(null)), {
    getPrototypeOf() { proxyTrapAccessed = true; throw new Error('normalized_secret'); },
  });
  expectCode('report_invalid', () => canonicalMeasurementBytes(forgedProxy));
  assert.equal(proxyTrapAccessed, false);
});

test('fractional monotonic timestamps are accepted and checked without rounded overflow', () => {
  const fractional = listenerWindow(0, { monotonicStartMs: 0.5, durationMs: 9999.5 });
  assert.equal(validateMeasurementJson(bytes(fractional)).monotonicStartMs, 0.5);
  const overflowing = listenerWindow(0, { monotonicStartMs: Number.MAX_SAFE_INTEGER, durationMs: 0.1 });
  expectCode('report_invalid', () => validateMeasurementJson(bytes(overflowing)));
});

test('canonical bytes are independent of caller property order', () => {
  const value = listenerWindow();
  const reversed = Object.fromEntries(Object.entries(value).reverse());
  reversed.measurements = Object.fromEntries(Object.entries(value.measurements).reverse());
  const a = validateMeasurementJson(bytes(value));
  const b = validateMeasurementJson(bytes(reversed));
  assert.deepEqual(canonicalMeasurementBytes(a), canonicalMeasurementBytes(b));
  assert.equal(measurementIdentity(a), `${INSTANCE}:0`);

  const fractional = validateMeasurementJson(bytes(listenerWindow(0, {
    monotonicStartMs: 0.5, durationMs: 9999.5,
  })));
  const canonical = new TextDecoder().decode(canonicalMeasurementBytes(fractional));
  assert.match(canonical, /^\{"schemaVersion":1,"kind":"listener_window","instanceId":/);
  assert.match(canonical, /"monotonicStartMs":0\.5,"durationMs":9999\.5,/);
  for (const fixture of FIXTURES) {
    assert.ok(canonicalMeasurementBytes(validateMeasurementJson(bytes(fixture))).byteLength <= 2048);
  }
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
    listenerWindow(0, { measurements: { chunkGap: { status: 'observed', count: 98, meanMs: 10, maxMs: 20 } } }),
    listenerWindow(0, { measurements: { chunkGap: { status: 'not_applicable' } } }),
    listenerWindow(0, { measurements: { chunkGap: { status: 'observed', count: 99, meanMs: 21, maxMs: 20 } } }),
    listenerWindow(0, { measurements: { bufferDepth: { status: 'observed', sampleCount: 1, currentMs: 10, minMs: 20, maxMs: 30, meanMs: 25, trendMsPerSecond: 0 } } }),
    listenerWindow(0, { measurements: { underrunCount: 1, underrunDurationMs: 0 } }),
    listenerWindow(0, { measurements: { underrunCount: 0, underrunDurationMs: 1 } }),
    listenerWindow(0, { measurements: { windowStartedInUnderrun: true, underrunDurationMs: 1, reprimeCount: 2 } }),
    listenerWindow(0, { measurements: { overflowCount: 1, discardedFrames: 0 } }),
    listenerWindow(0, { measurements: { overflowCount: 0, discardedFrames: 1 } }),
    listenerWindow(0, { measurements: { nominalRateRatio: 2 } }),
    listenerWindow(0, { measurements: { longTasks: { status: 'observed', count: 0, maxDurationMs: 1 } } }),
    listenerWindow(0, { measurements: { longTasks: { status: 'observed', count: 1, maxDurationMs: 0 } } }),
    sourceWindow(0, { measurements: { publishedFrames: 48_001 } }),
    sourceWindow(0, { measurements: { capturedFrames: 47_999 } }),
    sourceWindow(0, { measurements: { publishedBytes: 1 } }),
    relayWindow(0, { measurements: { activeListenerCount: 2 } }),
    relayWindow(0, { measurements: { closedListenerCount: 3 } }),
    relayWindow(0, { measurements: { deliveredBytes: 3 } }),
    relayWindow(0, { measurements: { backpressureClosureCount: 1, generationFenceDisconnectCount: 1 } }),
  ];
  for (const value of impossible) {
    expectCode('report_invalid', () => validateMeasurementJson(bytes(value)));
  }
});

test('cross-field truth tables accept their finite boundary rows', () => {
  const valid = [
    listenerWindow(0, { measurements: {
      receivedBytes: 0, receivedFrames: 0, chunkCount: 0,
      chunkGap: { status: 'not_applicable' }, signalPresence: 'unknown', clippingSeverity: 'unknown',
    } }),
    listenerWindow(0, { measurements: {
      receivedBytes: 4, receivedFrames: 1, chunkCount: 1,
      chunkGap: { status: 'not_applicable' }, signalPresence: 'present', clippingSeverity: 'none',
    } }),
    listenerWindow(0, { measurements: {
      underrunCount: 0, windowStartedInUnderrun: true, underrunDurationMs: 1, reprimeCount: 1,
    } }),
    listenerWindow(0, { measurements: { overflowCount: 1, discardedFrames: 1 } }),
    listenerWindow(0, { measurements: { longTasks: { status: 'observed', count: 1, maxDurationMs: 1 } } }),
    sourceWindow(0, { measurements: {
      capturedFrames: 3, enqueuedFrames: 2, publishedFrames: 1, publishedBytes: 4,
    } }),
    relayWindow(0, { measurements: {
      acceptedListenerCount: 2, closedListenerCount: 2, activeListenerCount: 0,
      backpressureClosureCount: 1, generationFenceDisconnectCount: 1,
    } }),
  ];
  for (const value of valid) assert.equal(validateMeasurementJson(bytes(value)).kind, value.kind);
});

test('signal classifier covers zero, silent, present, isolated, and sustained windows', () => {
  assert.deepEqual(classifySignalWindow(0, 0, 0, 2), { signalPresence: 'unknown', clippingSeverity: 'unknown' });
  assert.deepEqual(classifySignalWindow(100, 100, 0, 2), { signalPresence: 'silent', clippingSeverity: 'none' });
  assert.deepEqual(classifySignalWindow(100, 0, 0, 2), { signalPresence: 'present', clippingSeverity: 'none' });
  assert.deepEqual(classifySignalWindow(1000, 0, 1, 2), { signalPresence: 'present', clippingSeverity: 'isolated' });
  assert.deepEqual(classifySignalWindow(100, 0, 1, 2), { signalPresence: 'present', clippingSeverity: 'sustained' });
  expectCode('report_invalid', () => classifySignalWindow(1, 1, 1, 2));
  expectCode('report_invalid', () => classifySignalWindow({}, 0, 0, 2));
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

  const changedConstant = validateMeasurementJson(bytes(sourceWindow(1, {
    measurements: { sampleRate: 44_100 },
  })));
  expectCode('report_invalid', () => validateMeasurementSeries([first, changedConstant]));
  const overlap = validateMeasurementJson(bytes(sourceWindow(1, { monotonicStartMs: 9_999 })));
  expectCode('report_invalid', () => validateMeasurementSeries([first, overlap]));

  const max = Array.from({ length: 256 }, (_, sequence) => validateMeasurementJson(bytes(sourceTransition(sequence))));
  assert.equal(validateMeasurementSeries(max), undefined);
  expectCode('report_invalid', () => validateMeasurementSeries([...max, validateMeasurementJson(bytes(sourceTransition(256)))]));
});

test('listener reconnect transitions do not corrupt successive-window accounting', () => {
  const first = validateMeasurementJson(bytes(listenerWindow(0)));
  const reconnect = validateMeasurementJson(bytes(listenerTransition(1, 'reconnect', { connectionAttemptSequence: 1 })));
  const second = validateMeasurementJson(bytes(listenerWindow(2, {
    measurements: { connectionAttemptSequence: 1, reconnectCount: 1 },
  })));
  assert.equal(validateMeasurementSeries([first, reconnect, second]), undefined);
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
  for (const fixture of FIXTURES) {
    const input = bytes(fixture);
    const operator = projectOperatorMeasurementJson(input);
    assert.equal(operator.kind, fixture.kind);
    if (fixture.kind.startsWith('listener_')) {
      assert.deepEqual(projectMemberMeasurementJson(input), validateMeasurementJson(input));
    } else {
      expectCode('not_authorized', () => projectMemberMeasurementJson(input));
    }
  }

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
    generatedAtMonotonicMs: 20_000.5,
    instanceId: INSTANCE,
    summaries: [first, second],
  };
  const normalized = validateLocalDiagnosticExportJson(bytes(wrapper));
  assert.equal(normalized.summaries.length, 2);
  assert.equal(normalized.generatedAtMonotonicMs, 20_000.5);
  assert.deepEqual(validateLocalDiagnosticExportJson(canonicalLocalDiagnosticExportBytes(normalized)), normalized);

  let iteratorAccessed = false;
  const hostileSummaries = [];
  Object.setPrototypeOf(hostileSummaries, {
    [Symbol.iterator]() { iteratorAccessed = true; throw new Error('iterator_secret'); },
  });
  const forgedExport = Object.freeze({ ...wrapper, summaries: Object.freeze(hostileSummaries) });
  expectCode('report_invalid', () => canonicalLocalDiagnosticExportBytes(forgedExport));
  assert.equal(iteratorAccessed, false);

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
  assert.doesNotMatch(source, /\bimport\s*\(|\bimport\s+(?:['"]|[^;\n]*\bfrom\s*['"])/m);
  assert.doesNotMatch(source, /\bexport\s+(?:\*|\{[^}]*\})\s+from\s*['"]/m);
  assert.doesNotMatch(source, /s2e-e[2-9]|alignment|collector|sqlite|react|audio-worklet/i);
});
