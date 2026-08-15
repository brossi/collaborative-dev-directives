import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { DiagnosticCollector } from '../src/collector.mjs';
import { createDiagnosticService } from '../src/server.mjs';

function temporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), 'cannabeats-e73-'));
  return {
    directory,
    databasePath: join(directory, 'diagnostics.sqlite'),
    remove: () => rmSync(directory, { recursive: true, force: true }),
  };
}

async function request(address, path, options) {
  const response = await fetch(`http://127.0.0.1:${address.port}${path}`, options);
  return { status: response.status, body: await response.json() };
}

test('private process exposes only bounded liveness readiness and status', async () => {
  const fixture = temporaryDirectory();
  const service = createDiagnosticService({
    databasePath: fixture.databasePath,
    host: '127.0.0.1',
    port: 0,
  });
  try {
    const address = await service.start();
    assert.deepEqual(await request(address, '/live'), {
      status: 200,
      body: { status: 'live' },
    });
    assert.deepEqual(await request(address, '/ready'), {
      status: 200,
      body: { status: 'ready' },
    });
    assert.deepEqual(await request(address, '/v1/status'), {
      status: 200,
      body: {
        status: 'healthy', reason: null, schemaGeneration: 1,
        traceCount: 0, reportCount: 0, requestCount: 0, canonicalBytes: 0,
      },
    });
    assert.deepEqual(await request(address, '/v1/status', { method: 'POST' }), {
      status: 404,
      body: { status: 'not_found' },
    });
    assert.deepEqual(await request(address, '/missing'), {
      status: 404,
      body: { status: 'not_found' },
    });
  } finally {
    await service.close();
    fixture.remove();
  }
});

test('startup validates the real store and refuses incompatible or second-owner files', async () => {
  const incompatible = temporaryDirectory();
  writeFileSync(incompatible.databasePath, 'not sqlite');
  assert.throws(() => createDiagnosticService({
    databasePath: incompatible.databasePath,
    host: '127.0.0.1',
    port: 0,
  }), /schema_incompatible/);
  incompatible.remove();

  const owned = temporaryDirectory();
  const owner = new DiagnosticCollector(owned.databasePath);
  try {
    assert.throws(() => createDiagnosticService({
      databasePath: owned.databasePath,
      host: '127.0.0.1',
      port: 0,
    }), /operating-system owner/);
  } finally {
    owner.close();
    owned.remove();
  }
});

test('a listen failure releases the store owner before returning', async () => {
  const fixture = temporaryDirectory();
  const blocker = createServer();
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  const port = blocker.address().port;
  const service = createDiagnosticService({
    databasePath: fixture.databasePath,
    host: '127.0.0.1',
    port,
  });
  try {
    await assert.rejects(service.start(), (error) => error.code === 'EADDRINUSE');
    const nextOwner = new DiagnosticCollector(fixture.databasePath);
    nextOwner.close();
  } finally {
    await service.close();
    await new Promise((resolve) => blocker.close(resolve));
    fixture.remove();
  }
});

test('maintenance is bounded to one timer and shutdown releases every owner', async () => {
  const fixture = temporaryDirectory();
  let sweeps = 0;
  let closes = 0;
  const events = [];
  const service = createDiagnosticService({
    databasePath: fixture.databasePath,
    host: '127.0.0.1',
    port: 0,
    maintenanceIntervalMs: 5,
    onLifecycle: (event) => events.push(event),
    createCollector() {
      return {
        status: () => ({
          status: 'healthy', reason: null, schemaGeneration: 1,
          traceCount: 0, reportCount: 0, requestCount: 0, canonicalBytes: 0,
        }),
        retentionSweep: () => { sweeps += 1; },
        close: () => { closes += 1; },
      };
    },
  });
  await service.start();
  await new Promise((resolve) => setTimeout(resolve, 18));
  await Promise.all([service.close(), service.close()]);
  const afterClose = sweeps;
  await new Promise((resolve) => setTimeout(resolve, 12));
  assert.ok(afterClose >= 1);
  assert.equal(sweeps, afterClose);
  assert.equal(closes, 1);
  assert.deepEqual(events, [{ event: 'started' }, { event: 'stopped' }]);
  fixture.remove();
});

test('maintenance and status dependency failures stay finite and isolated', async () => {
  const fixture = temporaryDirectory();
  let statusCalls = 0;
  const service = createDiagnosticService({
    databasePath: fixture.databasePath,
    host: '127.0.0.1',
    port: 0,
    maintenanceIntervalMs: 5,
    onLifecycle: () => { throw new Error('observer must be isolated'); },
    createCollector() {
      return {
        status() {
          statusCalls += 1;
          throw new Error('untrusted lower-layer text');
        },
        retentionSweep() { throw new Error('untrusted maintenance text'); },
        close() {},
      };
    },
  });
  try {
    const address = await service.start();
    assert.deepEqual(await request(address, '/ready'), {
      status: 503,
      body: { status: 'degraded', reason: 'collector_degraded' },
    });
    assert.deepEqual(await request(address, '/v1/status'), {
      status: 503,
      body: { status: 'degraded', reason: 'collector_degraded' },
    });
    await new Promise((resolve) => setTimeout(resolve, 12));
    assert.equal(statusCalls, 2);
    assert.deepEqual(await request(address, '/live'), {
      status: 200,
      body: { status: 'live' },
    });
  } finally {
    await service.close();
    fixture.remove();
  }
});
