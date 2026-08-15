import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, linkSync, mkdtempSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
  acceptSynchronizationSample,
  bindRelayGeneration,
  canonicalE2OperationCommandBytes,
  canonicalE2OperationReceiptBytes,
  composeUploadedEnvelope,
  createOperationAuthorityFixtureForTest,
  createServerContextFixtureForTest,
  createSynchronizationIssuanceFixtureForTest,
  mapMeasurementAlignment,
  validateE2OperationCommandJson,
} from '../../web/lib/s2e-e2-correlation.mjs';
import { validateMeasurementJson } from '../../web/lib/s2e-e1-contract.mjs';
import { DiagnosticCollector, E7StoreError } from '../src/collector.mjs';
import {
  DIAGNOSTIC_LIMITS,
  reportQuotaAllows,
  requestQuotaAllows,
} from '../src/quota.mjs';
import {
  closeDiagnosticStore,
  createDiagnosticStore,
  validateDiagnosticStoreSchema,
} from '../src/store.mjs';

const INSTANCE = '123e4567-e89b-42d3-a456-426614174000';
const SAMPLE = '223e4567-e89b-42d3-a456-426614174000';
const TIMEBASE = '323e4567-e89b-42d3-a456-426614174000';
const TRACE = '423e4567-e89b-42d3-a456-426614174000';
const RUN = '523e4567-e89b-42d3-a456-426614174000';
const SEGMENT = '623e4567-e89b-42d3-a456-426614174000';
const LEASE = '723e4567-e89b-42d3-a456-426614174000';
const SOURCE = '823e4567-e89b-42d3-a456-426614174000';
const SEGMENT_2 = '923e4567-e89b-42d3-a456-426614174000';
const LEASE_2 = 'a23e4567-e89b-42d3-a456-426614174000';
const REQUESTS = [
  'b23e4567-e89b-42d3-a456-426614174000',
  'c23e4567-e89b-42d3-a456-426614174000',
  'd23e4567-e89b-42d3-a456-426614174000',
  'e23e4567-e89b-42d3-a456-426614174000',
  'f23e4567-e89b-42d3-a456-426614174000',
];
const json = (value) => Buffer.from(JSON.stringify(value));
const workspace = () => mkdtempSync(join(tmpdir(), 'cannabeats-e7-'));
const uuidFor = (value) => `${value.toString(16).padStart(8, '0')}-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
const healthyPhysical = () => ({
  physicalBytes: 1024, hostFreeBytes: 2 * 1024 * 1024 * 1024,
  tempBytes: 0, logBytes: 0,
});
const fileBytes = (path) => existsSync(path) ? statSync(path).size : 0;

function command(operation, parameters = {}, requestId = REQUESTS[0]) {
  return validateE2OperationCommandJson(json({ requestId, operation, parameters }));
}

function authority(value) {
  return createOperationAuthorityFixtureForTest(json({ authorityVersion: 1, ...value }));
}

function startAuthority(overrides = {}) {
  return authority({
    operation: 'trace_start', nowMs: 1000, isHost: true, runId: RUN,
    runGeneration: 1, leaseId: LEASE, issuedTraceId: TRACE,
    issuedSegmentId: SEGMENT, ...overrides,
  });
}

function issuance() {
  return createSynchronizationIssuanceFixtureForTest(json({
    sampleId: SAMPLE, timebaseId: TIMEBASE, instanceId: INSTANCE,
    serverReceiveMs: 1000, serverSendMs: 1005,
  }));
}

function base(kind, measurements, sequence = 0) {
  return {
    schemaVersion: 1, kind, instanceId: INSTANCE, sequence,
    monotonicStartMs: 120 + sequence * 10_000,
    durationMs: kind.endsWith('_transition') ? 0 : 10_000,
    measurements,
  };
}

function fixture(kind, sequence) {
  if (kind === 'listener_window') return base(kind, {
    connectionAttemptSequence: 0, receivedBytes: 192000, receivedFrames: 48000,
    chunkCount: 100, chunkGap: { status: 'observed', count: 99, meanMs: 10, maxMs: 20 },
    reconnectCount: 0, terminalCategory: 'open',
    bufferDepth: { status: 'observed', sampleCount: 10, currentMs: 400, minMs: 300,
      maxMs: 500, meanMs: 410, trendMsPerSecond: 2 },
    underrunCount: 0, underrunDurationMs: 0, reprimeCount: 0,
    windowStartedInUnderrun: false, overflowCount: 0, discardedFrames: 0,
    resetCount: 0, sourceSampleRate: 48000, sourceChannels: 2,
    outputSampleRate: 48000, nominalRateRatio: 1, audioContextState: 'running',
    baseLatencyMs: { status: 'observed', value: 12 },
    outputLatencyMs: { status: 'unsupported' }, visibilityState: 'visible',
    suspensionCount: 0, longTasks: { status: 'observed', count: 0, maxDurationMs: 0 },
    signalPresence: 'present', clippingSeverity: 'none', browserFamily: 'safari',
    browserMajor: { status: 'observed', value: 18 }, osFamily: 'ios',
    displayMode: 'browser', implementationVersion: 1,
  }, sequence);
  if (kind === 'source_window') return base(kind, {
    sampleRate: 48000, channels: 2, encoding: 's16le', capturedFrames: 48000,
    enqueuedFrames: 48000, publishedFrames: 48000, publishedBytes: 192000,
    captureGapCount: 0, droppedUploadCount: 0, reconnectCount: 0,
    publisherRestartCount: 0, publisherState: 'publishing',
    playbackObservation: 'playing',
  }, sequence);
  if (kind === 'relay_window') return base(kind, {
    sampleRate: 48000, channels: 2, encoding: 's16le', ingressFrames: 48000,
    ingressBytes: 192000, ingressGapCount: 0, rejectedIngressCount: 0,
    droppedIngressCount: 0, acceptedListenerCount: 2, closedListenerCount: 1,
    deliveredBytes: 192000, backpressureClosureCount: 0,
    generationFenceDisconnectCount: 1, activeListenerCount: 1,
  }, sequence);
  const measurements = kind === 'listener_transition'
    ? { type: 'request_started', category: 'observed', connectionAttemptSequence: 0, elapsedMs: 0 }
    : kind === 'source_transition'
      ? { type: 'capture_started', category: 'observed' }
      : { type: 'process_started', category: 'observed' };
  return base(kind, measurements, sequence);
}

function context(family) {
  const identity = family === 'listener'
    ? { authorityKind: 'listener', role: 'member', listenerInstanceId: INSTANCE }
    : family === 'source'
      ? { authorityKind: 'source', role: 'source', sourceId: SOURCE, sourceInstanceId: INSTANCE }
      : { authorityKind: 'relay', role: 'relay', relayGenerationId: INSTANCE };
  return createServerContextFixtureForTest(json({
    contextVersion: 1, traceId: TRACE, runId: RUN, runGeneration: 1,
    correlationSegmentId: SEGMENT, leaseId: LEASE, ...identity,
  }));
}

function envelope(kind, sequence) {
  return envelopeFromFixture(fixture(kind, sequence), kind.split('_')[0]);
}

function envelopeFromFixture(value, family = value.kind.split('_')[0]) {
  const core = validateMeasurementJson(json(value));
  const issued = issuance();
  const sample = acceptSynchronizationSample(json({
    sampleId: SAMPLE, instanceId: INSTANCE, localSendMs: 100, localReceiveMs: 120,
  }), issued);
  return composeUploadedEnvelope(
    core, mapMeasurementAlignment(core, sample), context(family),
  );
}

function dynamicIssuance(block, instanceId = INSTANCE) {
  const localReceiveMs = block * 50_000 + 120;
  const sampleSeed = 1000 + block + (instanceId === INSTANCE ? 0 : 5000);
  const value = createSynchronizationIssuanceFixtureForTest(json({
    sampleId: uuidFor(sampleSeed), timebaseId: TIMEBASE, instanceId,
    serverReceiveMs: localReceiveMs + 880, serverSendMs: localReceiveMs + 885,
  }));
  const sample = acceptSynchronizationSample(json({
    sampleId: value.sampleId, instanceId,
    localSendMs: localReceiveMs - 20, localReceiveMs,
  }), value);
  return { issuance: value, sample, localReceiveMs };
}

function dynamicSourceEnvelope(sequence, block, instanceId = INSTANCE, slot = sequence % 5) {
  const synchronized = dynamicIssuance(block, instanceId);
  const value = fixture('source_window', sequence);
  value.instanceId = instanceId;
  value.monotonicStartMs = synchronized.localReceiveMs + slot * 10_000;
  const core = validateMeasurementJson(json(value));
  const serverContext = createServerContextFixtureForTest(json({
    contextVersion: 1, traceId: TRACE, runId: RUN, runGeneration: 1,
    correlationSegmentId: SEGMENT, leaseId: LEASE,
    authorityKind: 'source', role: 'source', sourceId: SOURCE,
    sourceInstanceId: instanceId,
  }));
  return {
    issuance: synchronized.issuance,
    envelope: composeUploadedEnvelope(
      core, mapMeasurementAlignment(core, synchronized.sample), serverContext,
    ),
    receivedAt: synchronized.issuance.serverSendMs + 60_000,
  };
}

function expectCode(code, action) {
  assert.throws(action, (error) => error instanceof E7StoreError && error.code === code);
}

function ingestSourceReports(collector, count) {
  const issuanceBlocks = new Set();
  for (let sequence = 0; sequence < count; sequence += 1) {
    const block = Math.floor(sequence / 5);
    const value = dynamicSourceEnvelope(sequence, block);
    if (!issuanceBlocks.has(block)) {
      collector.putIssuance(TRACE, value.issuance);
      issuanceBlocks.add(block);
    }
    assert.equal(collector.ingestReport(value.envelope, {
      receivedAt: value.receivedAt,
    }).status, 'accepted');
  }
}

test('generation-1 schema is exact and lifetime ownership rejects aliases', () => {
  const dir = workspace();
  const path = join(dir, 'diagnostics.sqlite');
  const lockDirectory = join(dir, 'locks');
  const first = createDiagnosticStore(path, { lockDirectory });
  assert.equal(validateDiagnosticStoreSchema(first).generation, 1);
  assert.throws(() => createDiagnosticStore(path, { lockDirectory }), /operating-system owner/);
  const alias = join(dir, 'alias.sqlite');
  linkSync(path, alias);
  assert.throws(() => createDiagnosticStore(alias, { lockDirectory }), /operating-system owner/);
  const symbolic = join(dir, 'symbolic.sqlite');
  symlinkSync(path, symbolic);
  assert.throws(() => createDiagnosticStore(symbolic, { lockDirectory }), /operating-system owner/);
  const storeModule = new URL('../src/store.mjs', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { createDiagnosticStore } from ${JSON.stringify(storeModule)};
    try {
      createDiagnosticStore(${JSON.stringify(path)}, {
        lockDirectory: ${JSON.stringify(lockDirectory)}
      });
      process.exit(2);
    } catch (error) {
      if (!String(error.message).includes('operating-system owner')) process.exit(3);
    }
  `]);
  assert.equal(child.status, 0, child.stderr.toString());
  closeDiagnosticStore(first);
  const reopened = createDiagnosticStore(path, { lockDirectory });
  closeDiagnosticStore(reopened);

  const raw = new DatabaseSync(path);
  raw.exec('PRAGMA writable_schema=ON');
  raw.prepare("UPDATE sqlite_schema SET sql=sql || ' ' WHERE name='diagnostic_reports'").run();
  raw.exec('PRAGMA writable_schema=OFF');
  raw.close();
  assert.throws(() => createDiagnosticStore(path, { lockDirectory }), /schema_incompatible/);
});

test('incompatible existing SQLite files are inspected without persistent mutation', () => {
  const dir = workspace();
  const path = join(dir, 'foreign.sqlite');
  const foreign = new DatabaseSync(path);
  foreign.exec('PRAGMA journal_mode=DELETE; CREATE TABLE foreign_data(value TEXT)');
  foreign.close();
  assert.throws(() => createDiagnosticStore(path, {
    lockDirectory: join(dir, 'locks'),
  }), /schema_incompatible/);
  const reopened = new DatabaseSync(path);
  assert.equal(reopened.prepare('PRAGMA journal_mode').get().journal_mode, 'delete');
  assert.deepEqual(reopened.prepare(`SELECT name FROM sqlite_schema
    WHERE type='table' ORDER BY name`).all().map((row) => row.name), ['foreign_data']);
  reopened.close();
});

test('startup rejects retained projection and counter corruption', () => {
  const dir = workspace();
  const path = join(dir, 'diagnostics.sqlite');
  const lockDirectory = join(dir, 'locks');
  const collector = new DiagnosticCollector(path, { lockDirectory, now: 0 });
  collector.startTrace(command('trace_start'), startAuthority());
  collector.close();
  const raw = new DatabaseSync(path);
  const trigger = raw.prepare(`SELECT sql FROM sqlite_schema WHERE type='trigger'
    AND name='diagnostic_traces_monotonic_update'`).get().sql;
  raw.exec('DROP TRIGGER diagnostic_traces_monotonic_update');
  raw.prepare('UPDATE diagnostic_traces SET run_generation=2 WHERE trace_id=?').run(TRACE);
  raw.exec(trigger);
  raw.close();
  expectCode('collector_degraded', () => new DiagnosticCollector(path, {
    lockDirectory, now: 2000,
  }));
});

test('startup rejects dangling, unreferenced, and impossible-retention rows', () => {
  for (const corruption of ['orphan', 'unreferenced_segment', 'expiry']) {
    const dir = workspace();
    const path = join(dir, `${corruption}.sqlite`);
    const lockDirectory = join(dir, 'locks');
    const collector = new DiagnosticCollector(path, { lockDirectory, now: 0 });
    collector.startTrace(command('trace_start'), startAuthority());
    collector.close();
    const raw = new DatabaseSync(path);
    if (corruption === 'orphan') {
      raw.exec('PRAGMA foreign_keys=OFF');
      raw.prepare(`INSERT INTO diagnostic_segments
        (segment_id,trace_id,lease_id,started_at) VALUES (?,?,?,?)`).run(
        uuidFor(9900), uuidFor(9901), uuidFor(9902), 1000,
      );
    } else if (corruption === 'unreferenced_segment') {
      raw.prepare(`INSERT INTO diagnostic_segments
        (segment_id,trace_id,lease_id,started_at) VALUES (?,?,?,?)`).run(
        uuidFor(9910), TRACE, uuidFor(9911), 1001,
      );
    } else {
      raw.exec('PRAGMA ignore_check_constraints=ON');
      raw.prepare(`UPDATE diagnostic_requests SET expires_at=expires_at+1
        WHERE operation='trace_start'`).run();
    }
    raw.close();
    expectCode('collector_degraded', () => new DiagnosticCollector(path, {
      lockDirectory, now: 2000,
    }));
  }
});

test('segment retention has an exact per-trace bound', () => {
  const dir = workspace();
  const collector = new DiagnosticCollector(join(dir, 'diagnostics.sqlite'), {
    lockDirectory: join(dir, 'locks'), now: 0,
    observePhysicalUsage: healthyPhysical,
  });
  collector.startTrace(command('trace_start'), startAuthority());
  const insert = collector.db.prepare(`INSERT INTO diagnostic_segments
    (segment_id,trace_id,lease_id,started_at) VALUES (?,?,?,?)`);
  for (let index = 1; index < DIAGNOSTIC_LIMITS.traceSegments; index += 1) {
    insert.run(uuidFor(30_000 + index), TRACE, uuidFor(40_000 + index), 1000 + index);
  }
  expectCode('quota_exhausted', () => collector.rotateSegment(authority({
    operation: 'segment_rotate', nowMs: 2000, traceId: TRACE,
    priorLeaseId: LEASE, leaseId: LEASE_2, issuedSegmentId: SEGMENT_2,
  })));
  assert.equal(collector.db.prepare(`SELECT COUNT(*) AS n FROM diagnostic_segments
    WHERE trace_id=?`).get(TRACE).n, DIAGNOSTIC_LIMITS.traceSegments);
  collector.close();
});

test('trace, segment, consent, relay, and receipts survive restart exactly', () => {
  const dir = workspace();
  const path = join(dir, 'diagnostics.sqlite');
  const options = { lockDirectory: join(dir, 'locks'), now: 0, clock: () => 2200 };
  let collector = new DiagnosticCollector(path, options);
  const startCommand = command('trace_start');
  const started = collector.startTrace(startCommand, startAuthority());
  assert.equal(started.status, 'accepted');
  assert.equal(collector.startTrace(startCommand, startAuthority()).status, 'replayed');
  expectCode('request_conflict', () => collector.endTrace(
    command('trace_end', {}, REQUESTS[0]),
    authority({ operation: 'trace_end', nowMs: 1500, traceId: TRACE,
      reason: 'host_stopped' }),
  ));

  const rotated = collector.rotateSegment(authority({
    operation: 'segment_rotate', nowMs: 2000, traceId: TRACE,
    priorLeaseId: LEASE, leaseId: LEASE_2, issuedSegmentId: SEGMENT_2,
  }));
  assert.equal(rotated.status, 'accepted');
  assert.equal(rotated.state.segment.segmentId, SEGMENT_2);
  const rotationReplay = collector.rotateSegment(authority({
    operation: 'segment_rotate', nowMs: 2100, traceId: TRACE,
    priorLeaseId: LEASE, leaseId: LEASE_2, issuedSegmentId: SEGMENT_2,
  }));
  assert.equal(rotationReplay.status, 'replayed');
  assert.equal(rotationReplay.state.segment.startedAtMs, 2000);

  const optCommand = command('consent_opt_in', {
    listenerInstanceId: INSTANCE, firstAllowedSequence: 0,
    localConsentStartedMs: 120,
  }, REQUESTS[1]);
  const optAuthority = authority({
    operation: 'consent_opt_in', nowMs: 2100, traceId: TRACE,
    listenerInstanceId: INSTANCE,
  });
  assert.equal(collector.optIn(optCommand, optAuthority).status, 'accepted');
  assert.equal(collector.consentReceiptContext(REQUESTS[1],'consent_opt_in').status,'found');
  assert.deepEqual(collector.consentReceiptContext(uuidFor(999),'consent_opt_in'),{
    status: 'receipt_absent',
  });
  const relayCommand = command('relay_bind', { relayGenerationId: INSTANCE }, REQUESTS[2]);
  const relayAuthority = authority({
    operation: 'relay_bind', traceId: TRACE, segmentId: SEGMENT_2,
    leaseId: LEASE_2, relayGenerationId: INSTANCE,
  });
  assert.equal(collector.bindRelay(relayCommand, relayAuthority).status, 'accepted');
  assert.equal(collector.relayReceiptContext(REQUESTS[2]).status,'found');
  assert.deepEqual(collector.relayReceiptContext(uuidFor(998)),{ status: 'receipt_absent' });
  assert.equal(collector.relayBindingContext(INSTANCE).status,'found');
  assert.deepEqual(collector.relayBindingContext(uuidFor(997)),{ status: 'binding_absent' });
  collector.close();

  collector = new DiagnosticCollector(path, { ...options, now: 2200 });
  assert.equal(collector.startTrace(startCommand, startAuthority()).status, 'replayed');
  assert.equal(collector.optIn(optCommand, optAuthority).status, 'replayed');
  assert.equal(collector.bindRelay(relayCommand, relayAuthority).status, 'replayed');
  assert.equal(collector.relayReceiptContext(REQUESTS[2]).receipt.requestId,REQUESTS[2]);
  assert.equal(collector.relayBindingContext(INSTANCE).binding.traceId,TRACE);
  const stopCommand = command('consent_stop', {
    listenerInstanceId: INSTANCE, expectedGeneration: 1,
  }, REQUESTS[3]);
  const stopAuthority = authority({
    operation: 'consent_stop', nowMs: 2300, traceId: TRACE,
    listenerInstanceId: INSTANCE,
  });
  assert.equal(collector.stopSharing(stopCommand, stopAuthority).status, 'accepted');
  assert.equal(collector.consentReceiptContext(REQUESTS[3],'consent_stop').status,'found');
  const endCommand = command('trace_end', {}, REQUESTS[4]);
  const endAuthority = authority({
    operation: 'trace_end', nowMs: 3000, traceId: TRACE, reason: 'host_stopped',
  });
  assert.equal(collector.endTrace(endCommand, endAuthority).status, 'accepted');
  assert.deepEqual(collector.validate(), {
    status: 'healthy', traceCount: 1, reportCount: 0, requestCount: 5,
    canonicalBytes: collector.validate().canonicalBytes,
  });
  collector.close();
  collector = new DiagnosticCollector(path, { ...options, now: 3100 });
  assert.equal(collector.stopSharing(stopCommand, stopAuthority).status, 'replayed');
  assert.equal(collector.endTrace(endCommand, endAuthority).status, 'replayed');
  collector.close();
});

test('startup requires a one-to-one relay binding and bind receipt relationship', () => {
  for (const missing of ['binding','receipt']) {
    const dir = workspace();
    const path = join(dir,`relay-${missing}.sqlite`);
    const lockDirectory = join(dir,'locks');
    let collector = new DiagnosticCollector(path,{ lockDirectory,now: 0,clock: () => 2200 });
    collector.startTrace(command('trace_start'),startAuthority());
    collector.bindRelay(command('relay_bind',{ relayGenerationId: INSTANCE },REQUESTS[2]),
      authority({
        operation: 'relay_bind',traceId: TRACE,segmentId: SEGMENT,
        leaseId: LEASE,relayGenerationId: INSTANCE,
    }));
    if (missing === 'binding') {
      const trigger = collector.db.prepare(`SELECT sql FROM sqlite_master
        WHERE type='trigger' AND name='diagnostic_relay_bindings_immutable_delete'`).get().sql;
      collector.db.exec('DROP TRIGGER diagnostic_relay_bindings_immutable_delete');
      collector.db.prepare('DELETE FROM diagnostic_relay_bindings WHERE relay_generation_id=?')
        .run(INSTANCE);
      collector.db.exec(trigger);
    } else {
      const row = collector.db.prepare(`SELECT length(canonical_receipt) AS bytes
        FROM diagnostic_requests WHERE request_id=?`).get(REQUESTS[2]);
      collector.db.prepare('DELETE FROM diagnostic_requests WHERE request_id=?').run(REQUESTS[2]);
      collector.db.prepare(`UPDATE diagnostic_store SET request_count=request_count-1,
        canonical_bytes=canonical_bytes-? WHERE singleton='diagnostics'`).run(row.bytes);
    }
    collector.close();
    expectCode('collector_degraded',() => {
      collector = new DiagnosticCollector(path,{ lockDirectory,now: 2200,clock: () => 2200 });
    });
  }

  const dir = workspace();
  const path = join(dir,'relay-duplicate-receipt.sqlite');
  const lockDirectory = join(dir,'locks');
  let collector = new DiagnosticCollector(path,{ lockDirectory,now: 0,clock: () => 2200 });
  collector.startTrace(command('trace_start'),startAuthority());
  const relayAuthority = authority({
    operation: 'relay_bind',traceId: TRACE,segmentId: SEGMENT,
    leaseId: LEASE,relayGenerationId: INSTANCE,
  });
  collector.bindRelay(command('relay_bind',{ relayGenerationId: INSTANCE },REQUESTS[2]),
    relayAuthority);
  const duplicateCommand = command('relay_bind',{ relayGenerationId: INSTANCE },uuidFor(996));
  const duplicate = bindRelayGeneration(
    collector.traceContext({ traceId: TRACE }).state,null,duplicateCommand,relayAuthority,
  );
  const commandBytes = canonicalE2OperationCommandBytes(duplicateCommand);
  const receiptBytes = canonicalE2OperationReceiptBytes(duplicate.receipt);
  const fingerprint = createHash('sha256').update(commandBytes).digest('hex');
  const trace = collector.traceContext({ traceId: TRACE }).state;
  collector.db.prepare(`INSERT INTO diagnostic_requests
    (request_id,trace_id,operation,fingerprint,canonical_receipt,accepted_at,expires_at)
    VALUES (?,?,?,?,?,?,?)`).run(
    duplicateCommand.requestId,TRACE,'relay_bind',fingerprint,Buffer.from(receiptBytes),2200,
    trace.expiresAtMs + 172_800_000,
  );
  collector.db.prepare(`UPDATE diagnostic_store SET request_count=request_count+1,
    canonical_bytes=canonical_bytes+? WHERE singleton='diagnostics'`).run(receiptBytes.byteLength);
  collector.close();
  expectCode('collector_degraded',() => {
    collector = new DiagnosticCollector(path,{ lockDirectory,now: 2200,clock: () => 2200 });
  });
});

test('trace context recovers exact current authority by trace or active run', () => {
  const dir = workspace();
  const path = join(dir,'trace-context.sqlite');
  const lockDirectory = join(dir,'locks');
  let now = 1200;
  let collector = new DiagnosticCollector(path,{
    lockDirectory,now: 0,clock: () => now,
  });
  const originalStart = collector.startTrace(command('trace_start'),startAuthority());
  collector.putIssuance(TRACE,issuance());
  const expected = {
    status: 'found',
    state: collector.traceContext({ traceId: TRACE }).state,
  };
  assert.equal(expected.state.traceId,TRACE);
  assert.equal(expected.state.runId,RUN);
  assert.equal(expected.state.segment.segmentId,SEGMENT);
  assert.equal(expected.state.segment.leaseId,LEASE);
  assert.deepEqual(collector.traceContext({ activeRunId: RUN }),expected);
  assert.deepEqual(collector.traceContext({ active: true }),expected);
  assert.deepEqual(collector.issuanceContext(SAMPLE,1200),{
    status: 'found',traceId: TRACE,issuance: issuance(),
  });
  assert.deepEqual(collector.traceContext({ activeRunId: SOURCE }),{
    status: 'trace_absent',
  });
  expectCode('request_invalid',() => collector.traceContext({}));
  expectCode('request_invalid',() => collector.traceContext({ active: 1 }));
  expectCode('request_invalid',() => collector.traceContext({ active: true,traceId: TRACE }));
  collector.close();

  collector = new DiagnosticCollector(path,{ lockDirectory,now,clock: () => now });
  assert.deepEqual(collector.traceContext({ activeRunId: RUN }),expected);
  assert.equal(collector.issuanceContext(SAMPLE,121004).status,'found');
  assert.deepEqual(collector.issuanceContext(SAMPLE,121005),{
    status: 'sample_absent',
  });
  now = 1000 + 21_600_000;
  assert.deepEqual(collector.traceContext({ activeRunId: RUN }),{
    status: 'trace_absent',
  });
  assert.deepEqual(collector.traceContext({ active: true }),{
    status: 'trace_absent',
  });
  const ended = collector.traceContext({ traceId: TRACE });
  assert.equal(ended.status,'found');
  assert.equal(ended.state.status,'ended');
  assert.equal(ended.state.ended.reason,'expired');
  const startReceipt = collector.traceStartReceiptContext(REQUESTS[0]);
  assert.equal(startReceipt.status,'found');
  assert.deepEqual(startReceipt.receipt,originalStart.receipt);
  assert.equal(startReceipt.receipt.result.status,'active');
  collector.close();
});

test('authority context validates retained selectors and binds issuance replay to its trace', () => {
  const dir = workspace();
  const path = join(dir,'context-authority.sqlite');
  const lockDirectory = join(dir,'locks');
  let collector = new DiagnosticCollector(path,{
    lockDirectory,now: 0,clock: () => 3500,
  });
  collector.startTrace(command('trace_start'),startAuthority());
  collector.putIssuance(TRACE,issuance());
  collector.endTrace(command('trace_end',{},REQUESTS[1]),authority({
    operation: 'trace_end',nowMs: 2000,traceId: TRACE,reason: 'host_stopped',
  }));
  const secondTrace = uuidFor(42);
  collector.startTrace(command('trace_start',{},REQUESTS[2]),startAuthority({
    nowMs: 3000,runId: SOURCE,leaseId: LEASE_2,issuedTraceId: secondTrace,
    issuedSegmentId: SEGMENT_2,
  }));
  expectCode('report_conflict',() => collector.putIssuance(secondTrace,issuance()));
  const moveTrigger = collector.db.prepare(`SELECT sql FROM sqlite_schema
    WHERE type='trigger' AND name='diagnostic_issuances_immutable_update'`).get().sql;
  collector.db.exec('DROP TRIGGER diagnostic_issuances_immutable_update');
  collector.db.prepare(`UPDATE diagnostic_issuances SET trace_id=? WHERE sample_id=?`)
    .run(secondTrace,SAMPLE);
  collector.db.exec(moveTrigger);
  collector.close();
  expectCode('collector_degraded',() => new DiagnosticCollector(path,{
    lockDirectory,now: 3500,clock: () => 3500,
  }));

  collector = new DiagnosticCollector(join(dir,'trace-corruption.sqlite'),{
    lockDirectory: join(dir,'trace-locks'),now: 0,clock: () => 1200,
  });
  collector.startTrace(command('trace_start'),startAuthority());
  const traceTrigger = collector.db.prepare(`SELECT sql FROM sqlite_schema
    WHERE type='trigger' AND name='diagnostic_traces_monotonic_update'`).get().sql;
  collector.db.exec('DROP TRIGGER diagnostic_traces_monotonic_update');
  collector.db.prepare(`UPDATE diagnostic_traces SET run_id=? WHERE trace_id=?`)
    .run(SOURCE,TRACE);
  collector.db.exec(traceTrigger);
  expectCode('collector_degraded',() => collector.traceContext({ activeRunId: RUN }));
  assert.equal(collector.status().status,'degraded');
  collector.close();

  collector = new DiagnosticCollector(join(dir,'issuance-corruption.sqlite'),{
    lockDirectory: join(dir,'issuance-locks'),now: 0,clock: () => 1200,
  });
  collector.startTrace(command('trace_start'),startAuthority());
  collector.putIssuance(TRACE,issuance());
  const issuanceTrigger = collector.db.prepare(`SELECT sql FROM sqlite_schema
    WHERE type='trigger' AND name='diagnostic_issuances_immutable_update'`).get().sql;
  collector.db.exec('DROP TRIGGER diagnostic_issuances_immutable_update');
  collector.db.prepare(`UPDATE diagnostic_issuances SET canonical_issuance=?
    WHERE sample_id=?`).run(json({
      sampleId: SAMPLE,timebaseId: TIMEBASE,instanceId: INSTANCE,
      serverReceiveMs: 1000,serverSendMs: 1006,
    }),SAMPLE);
  collector.db.exec(issuanceTrigger);
  expectCode('collector_degraded',() => collector.issuanceContext(SAMPLE,121005));
  assert.equal(collector.status().status,'degraded');
  collector.close();
});

test('all six report kinds ingest atomically and replay by E1 identity', () => {
  const dir = workspace();
  const path = join(dir, 'diagnostics.sqlite');
  const collector = new DiagnosticCollector(path, {
    lockDirectory: join(dir, 'locks'), now: 0, clock: () => 1200,
  });
  collector.startTrace(command('trace_start'), startAuthority());
  collector.putIssuance(TRACE, issuance());
  collector.optIn(command('consent_opt_in', {
    listenerInstanceId: INSTANCE, firstAllowedSequence: 0, localConsentStartedMs: 120,
  }, REQUESTS[1]), authority({
    operation: 'consent_opt_in', nowMs: 1100, traceId: TRACE,
    listenerInstanceId: INSTANCE,
  }));
  collector.bindRelay(command('relay_bind', { relayGenerationId: INSTANCE }, REQUESTS[2]),
    authority({ operation: 'relay_bind', traceId: TRACE, segmentId: SEGMENT,
      leaseId: LEASE, relayGenerationId: INSTANCE }));

  const kinds = ['listener_window', 'listener_transition', 'source_window',
    'source_transition', 'relay_window', 'relay_transition'];
  for (const [index, kind] of kinds.entries()) {
    const value = envelope(kind, index);
    const accepted = collector.ingestReport(value, {
      receivedAt: 2000 + index * 1100, grantGeneration: kind.startsWith('listener') ? 1 : null,
    });
    assert.equal(accepted.status, 'accepted');
    const replayed = collector.ingestReport(value, {
      receivedAt: 20_000, grantGeneration: null,
    });
    assert.equal(replayed.status, 'replayed');
    assert.equal(replayed.receivedAt, 2000 + index * 1100);
  }
  const retainedListener = collector.reportIdentityContext(TRACE,INSTANCE,0);
  assert.equal(retainedListener.status,'found');
  assert.equal(retainedListener.envelope.measurementCore.kind,'listener_window');
  assert.equal(retainedListener.receivedAt,2000);
  assert.deepEqual(collector.reportIdentityContext(TRACE,INSTANCE,99),{
    status: 'report_absent',
  });
  const changed = fixture('source_window', 2);
  changed.measurements.capturedFrames = 47_999;
  changed.measurements.enqueuedFrames = 47_999;
  changed.measurements.publishedFrames = 47_999;
  changed.measurements.publishedBytes = 191_996;
  assert.equal(collector.ingestReport(envelopeFromFixture(changed, 'source'), {
    receivedAt: 20_000,
  }).status, 'report_conflict');
  assert.equal(collector.validate().reportCount, 6);

  collector.db.exec(`CREATE TEMP TRIGGER fail_report BEFORE INSERT ON diagnostic_reports
    BEGIN SELECT RAISE(ABORT,'injected'); END`);
  expectCode('collector_degraded', () => collector.ingestReport(
    envelope('source_transition', 6), { receivedAt: 20_000 },
  ));
  assert.equal(collector.validate().reportCount, 6);
  collector.close();

  const reopened = new DiagnosticCollector(path, { lockDirectory: join(dir, 'locks'), now: 10_000 });
  assert.equal(reopened.validate().reportCount, 6);
  reopened.close();
});

test('automatic expiry is deterministic and prevents later ingestion', () => {
  const dir = workspace();
  const path = join(dir, 'diagnostics.sqlite');
  const options = { lockDirectory: join(dir, 'locks') };
  let collector = new DiagnosticCollector(path, { ...options, now: 0 });
  collector.startTrace(command('trace_start'), startAuthority());
  collector.close();
  collector = new DiagnosticCollector(path, { ...options, now: 21_601_999 });
  const row = collector.db.prepare('SELECT status,ended_at,active_expires_at,end_reason FROM diagnostic_traces').get();
  assert.deepEqual({ status: row.status, ended: row.ended_at, expiry: row.active_expires_at,
    reason: row.end_reason }, {
    status: 'ended', ended: 21_601_000, expiry: 21_601_000, reason: 'expired',
  });
  expectCode('stale_correlation', () => collector.startTrace(
    command('trace_start', {}, REQUESTS[3]), startAuthority(),
  ));
  collector.close();
});

test('fixed report and cleanup reservations enforce every exact quota boundary', () => {
  const baseline = {
    tracePeriodic: 23_999, traceTransitions: 5_999, globalReports: 89_999,
    traceBytes: DIAGNOSTIC_LIMITS.traceBytes - 4096,
    globalBytes: DIAGNOSTIC_LIMITS.globalBytes - 4096,
  };
  assert.equal(reportQuotaAllows(baseline, 'periodic', 4096), true);
  assert.equal(reportQuotaAllows({ ...baseline, tracePeriodic: 24_000 }, 'periodic', 1), false);
  assert.equal(reportQuotaAllows({ ...baseline, traceTransitions: 6000 }, 'transition', 1), false);
  assert.equal(reportQuotaAllows({ ...baseline, globalReports: 90_000 }, 'periodic', 1), false);
  assert.equal(reportQuotaAllows({ ...baseline,
    traceBytes: DIAGNOSTIC_LIMITS.traceBytes - 4095 }, 'periodic', 4096), false);
  assert.equal(reportQuotaAllows({ ...baseline,
    globalBytes: DIAGNOSTIC_LIMITS.globalBytes - 4095 }, 'periodic', 4096), false);
  assert.equal(requestQuotaAllows(4092, 3, false), true);
  assert.equal(requestQuotaAllows(4093, 3, false), false);
  assert.equal(requestQuotaAllows(4095, 99, true), true);
  assert.equal(requestQuotaAllows(4096, 0, true), false);
});

test('manual purge is whole-trace, tombstoned, replayable, and restart-safe', () => {
  const dir = workspace();
  const path = join(dir, 'diagnostics.sqlite');
  const options = { lockDirectory: join(dir, 'locks'), now: 0, clock: () => 4000,
    observePhysicalUsage: healthyPhysical };
  let collector = new DiagnosticCollector(path, options);
  collector.startTrace(command('trace_start'), startAuthority());
  collector.putIssuance(TRACE, issuance());
  collector.ingestReport(envelope('source_window', 0), { receivedAt: 2000 });
  const purgeRequestId = uuidFor(9000);
  const purge = json({ requestId: purgeRequestId, operation: 'trace_purge',
    parameters: { traceId: TRACE } });
  assert.equal(collector.purgeTrace(purge, 2500).status, 'trace_inactive');
  collector.endTrace(command('trace_end', {}, REQUESTS[4]), authority({
    operation: 'trace_end', nowMs: 3000, traceId: TRACE, reason: 'host_stopped',
  }));
  collector.db.exec(`CREATE TEMP TRIGGER fail_trace_purge BEFORE DELETE ON diagnostic_traces
    BEGIN SELECT RAISE(ABORT,'injected'); END`);
  expectCode('collector_degraded', () => collector.purgeTrace(purge, 4000));
  assert.equal(collector.validate().traceCount, 1);
  assert.equal(collector.validate().reportCount, 1);
  collector.db.exec('DROP TRIGGER fail_trace_purge');
  assert.deepEqual(collector.purgeTrace(purge, 4000), { status: 'purged', traceId: TRACE });
  assert.deepEqual(collector.purgeTrace(purge, 5000), { status: 'purged', traceId: TRACE });
  expectCode('stale_correlation', () => collector.startTrace(
    command('trace_start', {}, uuidFor(9001)), startAuthority({ nowMs: 5001 }),
  ));
  assert.throws(() => collector.db.prepare(`UPDATE diagnostic_request_tombstones
    SET created_at=created_at+1,expires_at=expires_at+1`).run(), /tombstone is immutable/);
  assert.equal(collector.validate().traceCount, 0);
  assert.deepEqual(collector.readTrace(json({ traceId: TRACE, cursor: null })), {
    status: 'trace_absent',
  });
  const counts = collector.validate();
  assert.equal(counts.traceCount, 0);
  assert.equal(counts.reportCount, 0);
  assert.equal(counts.requestCount, 3);
  collector.close();

  collector = new DiagnosticCollector(path, { ...options, now: 6000 });
  assert.equal(collector.validate().traceCount, 0);
  assert.deepEqual(collector.purgeTrace(purge, 6000), { status: 'purged', traceId: TRACE });
  collector.retentionSweep(4000 + 172_800_000);
  assert.equal(collector.validate().requestCount, 0);
  collector.close();
});

test('startup rejects an overlong purge tombstone lifetime', () => {
  const dir = workspace();
  const path = join(dir, 'diagnostics.sqlite');
  const lockDirectory = join(dir, 'locks');
  const collector = new DiagnosticCollector(path, {
    lockDirectory, now: 0, clock: () => 4000,
    observePhysicalUsage: healthyPhysical,
  });
  collector.startTrace(command('trace_start'), startAuthority());
  collector.endTrace(command('trace_end', {}, REQUESTS[4]), authority({
    operation: 'trace_end', nowMs: 3000, traceId: TRACE, reason: 'host_stopped',
  }));
  collector.purgeTrace(json({ requestId: uuidFor(9050), operation: 'trace_purge',
    parameters: { traceId: TRACE } }), 4000);
  collector.close();
  const raw = new DatabaseSync(path);
  raw.exec('PRAGMA ignore_check_constraints=ON');
  const trigger = raw.prepare(`SELECT sql FROM sqlite_schema WHERE type='trigger'
    AND name='diagnostic_request_tombstones_immutable_update'`).get().sql;
  raw.exec('DROP TRIGGER diagnostic_request_tombstones_immutable_update');
  raw.prepare(`UPDATE diagnostic_request_tombstones SET expires_at=expires_at+1`).run();
  raw.exec(trigger);
  raw.close();
  expectCode('collector_degraded', () => new DiagnosticCollector(path, {
    lockDirectory, now: 5000, observePhysicalUsage: healthyPhysical,
  }));
});

test('retention observes cutoff equality and removes at most one whole trace', () => {
  const dir = workspace();
  const path = join(dir, 'diagnostics.sqlite');
  const options = {
    lockDirectory: join(dir, 'locks'), now: 0, clock: () => 4000,
    observePhysicalUsage: healthyPhysical,
  };
  let collector = new DiagnosticCollector(path, options);
  collector.startTrace(command('trace_start'), startAuthority());
  collector.endTrace(command('trace_end', {}, REQUESTS[4]), authority({
    operation: 'trace_end', nowMs: 3000, traceId: TRACE, reason: 'host_stopped',
  }));
  assert.equal(collector.retentionSweep(172_802_999).removedTraceId, null);
  const secondTrace = uuidFor(9300);
  const secondRun = uuidFor(9301);
  const secondSegment = uuidFor(9302);
  const secondLease = uuidFor(9303);
  collector.startTrace(command('trace_start', {}, uuidFor(9304)), startAuthority({
    nowMs: 4000, runId: secondRun, leaseId: secondLease,
    issuedTraceId: secondTrace, issuedSegmentId: secondSegment,
  }));
  collector.endTrace(command('trace_end', {}, uuidFor(9305)), authority({
    operation: 'trace_end', nowMs: 5000, traceId: secondTrace, reason: 'host_stopped',
  }));
  collector.close();
  collector = new DiagnosticCollector(path, { ...options, now: 172_805_000 });
  assert.equal(collector.validate().traceCount, 1);
  assert.equal(collector.db.prepare('SELECT trace_id FROM diagnostic_traces').get().trace_id,
    secondTrace);
  assert.equal(collector.retentionSweep(172_805_000).removedTraceId, secondTrace);
  assert.equal(collector.validate().traceCount, 0);
  collector.close();
});

test('snapshot paging rejects cursor jumps and excludes later out-of-order rows', () => {
  const dir = workspace();
  const path = join(dir, 'diagnostics.sqlite');
  let now = 1000;
  const collector = new DiagnosticCollector(path, {
    lockDirectory: join(dir, 'locks'), now: 0, clock: () => now,
    observePhysicalUsage: healthyPhysical,
  });
  collector.startTrace(command('trace_start'), startAuthority());
  ingestSourceReports(collector, 257);

  const first = collector.readTrace(json({ traceId: TRACE, cursor: null }));
  assert.equal(first.status, 'found');
  assert.equal(first.complete, false);
  assert.equal(first.reports.length, 256);

  const laterRow = collector.db.prepare(`SELECT mapped_start_earliest AS mappedStartEarliestMs,
    mapped_end_latest AS mappedEndLatestMs,kind,instance_id AS instanceId,sequence
    FROM diagnostic_reports WHERE trace_id=? ORDER BY row_ordinal DESC LIMIT 1`).get(TRACE);
  const jumped = { readSessionId: first.cursor.readSessionId, last: laterRow };
  assert.equal(collector.readTrace(json({ traceId: TRACE, cursor: jumped })).status,
    'read_expired');
  assert.equal(collector.readTrace(json({ traceId: TRACE, cursor: first.cursor })).status,
    'read_expired');

  const stableFirst = collector.readTrace(json({ traceId: TRACE, cursor: null }));
  const lateInstance = uuidFor(9100);
  const late = dynamicSourceEnvelope(999, 0, lateInstance, 0);
  collector.putIssuance(TRACE, late.issuance);
  assert.equal(collector.ingestReport(late.envelope, { receivedAt: 100_000 }).status, 'accepted');
  const stableLast = collector.readTrace(json({ traceId: TRACE, cursor: stableFirst.cursor }));
  assert.equal(stableLast.status, 'found');
  assert.equal(stableLast.complete, true);
  assert.equal(stableLast.reports.length, 1);

  const current = collector.readTrace(json({ traceId: TRACE, cursor: null }));
  assert.equal(current.reports.length, 256);
  const currentLast = collector.readTrace(json({ traceId: TRACE, cursor: current.cursor }));
  assert.equal(currentLast.reports.length, 2);

  const expiring = [];
  for (let index = 0; index < 16; index += 1) {
    expiring.push(collector.readTrace(json({ traceId: TRACE, cursor: null })));
  }
  assert.equal(collector.readTrace(json({ traceId: TRACE, cursor: null })).status,
    'collector_busy');
  now += 300_001;
  assert.equal(collector.readTrace(json({ traceId: TRACE, cursor: expiring[0].cursor })).status,
    'read_expired');
  const purgedSession = collector.readTrace(json({ traceId: TRACE, cursor: null }));
  collector.endTrace(command('trace_end', {}, REQUESTS[4]), authority({
    operation: 'trace_end', nowMs: 400_000, traceId: TRACE, reason: 'host_stopped',
  }));
  collector.purgeTrace(json({ requestId: uuidFor(9400), operation: 'trace_purge',
    parameters: { traceId: TRACE } }), 400_001);
  assert.equal(collector.readTrace(json({ traceId: TRACE, cursor: purgedSession.cursor })).status,
    'read_expired');
  assert.equal(collector.validate().reportCount, 0);
  collector.close();
});

test('every read page revalidates canonical trace state before publishing', () => {
  const dir = workspace();
  const path = join(dir, 'diagnostics.sqlite');
  const lockDirectory = join(dir, 'locks');
  let collector = new DiagnosticCollector(path, {
    lockDirectory, now: 0, clock: () => 1000,
    observePhysicalUsage: healthyPhysical,
  });
  collector.startTrace(command('trace_start'), startAuthority());
  ingestSourceReports(collector, 257);
  const canonical = collector.db.prepare(`SELECT canonical_state FROM diagnostic_traces
    WHERE trace_id=?`).get(TRACE).canonical_state;
  collector.db.prepare(`UPDATE diagnostic_traces SET canonical_state=? WHERE trace_id=?`)
    .run(Buffer.from('{}'), TRACE);
  expectCode('collector_degraded', () => collector.readTrace(json({ traceId: TRACE, cursor: null })));
  collector.close();

  const repair = new DatabaseSync(path);
  repair.prepare(`UPDATE diagnostic_traces SET canonical_state=? WHERE trace_id=?`)
    .run(canonical, TRACE);
  repair.prepare(`UPDATE diagnostic_store SET mode='healthy',degraded_reason=NULL
    WHERE singleton='diagnostics'`).run();
  repair.close();
  collector = new DiagnosticCollector(path, {
    lockDirectory, now: 0, clock: () => 1000,
    observePhysicalUsage: healthyPhysical,
  });
  const first = collector.readTrace(json({ traceId: TRACE, cursor: null }));
  assert.equal(first.complete, false);
  assert.deepEqual(first.metadata, {
    traceId: TRACE, status: 'active', startedAtMs: 1000,
    endedAtMs: null, endReason: null, reportCount: 257,
  });
  collector.db.prepare(`UPDATE diagnostic_traces SET canonical_state=? WHERE trace_id=?`)
    .run(Buffer.from('{}'), TRACE);
  expectCode('collector_degraded', () => collector.readTrace(json({
    traceId: TRACE, cursor: first.cursor,
  })));
  collector.close();
});

test('read-time denormalized corruption durably degrades the disposable store', () => {
  const dir = workspace();
  const path = join(dir, 'diagnostics.sqlite');
  const lockDirectory = join(dir, 'locks');
  const collector = new DiagnosticCollector(path, {
    lockDirectory, now: 0, clock: () => 2000,
    observePhysicalUsage: healthyPhysical,
  });
  collector.startTrace(command('trace_start'), startAuthority());
  collector.putIssuance(TRACE, issuance());
  collector.ingestReport(envelope('source_window', 0), { receivedAt: 2000 });
  const triggerSql = collector.db.prepare(`SELECT sql FROM sqlite_schema
    WHERE type='trigger' AND name='diagnostic_reports_immutable_update'`).get().sql;
  collector.db.exec('DROP TRIGGER diagnostic_reports_immutable_update');
  collector.db.prepare(`UPDATE diagnostic_reports SET mapped_start_earliest=
    mapped_start_earliest+1 WHERE trace_id=?`).run(TRACE);
  collector.db.exec(triggerSql);
  expectCode('collector_degraded', () => collector.readTrace(json({
    traceId: TRACE, cursor: null,
  })));
  assert.deepEqual({ status: collector.status().status, reason: collector.status().reason }, {
    status: 'degraded', reason: 'retained_data_invalid',
  });
  collector.close();
  expectCode('collector_degraded', () => new DiagnosticCollector(path, {
    lockDirectory, now: 3000, observePhysicalUsage: healthyPhysical,
  }));
});

test('auxiliary trusted-state corruption becomes durable collector degradation', () => {
  const dir = workspace();
  const path = join(dir, 'diagnostics.sqlite');
  const lockDirectory = join(dir, 'locks');
  const collector = new DiagnosticCollector(path, {
    lockDirectory, now: 0, clock: () => 2000,
    observePhysicalUsage: healthyPhysical,
  });
  collector.startTrace(command('trace_start'), startAuthority());
  collector.putIssuance(TRACE, issuance());
  const trigger = collector.db.prepare(`SELECT sql FROM sqlite_schema
    WHERE type='trigger' AND name='diagnostic_issuances_immutable_update'`).get().sql;
  collector.db.exec('DROP TRIGGER diagnostic_issuances_immutable_update');
  collector.db.prepare(`UPDATE diagnostic_issuances SET canonical_issuance=?
    WHERE sample_id=?`).run(Buffer.from('{}'), SAMPLE);
  collector.db.exec(trigger);
  expectCode('collector_degraded', () => collector.readTrace(json({
    traceId: TRACE, cursor: null,
  })));
  assert.deepEqual({ status: collector.status().status, reason: collector.status().reason }, {
    status: 'degraded', reason: 'retained_data_invalid',
  });
  collector.close();
  expectCode('collector_degraded', () => new DiagnosticCollector(path, {
    lockDirectory, now: 3000, observePhysicalUsage: healthyPhysical,
  }));
});

test('a missing middle report ordinal cannot produce a complete projection', () => {
  const dir = workspace();
  const path = join(dir, 'diagnostics.sqlite');
  const collector = new DiagnosticCollector(path, {
    lockDirectory: join(dir, 'locks'), now: 0, clock: () => 5000,
    observePhysicalUsage: healthyPhysical,
  });
  collector.startTrace(command('trace_start'), startAuthority());
  collector.putIssuance(TRACE, issuance());
  for (let sequence = 0; sequence < 3; sequence += 1) {
    assert.equal(collector.ingestReport(envelope('source_window', sequence), {
      receivedAt: 2000 + sequence * 1000,
    }).status, 'accepted');
  }
  assert.throws(() => collector.db.prepare(`UPDATE diagnostic_traces
    SET report_revision=report_revision-1 WHERE trace_id=?`).run(TRACE),
  /trace authority is monotonic/);
  const removed = collector.db.prepare(`SELECT length(canonical_envelope) AS bytes
    FROM diagnostic_reports WHERE trace_id=? AND row_ordinal=2`).get(TRACE);
  const reportTrigger = collector.db.prepare(`SELECT sql FROM sqlite_schema
    WHERE type='trigger' AND name='diagnostic_reports_immutable_delete'`).get().sql;
  const traceTrigger = collector.db.prepare(`SELECT sql FROM sqlite_schema
    WHERE type='trigger' AND name='diagnostic_traces_monotonic_update'`).get().sql;
  collector.db.exec('DROP TRIGGER diagnostic_reports_immutable_delete');
  collector.db.exec('DROP TRIGGER diagnostic_traces_monotonic_update');
  collector.db.prepare(`DELETE FROM diagnostic_reports
    WHERE trace_id=? AND row_ordinal=2`).run(TRACE);
  collector.db.prepare(`UPDATE diagnostic_traces SET periodic_count=periodic_count-1,
    canonical_bytes=canonical_bytes-? WHERE trace_id=?`).run(removed.bytes, TRACE);
  collector.db.exec(reportTrigger);
  collector.db.exec(traceTrigger);
  collector.db.prepare(`UPDATE diagnostic_store SET report_count=report_count-1,
    canonical_bytes=canonical_bytes-? WHERE singleton='diagnostics'`).run(removed.bytes);
  expectCode('collector_degraded', () => collector.readTrace(json({
    traceId: TRACE, cursor: null,
  })));
  collector.close();
});

test('a pinned reader cannot make checkpoint state corrupt or unbounded', () => {
  const dir = workspace();
  const path = join(dir, 'diagnostics.sqlite');
  const collector = new DiagnosticCollector(path, {
    lockDirectory: join(dir, 'locks'), now: 0, clock: () => 2000,
    observePhysicalUsage: healthyPhysical,
  });
  collector.startTrace(command('trace_start'), startAuthority());
  const reader = new DatabaseSync(path, { readOnly: true });
  reader.exec('PRAGMA query_only=ON; BEGIN');
  reader.prepare('SELECT COUNT(*) FROM diagnostic_traces').get();
  collector.rotateSegment(authority({
    operation: 'segment_rotate', nowMs: 1500, traceId: TRACE,
    priorLeaseId: LEASE, leaseId: LEASE_2, issuedSegmentId: SEGMENT_2,
  }));
  const result = collector.retentionSweep(2000);
  assert.equal(typeof result.checkpoint.busy, 'number');
  assert.equal(typeof result.checkpoint.log, 'number');
  assert.equal(typeof result.checkpoint.checkpointed, 'number');
  assert.ok(result.checkpoint.log > result.checkpoint.checkpointed);
  assert.equal(collector.validate().traceCount, 1);
  reader.exec('ROLLBACK');
  reader.close();
  const completed = collector.retentionSweep(2000).checkpoint;
  assert.equal(completed.busy, 0);
  assert.equal(completed.log, completed.checkpointed);
  collector.close();
});

test('physical pressure rejects new effects but permits replay, end, purge, and recovery', () => {
  const dir = workspace();
  const path = join(dir, 'diagnostics.sqlite');
  let pressured = false;
  const observePhysicalUsage = () => pressured ? {
    physicalBytes: 256 * 1024 * 1024, hostFreeBytes: 2 * 1024 * 1024 * 1024,
    tempBytes: 0, logBytes: 0,
  } : healthyPhysical();
  const collector = new DiagnosticCollector(path, {
    lockDirectory: join(dir, 'locks'), now: 0, clock: () => 4000,
    observePhysicalUsage,
  });
  const startCommand = command('trace_start');
  collector.startTrace(startCommand, startAuthority());
  pressured = true;
  assert.equal(collector.startTrace(startCommand, startAuthority()).status, 'replayed');
  assert.equal(collector.rotateSegment(authority({
    operation: 'segment_rotate', nowMs: 2000, traceId: TRACE,
    priorLeaseId: LEASE, leaseId: LEASE, issuedSegmentId: SEGMENT_2,
  })).state.segment.segmentId, SEGMENT);
  expectCode('collector_degraded', () => collector.rotateSegment(authority({
    operation: 'segment_rotate', nowMs: 2000, traceId: TRACE,
    priorLeaseId: LEASE, leaseId: LEASE_2, issuedSegmentId: SEGMENT_2,
  })));
  assert.equal(collector.db.prepare(`SELECT COUNT(*) AS n FROM diagnostic_segments
    WHERE trace_id=?`).get(TRACE).n, 1);
  expectCode('collector_degraded', () => collector.putIssuance(TRACE, issuance()));
  assert.deepEqual(collector.status(), {
    status: 'degraded', reason: 'physical_limit', schemaGeneration: 1,
    traceCount: 1, reportCount: 0, requestCount: 1,
    canonicalBytes: collector.status().canonicalBytes,
  });
  collector.endTrace(command('trace_end', {}, REQUESTS[4]), authority({
    operation: 'trace_end', nowMs: 3000, traceId: TRACE, reason: 'host_stopped',
  }));
  const purge = json({ requestId: uuidFor(9200), operation: 'trace_purge',
    parameters: { traceId: TRACE } });
  assert.equal(collector.purgeTrace(purge, 4000).status, 'purged');
  pressured = false;
  assert.equal(collector.status().status, 'healthy');
  collector.close();
});

test('issuance expiry equality is rejected regardless of maintenance order', () => {
  for (const sweepFirst of [false, true]) {
    const dir = workspace();
    const collector = new DiagnosticCollector(join(dir, 'diagnostics.sqlite'), {
      lockDirectory: join(dir, 'locks'), now: 0, clock: () => 121_005,
      observePhysicalUsage: healthyPhysical,
    });
    collector.startTrace(command('trace_start'), startAuthority());
    collector.putIssuance(TRACE, issuance());
    if (sweepFirst) collector.retentionSweep(121_005);
    assert.equal(collector.ingestReport(envelope('source_window', 0), {
      receivedAt: 121_005,
    }).status, 'stale_correlation');
    collector.close();
  }
});

test('synthetic maximum trace stays within ordinary and cleanup WAL allowances', () => {
  const dir = workspace();
  const path = join(dir, 'diagnostics.sqlite');
  const collector = new DiagnosticCollector(path, {
    lockDirectory: join(dir, 'locks'), now: 0,
    observePhysicalUsage: healthyPhysical,
  });
  collector.startTrace(command('trace_start'), startAuthority());
  collector.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
  const reader = new DatabaseSync(path, { readOnly: true });
  reader.exec('BEGIN');
  reader.prepare('SELECT COUNT(*) FROM diagnostic_traces').get();
  const walBefore = fileBytes(`${path}-wal`);
  collector.db.exec('BEGIN IMMEDIATE');
  collector.db.prepare(`INSERT INTO diagnostic_reports
    (trace_id,instance_id,sequence,row_ordinal,segment_id,kind,bucket,received_at,
     mapped_start_earliest,mapped_end_latest,core_digest,envelope_digest,canonical_envelope)
    VALUES (?,?,?,?,?,'source_window','periodic',0,0,0,?,?,zeroblob(4096))`).run(
    TRACE, uuidFor(20_000), 0, 1, SEGMENT, '0'.repeat(64), '0'.repeat(64),
  );
  collector.db.exec('COMMIT');
  const ordinaryWalGrowth = fileBytes(`${path}-wal`) - walBefore;
  assert.ok(ordinaryWalGrowth <= 1024 * 1024, `ordinary WAL growth ${ordinaryWalGrowth}`);
  reader.exec('ROLLBACK');
  reader.close();
  collector.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();

  collector.db.exec('BEGIN IMMEDIATE');
  collector.db.prepare(`WITH RECURSIVE n(value) AS (
      SELECT 2 UNION ALL SELECT value+1 FROM n WHERE value<16384
    ) INSERT INTO diagnostic_reports
      (trace_id,instance_id,sequence,row_ordinal,segment_id,kind,bucket,received_at,
       mapped_start_earliest,mapped_end_latest,core_digest,envelope_digest,canonical_envelope)
    SELECT ?,printf('synthetic-%05d',value),value,value,?,'source_window','periodic',
      value,value,value,?, ?,zeroblob(4096) FROM n`).run(
    TRACE, SEGMENT, '0'.repeat(64), '0'.repeat(64),
  );
  collector.db.prepare(`UPDATE diagnostic_traces SET report_revision=16384,
    periodic_count=16384,canonical_bytes=67108864 WHERE trace_id=?`).run(TRACE);
  collector.db.prepare(`UPDATE diagnostic_store SET report_count=16384,
    canonical_bytes=canonical_bytes+67108864 WHERE singleton='diagnostics'`).run();
  collector.db.exec('COMMIT');
  collector.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
  const purgeReader = new DatabaseSync(path, { readOnly: true });
  purgeReader.exec('BEGIN');
  purgeReader.prepare('SELECT COUNT(*) FROM diagnostic_reports').get();
  const cleanupWalBefore = fileBytes(`${path}-wal`);
  collector.db.exec('BEGIN IMMEDIATE');
  collector.db.prepare('DELETE FROM diagnostic_traces WHERE trace_id=?').run(TRACE);
  collector.db.prepare(`UPDATE diagnostic_store SET trace_count=0,report_count=0,
    request_count=0,canonical_bytes=0 WHERE singleton='diagnostics'`).run();
  collector.db.exec('COMMIT');
  const cleanupWalGrowth = fileBytes(`${path}-wal`) - cleanupWalBefore;
  assert.ok(cleanupWalGrowth <= 128 * 1024 * 1024,
    `cleanup WAL growth ${cleanupWalGrowth}`);
  purgeReader.exec('ROLLBACK');
  purgeReader.close();
  collector.close();
});
