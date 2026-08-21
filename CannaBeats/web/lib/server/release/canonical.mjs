import { createHash } from 'node:crypto';

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
export const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
export const CATALOG_VERSION_PATTERN = /^sha256:[0-9a-f]{64}$/u;

export function canonicalValue(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('non_finite_number');
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error('non_json_value');
  }
  const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
  if (entries.some(([, entry]) => entry === undefined
      || typeof entry === 'function' || typeof entry === 'symbol' || typeof entry === 'bigint')) {
    throw new Error('non_json_value');
  }
  return Object.fromEntries(entries.map(([key, entry]) => [key, canonicalValue(entry)]));
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

export function parseCanonicalJson(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('invalid_json');
  }
  const canonical = canonicalJson(parsed);
  if (canonical !== text) throw new Error('noncanonical_json');
  return parsed;
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function assertUuid(value, code = 'invalid_uuid') {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) throw new Error(code);
  return value;
}

export function assertTimestamp(value, code = 'invalid_timestamp') {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(code);
  return value;
}

export function assertHash(value, code = 'invalid_hash') {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) throw new Error(code);
  return value;
}
