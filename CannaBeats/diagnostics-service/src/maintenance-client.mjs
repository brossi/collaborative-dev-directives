import { readFileSync } from 'node:fs';

import { validatePurgeCommandJson } from './contract.mjs';

const TOKEN = /^[!-~]{32,256}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_BYTES = 8192;
const decoder = new TextDecoder('utf-8',{ fatal: true });
const FAILURE_CODES = new Set([
  'authentication_required','not_authorized','request_invalid','request_conflict',
  'trace_inactive','trace_absent','collector_busy','collector_degraded',
  'quota_exhausted','schema_incompatible','maintenance_unavailable',
]);
const STATUS_REASONS = new Set([
  'retained_data_invalid','counter_mismatch','measurement_unavailable',
  'physical_limit','host_reserve','temp_limit','log_limit',
]);

export class DiagnosticMaintenanceError extends Error {
  constructor(code) {
    super(code);
    this.name = 'DiagnosticMaintenanceError';
    this.code = code;
  }
}

function fail(code) {
  throw new DiagnosticMaintenanceError(code);
}

async function boundedJson(response) {
  if (!response.body) fail('maintenance_response_invalid');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done,value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) fail('maintenance_response_invalid');
      chunks.push(value);
    }
  } finally {
    try { void reader.cancel().catch(() => {}); } catch {}
    reader.releaseLock();
  }
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk,offset);
    offset += chunk.byteLength;
  }
  try {
    const value = JSON.parse(decoder.decode(joined));
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      fail('maintenance_response_invalid');
    }
    return value;
  } catch (error) {
    if (error instanceof DiagnosticMaintenanceError) throw error;
    fail('maintenance_response_invalid');
  }
}

export function createDiagnosticMaintenanceClient({
  origin = process.env.CANNABEATS_DIAGNOSTICS_SERVICE_ORIGIN,
  token = '',fetchImpl = fetch,deadlineMs = 2000,
} = {}) {
  if (!origin || !TOKEN.test(token) || !Number.isSafeInteger(deadlineMs) || deadlineMs < 1) {
    throw new Error('diagnostic_maintenance_configuration_invalid');
  }
  const base = new URL(origin).origin;
  async function request(path,{ method = 'POST',body } = {}) {
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(),deadlineMs);
    try {
      const response = await fetchImpl(`${base}${path}`,{
        method,signal: controller.signal,cache: 'no-store',redirect: 'error',
        headers: { authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const value = await boundedJson(response);
      if (!response.ok) fail(FAILURE_CODES.has(value.code) ? value.code : 'maintenance_unavailable');
      return value;
    } catch (error) {
      if (error instanceof DiagnosticMaintenanceError) throw error;
      fail('maintenance_unavailable');
    } finally { clearTimeout(deadline); }
  }
  return Object.freeze({
    async status() {
      const value = await request('/v1/maintenance/status',{ method: 'GET' });
      const keys = ['status','reason','schemaGeneration','traceCount','reportCount',
        'requestCount','canonicalBytes'];
      if (Object.keys(value).length !== keys.length
        || keys.some((key) => !Object.hasOwn(value,key))
        || !['healthy','degraded'].includes(value.status)
        || (value.status === 'healthy' ? value.reason !== null
          : !STATUS_REASONS.has(value.reason))
        || !Number.isSafeInteger(value.schemaGeneration) || value.schemaGeneration !== 1
        || ['traceCount','reportCount','requestCount','canonicalBytes'].some(
          (key) => !Number.isSafeInteger(value[key]) || value[key] < 0,
        )) fail('maintenance_response_invalid');
      return Object.freeze(value);
    },
    async purge({ requestId,traceId }) {
      if (!UUID.test(requestId ?? '') || !UUID.test(traceId ?? '')) {
        fail('maintenance_request_invalid');
      }
      const command = { requestId,operation: 'trace_purge',parameters: { traceId } };
      try { validatePurgeCommandJson(Buffer.from(JSON.stringify(command))); }
      catch { fail('maintenance_request_invalid'); }
      const value = await request('/v1/maintenance/trace/purge',{ body: command });
      if (!['purged','trace_absent','trace_inactive'].includes(value.status)
        || value.traceId !== traceId || Object.keys(value).length !== 2) {
        fail('maintenance_response_invalid');
      }
      return Object.freeze(value);
    },
  });
}

export function maintenanceTokenFromEnvironment(
  environment = process.env,read = readFileSync,
) {
  const direct = environment.CANNABEATS_DIAGNOSTICS_MAINTENANCE_TOKEN?.trim();
  const path = environment.CANNABEATS_DIAGNOSTICS_MAINTENANCE_TOKEN_FILE;
  const token = direct || (path ? read(path,'utf8').trim() : '');
  if (!TOKEN.test(token)) throw new Error('diagnostic_maintenance_configuration_invalid');
  return token;
}
