import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';

import { ReleaseStoreError } from '../../web/lib/server/release/store.mjs';
import { createReleaseRuntime, unifiedRuntimeEnabled } from '../../web/lib/server/release/runtime.mjs';

const roots = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

function temporaryPath() {
  const root = mkdtempSync(join(tmpdir(), 'cannabeats-runtime-'));
  roots.push(root);
  return join(root, 'cannabeats.sqlite3');
}

test('runtime selection is explicit and fail closed', () => {
  assert.equal(unifiedRuntimeEnabled({ CANNABEATS_RUNTIME: 'unified' }), true);
  assert.equal(unifiedRuntimeEnabled({}), false);
  assert.equal(unifiedRuntimeEnabled({ CANNABEATS_RUNTIME: 'legacy' }), false);
});

test('health proves process response while readiness proves the real owner', () => {
  const runtime = createReleaseRuntime({ databasePath: temporaryPath() });
  assert.deepEqual(runtime.health(), { ok: true, service: 'cannabeats' });
  const readiness = runtime.readiness();
  assert.equal(readiness.ready, true);
  assert.equal(readiness.reason, 'ready');
  assert.equal(readiness.service, 'cannabeats');
  assert.equal(readiness.schemaGeneration, 1);
  assert.match(readiness.catalogVersion, /^sha256:[0-9a-f]{64}$/u);
  runtime.close();
  assert.deepEqual(runtime.readiness(), { ready: false, reason: 'database_unavailable' });
});

test('initialization and owner failures expose only the finite readiness taxonomy', () => {
  const cases = [
    ['database_unavailable', new Error('/private/path SQL token secret')],
    ['database_incompatible', new ReleaseStoreError('database_incompatible')],
    ['database_corrupt', new ReleaseStoreError('database_corrupt')],
    ['catalog_incompatible', new Error('catalog_incompatible')],
  ];
  for (const [expected, failure] of cases) {
    const runtime = createReleaseRuntime({
      databasePath: temporaryPath(),
      loadCatalog: () => {
        if (expected === 'catalog_incompatible') throw failure;
        return { version: `sha256:${'0'.repeat(64)}` };
      },
      createStore: () => { throw failure; },
    });
    const serialized = JSON.stringify(runtime.readiness());
    assert.deepEqual(runtime.readiness(), { ready: false, reason: expected });
    assert.doesNotMatch(serialized, /private|path|sql|token|secret/iu);
    assert.deepEqual(runtime.health(), { ok: true, service: 'cannabeats' });
  }
});

test('an owner capacity result remains distinct from database corruption', () => {
  const fakeStore = {
    readiness: () => ({ ready: false, reason: 'database_capacity' }),
    close: () => {},
  };
  const runtime = createReleaseRuntime({
    databasePath: temporaryPath(),
    loadCatalog: () => ({ version: `sha256:${'0'.repeat(64)}` }),
    createStore: () => fakeStore,
  });
  assert.deepEqual(runtime.readiness(), { ready: false, reason: 'database_capacity' });
  runtime.close();
});
