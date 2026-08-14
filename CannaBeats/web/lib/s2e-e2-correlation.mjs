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
const encoder = new TextEncoder();

const issuanceFixtures = new WeakSet();
const acceptedSamples = new WeakSet();
const alignments = new WeakSet();
const alignmentCoreBytes = new WeakMap();
const contextFixtures = new WeakSet();
const uploadedEnvelopes = new WeakSet();
const operationAuthorities = new WeakSet();
const operationCommands = new WeakSet();
const traceStates = new WeakSet();
const consentStates = new WeakSet();
const relayBindings = new WeakSet();
const operationReceipts = new WeakSet();

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

function uint(value, code) {
  if (!Number.isSafeInteger(value) || value < 0) fail(code);
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
  alignmentCoreBytes.set(alignment, canonicalMeasurementBytes(normalized));
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
  if (!sameBytes(
    alignmentCoreBytes.get(alignment), canonicalMeasurementBytes(normalized),
  )) fail('alignment_invalid');

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

const OPERATIONS = [
  'trace_start', 'trace_end', 'consent_opt_in', 'consent_stop', 'relay_bind',
];

function normalizeOperationCommand(parsed) {
  const code = 'request_conflict';
  if (!isRecord(parsed) || !OPERATIONS.includes(parsed.operation)) fail(code);
  const common = {
    requestId: (value) => uuid(value, code),
    operation: literal(parsed.operation, code),
  };
  const parameters = {
    trace_start: (value) => exactRecord(value, {}, code),
    trace_end: (value) => exactRecord(value, {}, code),
    consent_opt_in: (value) => exactRecord(value, {
      listenerInstanceId: (entry) => uuid(entry, code),
      firstAllowedSequence: (entry) => uint(entry, code),
      localConsentStartedMs: (entry) => finiteTime(entry, code),
    }, code),
    consent_stop: (value) => exactRecord(value, {
      listenerInstanceId: (entry) => uuid(entry, code),
      expectedGeneration: (entry) => positiveUint(entry, code),
    }, code),
    relay_bind: (value) => exactRecord(value, {
      relayGenerationId: (entry) => uuid(entry, code),
    }, code),
  }[parsed.operation];
  return exactRecord(parsed, { ...common, parameters }, code);
}

export function validateE2OperationCommandJson(input) {
  const command = deepFreeze(normalizeOperationCommand(parseBytes(input, 'request_conflict')));
  operationCommands.add(command);
  return command;
}

export function canonicalE2OperationCommandBytes(command) {
  if (!operationCommands.has(command)) fail('request_conflict');
  return encoder.encode(JSON.stringify(command));
}

function sameBytes(left, right) {
  if (!(left instanceof Uint8Array) || !(right instanceof Uint8Array)) return false;
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function normalizeOperationAuthority(parsed) {
  const code = 'authority_invalid';
  if (!isRecord(parsed) || typeof parsed.operation !== 'string') fail(code);
  const now = (value) => finiteTime(value, code);
  const run = {
    runId: (value) => uuid(value, code),
    runGeneration: (value) => positiveUint(value, code),
    leaseId: (value) => uuid(value, code),
  };
  if (parsed.operation === 'trace_start') {
    return exactRecord(parsed, {
      authorityVersion: literal(1, code), operation: literal('trace_start', code),
      nowMs: now, isHost: literal(true, code), ...run,
      issuedTraceId: (value) => uuid(value, code),
      issuedSegmentId: (value) => uuid(value, code),
    }, code);
  }
  if (parsed.operation === 'trace_end') {
    return exactRecord(parsed, {
      authorityVersion: literal(1, code), operation: literal('trace_end', code),
      nowMs: now, traceId: (value) => uuid(value, code),
      reason: enumeration([
        'host_stopped', 'expired', 'run_replaced', 'authority_lost',
      ], code),
    }, code);
  }
  if (parsed.operation === 'segment_rotate') {
    return exactRecord(parsed, {
      authorityVersion: literal(1, code), operation: literal('segment_rotate', code),
      nowMs: now, traceId: (value) => uuid(value, code),
      priorLeaseId: (value) => uuid(value, code),
      leaseId: (value) => uuid(value, code),
      issuedSegmentId: (value) => uuid(value, code),
    }, code);
  }
  if (parsed.operation === 'consent_opt_in' || parsed.operation === 'consent_stop') {
    return exactRecord(parsed, {
      authorityVersion: literal(1, code), operation: literal(parsed.operation, code),
      nowMs: now, traceId: (value) => uuid(value, code),
      listenerInstanceId: (value) => uuid(value, code),
    }, code);
  }
  if (parsed.operation === 'relay_bind') {
    return exactRecord(parsed, {
      authorityVersion: literal(1, code), operation: literal('relay_bind', code),
      traceId: (value) => uuid(value, code),
      segmentId: (value) => uuid(value, code),
      leaseId: (value) => uuid(value, code),
      relayGenerationId: (value) => uuid(value, code),
    }, code);
  }
  fail(code);
}

/** Test-only operation seam. E8 replaces this with authenticated State facts. */
export function createOperationAuthorityFixtureForTest(input) {
  const authority = deepFreeze(normalizeOperationAuthority(
    parseBytes(input, 'authority_invalid'),
  ));
  operationAuthorities.add(authority);
  return authority;
}

function assertCommand(command, operation) {
  if (!operationCommands.has(command) || command.operation !== operation) {
    fail('request_conflict');
  }
  return command;
}

function assertAuthority(authority, operation) {
  if (!operationAuthorities.has(authority) || authority.operation !== operation) {
    fail('authority_invalid');
  }
  return authority;
}

function makeReceipt(command, result) {
  const receipt = deepFreeze(Object.assign(Object.create(null), {
    receiptVersion: 1,
    requestId: command.requestId,
    operation: command.operation,
    canonicalCommand: command,
    result,
  }));
  operationReceipts.add(receipt);
  return receipt;
}

function normalizeTraceState(value) {
  const code = 'request_conflict';
  if (!isRecord(value) || !['active', 'ended'].includes(value.status)) fail(code);
  const ended = value.status === 'active'
    ? (entry) => exactRecord(entry, { status: literal('not_applicable', code) }, code)
    : (entry) => exactRecord(entry, {
      status: literal('ended', code),
      endedAtMs: (field) => finiteTime(field, code),
      reason: enumeration([
        'host_stopped', 'expired', 'run_replaced', 'authority_lost',
      ], code),
    }, code);
  const state = exactRecord(value, {
    traceVersion: literal(1, code),
    traceId: (field) => uuid(field, code),
    runId: (field) => uuid(field, code),
    runGeneration: (field) => positiveUint(field, code),
    status: literal(value.status, code),
    startedAtMs: (field) => finiteTime(field, code),
    expiresAtMs: (field) => finiteTime(field, code),
    ended,
    segment: (entry) => exactRecord(entry, {
      segmentId: (field) => uuid(field, code),
      leaseId: (field) => uuid(field, code),
      startedAtMs: (field) => finiteTime(field, code),
    }, code),
  }, code);
  if (state.expiresAtMs !== state.startedAtMs + 21600000
    || state.segment.startedAtMs < state.startedAtMs
    || state.segment.startedAtMs >= state.expiresAtMs
    || (state.status === 'ended'
      && (state.ended.endedAtMs < state.segment.startedAtMs
        || ((state.ended.endedAtMs >= state.expiresAtMs)
          !== (state.ended.reason === 'expired'))))) fail(code);
  return state;
}

function normalizeConsentState(value) {
  const code = 'request_conflict';
  if (!isRecord(value) || !['enabled', 'revoked'].includes(value.status)) fail(code);
  return exactRecord(value, {
    consentVersion: literal(1, code),
    traceId: (field) => uuid(field, code),
    listenerInstanceId: (field) => uuid(field, code),
    generation: (field) => positiveUint(field, code),
    status: literal(value.status, code),
    firstAllowedSequence: (field) => uint(field, code),
    localConsentStartedMs: (field) => finiteTime(field, code),
    changedAtMs: (field) => finiteTime(field, code),
  }, code);
}

function normalizeRelayBinding(value) {
  const code = 'request_conflict';
  return exactRecord(value, {
    relayGenerationId: (field) => uuid(field, code),
    traceId: (field) => uuid(field, code),
    segmentId: (field) => uuid(field, code),
    leaseId: (field) => uuid(field, code),
  }, code);
}

export function restoreE2OperationReceiptFromTrustedStore(input) {
  const code = 'request_conflict';
  const parsed = parseBytes(input, code);
  if (!isRecord(parsed) || !OPERATIONS.includes(parsed.operation)) fail(code);
  const receipt = exactRecord(parsed, {
    receiptVersion: literal(1, code),
    requestId: (field) => uuid(field, code),
    operation: literal(parsed.operation, code),
    canonicalCommand: normalizeOperationCommand,
    result: parsed.operation === 'trace_start' || parsed.operation === 'trace_end'
      ? normalizeTraceState
      : parsed.operation === 'relay_bind'
        ? normalizeRelayBinding
        : normalizeConsentState,
  }, code);
  if (receipt.requestId !== receipt.canonicalCommand.requestId
    || receipt.operation !== receipt.canonicalCommand.operation) fail(code);
  if ((receipt.operation === 'trace_start' && receipt.result.status !== 'active')
    || (receipt.operation === 'trace_end' && receipt.result.status !== 'ended')
    || (receipt.operation === 'consent_opt_in'
      && (receipt.result.status !== 'enabled'
        || receipt.result.listenerInstanceId
          !== receipt.canonicalCommand.parameters.listenerInstanceId
        || receipt.result.firstAllowedSequence
          !== receipt.canonicalCommand.parameters.firstAllowedSequence
        || receipt.result.localConsentStartedMs
          !== receipt.canonicalCommand.parameters.localConsentStartedMs))
    || (receipt.operation === 'consent_stop'
      && (receipt.result.status !== 'revoked'
        || receipt.result.listenerInstanceId
          !== receipt.canonicalCommand.parameters.listenerInstanceId
        || receipt.result.generation
          !== receipt.canonicalCommand.parameters.expectedGeneration + 1))
    || (receipt.operation === 'relay_bind'
      && receipt.result.relayGenerationId
        !== receipt.canonicalCommand.parameters.relayGenerationId)) fail(code);
  const frozen = deepFreeze(receipt);
  operationCommands.add(frozen.canonicalCommand);
  if (frozen.operation === 'trace_start' || frozen.operation === 'trace_end') {
    traceStates.add(frozen.result);
  } else if (frozen.operation === 'relay_bind') {
    relayBindings.add(frozen.result);
  } else {
    consentStates.add(frozen.result);
  }
  operationReceipts.add(frozen);
  return frozen;
}

export function canonicalE2OperationReceiptBytes(receipt) {
  if (!operationReceipts.has(receipt)) fail('request_conflict');
  return encoder.encode(JSON.stringify(receipt));
}

function replayReceipt(existingReceipt, command) {
  if (existingReceipt === null) return null;
  if (!operationReceipts.has(existingReceipt)
    || existingReceipt.requestId !== command.requestId) fail('request_conflict');
  if (!sameBytes(
    canonicalE2OperationCommandBytes(existingReceipt.canonicalCommand),
    canonicalE2OperationCommandBytes(command),
  )) fail('request_conflict');
  return deepFreeze(Object.assign(Object.create(null), {
    status: 'replayed',
    state: existingReceipt.result,
    receipt: existingReceipt,
  }));
}

function accepted(command, result) {
  const receipt = makeReceipt(command, result);
  return deepFreeze(Object.assign(Object.create(null), {
    status: 'accepted', state: result, receipt,
  }));
}

export function startDiagnosticTrace(currentTrace, command, authority, existingReceipt = null) {
  assertCommand(command, 'trace_start');
  const replay = replayReceipt(existingReceipt, command);
  if (replay) return replay;
  assertAuthority(authority, 'trace_start');
  if (currentTrace !== null) {
    if (!traceStates.has(currentTrace)) fail('stale_correlation');
    if (currentTrace.traceId === authority.issuedTraceId) fail('stale_correlation');
    if (currentTrace.status === 'active') {
      return deepFreeze(Object.assign(Object.create(null), {
        status: 'trace_busy', state: currentTrace, receipt: null,
      }));
    }
  }
  const expiresAtMs = checkedAdd(authority.nowMs, 21600000, 'authority_invalid');
  const state = deepFreeze(Object.assign(Object.create(null), {
    traceVersion: 1,
    traceId: authority.issuedTraceId,
    runId: authority.runId,
    runGeneration: authority.runGeneration,
    status: 'active',
    startedAtMs: authority.nowMs,
    expiresAtMs,
    ended: deepFreeze(Object.assign(Object.create(null), { status: 'not_applicable' })),
    segment: deepFreeze(Object.assign(Object.create(null), {
      segmentId: authority.issuedSegmentId,
      leaseId: authority.leaseId,
      startedAtMs: authority.nowMs,
    })),
  }));
  traceStates.add(state);
  return accepted(command, state);
}

export function endDiagnosticTrace(currentTrace, command, authority, existingReceipt = null) {
  assertCommand(command, 'trace_end');
  const replay = replayReceipt(existingReceipt, command);
  if (replay) return replay;
  assertAuthority(authority, 'trace_end');
  if (!traceStates.has(currentTrace) || currentTrace.status !== 'active'
    || currentTrace.traceId !== authority.traceId
    || authority.nowMs < currentTrace.segment.startedAtMs
    || ((authority.nowMs >= currentTrace.expiresAtMs)
      !== (authority.reason === 'expired'))) fail('stale_correlation');
  const state = deepFreeze(Object.assign(Object.create(null), {
    ...currentTrace,
    status: 'ended',
    ended: deepFreeze(Object.assign(Object.create(null), {
      status: 'ended', endedAtMs: authority.nowMs, reason: authority.reason,
    })),
  }));
  traceStates.add(state);
  return accepted(command, state);
}

export function rotateCorrelationSegment(currentTrace, authority) {
  assertAuthority(authority, 'segment_rotate');
  if (!traceStates.has(currentTrace) || currentTrace.status !== 'active'
    || currentTrace.traceId !== authority.traceId) fail('stale_correlation');
  if (currentTrace.segment.leaseId === authority.leaseId
    && currentTrace.segment.segmentId === authority.issuedSegmentId) {
    return currentTrace;
  }
  if (currentTrace.segment.leaseId !== authority.priorLeaseId
    || authority.nowMs < currentTrace.segment.startedAtMs
    || authority.nowMs >= currentTrace.expiresAtMs) fail('stale_correlation');
  if (authority.leaseId === authority.priorLeaseId) return currentTrace;
  if (authority.issuedSegmentId === currentTrace.segment.segmentId) {
    fail('stale_correlation');
  }
  const state = deepFreeze(Object.assign(Object.create(null), {
    ...currentTrace,
    segment: deepFreeze(Object.assign(Object.create(null), {
      segmentId: authority.issuedSegmentId,
      leaseId: authority.leaseId,
      startedAtMs: authority.nowMs,
    })),
  }));
  traceStates.add(state);
  return state;
}

export function bindRelayGeneration(
  currentTrace, currentBinding, command, authority, existingReceipt = null,
) {
  assertCommand(command, 'relay_bind');
  const replay = replayReceipt(existingReceipt, command);
  if (replay) return replay;
  assertAuthority(authority, 'relay_bind');
  if (currentBinding !== null
    || !traceStates.has(currentTrace) || currentTrace.status !== 'active'
    || currentTrace.traceId !== authority.traceId
    || currentTrace.segment.segmentId !== authority.segmentId
    || currentTrace.segment.leaseId !== authority.leaseId
    || command.parameters.relayGenerationId !== authority.relayGenerationId) {
    fail('stale_correlation');
  }
  const binding = deepFreeze(Object.assign(Object.create(null), {
    relayGenerationId: authority.relayGenerationId,
    traceId: authority.traceId,
    segmentId: authority.segmentId,
    leaseId: authority.leaseId,
  }));
  relayBindings.add(binding);
  return accepted(command, binding);
}

export function optInDiagnosticSharing(currentConsent, command, authority, existingReceipt = null) {
  assertCommand(command, 'consent_opt_in');
  const replay = replayReceipt(existingReceipt, command);
  if (replay) return replay;
  assertAuthority(authority, 'consent_opt_in');
  if ((currentConsent !== null && !consentStates.has(currentConsent))
    || command.parameters.listenerInstanceId !== authority.listenerInstanceId
    || (currentConsent !== null && (currentConsent.traceId !== authority.traceId
      || currentConsent.listenerInstanceId !== authority.listenerInstanceId
      || command.parameters.firstAllowedSequence < currentConsent.firstAllowedSequence
      || command.parameters.localConsentStartedMs < currentConsent.localConsentStartedMs
      || authority.nowMs < currentConsent.changedAtMs))) {
    fail('authority_invalid');
  }
  const generation = currentConsent === null ? 1 : currentConsent.generation + 1;
  if (!Number.isSafeInteger(generation)) fail('authority_invalid');
  const state = deepFreeze(Object.assign(Object.create(null), {
    consentVersion: 1,
    traceId: authority.traceId,
    listenerInstanceId: authority.listenerInstanceId,
    generation,
    status: 'enabled',
    firstAllowedSequence: command.parameters.firstAllowedSequence,
    localConsentStartedMs: command.parameters.localConsentStartedMs,
    changedAtMs: authority.nowMs,
  }));
  consentStates.add(state);
  return accepted(command, state);
}

export function stopDiagnosticSharing(currentConsent, command, authority, existingReceipt = null) {
  assertCommand(command, 'consent_stop');
  const replay = replayReceipt(existingReceipt, command);
  if (replay) return replay;
  assertAuthority(authority, 'consent_stop');
  if (!consentStates.has(currentConsent) || currentConsent.status !== 'enabled'
    || currentConsent.traceId !== authority.traceId
    || currentConsent.listenerInstanceId !== authority.listenerInstanceId
    || command.parameters.listenerInstanceId !== authority.listenerInstanceId
    || command.parameters.expectedGeneration !== currentConsent.generation
    || authority.nowMs < currentConsent.changedAtMs) fail('sharing_disabled');
  const generation = currentConsent.generation + 1;
  if (!Number.isSafeInteger(generation)) fail('authority_invalid');
  const state = deepFreeze(Object.assign(Object.create(null), {
    ...currentConsent,
    generation,
    status: 'revoked',
    changedAtMs: authority.nowMs,
  }));
  consentStates.add(state);
  return accepted(command, state);
}

export function classifyDiagnosticReportIngest({
  existingEnvelope,
  incomingEnvelope,
  consent,
  grantGeneration,
}) {
  if (!uploadedEnvelopes.has(incomingEnvelope)) fail('report_invalid');
  if (existingEnvelope !== null) {
    if (!uploadedEnvelopes.has(existingEnvelope)
      || uploadedEnvelopeIdentity(existingEnvelope) !== uploadedEnvelopeIdentity(incomingEnvelope)) {
      fail('report_invalid');
    }
    return sameBytes(
      canonicalMeasurementBytes(existingEnvelope.measurementCore),
      canonicalMeasurementBytes(incomingEnvelope.measurementCore),
    ) ? 'replayed' : 'report_conflict';
  }
  if (incomingEnvelope.serverContext.authorityKind !== 'listener') return 'accepted';
  if (!consentStates.has(consent) || !Number.isSafeInteger(grantGeneration)
    || grantGeneration < 1 || consent.status !== 'enabled'
    || consent.generation !== grantGeneration
    || consent.traceId !== incomingEnvelope.serverContext.traceId
    || consent.listenerInstanceId !== incomingEnvelope.measurementCore.instanceId
    || incomingEnvelope.measurementCore.sequence < consent.firstAllowedSequence
    || incomingEnvelope.measurementCore.monotonicStartMs < consent.localConsentStartedMs) {
    return 'sharing_disabled';
  }
  return 'accepted';
}
