const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const NIL_UUID = '00000000-0000-0000-0000-000000000000';
const decoder = new TextDecoder('utf-8', { fatal: true });
const encoder = new TextEncoder();
const purgeCommands = new WeakSet();

export class E7ContractError extends Error {
  constructor(code) {
    super(code);
    this.name = 'E7ContractError';
    this.code = code;
  }
}

function fail(code) {
  throw new E7ContractError(code);
}

function parse(input, code) {
  try {
    if (!ArrayBuffer.isView(input) || !(input instanceof Uint8Array)) fail(code);
    const prototype = Object.getPrototypeOf(Uint8Array.prototype);
    const length = Object.getOwnPropertyDescriptor(prototype, 'byteLength').get.call(input);
    if (length > 8192) fail(code);
    const copy = new Uint8Array(length);
    Uint8Array.prototype.set.call(copy, input);
    return JSON.parse(decoder.decode(copy));
  } catch (error) {
    if (error instanceof E7ContractError) throw error;
    fail(code);
  }
}

function record(value, keys, code) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).length !== keys.length
    || keys.some((key) => !Object.hasOwn(value, key))) fail(code);
  return value;
}

function uuid(value, code) {
  if (typeof value !== 'string' || !UUID.test(value) || value === NIL_UUID) fail(code);
  return value;
}

function uint(value, code) {
  if (!Number.isSafeInteger(value) || value < 0) fail(code);
  return value;
}

function serverTime(value, code) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0
    || value > Number.MAX_SAFE_INTEGER || Object.is(value, -0)) fail(code);
  return value;
}

export function validatePurgeCommandJson(input) {
  const code = 'request_conflict';
  const value = record(parse(input, code), ['requestId', 'operation', 'parameters'], code);
  const parameters = record(value.parameters, ['traceId'], code);
  if (value.operation !== 'trace_purge') fail(code);
  const command = Object.freeze({
    requestId: uuid(value.requestId, code),
    operation: 'trace_purge',
    parameters: Object.freeze({ traceId: uuid(parameters.traceId, code) }),
  });
  purgeCommands.add(command);
  return command;
}

export function canonicalPurgeCommandBytes(command) {
  if (!purgeCommands.has(command)) fail('request_conflict');
  return encoder.encode(JSON.stringify(command));
}

export function canonicalPurgeReceiptBytes(command, result) {
  if (!purgeCommands.has(command) || result?.status !== 'purged'
    || result?.traceId !== command.parameters.traceId) fail('request_conflict');
  const receipt = {
    receiptVersion: 1,
    requestId: command.requestId,
    operation: 'trace_purge',
    canonicalCommand: command,
    result,
  };
  return encoder.encode(JSON.stringify(receipt));
}

export function restorePurgeReceipt(input) {
  const code = 'request_conflict';
  const value = record(parse(input, code), [
    'receiptVersion', 'requestId', 'operation', 'canonicalCommand', 'result',
  ], code);
  if (value.receiptVersion !== 1 || value.operation !== 'trace_purge') fail(code);
  const command = validatePurgeCommandJson(encoder.encode(JSON.stringify(value.canonicalCommand)));
  const result = record(value.result, ['status', 'traceId'], code);
  if (value.requestId !== command.requestId || result.status !== 'purged'
    || uuid(result.traceId, code) !== command.parameters.traceId) fail(code);
  return Object.freeze({ ...value, canonicalCommand: command,
    result: Object.freeze({ status: 'purged', traceId: result.traceId }) });
}

function readLast(value, code) {
  const last = record(value, [
    'mappedStartEarliestMs', 'mappedEndLatestMs', 'kind', 'instanceId', 'sequence',
  ], code);
  const kinds = ['listener_window', 'listener_transition', 'source_window',
    'source_transition', 'relay_window', 'relay_transition'];
  if (!kinds.includes(last.kind)) fail(code);
  return Object.freeze({
    mappedStartEarliestMs: serverTime(last.mappedStartEarliestMs, code),
    mappedEndLatestMs: serverTime(last.mappedEndLatestMs, code),
    kind: last.kind,
    instanceId: uuid(last.instanceId, code),
    sequence: uint(last.sequence, code),
  });
}

export function validateReadRequestJson(input) {
  const code = 'read_expired';
  const value = record(parse(input, code), ['traceId', 'cursor'], code);
  const traceId = uuid(value.traceId, code);
  if (value.cursor === null) return Object.freeze({ traceId, cursor: null });
  const cursor = record(value.cursor, ['readSessionId', 'last'], code);
  return Object.freeze({ traceId, cursor: Object.freeze({
    readSessionId: uuid(cursor.readSessionId, code),
    last: readLast(cursor.last, code),
  }) });
}
