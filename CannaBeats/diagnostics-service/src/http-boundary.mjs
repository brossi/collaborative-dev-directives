import { timingSafeEqual } from 'node:crypto';

import {
  validateE2OperationCommandJson,
  validateOperationAuthorityJson,
  validateSynchronizationIssuanceJson,
  validateUploadedEnvelopeJson,
} from '../../web/lib/s2e-e2-correlation.mjs';
import { validatePurgeCommandJson, validateReadRequestJson } from './contract.mjs';

const MAX_BODY_BYTES = 8192;
const BODY_DEADLINE_MS = 2000;
const TOKEN = /^[!-~]{32,256}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const decoder = new TextDecoder('utf-8', { fatal: true });

export class E8HttpError extends Error {
  constructor(code) {
    super(code);
    this.name = 'E8HttpError';
    this.code = code;
  }
}

function fail(code) {
  throw new E8HttpError(code);
}

function token(value) {
  if (typeof value !== 'string' || !TOKEN.test(value)) fail('credential_invalid');
  return value;
}

export function validateDiagnosticCredentials(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).length !== 2
    || !Object.hasOwn(input, 'gameToken') || !Object.hasOwn(input, 'maintenanceToken')) {
    fail('credential_invalid');
  }
  const gameToken = token(input.gameToken);
  const maintenanceToken = token(input.maintenanceToken);
  if (gameToken === maintenanceToken) fail('credential_invalid');
  return Object.freeze({ gameToken, maintenanceToken });
}

function equalSecret(left, right) {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.byteLength === rightBytes.byteLength
    && timingSafeEqual(leftBytes, rightBytes);
}

export function authenticateDiagnosticRequest(authorization, credentials, expectedScope) {
  if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) {
    fail('authentication_required');
  }
  const supplied = authorization.slice(7);
  const game = equalSecret(supplied, credentials.gameToken);
  const maintenance = equalSecret(supplied, credentials.maintenanceToken);
  if (!game && !maintenance) fail('authentication_required');
  const actualScope = game ? 'game' : 'maintenance';
  if (actualScope !== expectedScope) fail('not_authorized');
  return actualScope;
}

export function readBoundedRequestBody(request, {
  maxBytes = MAX_BODY_BYTES,
  deadlineMs = BODY_DEADLINE_MS,
} = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let finished = false;
    const finish = (action, value) => {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      request.off('data', data);
      request.off('end', end);
      request.off('aborted', aborted);
      request.off('error', errored);
      action(value);
    };
    const data = (chunk) => {
      size += chunk.byteLength;
      if (size > maxBytes) {
        request.resume();
        finish(reject, new E8HttpError('request_invalid'));
        return;
      }
      chunks.push(chunk);
    };
    const end = () => finish(resolve, Buffer.concat(chunks, size));
    const aborted = () => finish(reject, new E8HttpError('request_invalid'));
    const errored = () => finish(reject, new E8HttpError('request_invalid'));
    const deadline = setTimeout(() => {
      request.resume();
      finish(reject, new E8HttpError('request_timeout'));
    }, deadlineMs);
    deadline.unref?.();
    request.on('data', data);
    request.once('end', end);
    request.once('aborted', aborted);
    request.once('error', errored);
  });
}

function parse(bytes) {
  try {
    const value = JSON.parse(decoder.decode(bytes));
    if (value === null || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) fail('request_invalid');
    return value;
  } catch (error) {
    if (error instanceof E8HttpError) throw error;
    fail('request_invalid');
  }
}

function exact(value, keys) {
  if (Object.keys(value).length !== keys.length
    || keys.some((key) => !Object.hasOwn(value, key))) fail('request_invalid');
  return value;
}

function encoded(value) {
  return Buffer.from(JSON.stringify(value));
}

function commandAuthority(bytes, operation) {
  const value = exact(parse(bytes), ['command', 'authority']);
  const command = validateE2OperationCommandJson(encoded(value.command));
  const authority = validateOperationAuthorityJson(encoded(value.authority));
  if (command.operation !== operation || authority.operation !== operation) {
    fail('request_invalid');
  }
  return Object.freeze({ command, authority });
}

export function validateGameCollectorRequest(path, bytes) {
  if (path === '/v1/game/trace/context') {
    const value = parse(bytes);
    const keys = Object.keys(value);
    const key = keys[0];
    if (keys.length !== 1 || !['traceId', 'activeRunId', 'active'].includes(key)
      || (key === 'active'
        ? value.active !== true
        : typeof value[key] !== 'string' || !UUID.test(value[key]))) {
      fail('request_invalid');
    }
    return Object.freeze({
      operation: 'traceContext',
      locator: Object.freeze({ [key]: value[key] }),
    });
  }
  if (path === '/v1/game/trace/start-context') {
    const value = exact(parse(bytes), ['requestId']);
    if (typeof value.requestId !== 'string' || !UUID.test(value.requestId)) {
      fail('request_invalid');
    }
    return Object.freeze({ operation: 'traceStartReceiptContext',requestId: value.requestId });
  }
  if (path === '/v1/game/synchronization/context') {
    const value = exact(parse(bytes), ['sampleId']);
    if (typeof value.sampleId !== 'string' || !UUID.test(value.sampleId)) {
      fail('request_invalid');
    }
    return Object.freeze({ operation: 'issuanceContext',sampleId: value.sampleId });
  }
  if (path === '/v1/game/trace/start') return {
    operation: 'startTrace', ...commandAuthority(bytes, 'trace_start'),
  };
  if (path === '/v1/game/trace/end') return {
    operation: 'endTrace', ...commandAuthority(bytes, 'trace_end'),
  };
  if (path === '/v1/game/consent/opt-in') return {
    operation: 'optIn', ...commandAuthority(bytes, 'consent_opt_in'),
  };
  if (path === '/v1/game/consent/stop') return {
    operation: 'stopSharing', ...commandAuthority(bytes, 'consent_stop'),
  };
  if (path === '/v1/game/relay/bind') return {
    operation: 'bindRelay', ...commandAuthority(bytes, 'relay_bind'),
  };
  if (path === '/v1/game/segment/rotate') {
    const value = exact(parse(bytes), ['authority']);
    const authority = validateOperationAuthorityJson(encoded(value.authority));
    if (authority.operation !== 'segment_rotate') fail('request_invalid');
    return Object.freeze({ operation: 'rotateSegment', authority });
  }
  if (path === '/v1/game/synchronization/issue') {
    const value = exact(parse(bytes), ['traceId', 'issuance']);
    if (typeof value.traceId !== 'string' || !UUID.test(value.traceId)) fail('request_invalid');
    return Object.freeze({
      operation: 'putIssuance', traceId: value.traceId,
      issuance: validateSynchronizationIssuanceJson(encoded(value.issuance)),
    });
  }
  if (path === '/v1/game/report/ingest') {
    const value = exact(parse(bytes), ['envelope', 'grantGeneration']);
    if (!(value.grantGeneration === null
      || (Number.isSafeInteger(value.grantGeneration) && value.grantGeneration > 0))) {
      fail('request_invalid');
    }
    return Object.freeze({
      operation: 'ingestReport',
      envelope: validateUploadedEnvelopeJson(encoded(value.envelope)),
      grantGeneration: value.grantGeneration,
    });
  }
  if (path === '/v1/game/trace/read') {
    validateReadRequestJson(bytes);
    return Object.freeze({ operation: 'readTrace', request: bytes });
  }
  fail('request_invalid');
}

export function validateMaintenancePurgeRequest(bytes) {
  validatePurgeCommandJson(bytes);
  return bytes;
}
