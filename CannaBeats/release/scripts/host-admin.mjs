#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { loadCatalogArtifacts } from '../../web/lib/server/release/catalog.mjs';
import { createReleaseStore } from '../../web/lib/server/release/store.mjs';

const REQUIRED = new Set(['database', 'catalog', 'manifest', 'request-id', 'code-fd']);

export function parseHostAdminArguments(argv) {
  if (argv[0] !== 'bootstrap-enrollment') throw new Error('invalid_arguments');
  const values = {};
  for (let index = 1; index < argv.length; index += 2) {
    const name = argv[index]?.startsWith('--') ? argv[index].slice(2) : '';
    const value = argv[index + 1];
    if (!REQUIRED.has(name) || typeof value !== 'string' || !value || values[name]) {
      throw new Error('invalid_arguments');
    }
    values[name] = value;
  }
  if (Object.keys(values).length !== REQUIRED.size) throw new Error('invalid_arguments');
  return Object.freeze(values);
}

export function bootstrapEnrollment(values, {
  loadCatalog = loadCatalogArtifacts, createStore = createReleaseStore, now = Date.now(),
  readCode = (descriptor) => readFileSync(descriptor, 'utf8'),
} = {}) {
  if (!/^(?:0|[1-9]\d{0,2})$/u.test(values['code-fd'])) throw new Error('invalid_arguments');
  const rawCode = readCode(Number(values['code-fd']));
  if (typeof rawCode !== 'string') throw new Error('invalid_arguments');
  const code = rawCode.endsWith('\r\n') ? rawCode.slice(0, -2)
    : rawCode.endsWith('\n') ? rawCode.slice(0, -1) : rawCode;
  if (!code || /[\r\n]/u.test(code)) throw new Error('invalid_arguments');
  const catalog = loadCatalog({ catalogPath: values.catalog, manifestPath: values.manifest });
  const store = createStore(values.database, { catalog, now });
  try {
    return store.issueEnrollment({
      enrollmentCode: code, requestId: values['request-id'], now,
    });
  } finally {
    store.close();
  }
}

export function renderHostAdminResult(result) {
  return JSON.stringify({ code: result.code, expiresAt: result.expiresAt });
}

async function main() {
  try {
    const values = parseHostAdminArguments(process.argv.slice(2));
    process.stdout.write(`${renderHostAdminResult(bootstrapEnrollment(values))}\n`);
  } catch (error) {
    const code = typeof error?.code === 'string' ? error.code
      : typeof error?.message === 'string' && /^[a-z_]+$/u.test(error.message)
        ? error.message : 'operation_failed';
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
