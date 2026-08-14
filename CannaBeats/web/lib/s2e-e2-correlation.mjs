import {
  E1ContractError,
  canonicalMeasurementBytes,
  measurementIdentity,
} from './s2e-e1-contract.mjs';

const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const MAX_INPUT_BYTES = 8192;
const MAX_RTT_MS = 2000;
const MAX_SAMPLE_AGE_MS = 60000;
const MAX_UNCERTAINTY_MS = 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const NIL_UUID = '00000000-0000-0000-0000-000000000000';
const decoder = new TextDecoder('utf-8', { fatal: true });

const issuanceFixtures = new WeakSet();
const acceptedSamples = new WeakSet();
const alignments = new WeakSet();
const contextFixtures = new WeakSet();
const uploadedEnvelopes = new WeakSet();

export class E2ContractError extends Error {
  constructor(code) {
    super(code);
    this.name = 'E2ContractError';
    this.code = code;
  }
}

function fail(code) {
  throw new E2ContractError(code);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype
      || Object.getPrototypeOf(value) === null);
}

function rejectInvalidString(value, code) {
  if (typeof value !== 'string') fail(code);
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) fail(code);
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      fail(code);
    }
  }
  return value;
}

function uuid(value, code) {
  rejectInvalidString(value, code);
  if (value === NIL_UUID || !UUID.test(value)) fail(code);
  return value;
}

function finiteTime(value, code) {
  if (typeof value !== 'number' || !Number.isFinite(value)
    || Object.is(value, -0) || value < 0 || value > MAX_SAFE) fail(code);
  return value;
}

function positiveUint(value, code) {
  if (!Number.isSafeInteger(value) || value < 1) fail(code);
  return value;
}

function exactRecord(value, fields, code) {
  if (!isRecord(value)) fail(code);
  const keys = Object.keys(value);
  const expected = Object.keys(fields);
  if (keys.length !== expected.length
    || expected.some((key) => !Object.hasOwn(value, key))) fail(code);
  const output = Object.create(null);
  for (const key of expected) output[key] = fields[key](value[key]);
  return output;
}

function literal(expected, code) {
  return (value) => {
    if (value !== expected) fail(code);
    return value;
  };
}

function enumeration(values, code) {
  const allowed = new Set(values);
  return (value) => {
    rejectInvalidString(value, code);
    if (!allowed.has(value)) fail(code);
    return value;
  };
}

function deepFreeze(value) {
  for (const nested of Object.values(value)) {
    if (nested && typeof nested === 'object') deepFreeze(nested);
  }
  return Object.freeze(value);
}

function parseBytes(input, code) {
  try {
    if (!ArrayBuffer.isView(input) || !(input instanceof Uint8Array)) fail(code);
    const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
    const byteLength = Object.getOwnPropertyDescriptor(
      typedArrayPrototype, 'byteLength',
    ).get.call(input);
    if (byteLength > MAX_INPUT_BYTES) fail(code);
    const copy = new Uint8Array(byteLength);
    Uint8Array.prototype.set.call(copy, input);
    return JSON.parse(decoder.decode(copy));
  } catch {
    fail(code);
  }
}

function checkedAdd(left, right, code) {
  if (typeof left !== 'number' || typeof right !== 'number'
    || !Number.isFinite(left) || !Number.isFinite(right)) fail(code);
  const result = left + right;
  if (!Number.isFinite(result) || Object.is(result, -0)
    || result < 0 || result > MAX_SAFE) fail(code);
  if ((right >= 0 && left > MAX_SAFE - right) || (right < 0 && left < -right)) {
    fail(code);
  }
  return result;
}

function assertE1Report(report) {
  try {
    canonicalMeasurementBytes(report);
    measurementIdentity(report);
    return report;
  } catch (error) {
    if (error instanceof E1ContractError) fail('report_invalid');
    throw error;
  }
}

function reportFamily(kind) {
  if (kind.startsWith('listener_')) return 'listener';
  if (kind.startsWith('source_')) return 'source';
  if (kind.startsWith('relay_')) return 'relay';
  fail('report_invalid');
}

/** Test-only issuance seam. E8 replaces this with authenticated server facts. */
export function createSynchronizationIssuanceFixtureForTest(input) {
  const code = 'sample_invalid';
  const parsed = parseBytes(input, code);
  const issuance = deepFreeze(exactRecord(parsed, {
    sampleId: (value) => uuid(value, code),
    timebaseId: (value) => uuid(value, code),
    instanceId: (value) => uuid(value, code),
    serverReceiveMs: (value) => finiteTime(value, code),
    serverSendMs: (value) => finiteTime(value, code),
  }, code));
  issuanceFixtures.add(issuance);
  return issuance;
}

export function acceptSynchronizationSample(input, issuance) {
  const code = 'sample_invalid';
  if (!issuanceFixtures.has(issuance)) fail(code);
  const observation = exactRecord(parseBytes(input, code), {
    sampleId: (value) => uuid(value, code),
    instanceId: (value) => uuid(value, code),
    localSendMs: (value) => finiteTime(value, code),
    localReceiveMs: (value) => finiteTime(value, code),
  }, code);
  if (observation.sampleId !== issuance.sampleId
    || observation.instanceId !== issuance.instanceId) fail(code);

  const localRtt = observation.localReceiveMs - observation.localSendMs;
  const serverWork = issuance.serverSendMs - issuance.serverReceiveMs;
  const offsetLowerMs = issuance.serverSendMs - observation.localReceiveMs;
  const offsetUpperMs = issuance.serverReceiveMs - observation.localSendMs;
  const uncertainty = (offsetUpperMs - offsetLowerMs) / 2;
  if (localRtt < 0 || localRtt > MAX_RTT_MS || serverWork < 0
    || serverWork > localRtt || offsetLowerMs > offsetUpperMs
    || !Number.isFinite(uncertainty) || uncertainty < 0
    || uncertainty > MAX_UNCERTAINTY_MS) fail(code);

  const sample = deepFreeze(Object.assign(Object.create(null), {
    sampleVersion: 1,
    sampleId: observation.sampleId,
    timebaseId: issuance.timebaseId,
    instanceId: observation.instanceId,
    localSendMs: observation.localSendMs,
    localReceiveMs: observation.localReceiveMs,
    serverReceiveMs: issuance.serverReceiveMs,
    serverSendMs: issuance.serverSendMs,
  }));
  acceptedSamples.add(sample);
  return sample;
}

export function mapMeasurementAlignment(report, sample) {
  const normalized = assertE1Report(report);
  if (!acceptedSamples.has(sample)) fail('sample_invalid');
  if (normalized.instanceId !== sample.instanceId) fail('sample_invalid');

  const reportEnd = checkedAdd(
    normalized.monotonicStartMs, normalized.durationMs, 'alignment_invalid',
  );
  const sampleExpiry = checkedAdd(
    sample.localReceiveMs, MAX_SAMPLE_AGE_MS, 'alignment_invalid',
  );
  if (normalized.monotonicStartMs < sample.localReceiveMs
    || reportEnd > sampleExpiry) fail('sample_expired');

  const offsetLowerMs = sample.serverSendMs - sample.localReceiveMs;
  const offsetUpperMs = sample.serverReceiveMs - sample.localSendMs;
  const mappedStartEarliestMs = checkedAdd(
    normalized.monotonicStartMs, offsetLowerMs, 'alignment_invalid',
  );
  const mappedStartLatestMs = checkedAdd(
    normalized.monotonicStartMs, offsetUpperMs, 'alignment_invalid',
  );
  const mappedEndEarliestMs = checkedAdd(reportEnd, offsetLowerMs, 'alignment_invalid');
  const mappedEndLatestMs = checkedAdd(reportEnd, offsetUpperMs, 'alignment_invalid');
  const mappingUncertaintyMs = (offsetUpperMs - offsetLowerMs) / 2;

  if (!(mappedStartEarliestMs <= mappedStartLatestMs
    && mappedStartLatestMs <= mappedEndLatestMs
    && mappedStartEarliestMs <= mappedEndEarliestMs
    && mappedEndEarliestMs <= mappedEndLatestMs)) fail('alignment_invalid');

  const alignment = deepFreeze(Object.assign(Object.create(null), {
    alignmentVersion: 1,
    sample,
    offsetLowerMs,
    offsetUpperMs,
    mappedStartEarliestMs,
    mappedStartLatestMs,
    mappedEndEarliestMs,
    mappedEndLatestMs,
    mappingUncertaintyMs,
  }));
  alignments.add(alignment);
  return alignment;
}

function normalizeContext(parsed) {
  const code = 'authority_invalid';
  if (!isRecord(parsed)) fail(code);
  const common = {
    contextVersion: literal(1, code),
    traceId: (value) => uuid(value, code),
    runId: (value) => uuid(value, code),
    runGeneration: (value) => positiveUint(value, code),
    correlationSegmentId: (value) => uuid(value, code),
    leaseId: (value) => uuid(value, code),
  };
  if (parsed.authorityKind === 'listener') {
    return exactRecord(parsed, {
      ...common,
      authorityKind: literal('listener', code),
      role: enumeration(['host', 'member'], code),
      listenerInstanceId: (value) => uuid(value, code),
    }, code);
  }
  if (parsed.authorityKind === 'source') {
    return exactRecord(parsed, {
      ...common,
      authorityKind: literal('source', code),
      role: literal('source', code),
      sourceId: (value) => uuid(value, code),
      sourceInstanceId: (value) => uuid(value, code),
    }, code);
  }
  if (parsed.authorityKind === 'relay') {
    return exactRecord(parsed, {
      ...common,
      authorityKind: literal('relay', code),
      role: literal('relay', code),
      relayGenerationId: (value) => uuid(value, code),
    }, code);
  }
  fail(code);
}

/** Test-only authority seam. E8 replaces this with authenticated State facts. */
export function createServerContextFixtureForTest(input) {
  const context = deepFreeze(normalizeContext(parseBytes(input, 'authority_invalid')));
  contextFixtures.add(context);
  return context;
}

export function composeUploadedEnvelope(report, alignment, serverContext) {
  const normalized = assertE1Report(report);
  if (!alignments.has(alignment)) fail('alignment_invalid');
  if (!contextFixtures.has(serverContext)) fail('authority_invalid');
  const family = reportFamily(normalized.kind);
  if (family !== serverContext.authorityKind) fail('authority_invalid');
  const contextInstance = family === 'listener'
    ? serverContext.listenerInstanceId
    : family === 'source'
      ? serverContext.sourceInstanceId
      : serverContext.relayGenerationId;
  if (contextInstance !== normalized.instanceId
    || alignment.sample.instanceId !== normalized.instanceId) fail('authority_invalid');

  const envelope = deepFreeze(Object.assign(Object.create(null), {
    uploadVersion: 1,
    measurementCore: normalized,
    alignment,
    serverContext,
  }));
  uploadedEnvelopes.add(envelope);
  return envelope;
}

export function uploadedEnvelopeIdentity(envelope) {
  if (!uploadedEnvelopes.has(envelope)) fail('report_invalid');
  return `${envelope.serverContext.traceId}:${measurementIdentity(envelope.measurementCore)}`;
}

export function classifyTimebaseRelation(left, right) {
  if (!alignments.has(left) || !alignments.has(right)) fail('alignment_invalid');
  return left.sample.timebaseId === right.sample.timebaseId
    ? 'same_timebase'
    : 'unrelated_timebase';
}
