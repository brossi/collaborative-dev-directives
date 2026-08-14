import { validateMeasurementSeries } from './s2e-e1-contract.mjs';
import { uploadedEnvelopeIdentity } from './s2e-e2-correlation.mjs';

const RESULTS = new Set([
  'source_suspected', 'relay_suspected', 'listener_delivery_suspected',
  'listener_buffer_suspected', 'browser_output_suspected',
  'insufficient_evidence',
]);

class InputFailure extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function fail(code) {
  throw new InputFailure(code);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype
      || Object.getPrototypeOf(value) === null);
}

function exactKeys(value, keys, code) {
  if (!isRecord(value)) fail(code);
  const actual = Object.keys(value);
  if (actual.length !== keys.length
    || keys.some((key) => !Object.hasOwn(value, key))) fail(code);
  return value;
}

function deepFreeze(value) {
  for (const nested of Object.values(value)) {
    if (nested && typeof nested === 'object') deepFreeze(nested);
  }
  return Object.freeze(value);
}

function insufficient(code, references = []) {
  return output('insufficient_evidence', 'insufficient', references, [code]);
}

function output(result, confidence, references, missing = []) {
  if (!RESULTS.has(result)) fail('contradictory_evidence');
  const contributing = [...references].sort((left, right) => (
    left.interval.startEarliestMs - right.interval.startEarliestMs
      || left.instanceId.localeCompare(right.instanceId)
      || left.sequence - right.sequence
  ));
  return deepFreeze(Object.assign(Object.create(null), {
    diagnosisVersion: 1,
    result,
    confidence,
    contributing,
    missing: [...new Set(missing)].sort(),
  }));
}

function envelope(envelopeValue, kind, code) {
  try {
    uploadedEnvelopeIdentity(envelopeValue);
  } catch {
    fail(code);
  }
  if (envelopeValue.measurementCore.kind !== kind) fail(code);
  return envelopeValue;
}

function pair(value, kind, code) {
  exactKeys(value, ['prior', 'current'], code);
  const prior = envelope(value.prior, kind, code);
  const current = envelope(value.current, kind, code);
  try {
    validateMeasurementSeries([prior.measurementCore, current.measurementCore]);
  } catch {
    fail('invalid_pair');
  }
  return { prior, current };
}

function delta(pairValue, field) {
  const value = pairValue.current.measurementCore.measurements[field]
    - pairValue.prior.measurementCore.measurements[field];
  if (!Number.isSafeInteger(value) || value < 0) fail('invalid_pair');
  return value;
}

function reference(envelopeValue) {
  const { measurementCore: core, alignment, serverContext } = envelopeValue;
  return deepFreeze(Object.assign(Object.create(null), {
    traceId: serverContext.traceId,
    instanceId: core.instanceId,
    sequence: core.sequence,
    kind: core.kind,
    interval: deepFreeze(Object.assign(Object.create(null), {
      timebaseId: alignment.sample.timebaseId,
      startEarliestMs: alignment.mappedStartEarliestMs,
      startLatestMs: alignment.mappedStartLatestMs,
      endEarliestMs: alignment.mappedEndEarliestMs,
      endLatestMs: alignment.mappedEndLatestMs,
      uncertaintyMs: alignment.mappingUncertaintyMs,
    })),
  }));
}

function precedes(left, right) {
  return left.alignment.mappedEndLatestMs < right.alignment.mappedStartEarliestMs;
}

function sourceState(source) {
  const eventFields = [
    'captureGapCount', 'droppedUploadCount', 'reconnectCount',
    'publisherRestartCount',
  ];
  const eventAnomaly = eventFields.some((field) => delta(source, field) > 0);
  const captured = delta(source, 'capturedFrames');
  const enqueued = delta(source, 'enqueuedFrames');
  const published = delta(source, 'publishedFrames');
  const measurements = source.current.measurementCore.measurements;
  const flowRegular = captured === enqueued && enqueued === published;
  const stateAnomaly = ['backoff', 'error'].includes(measurements.publisherState);
  if (eventAnomaly || stateAnomaly || !flowRegular) return 'anomalous';
  if (measurements.publisherState === 'publishing'
    && measurements.playbackObservation === 'playing' && flowRegular) return 'regular';
  return 'unknown';
}

function relayState(relay) {
  const eventFields = [
    'ingressGapCount', 'rejectedIngressCount', 'droppedIngressCount',
    'backpressureClosureCount', 'generationFenceDisconnectCount',
  ];
  const ingressFrames = delta(relay, 'ingressFrames');
  const deliveredBytes = delta(relay, 'deliveredBytes');
  const activeListeners = relay.current.measurementCore.measurements.activeListenerCount;
  if (eventFields.some((field) => delta(relay, field) > 0)
    || (ingressFrames > 0 && activeListeners > 0 && deliveredBytes === 0)) {
    return 'anomalous';
  }
  return ingressFrames > 0 && deliveredBytes > 0 && activeListeners > 0
    ? 'regular' : 'unknown';
}

function listenerStates(listener) {
  const value = listener.measurementCore.measurements;
  let delivery = 'unknown';
  const terminalAnomaly = [
    'no_response', 'rejected', 'unsupported_format', 'stream_error',
    'stream_ended', 'aborted',
  ].includes(value.terminalCategory);
  const gapAnomaly = value.chunkGap.status === 'observed' && value.chunkGap.maxMs > 250;
  if (value.receivedFrames === 0 || value.reconnectCount > 0
    || terminalAnomaly || gapAnomaly) {
    delivery = 'anomalous';
  } else if (value.receivedFrames > 0 && value.reconnectCount === 0
    && value.terminalCategory === 'open'
    && (value.chunkGap.status === 'not_applicable'
      || (value.chunkGap.status === 'observed' && value.chunkGap.maxMs <= 250))) {
    delivery = 'regular';
  }

  let buffer = 'unknown';
  const lowFalling = value.bufferDepth.status === 'observed'
    && value.bufferDepth.currentMs < 100
    && value.bufferDepth.trendMsPerSecond < 0;
  if (value.underrunCount > 0 || value.overflowCount > 0 || lowFalling) {
    buffer = 'anomalous';
  } else if (value.underrunCount === 0 && value.overflowCount === 0
    && value.bufferDepth.status === 'observed') {
    buffer = 'regular';
  }

  let browserOutput = 'unknown';
  const longTaskAnomaly = value.longTasks.status === 'observed'
    && value.longTasks.count > 0 && value.longTasks.maxDurationMs >= 100;
  if (['suspended', 'interrupted', 'closed'].includes(value.audioContextState)
    || value.suspensionCount > 0 || longTaskAnomaly) {
    browserOutput = 'anomalous';
  } else if (value.audioContextState === 'running' && value.suspensionCount === 0
    && ((value.longTasks.status === 'observed' && value.longTasks.count === 0)
      || value.longTasks.status === 'unsupported')) {
    browserOutput = 'regular';
  }
  return { delivery, buffer, browserOutput };
}

function validateInput(input) {
  exactKeys(input, ['source', 'relay', 'listeners'], 'contradictory_evidence');
  if (input.source === null || input.source === undefined) fail('source');
  if (input.relay === null || input.relay === undefined) fail('relay');
  if (!Array.isArray(input.listeners) || input.listeners.length < 1
    || input.listeners.length > 8) fail('listener');
  const source = pair(input.source, 'source_window', 'source');
  const relay = pair(input.relay, 'relay_window', 'relay');
  const listeners = input.listeners.map((value) => envelope(
    value, 'listener_window', 'listener',
  ));

  const all = [source.prior, source.current, relay.prior, relay.current, ...listeners];
  const traceId = all[0].serverContext.traceId;
  const timebaseId = all[0].alignment.sample.timebaseId;
  const segmentId = all[0].serverContext.correlationSegmentId;
  const leaseId = all[0].serverContext.leaseId;
  if (all.some((value) => value.serverContext.traceId !== traceId)) fail('trace_mismatch');
  if (all.some((value) => value.serverContext.correlationSegmentId !== segmentId
    || value.serverContext.leaseId !== leaseId)) fail('segment_mismatch');
  if (all.some((value) => value.alignment.sample.timebaseId !== timebaseId)) {
    fail('timebase_mismatch');
  }
  const listenerIds = listeners.map((value) => value.measurementCore.instanceId);
  if (new Set(listenerIds).size !== listenerIds.length) fail('duplicate_listener');
  return { source, relay, listeners, all };
}

export function classifyDiagnosticEvidence(input) {
  let evidence;
  try {
    evidence = validateInput(input);
  } catch (error) {
    return insufficient(error instanceof InputFailure ? error.code : 'contradictory_evidence');
  }

  const references = evidence.all.map(reference);
  let source;
  let relay;
  let listeners;
  try {
    source = sourceState(evidence.source);
    relay = relayState(evidence.relay);
    listeners = evidence.listeners.map((value) => ({
      envelope: value, ...listenerStates(value),
    }));
  } catch {
    return insufficient('invalid_pair', references);
  }

  const everyDeliveryAnomalous = listeners.every((value) => value.delivery === 'anomalous');
  const sourceBeforeRelay = precedes(evidence.source.current, evidence.relay.current);
  const relayBeforeListeners = listeners.every((value) => precedes(
    evidence.relay.current, value.envelope,
  ));
  const sourceBeforeListeners = listeners.every((value) => precedes(
    evidence.source.current, value.envelope,
  ));

  if (source === 'anomalous' && relay === 'anomalous' && everyDeliveryAnomalous) {
    if (sourceBeforeRelay && sourceBeforeListeners && relayBeforeListeners) {
      return output('source_suspected', 'high', references);
    }
    return insufficient('ordering_overlap', references);
  }
  if (source === 'regular' && relay === 'anomalous' && everyDeliveryAnomalous) {
    return relayBeforeListeners
      ? output('relay_suspected', 'high', references)
      : insufficient('ordering_overlap', references);
  }

  if (source !== 'regular' || relay !== 'regular') {
    return insufficient(source === 'unknown' || relay === 'unknown'
      ? 'unknown_state' : 'contradictory_evidence', references);
  }

  const deliveryCandidates = listeners.filter((value) => value.delivery === 'anomalous');
  if (deliveryCandidates.length === 1
    && listeners.every((value) => value === deliveryCandidates[0]
      || value.delivery === 'regular')) {
    return output('listener_delivery_suspected', 'medium', references);
  }
  if (deliveryCandidates.length > 0) {
    return insufficient('contradictory_evidence', references);
  }

  const bufferCandidates = listeners.filter((value) => (
    value.delivery === 'regular' && value.buffer === 'anomalous'
  ));
  if (bufferCandidates.length === 1
    && listeners.every((value) => value === bufferCandidates[0]
      || (value.delivery === 'regular' && value.buffer === 'regular'))) {
    return output('listener_buffer_suspected', 'medium', references);
  }
  if (bufferCandidates.length > 0) {
    return insufficient('contradictory_evidence', references);
  }

  const outputCandidates = listeners.filter((value) => (
    value.delivery === 'regular' && value.buffer === 'regular'
      && value.browserOutput === 'anomalous'
  ));
  if (outputCandidates.length === 1
    && listeners.every((value) => value === outputCandidates[0]
      || (value.delivery === 'regular' && value.buffer === 'regular'
        && value.browserOutput === 'regular'))) {
    return output('browser_output_suspected', 'medium', references);
  }
  if (outputCandidates.length > 0) {
    return insufficient('contradictory_evidence', references);
  }
  if (listeners.some((value) => value.delivery === 'unknown'
    || value.buffer === 'unknown' || value.browserOutput === 'unknown')) {
    return insufficient('unknown_state', references);
  }
  return insufficient('no_anomaly', references);
}
