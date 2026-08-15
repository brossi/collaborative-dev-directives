import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { DiagnosticCollector } from '../src/collector.mjs';
import {
  classifyDiagnosticHttpFailure,
  createDiagnosticService,
  delegateGameCollectorOperation,
} from '../src/server.mjs';

const GAME_TOKEN = 'game-token-000000000000000000000000';
const MAINTENANCE_TOKEN = 'maintenance-token-0000000000000000';
const TRACE = '423e4567-e89b-42d3-a456-426614174000';
const RUN = '523e4567-e89b-42d3-a456-426614174000';
const LEASE = '723e4567-e89b-42d3-a456-426614174000';
const SEGMENT = '623e4567-e89b-42d3-a456-426614174000';
const REQUEST = 'b23e4567-e89b-42d3-a456-426614174000';
const authenticatedApi = Object.freeze({
  gameToken: GAME_TOKEN, maintenanceToken: MAINTENANCE_TOKEN,
});

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

const startBody = () => ({
  command: { requestId: REQUEST, operation: 'trace_start', parameters: {} },
  authority: {
    authorityVersion: 1, operation: 'trace_start', nowMs: 1000, isHost: true,
    runId: RUN, runGeneration: 1, leaseId: LEASE,
    issuedTraceId: TRACE, issuedSegmentId: SEGMENT,
  },
});

function authenticatedOptions(token, body, method = 'POST') {
  return {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
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

test('startup rejects a diagnostics volume alias before opening the store', () => {
  let collectorCreates = 0;
  const createCollector = () => {
    collectorCreates += 1;
    throw new Error('collector must not be opened');
  };
  const base = {
    databasePath: '/diagnostics/cannabeats-diagnostics.sqlite',
    createCollector,
  };

  for (const volumeTopology of [
    { diagnostics: 'shared', access: 'shared', state: 'state' },
    { diagnostics: 'shared', access: 'access', state: 'shared' },
    { diagnostics: 'diagnostics', access: 'shared', state: 'shared' },
  ]) {
    assert.throws(() => createDiagnosticService({ ...base, volumeTopology }),
      (error) => error.code === 'volume_identity_conflict');
  }
  assert.throws(() => createDiagnosticService({
    ...base,
    volumeTopology: { diagnostics: '../diagnostics', access: 'access', state: 'state' },
  }), (error) => error.code === 'volume_identity_invalid');
  assert.equal(collectorCreates, 0);
});

test('authenticated API configuration fails before collector creation', () => {
  let collectorCreates = 0;
  for (const value of [
    { gameToken: GAME_TOKEN, maintenanceToken: GAME_TOKEN },
    { gameToken: 'short', maintenanceToken: MAINTENANCE_TOKEN },
  ]) {
    assert.throws(() => createDiagnosticService({
      databasePath: '/diagnostics/cannabeats-diagnostics.sqlite',
      authenticatedApi: value,
      createCollector() { collectorCreates += 1; },
    }), (error) => error.code === 'credential_invalid');
  }
  assert.equal(collectorCreates, 0);
});

test('finite HTTP failures cover every documented status family without native text', () => {
  const families = [
    [400, ['request_invalid', 'authority_invalid', 'sample_invalid', 'alignment_invalid',
      'report_invalid', 'report_too_large']],
    [401, ['authentication_required']],
    [403, ['not_authorized']],
    [408, ['request_timeout']],
    [409, ['request_conflict', 'report_conflict', 'stale_correlation', 'sample_expired',
      'read_expired', 'trace_inactive']],
    [503, ['collector_busy', 'collector_degraded', 'quota_exhausted',
      'schema_incompatible']],
  ];
  for (const [statusCode, codes] of families) {
    for (const code of codes) {
      assert.deepEqual(classifyDiagnosticHttpFailure({ code, message: 'secret' }),
        { statusCode, code });
    }
  }
  assert.deepEqual(classifyDiagnosticHttpFailure(new Error('secret native text')),
    { statusCode: 503, code: 'collector_unavailable' });
});

test('every normalized Game operation delegates once to only its named collector method', () => {
  const calls = [];
  const collector = {};
  for (const method of [
    'startTrace', 'endTrace', 'rotateSegment', 'putIssuance', 'optIn',
    'stopSharing', 'bindRelay', 'ingestReport', 'readTrace',
  ]) {
    collector[method] = (...args) => {
      calls.push([method, ...args]);
      return method === 'putIssuance' ? 'accepted' : { delegated: method };
    };
  }
  const marker = Object.freeze({ marker: true });
  const operations = [
    { operation: 'startTrace', command: marker, authority: marker },
    { operation: 'endTrace', command: marker, authority: marker },
    { operation: 'rotateSegment', authority: marker },
    { operation: 'putIssuance', traceId: TRACE, issuance: marker },
    { operation: 'optIn', command: marker, authority: marker },
    { operation: 'stopSharing', command: marker, authority: marker },
    { operation: 'bindRelay', command: marker, authority: marker },
    { operation: 'ingestReport', envelope: marker, grantGeneration: 2 },
    { operation: 'readTrace', request: marker },
  ];
  for (const operation of operations) {
    delegateGameCollectorOperation(collector, operation, 4321);
  }
  assert.deepEqual(calls.map(([method]) => method),
    operations.map(({ operation }) => operation));
  assert.deepEqual(calls[7], [
    'ingestReport', marker, { receivedAt: 4321, grantGeneration: 2 },
  ]);
  assert.throws(() => delegateGameCollectorOperation(collector,
    { operation: 'unknown' }, 4321), (error) => error.code === 'request_invalid');
});

test('authenticated routes enforce scope before body and delegate once', async () => {
  const fixture = temporaryDirectory();
  const calls = [];
  const collector = {
    status: () => ({ status: 'healthy', marker: 1 }),
    startTrace(command, authority) {
      calls.push(['startTrace', command.operation, authority.operation]);
      return { status: 'accepted' };
    },
    purgeTrace(input, now) {
      calls.push(['purgeTrace', Buffer.isBuffer(input), now]);
      return { status: 'purged', traceId: TRACE };
    },
    close() {},
    retentionSweep() {},
  };
  const service = createDiagnosticService({
    databasePath: fixture.databasePath, host: '127.0.0.1', port: 0,
    authenticatedApi, clock: () => 5000, createCollector: () => collector,
  });
  try {
    const address = await service.start();
    assert.deepEqual(await request(address, '/v1/game/trace/start',
      authenticatedOptions(GAME_TOKEN, startBody())), {
      status: 200, body: { status: 'accepted' },
    });
    assert.deepEqual(calls, [['startTrace', 'trace_start', 'trace_start']]);
    for (const [path, token, expected] of [
      ['/v1/game/trace/start', MAINTENANCE_TOKEN, 403],
      ['/v1/game/trace/start', 'unknown-token-000000000000000000000', 401],
      ['/v1/maintenance/status', GAME_TOKEN, 403],
    ]) {
      const response = await request(address, path,
        authenticatedOptions(token, path.endsWith('start') ? startBody() : undefined,
          path.endsWith('status') ? 'GET' : 'POST'));
      assert.equal(response.status, expected);
    }
    assert.deepEqual(calls, [['startTrace', 'trace_start', 'trace_start']]);
    assert.deepEqual(await request(address, '/v1/maintenance/status',
      authenticatedOptions(MAINTENANCE_TOKEN, undefined, 'GET')), {
      status: 200, body: { status: 'healthy', marker: 1 },
    });
    assert.deepEqual(await request(address, '/v1/maintenance/trace/purge',
      authenticatedOptions(MAINTENANCE_TOKEN, {
        requestId: REQUEST, operation: 'trace_purge', parameters: { traceId: TRACE },
      })), {
      status: 200, body: { status: 'purged', traceId: TRACE },
    });
    assert.deepEqual(calls.at(-1), ['purgeTrace', true, 5000]);
    assert.deepEqual(await request(address, '/v1/status',
      authenticatedOptions(MAINTENANCE_TOKEN, undefined, 'GET')), {
      status: 404, body: { status: 'not_found' },
    });
  } finally {
    await service.close();
    fixture.remove();
  }
});

test('HTTP mutation replay and conflict remain exact across collector restart', async () => {
  const fixture = temporaryDirectory();
  const open = () => createDiagnosticService({
    databasePath: fixture.databasePath, host: '127.0.0.1', port: 0,
    authenticatedApi, collectorOptions: { now: 0 },
  });
  let service = open();
  try {
    let address = await service.start();
    const accepted = await request(address, '/v1/game/trace/start',
      authenticatedOptions(GAME_TOKEN, startBody()));
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.status, 'accepted');
    await service.close();

    service = open();
    address = await service.start();
    const replayed = await request(address, '/v1/game/trace/start',
      authenticatedOptions(GAME_TOKEN, startBody()));
    assert.equal(replayed.status, 200);
    assert.equal(replayed.body.status, 'replayed');

    const conflict = await request(address, '/v1/game/trace/end',
      authenticatedOptions(GAME_TOKEN, {
        command: { requestId: REQUEST, operation: 'trace_end', parameters: {} },
        authority: {
          authorityVersion: 1, operation: 'trace_end', nowMs: 2000,
          traceId: TRACE, reason: 'host_stopped',
        },
      }));
    assert.deepEqual(conflict, {
      status: 409, body: { status: 'error', code: 'request_conflict' },
    });
  } finally {
    await service.close();
    fixture.remove();
  }
});

test('body bounds timeout and dependency errors stay finite and effect-free', async () => {
  const fixture = temporaryDirectory();
  let effects = 0;
  const service = createDiagnosticService({
    databasePath: fixture.databasePath, host: '127.0.0.1', port: 0,
    authenticatedApi, bodyDeadlineMs: 15,
    createCollector: () => ({
      status: () => ({ status: 'healthy' }),
      startTrace() { effects += 1; throw new Error('lower-layer secret text'); },
      close() {}, retentionSweep() {},
    }),
  });
  try {
    const address = await service.start();
    const oversized = await request(address, '/v1/game/trace/start',
      authenticatedOptions(GAME_TOKEN, { padding: 'x'.repeat(8192) }));
    assert.deepEqual(oversized, {
      status: 400, body: { status: 'error', code: 'request_invalid' },
    });
    assert.equal(effects, 0);

    const failed = await request(address, '/v1/game/trace/start',
      authenticatedOptions(GAME_TOKEN, startBody()));
    assert.deepEqual(failed, {
      status: 503, body: { status: 'error', code: 'collector_unavailable' },
    });
    assert.equal(effects, 1);

    const timeout = await new Promise((resolve, reject) => {
      const pending = httpRequest({
        hostname: '127.0.0.1', port: address.port, path: '/v1/game/trace/start',
        method: 'POST', headers: { authorization: `Bearer ${GAME_TOKEN}` },
      }, (response) => {
        let data = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => { data += chunk; });
        response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(data) }));
      });
      pending.on('error', reject);
      pending.write('{');
    });
    assert.deepEqual(timeout, {
      status: 408, body: { status: 'error', code: 'request_timeout' },
    });
    assert.equal(effects, 1);
  } finally {
    await service.close();
    fixture.remove();
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
