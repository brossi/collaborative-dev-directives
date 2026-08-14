const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const MAX_REPORT_INPUT_BYTES = 8192;
const MAX_REPORT_BYTES = 2048;
const MAX_EXPORT_INPUT_BYTES = 524288;
const MAX_EXPORT_BYTES = 262144;
const MAX_SERIES = 256;

const KINDS = new Set([
  'listener_window', 'listener_transition', 'source_window',
  'source_transition', 'relay_window', 'relay_transition',
]);
const LISTENER_KINDS = new Set(['listener_window', 'listener_transition']);
const WINDOW_KINDS = new Set(['listener_window', 'source_window', 'relay_window']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const NIL_UUID = '00000000-0000-0000-0000-000000000000';
const decoder = new TextDecoder('utf-8', { fatal: true });
const encoder = new TextEncoder();

export class E1ContractError extends Error {
  constructor(code) {
    super(code);
    this.name = 'E1ContractError';
    this.code = code;
  }
}

function fail(code = 'report_invalid') {
  throw new E1ContractError(code);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function rejectInvalidString(value) {
  if (typeof value !== 'string') fail();
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) fail();
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      fail();
    }
  }
  return value;
}

function finite(value, min, max, { integer = false, positive = false } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value) || Object.is(value, -0)) fail();
  if (integer && !Number.isInteger(value)) fail();
  if (value < min || value > max || (positive && value === 0)) fail();
  return value;
}

const uint = (value) => finite(value, 0, MAX_SAFE, { integer: true });
const positiveUint = (value) => finite(value, 1, MAX_SAFE, { integer: true, positive: true });
const monotonicMs = (value) => finite(value, 0, MAX_SAFE);
const windowMs = (value) => finite(value, 0, 60000);
const latencyMs = windowMs;
const boolean = (value) => {
  if (typeof value !== 'boolean') fail();
  return value;
};
const literal = (expected) => (value) => {
  if (value !== expected) fail();
  return value;
};
const enumeration = (values) => {
  const allowed = new Set(values);
  return (value) => {
    if (typeof value === 'string') rejectInvalidString(value);
    if (!allowed.has(value)) fail();
    return value;
  };
};
const uuid = (value) => {
  rejectInvalidString(value);
  if (value === NIL_UUID || !UUID.test(value)) fail();
  return value;
};

function exactRecord(value, fields) {
  if (!isRecord(value)) fail();
  const keys = Object.keys(value);
  const expected = Object.keys(fields);
  if (keys.length !== expected.length || expected.some((key) => !Object.hasOwn(value, key))) fail();
  const output = Object.create(null);
  for (const key of expected) output[key] = fields[key](value[key]);
  return output;
}

function unionByStatus(variants) {
  return (value) => {
    if (!isRecord(value) || typeof value.status !== 'string' || !Object.hasOwn(variants, value.status)) fail();
    return exactRecord(value, variants[value.status]);
  };
}

const observedLatency = unionByStatus({
  observed: { status: literal('observed'), value: latencyMs },
  unknown: { status: literal('unknown') },
  unsupported: { status: literal('unsupported') },
  not_applicable: { status: literal('not_applicable') },
});
const browserMajor = unionByStatus({
  observed: { status: literal('observed'), value: (value) => finite(value, 1, 999, { integer: true }) },
  unknown: { status: literal('unknown') },
});
const chunkGap = unionByStatus({
  observed: {
    status: literal('observed'), count: positiveUint, meanMs: windowMs, maxMs: windowMs,
  },
  not_applicable: { status: literal('not_applicable') },
});
const bufferDepth = unionByStatus({
  observed: {
    status: literal('observed'), sampleCount: positiveUint, currentMs: windowMs,
    minMs: windowMs, maxMs: windowMs, meanMs: windowMs,
    trendMsPerSecond: (value) => finite(value, -60000, 60000),
  },
  unknown: { status: literal('unknown') },
});
const longTasks = unionByStatus({
  observed: { status: literal('observed'), count: uint, maxDurationMs: windowMs },
  unsupported: { status: literal('unsupported') },
  unknown: { status: literal('unknown') },
});

const listenerWindowFields = {
  connectionAttemptSequence: uint,
  receivedBytes: uint,
  receivedFrames: uint,
  chunkCount: uint,
  chunkGap,
  reconnectCount: uint,
  terminalCategory: enumeration(['open', 'no_response', 'rejected', 'unsupported_format', 'stream_error', 'stream_ended', 'aborted', 'unknown']),
  bufferDepth,
  underrunCount: uint,
  underrunDurationMs: windowMs,
  reprimeCount: uint,
  windowStartedInUnderrun: boolean,
  overflowCount: uint,
  discardedFrames: uint,
  resetCount: uint,
  sourceSampleRate: (value) => finite(value, 8000, 384000, { integer: true }),
  sourceChannels: enumeration([1, 2]),
  outputSampleRate: (value) => finite(value, 8000, 384000, { integer: true }),
  nominalRateRatio: (value) => finite(value, 0.020833333333333332, 48),
  audioContextState: enumeration(['running', 'suspended', 'closed', 'interrupted', 'unknown']),
  baseLatencyMs: observedLatency,
  outputLatencyMs: observedLatency,
  visibilityState: enumeration(['visible', 'hidden', 'unknown']),
  suspensionCount: uint,
  longTasks,
  signalPresence: enumeration(['unknown', 'silent', 'present']),
  clippingSeverity: enumeration(['unknown', 'none', 'isolated', 'sustained']),
  browserFamily: enumeration(['chromium', 'firefox', 'safari', 'other', 'unknown']),
  browserMajor,
  osFamily: enumeration(['android', 'ios', 'macos', 'windows', 'linux', 'chromeos', 'other', 'unknown']),
  displayMode: enumeration(['browser', 'standalone', 'unknown']),
  implementationVersion: positiveUint,
};

const sourceWindowFields = {
  sampleRate: (value) => finite(value, 8000, 384000, { integer: true }),
  channels: enumeration([1, 2]),
  encoding: literal('s16le'),
  capturedFrames: uint,
  enqueuedFrames: uint,
  publishedFrames: uint,
  publishedBytes: uint,
  captureGapCount: uint,
  droppedUploadCount: uint,
  reconnectCount: uint,
  publisherRestartCount: uint,
  publisherState: enumeration(['idle', 'connecting', 'publishing', 'backoff', 'stopped', 'error', 'unknown']),
  playbackObservation: enumeration(['playing', 'paused', 'error', 'unknown']),
};

const relayWindowFields = {
  sampleRate: (value) => finite(value, 8000, 384000, { integer: true }),
  channels: enumeration([1, 2]),
  encoding: literal('s16le'),
  ingressFrames: uint,
  ingressBytes: uint,
  ingressGapCount: uint,
  rejectedIngressCount: uint,
  droppedIngressCount: uint,
  acceptedListenerCount: uint,
  closedListenerCount: uint,
  deliveredBytes: uint,
  backpressureClosureCount: uint,
  generationFenceDisconnectCount: uint,
  activeListenerCount: uint,
};

const CATEGORY = enumeration(['observed', 'error', 'unknown']);

function validateReasonCategory(reason, category) {
  const errors = new Set(['input_unavailable', 'publisher_unavailable', 'backpressure']);
  const unknown = reason === 'unknown';
  if ((errors.has(reason) && category !== 'error') || (unknown && category !== 'unknown')
    || (!errors.has(reason) && !unknown && category !== 'observed')) fail();
}

function listenerTransition(value) {
  if (!isRecord(value)) fail();
  const type = value.type;
  const base = { type: enumeration([
    'request_started', 'response_headers', 'first_pcm_bytes', 'buffer_primed',
    'first_rendered_quantum', 'underrun', 'reset', 'reconnect', 'context_suspended',
    'context_resumed', 'stream_failed', 'stream_ended', 'listener_stopped',
  ]), category: CATEGORY, connectionAttemptSequence: uint };
  let fields;
  if (type === 'request_started') fields = { ...base, elapsedMs: literal(0) };
  else if (['response_headers', 'first_pcm_bytes', 'buffer_primed', 'first_rendered_quantum'].includes(type)) fields = { ...base, elapsedMs: windowMs };
  else if (['underrun', 'reset', 'reconnect', 'context_suspended', 'context_resumed'].includes(type)) fields = base;
  else if (type === 'stream_failed') fields = { ...base, reason: enumeration(['no_response', 'rejected', 'unsupported_format', 'stream_error', 'unknown']) };
  else if (type === 'stream_ended') fields = { ...base, reason: literal('eof') };
  else if (type === 'listener_stopped') fields = { ...base, reason: enumeration(['requested', 'page_teardown', 'run_changed', 'unknown']) };
  else fail();
  const output = exactRecord(value, fields);
  if (['request_started', 'response_headers', 'first_pcm_bytes', 'buffer_primed', 'first_rendered_quantum', 'underrun', 'reset', 'reconnect', 'context_suspended', 'context_resumed', 'stream_ended'].includes(type) && output.category !== 'observed') fail();
  if (type === 'stream_failed') {
    if ((output.reason === 'unknown') !== (output.category === 'unknown')) fail();
    if (output.reason !== 'unknown' && output.category !== 'error') fail();
  }
  if (type === 'listener_stopped') {
    const expected = output.reason === 'unknown' ? 'unknown' : 'observed';
    if (output.category !== expected) fail();
  }
  return output;
}

function sourceTransition(value) {
  if (!isRecord(value)) fail();
  const type = value.type;
  const base = { type: enumeration(['capture_started', 'publisher_started', 'capture_stopped', 'publisher_stopped', 'publisher_restarted', 'playback_changed']), category: CATEGORY };
  let fields;
  if (['capture_started', 'publisher_started'].includes(type)) fields = base;
  else if (type === 'capture_stopped') fields = { ...base, reason: enumeration(['requested', 'input_unavailable', 'authority_lost', 'process_restart', 'unknown']) };
  else if (type === 'publisher_stopped') fields = { ...base, reason: enumeration(['requested', 'publisher_unavailable', 'authority_lost', 'process_restart', 'unknown']) };
  else if (type === 'publisher_restarted') fields = { ...base, reason: enumeration(['publisher_unavailable', 'process_restart', 'unknown']) };
  else if (type === 'playback_changed') fields = { ...base, playbackObservation: enumeration(['playing', 'paused', 'error', 'unknown']) };
  else fail();
  const output = exactRecord(value, fields);
  if (['capture_started', 'publisher_started'].includes(type) && output.category !== 'observed') fail();
  if (Object.hasOwn(output, 'reason')) validateReasonCategory(output.reason, output.category);
  if (type === 'playback_changed') {
    const expected = output.playbackObservation === 'error' ? 'error' : output.playbackObservation === 'unknown' ? 'unknown' : 'observed';
    if (output.category !== expected) fail();
  }
  return output;
}

function relayTransition(value) {
  if (!isRecord(value)) fail();
  const type = value.type;
  const base = { type: enumeration(['process_started', 'generation_started', 'process_stopped', 'generation_stopped', 'generation_fenced']), category: CATEGORY };
  let fields;
  if (['process_started', 'generation_started'].includes(type)) fields = base;
  else if (type === 'process_stopped') fields = { ...base, reason: enumeration(['requested', 'process_restart', 'authority_lost', 'unknown']) };
  else if (type === 'generation_stopped') fields = { ...base, reason: enumeration(['requested', 'publisher_closed', 'generation_replaced', 'authority_lost', 'process_restart', 'unknown']) };
  else if (type === 'generation_fenced') fields = { ...base, reason: enumeration(['generation_replaced', 'backpressure', 'authority_lost', 'unknown']) };
  else fail();
  const output = exactRecord(value, fields);
  if (['process_started', 'generation_started'].includes(type) && output.category !== 'observed') fail();
  if (Object.hasOwn(output, 'reason')) validateReasonCategory(output.reason, output.category);
  return output;
}

function checkedProduct(...values) {
  let product = 1n;
  for (const value of values) product *= BigInt(value);
  if (product > BigInt(MAX_SAFE)) fail();
  return Number(product);
}

function validateListenerWindow(value) {
  const output = exactRecord(value, listenerWindowFields);
  if (output.receivedBytes !== checkedProduct(output.receivedFrames, output.sourceChannels, 2)) fail();
  if ((output.chunkCount === 0) !== (output.receivedFrames === 0) || output.chunkCount > output.receivedFrames) fail();
  if (output.chunkCount >= 2) {
    if (output.chunkGap.status !== 'observed' || output.chunkGap.count !== output.chunkCount - 1 || output.chunkGap.meanMs > output.chunkGap.maxMs) fail();
  } else if (output.chunkGap.status !== 'not_applicable') fail();
  if (output.bufferDepth.status === 'observed') {
    const depth = output.bufferDepth;
    if (depth.minMs > depth.meanMs || depth.meanMs > depth.maxMs || depth.minMs > depth.currentMs || depth.currentMs > depth.maxMs) fail();
  }
  const activeUnderrun = output.underrunCount > 0 || output.windowStartedInUnderrun;
  if ((output.underrunDurationMs > 0) !== activeUnderrun || output.reprimeCount > output.underrunCount + (output.windowStartedInUnderrun ? 1 : 0)) fail();
  if ((output.overflowCount === 0) !== (output.discardedFrames === 0)) fail();
  if (Math.abs(output.nominalRateRatio - output.sourceSampleRate / output.outputSampleRate) > 1e-12) fail();
  if (output.longTasks.status === 'observed' && ((output.longTasks.count === 0) !== (output.longTasks.maxDurationMs === 0))) fail();
  const signalPair = `${output.signalPresence}/${output.clippingSeverity}`;
  const allowed = output.receivedFrames === 0
    ? new Set(['unknown/unknown'])
    : new Set(['silent/none', 'present/none', 'present/isolated', 'present/sustained']);
  if (!allowed.has(signalPair)) fail();
  return output;
}

function validateSourceWindow(value) {
  const output = exactRecord(value, sourceWindowFields);
  if (!(output.publishedFrames <= output.enqueuedFrames && output.enqueuedFrames <= output.capturedFrames)) fail();
  if (output.publishedBytes !== checkedProduct(output.publishedFrames, output.channels, 2)) fail();
  return output;
}

function validateRelayWindow(value) {
  const output = exactRecord(value, relayWindowFields);
  if (output.ingressBytes !== checkedProduct(output.ingressFrames, output.channels, 2)) fail();
  if (output.closedListenerCount > output.acceptedListenerCount
    || output.activeListenerCount !== output.acceptedListenerCount - output.closedListenerCount) fail();
  if (output.deliveredBytes % (output.channels * 2) !== 0) fail();
  if (output.backpressureClosureCount > output.closedListenerCount
    || output.generationFenceDisconnectCount > output.closedListenerCount
    || output.backpressureClosureCount + output.generationFenceDisconnectCount > output.closedListenerCount) fail();
  return output;
}

function normalizeReport(value) {
  if (!isRecord(value)) fail();
  const kind = value.kind;
  if (!KINDS.has(kind)) fail();
  const duration = kind.endsWith('_transition')
    ? literal(0)
    : (entry) => finite(entry, Number.MIN_VALUE, 10000, { positive: true });
  const measurementValidator = {
    listener_window: validateListenerWindow,
    listener_transition: listenerTransition,
    source_window: validateSourceWindow,
    source_transition: sourceTransition,
    relay_window: validateRelayWindow,
    relay_transition: relayTransition,
  }[kind];
  const output = exactRecord(value, {
    schemaVersion: literal(1),
    kind: literal(kind),
    instanceId: uuid,
    sequence: uint,
    monotonicStartMs: monotonicMs,
    durationMs: duration,
    measurements: measurementValidator,
  });
  if (output.durationMs > MAX_SAFE - output.monotonicStartMs) fail();
  return output;
}

function deepFreeze(value) {
  for (const nested of Object.values(value)) {
    if (nested && typeof nested === 'object') deepFreeze(nested);
  }
  return Object.freeze(value);
}

function parseBytes(input, maximum) {
  try {
    if (!ArrayBuffer.isView(input) || !(input instanceof Uint8Array)) fail();
    const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
    const byteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength').get.call(input);
    if (byteLength > maximum) fail();
    const copy = new Uint8Array(byteLength);
    Uint8Array.prototype.set.call(copy, input);
    return JSON.parse(decoder.decode(copy));
  } catch {
    fail();
  }
}

function encodeNormalized(value) {
  return encoder.encode(JSON.stringify(value));
}

function normalizeAndSize(value) {
  const output = normalizeReport(value);
  if (encodeNormalized(output).byteLength > MAX_REPORT_BYTES) fail('report_too_large');
  return deepFreeze(output);
}

function assertNormalized(report) {
  assertNormalizedTree(report);
  return normalizeAndSize(report);
}

function assertNormalizedTree(value, arraysAllowed = false) {
  if (Array.isArray(value)) {
    if (!arraysAllowed || !Object.isFrozen(value)) fail();
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
      if (Object.hasOwn(descriptor, 'get') || Object.hasOwn(descriptor, 'set')) fail();
    }
    for (const item of value) assertNormalizedTree(item, arraysAllowed);
    return;
  }
  if (!isRecord(value) || Object.getPrototypeOf(value) !== null || !Object.isFrozen(value)) fail();
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (Object.hasOwn(descriptor, 'get') || Object.hasOwn(descriptor, 'set') || !descriptor.enumerable) fail();
    if (descriptor.value && typeof descriptor.value === 'object') assertNormalizedTree(descriptor.value, arraysAllowed);
  }
}

export function validateMeasurementJson(input) {
  return normalizeAndSize(parseBytes(input, MAX_REPORT_INPUT_BYTES));
}

export function canonicalMeasurementBytes(report) {
  return encodeNormalized(assertNormalized(report));
}

export function measurementIdentity(report) {
  const normalized = assertNormalized(report);
  return `${normalized.instanceId}:${normalized.sequence}`;
}

export function classifyMeasurementReplay(existing, incoming) {
  const next = assertNormalized(incoming);
  if (existing === null) return 'accepted';
  if (existing === undefined) fail();
  const prior = assertNormalized(existing);
  if (measurementIdentity(prior) !== measurementIdentity(next)) return 'distinct';
  const priorBytes = canonicalMeasurementBytes(prior);
  const nextBytes = canonicalMeasurementBytes(next);
  if (priorBytes.byteLength !== nextBytes.byteLength) return 'report_conflict';
  for (let index = 0; index < priorBytes.byteLength; index += 1) {
    if (priorBytes[index] !== nextBytes[index]) return 'report_conflict';
  }
  return 'replayed';
}

function family(kind) {
  return kind.split('_')[0];
}

const CONSTANT_FIELDS = {
  listener_window: ['sourceSampleRate', 'sourceChannels', 'outputSampleRate', 'browserFamily', 'browserMajor', 'osFamily', 'displayMode', 'implementationVersion'],
  source_window: ['sampleRate', 'channels', 'encoding'],
  relay_window: ['sampleRate', 'channels', 'encoding'],
};
const CUMULATIVE_FIELDS = {
  source_window: ['capturedFrames', 'enqueuedFrames', 'publishedFrames', 'publishedBytes', 'captureGapCount', 'droppedUploadCount', 'reconnectCount', 'publisherRestartCount'],
  relay_window: ['ingressFrames', 'ingressBytes', 'ingressGapCount', 'rejectedIngressCount', 'droppedIngressCount', 'acceptedListenerCount', 'closedListenerCount', 'deliveredBytes', 'backpressureClosureCount', 'generationFenceDisconnectCount'],
};

function equalValue(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function validateMeasurementSeries(reports) {
  if (!Array.isArray(reports) || reports.length < 1 || reports.length > MAX_SERIES) fail();
  const normalized = reports.map(assertNormalized);
  const first = normalized[0];
  let previousSequence = -1;
  const priorWindows = new Map();
  const priorKinds = new Map();
  let latestAttempt = -1;
  let previousWindowAttempt = -1;
  const milestones = new Map();
  const terminals = new Map();
  const stopped = new Set();
  const reconnects = new Set();
  const milestoneOrder = new Map(['request_started', 'response_headers', 'first_pcm_bytes', 'buffer_primed', 'first_rendered_quantum'].map((name, index) => [name, index]));

  for (const report of normalized) {
    if (report.instanceId !== first.instanceId || family(report.kind) !== family(first.kind) || report.sequence <= previousSequence) fail();
    previousSequence = report.sequence;
    if (WINDOW_KINDS.has(report.kind)) {
      const priorWindow = priorWindows.get(report.kind);
      if (priorWindow && report.monotonicStartMs < priorWindow.monotonicStartMs + priorWindow.durationMs) fail();
      priorWindows.set(report.kind, report);
      const priorKind = priorKinds.get(report.kind);
      if (priorKind) {
        for (const field of CONSTANT_FIELDS[report.kind] ?? []) {
          if (!equalValue(priorKind.measurements[field], report.measurements[field])) fail();
        }
        for (const field of CUMULATIVE_FIELDS[report.kind] ?? []) {
          if (report.measurements[field] < priorKind.measurements[field]) fail();
        }
      }
      priorKinds.set(report.kind, report);
    }
    if (report.kind === 'listener_window') {
      const attempt = report.measurements.connectionAttemptSequence;
      if (attempt < latestAttempt) fail();
      if (previousWindowAttempt >= 0 && attempt === previousWindowAttempt && report.measurements.reconnectCount !== 0) fail();
      if (previousWindowAttempt >= 0 && attempt > previousWindowAttempt && report.measurements.reconnectCount > attempt - previousWindowAttempt) fail();
      previousWindowAttempt = attempt;
      latestAttempt = attempt;
    }
    if (report.kind === 'listener_transition') {
      const { connectionAttemptSequence: attempt, type } = report.measurements;
      if (attempt < latestAttempt) fail();
      latestAttempt = attempt;
      if (milestoneOrder.has(type)) {
        const prior = milestones.get(attempt);
        const current = { order: milestoneOrder.get(type), elapsed: report.measurements.elapsedMs };
        if (prior?.types.has(type) || (prior && (current.order < prior.order || current.elapsed < prior.elapsed))) fail();
        milestones.set(attempt, { order: current.order, elapsed: current.elapsed, types: new Set([...(prior?.types ?? []), type]) });
      }
      if (type === 'stream_failed' || type === 'stream_ended') {
        if (terminals.has(attempt) || stopped.has(attempt)) fail();
        terminals.set(attempt, report.sequence);
      }
      if (type === 'listener_stopped') {
        if (stopped.has(attempt) || (terminals.has(attempt) && report.sequence <= terminals.get(attempt))) fail();
        stopped.add(attempt);
      }
      if (type === 'reconnect') {
        if (reconnects.has(attempt)) fail();
        reconnects.add(attempt);
      }
    }
  }
}

export function classifySignalWindow(observedFrames, silentFrames, clippedFrames, sourceChannels) {
  const output = {
    observedFrames: uint(observedFrames),
    silentFrames: uint(silentFrames),
    clippedFrames: uint(clippedFrames),
    sourceChannels: enumeration([1, 2])(sourceChannels),
  };
  if (output.silentFrames + output.clippedFrames > output.observedFrames) fail();
  if (output.observedFrames === 0) return { signalPresence: 'unknown', clippingSeverity: 'unknown' };
  if (output.silentFrames === output.observedFrames) return { signalPresence: 'silent', clippingSeverity: 'none' };
  if (output.clippedFrames === 0) return { signalPresence: 'present', clippingSeverity: 'none' };
  return {
    signalPresence: 'present',
    clippingSeverity: output.clippedFrames / output.observedFrames < 0.01 ? 'isolated' : 'sustained',
  };
}

export function projectMemberMeasurementJson(input) {
  const report = validateMeasurementJson(input);
  if (!LISTENER_KINDS.has(report.kind)) fail('not_authorized');
  return report;
}

export function projectOperatorMeasurementJson(input) {
  return validateMeasurementJson(input);
}

const INVALID_RETAINED = deepFreeze({
  status: 'unavailable', reason: 'invalid_retained_report',
});

export function projectRetainedMeasurementJson(input, audience) {
  let report;
  try {
    report = validateMeasurementJson(input);
  } catch (error) {
    if (error instanceof E1ContractError) return INVALID_RETAINED;
    throw error;
  }
  if (audience !== 'member' && audience !== 'operator') fail('not_authorized');
  if (audience === 'member' && !LISTENER_KINDS.has(report.kind)) fail('not_authorized');
  return report;
}

function normalizeExport(value) {
  if (!isRecord(value)) fail();
  const output = exactRecord(value, {
    schemaVersion: literal(1),
    status: literal('local_only'),
    uploadState: literal('disabled'),
    generatedAtMonotonicMs: monotonicMs,
    instanceId: uuid,
    summaries: (summaries) => {
      if (!Array.isArray(summaries) || summaries.length < 1 || summaries.length > MAX_SERIES) fail();
      return summaries.map((summary) => {
        const report = normalizeAndSize(summary);
        if (!LISTENER_KINDS.has(report.kind)) fail();
        return report;
      });
    },
  });
  if (output.summaries.some((report) => report.instanceId !== output.instanceId)) fail();
  validateMeasurementSeries(output.summaries);
  const maximumEnd = Math.max(...output.summaries.map((report) => report.monotonicStartMs + report.durationMs));
  if (output.generatedAtMonotonicMs < maximumEnd) fail();
  return output;
}

function normalizeExportAndSize(value) {
  const output = normalizeExport(value);
  if (encodeNormalized(output).byteLength > MAX_EXPORT_BYTES) fail('report_too_large');
  return deepFreeze(output);
}

export function validateLocalDiagnosticExportJson(input) {
  return normalizeExportAndSize(parseBytes(input, MAX_EXPORT_INPUT_BYTES));
}

export function canonicalLocalDiagnosticExportBytes(value) {
  assertNormalizedTree(value, true);
  return encodeNormalized(normalizeExportAndSize(value));
}
