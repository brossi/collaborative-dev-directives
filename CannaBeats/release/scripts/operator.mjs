#!/usr/bin/env node

import { lstatSync, readFileSync, readSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const PRODUCTION_OPERATOR_ORIGIN = 'https://play.cannabeats.social';
export const PRODUCTION_OPERATOR_TOKEN = '/etc/cannabeats/secrets/operator-token';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const TOKEN = /^[A-Za-z0-9_-]{43}$/u;
const ENROLLMENT = /^[A-Za-z0-9_-]{22,128}$/u;
const MAX_RESPONSE_BYTES = 4 * 1024;
const MAX_ENROLLMENT_INPUT_BYTES = 130;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const STATUS_REASONS = new Set([
  'ready', 'database_unavailable', 'database_incompatible', 'database_corrupt',
  'database_capacity', 'catalog_incompatible',
]);
const REMOTE_FAILURE_CODES = new Set([
  'invalid_request', 'unauthorized', 'request_conflict', 'already_used',
  'capacity_reached', 'database_unavailable', 'database_corrupt',
  'operator_unavailable',
]);

export class OperatorError extends Error {
  constructor(code) { super(code); this.code = code; }
}
function fail(code) { throw new OperatorError(code); }
function pairs(argv, command, names) {
  if (argv[0] !== command || argv.length !== 1 + names.length * 2) fail('invalid_arguments');
  const values = {};
  for (let index = 1; index < argv.length; index += 2) {
    const name = argv[index];
    if (!names.includes(name) || Object.hasOwn(values, name) || !argv[index + 1]) {
      fail('invalid_arguments');
    }
    values[name] = argv[index + 1];
  }
  if (Object.keys(values).length !== names.length) fail('invalid_arguments');
  return values;
}

export function parseOperatorArguments(argv) {
  if (argv.length === 1 && ['status', 'active-game', 'purge-diagnostics'].includes(argv[0])) {
    return Object.freeze({ command: argv[0] });
  }
  if (argv[0] === 'bootstrap-enrollment') {
    const values = pairs(argv, argv[0], ['--request-id', '--code-fd']);
    if (!UUID.test(values['--request-id']) || !/^(?:0|[1-9]\d{0,2})$/u.test(values['--code-fd'])) {
      fail('invalid_arguments');
    }
    return Object.freeze({ command: argv[0], ...values });
  }
  if (argv[0] === 'revoke-device') {
    const values = pairs(argv, argv[0], ['--request-id', '--device-id']);
    if (!UUID.test(values['--request-id']) || !UUID.test(values['--device-id'])) {
      fail('invalid_arguments');
    }
    return Object.freeze({ command: argv[0], ...values });
  }
  fail('invalid_arguments');
}

function readRegular(path, maximum) {
  try {
    const retained = lstatSync(path);
    if (retained.isSymbolicLink() || !retained.isFile()
        || retained.size < 1 || retained.size > maximum) fail('operator_unavailable');
    return readFileSync(path, 'utf8');
  } catch (error) {
    if (error instanceof OperatorError) throw error;
    fail('operator_unavailable');
  }
}
function readCode(descriptor) {
  const bytes = Buffer.alloc(MAX_ENROLLMENT_INPUT_BYTES + 1);
  let length = 0;
  try {
    for (;;) {
      const count = readSync(descriptor, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
      if (length > MAX_ENROLLMENT_INPUT_BYTES) fail('invalid_arguments');
    }
  } catch (error) {
    if (error instanceof OperatorError) throw error;
    fail('invalid_arguments');
  }
  let value;
  try { value = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)); }
  catch { fail('invalid_arguments'); }
  if (value.endsWith('\r\n')) value = value.slice(0, -2);
  else if (value.endsWith('\n')) value = value.slice(0, -1);
  if (!ENROLLMENT.test(value)) fail('invalid_arguments');
  return value;
}
function exact(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}
function safeInteger(value, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}
function validateResult(command, value) {
  const valid = command === 'status'
    ? exact(value, [
      'code', 'ready', 'reason', 'schemaGeneration', 'catalogVersion',
      'activeGame', 'activeDevices', 'diagnostics',
    ]) && value.code === 'operator_status' && typeof value.ready === 'boolean'
      && STATUS_REASONS.has(value.reason)
      && (value.schemaGeneration === null || safeInteger(value.schemaGeneration, 1))
      && (value.catalogVersion === null
        || (typeof value.catalogVersion === 'string' && DIGEST.test(value.catalogVersion)))
      && typeof value.activeGame === 'boolean' && safeInteger(value.activeDevices, 0, 8)
      && safeInteger(value.diagnostics)
    : command === 'active-game'
      ? (value.code === 'active_game_absent' && exact(value, ['code']))
        || (value.code === 'active_game_summary'
          && exact(value, ['code', 'lifecycle', 'revision', 'phase', 'round', 'players'])
          && ['lobby', 'active'].includes(value.lifecycle)
          && ['lobby', 'ready', 'playing', 'placed', 'revealed'].includes(value.phase)
          && safeInteger(value.revision) && safeInteger(value.round)
          && safeInteger(value.players, 0, 8))
      : command === 'bootstrap-enrollment'
        ? exact(value, ['code', 'expiresAt']) && value.code === 'enrollment_issued'
          && safeInteger(value.expiresAt, 1)
        : command === 'revoke-device'
          ? exact(value, ['code', 'revokedAt']) && value.code === 'device_revoked'
            && safeInteger(value.revokedAt, 1)
          : exact(value, ['code']) && value.code === 'diagnostics_purged';
  if (!valid) fail('operator_response_invalid');
  return Object.freeze(value);
}

async function readBoundedResponse(response) {
  if (!response.body) fail('operator_response_invalid');
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        fail('operator_response_invalid');
      }
      chunks.push(Buffer.from(value));
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, length));
  } catch (error) {
    if (error instanceof OperatorError) throw error;
    fail('operator_response_invalid');
  }
}

export async function executeOperatorCommand(argv, {
  origin = PRODUCTION_OPERATOR_ORIGIN, tokenPath = PRODUCTION_OPERATOR_TOKEN,
  fetchImpl = fetch, codeReader = readCode,
} = {}) {
  const parsed = parseOperatorArguments(argv);
  if (origin !== PRODUCTION_OPERATOR_ORIGIN) {
    try {
      const url = new URL(origin);
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
        fail('invalid_arguments');
      }
    } catch (error) {
      if (error instanceof OperatorError) throw error;
      fail('invalid_arguments');
    }
  }
  const token = readRegular(tokenPath, 43);
  if (!TOKEN.test(token)) fail('operator_unavailable');
  let path;
  let method = 'GET';
  let payload = null;
  if (parsed.command === 'status') path = '/api/operator/status';
  else if (parsed.command === 'active-game') path = '/api/operator/active-game';
  else if (parsed.command === 'bootstrap-enrollment') {
    path = '/api/operator/enrollments';
    method = 'POST';
    payload = {
      enrollmentCode: codeReader(Number(parsed['--code-fd'])), requestId: parsed['--request-id'],
    };
  } else if (parsed.command === 'revoke-device') {
    path = '/api/operator/device-revocations';
    method = 'POST';
    payload = { requestId: parsed['--request-id'], targetDeviceId: parsed['--device-id'] };
  } else {
    path = '/api/operator/diagnostics/purge';
    method = 'POST';
    payload = {};
  }
  let response;
  try {
    response = await fetchImpl(new URL(path, `${origin}/`), {
      method, headers: {
        authorization: `Bearer ${token}`,
        ...(payload === null ? {} : { 'content-type': 'application/json' }),
      },
      ...(payload === null ? {} : { body: JSON.stringify(payload) }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch { fail('operator_unavailable'); }
  const text = await readBoundedResponse(response);
  let value;
  try { value = JSON.parse(text); } catch { fail('operator_response_invalid'); }
  if (!response.ok) {
    if (exact(value, ['ok', 'code']) && value.ok === false
        && REMOTE_FAILURE_CODES.has(value.code)) fail(value.code);
    fail('operator_unavailable');
  }
  return validateResult(parsed.command, value);
}

async function main() {
  try {
    const result = await executeOperatorCommand(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof OperatorError ? error.code : 'operator_unavailable'}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
