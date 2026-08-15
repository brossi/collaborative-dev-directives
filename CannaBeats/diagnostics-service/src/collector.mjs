import { createHash, randomUUID } from 'node:crypto';
import { existsSync, statfsSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import {
  bindRelayGeneration,
  canonicalConsentStateBytes,
  canonicalE2OperationCommandBytes,
  canonicalE2OperationReceiptBytes,
  canonicalRelayBindingBytes,
  canonicalSynchronizationIssuanceBytes,
  canonicalTraceStateBytes,
  canonicalUploadedEnvelopeBytes,
  classifyDiagnosticReportIngest,
  endDiagnosticTrace,
  expireDiagnosticTrace,
  optInDiagnosticSharing,
  restoreConsentStateFromTrustedStore,
  restoreE2OperationReceiptFromTrustedStore,
  restoreRelayBindingFromTrustedStore,
  restoreSynchronizationIssuanceFromTrustedStore,
  restoreTraceStateFromTrustedStore,
  restoreUploadedEnvelopeFromTrustedStore,
  rotateCorrelationSegment,
  startDiagnosticTrace,
  stopDiagnosticSharing,
  uploadedEnvelopeIdentity,
} from '../../web/lib/s2e-e2-correlation.mjs';
import { canonicalMeasurementBytes } from '../../web/lib/s2e-e1-contract.mjs';
import { closeDiagnosticStore, createDiagnosticStore } from './store.mjs';
import {
  canonicalPurgeCommandBytes,
  canonicalPurgeReceiptBytes,
  restorePurgeReceipt,
  validatePurgeCommandJson,
  validateReadRequestJson,
} from './contract.mjs';
import {
  DIAGNOSTIC_LIMITS,
  reportQuotaAllows,
  requestQuotaAllows,
} from './quota.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PHYSICAL_LIMIT = 256 * 1024 * 1024;
const HOST_RESERVE = 1024 * 1024 * 1024;
const READ_SESSION_LIMIT = 16;
const READ_SESSION_TTL = 300_000;

const bytes = (value) => Buffer.from(value.buffer, value.byteOffset, value.byteLength);
const digest = (value) => createHash('sha256').update(value).digest('hex');
const sameBytes = (left, right) => Buffer.compare(bytes(left), bytes(right)) === 0;

export class E7StoreError extends Error {
  constructor(code, cause, dataDegraded = false) {
    super(code, cause ? { cause } : undefined);
    this.name = 'E7StoreError';
    this.code = code;
    this.dataDegraded = dataDegraded;
  }
}

function fail(code, cause) {
  throw new E7StoreError(code, cause);
}

function dataFail(cause) {
  throw new E7StoreError('collector_degraded', cause, true);
}

function retained(action) {
  try {
    return action();
  } catch (error) {
    if (error instanceof E7StoreError) throw error;
    dataFail(error);
  }
}

function finiteTime(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)
    || value < 0 || value > Number.MAX_SAFE_INTEGER) fail('report_invalid');
  return value;
}

function validUuid(value) {
  return typeof value === 'string' && UUID.test(value)
    && value !== '00000000-0000-0000-0000-000000000000';
}

function canonicalStoredIssuanceBytes(traceId, issuance) {
  if (!validUuid(traceId)) fail('report_invalid');
  const canonical = bytes(canonicalSynchronizationIssuanceBytes(issuance));
  return Buffer.from(JSON.stringify({
    traceId,
    issuance: JSON.parse(canonical.toString('utf8')),
  }));
}

function restoreStoredIssuance(input) {
  const parsed = JSON.parse(bytes(input).toString('utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || Object.keys(parsed).length !== 2 || !Object.hasOwn(parsed, 'traceId')
    || !Object.hasOwn(parsed, 'issuance') || !validUuid(parsed.traceId)) {
    throw new Error('stored issuance is invalid');
  }
  const issuance = restoreSynchronizationIssuanceFromTrustedStore(
    Buffer.from(JSON.stringify(parsed.issuance)),
  );
  return { traceId: parsed.traceId, issuance };
}

function transaction(db, action) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const store = db.prepare(`SELECT mode FROM diagnostic_store
      WHERE singleton='diagnostics'`).get();
    if (store?.mode === 'data_degraded') fail('collector_degraded');
    const result = action();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    if (error?.dataDegraded) {
      try {
        db.exec('BEGIN IMMEDIATE');
        db.prepare(`UPDATE diagnostic_store SET mode='data_degraded',
          degraded_reason='retained_data_invalid' WHERE singleton='diagnostics'`).run();
        db.exec('COMMIT');
      } catch {
        if (db.isTransaction) db.exec('ROLLBACK');
      }
    }
    if (error instanceof E7StoreError
      || error?.name === 'E2ContractError' || error?.name === 'E7ContractError') throw error;
    fail('collector_degraded', error);
  }
}

function restoreTrace(row) {
  return row ? restoreTraceStateFromTrustedStore(row.canonical_state) : null;
}

function traceRow(db, traceId) {
  return db.prepare('SELECT * FROM diagnostic_traces WHERE trace_id=?').get(traceId);
}

function activeTraceRow(db) {
  return db.prepare("SELECT * FROM diagnostic_traces WHERE status='active'").get();
}

function restoreReceipt(row) {
  if (!row) return null;
  return row.operation === 'trace_purge'
    ? restorePurgeReceipt(row.canonical_receipt)
    : restoreE2OperationReceiptFromTrustedStore(row.canonical_receipt);
}

function observedFileBytes(path) {
  try {
    return existsSync(path) ? statSync(path).size : 0;
  } catch {
    return PHYSICAL_LIMIT;
  }
}

function defaultPhysicalObservation(databasePath) {
  const stats = statfsSync(dirname(databasePath));
  return {
    physicalBytes: observedFileBytes(databasePath)
      + observedFileBytes(`${databasePath}-wal`) + observedFileBytes(`${databasePath}-shm`),
    hostFreeBytes: stats.bavail * stats.bsize,
    tempBytes: 0,
    logBytes: 0,
  };
}

function physicalReason(observation) {
  if (!observation || !Number.isSafeInteger(observation.physicalBytes)
    || !Number.isSafeInteger(observation.hostFreeBytes)
    || !Number.isSafeInteger(observation.tempBytes)
    || !Number.isSafeInteger(observation.logBytes)
    || Object.values(observation).some((value) => value < 0)) return 'measurement_unavailable';
  if (observation.physicalBytes >= PHYSICAL_LIMIT) return 'physical_limit';
  if (observation.hostFreeBytes < HOST_RESERVE) return 'host_reserve';
  if (observation.tempBytes > 8 * 1024 * 1024) return 'temp_limit';
  if (observation.logBytes > 4 * 1024 * 1024) return 'log_limit';
  return null;
}

function requestLookup(db, command) {
  const commandBytes = canonicalE2OperationCommandBytes(command);
  const fingerprint = digest(commandBytes);
  const row = db.prepare('SELECT * FROM diagnostic_requests WHERE request_id=?')
    .get(command.requestId);
  if (!row) {
    const tombstone = db.prepare(`SELECT fingerprint FROM diagnostic_request_tombstones
      WHERE request_id=?`).get(command.requestId);
    if (!tombstone) return { receipt: null, fingerprint, commandBytes, tombstoned: false };
    if (tombstone.fingerprint !== fingerprint) fail('request_conflict');
    return { receipt: null, fingerprint, commandBytes, tombstoned: true };
  }
  if (row.fingerprint !== fingerprint) fail('request_conflict');
  return { receipt: restoreReceipt(row), fingerprint, commandBytes, tombstoned: false };
}

function persistTrace(db, state, { insert = false } = {}) {
  const stateBytes = bytes(canonicalTraceStateBytes(state));
  const ended = state.status === 'ended' ? state.ended : null;
  const purgeAfter = ended ? ended.endedAtMs + 172_800_000 : null;
  if (insert) {
    db.prepare(`INSERT INTO diagnostic_traces
      (trace_id,run_id,run_generation,status,started_at,active_expires_at,
       ended_at,end_reason,purge_after,current_segment_id,canonical_state)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
      state.traceId, state.runId, state.runGeneration, state.status,
      state.startedAtMs, state.expiresAtMs, ended?.endedAtMs ?? null,
      ended?.reason ?? null, purgeAfter, state.segment.segmentId, stateBytes,
    );
    db.prepare(`INSERT INTO diagnostic_segments
      (segment_id,trace_id,lease_id,started_at) VALUES (?,?,?,?)`).run(
      state.segment.segmentId, state.traceId, state.segment.leaseId,
      state.segment.startedAtMs,
    );
    db.prepare(`UPDATE diagnostic_store SET trace_count=trace_count+1
      WHERE singleton='diagnostics'`).run();
    return;
  }
  db.prepare(`UPDATE diagnostic_traces SET status=?,ended_at=?,end_reason=?,purge_after=?,
    current_segment_id=?,canonical_state=? WHERE trace_id=?`).run(
    state.status, ended?.endedAtMs ?? null, ended?.reason ?? null, purgeAfter,
    state.segment.segmentId, stateBytes, state.traceId,
  );
  if (ended) {
    db.prepare('UPDATE diagnostic_requests SET expires_at=? WHERE trace_id=?')
      .run(purgeAfter, state.traceId);
  }
}

function insertReceipt(db, traceId, command, fingerprint, receipt, acceptedAt, expiresAt) {
  const receiptBytes = bytes(canonicalE2OperationReceiptBytes(receipt));
  const store = db.prepare('SELECT request_count,canonical_bytes FROM diagnostic_store').get();
  const obligations = db.prepare(`SELECT
    (SELECT COUNT(*)*2 FROM diagnostic_traces WHERE status='active')
    +(SELECT COUNT(*) FROM diagnostic_traces WHERE status='ended')
    +(SELECT COUNT(*) FROM diagnostic_consents WHERE status='enabled') AS n`).get().n;
  const reducing = command.operation === 'trace_end' || command.operation === 'consent_stop';
  if (!requestQuotaAllows(store.request_count, obligations, reducing)
    || store.canonical_bytes + receiptBytes.byteLength > DIAGNOSTIC_LIMITS.globalBytes) {
    fail('quota_exhausted');
  }
  db.prepare(`INSERT INTO diagnostic_requests
    (request_id,trace_id,operation,fingerprint,canonical_receipt,accepted_at,expires_at)
    VALUES (?,?,?,?,?,?,?)`).run(
    command.requestId, traceId, command.operation, fingerprint, receiptBytes,
    acceptedAt, expiresAt,
  );
  db.prepare(`UPDATE diagnostic_store SET request_count=request_count+1,
    canonical_bytes=canonical_bytes+? WHERE singleton='diagnostics'`).run(receiptBytes.byteLength);
}

function expireActiveIfDue(db, now) {
  const row = activeTraceRow(db);
  if (!row) return null;
  const current = validateTraceAuthorityProjection(db,row);
  if (now < current.expiresAtMs) return row;
  const state = expireDiagnosticTrace(current);
  persistTrace(db, state);
  return null;
}

function exactIssuanceMatchesSample(issuance, sample) {
  return issuance.sampleId === sample.sampleId
    && issuance.instanceId === sample.instanceId
    && issuance.timebaseId === sample.timebaseId
    && issuance.serverReceiveMs === sample.serverReceiveMs
    && issuance.serverSendMs === sample.serverSendMs;
}

function canonicalPurgeResult(command) {
  return Object.freeze({ status: 'purged', traceId: command.parameters.traceId });
}

function purgeTraceRows(db, traceId, now) {
  const trace = traceRow(db, traceId);
  if (!trace) return null;
  const reports = db.prepare(`SELECT COUNT(*) AS count,
    COALESCE(SUM(length(canonical_envelope)),0) AS bytes
    FROM diagnostic_reports WHERE trace_id=?`).get(traceId);
  const issuances = db.prepare(`SELECT COALESCE(SUM(length(canonical_issuance)),0) AS bytes
    FROM diagnostic_issuances WHERE trace_id=?`).get(traceId);
  const requests = db.prepare(`SELECT request_id,fingerprint,length(canonical_receipt) AS bytes
    FROM diagnostic_requests WHERE trace_id=? AND operation<>'trace_purge'`).all(traceId);
  const requestBytes = requests.reduce((total, row) => total + row.bytes, 0);
  db.prepare(`DELETE FROM diagnostic_requests
    WHERE trace_id=? AND operation<>'trace_purge'`).run(traceId);
  const insertTombstone = db.prepare(`INSERT INTO diagnostic_request_tombstones
    (request_id,fingerprint,created_at,expires_at) VALUES (?,?,?,?)`);
  for (const request of requests) {
    insertTombstone.run(request.request_id, request.fingerprint, now, now + 172_800_000);
  }
  db.prepare('DELETE FROM diagnostic_traces WHERE trace_id=?').run(traceId);
  db.prepare(`UPDATE diagnostic_store SET trace_count=trace_count-1,
    report_count=report_count-?,canonical_bytes=canonical_bytes-?
    WHERE singleton='diagnostics'`).run(
    reports.count, reports.bytes + issuances.bytes + requestBytes,
  );
  return { reports: reports.count, requestCount: requests.length };
}

function tupleFromRow(row) {
  return Object.freeze({
    mappedStartEarliestMs: row.mapped_start_earliest,
    mappedEndLatestMs: row.mapped_end_latest,
    kind: row.kind,
    instanceId: row.instance_id,
    sequence: row.sequence,
  });
}

function sameTuple(left, right) {
  return left !== null && right !== null
    && left.mappedStartEarliestMs === right.mappedStartEarliestMs
    && left.mappedEndLatestMs === right.mappedEndLatestMs
    && left.kind === right.kind && left.instanceId === right.instanceId
    && left.sequence === right.sequence;
}

function snapshotDigest(rows) {
  const hash = createHash('sha256');
  for (const row of rows) hash.update(row.envelope_digest);
  return hash.digest('hex');
}

function validateTraceAuthorityProjection(db, trace) {
  let state;
  try {
    state = restoreTrace(trace);
  } catch (error) {
    dataFail(error);
  }
  const ended = state.status === 'ended' ? state.ended : null;
  if (state.traceId !== trace.trace_id || state.runId !== trace.run_id
    || state.runGeneration !== trace.run_generation || state.status !== trace.status
    || state.startedAtMs !== trace.started_at || state.expiresAtMs !== trace.active_expires_at
    || state.segment.segmentId !== trace.current_segment_id
    || !sameBytes(trace.canonical_state, canonicalTraceStateBytes(state))
    || (ended === null && (trace.ended_at !== null || trace.end_reason !== null
      || trace.purge_after !== null))
    || (ended !== null && (ended.endedAtMs !== trace.ended_at
      || ended.reason !== trace.end_reason
      || trace.purge_after !== trace.ended_at + 172_800_000))) dataFail();

  const currentSegment = db.prepare(`SELECT * FROM diagnostic_segments
    WHERE segment_id=? AND trace_id=?`).get(trace.current_segment_id,trace.trace_id);
  if (!currentSegment || !validUuid(currentSegment.segment_id)
    || !validUuid(currentSegment.trace_id) || !validUuid(currentSegment.lease_id)
    || currentSegment.lease_id !== state.segment.leaseId
    || currentSegment.started_at !== state.segment.startedAtMs
    || currentSegment.started_at < trace.started_at
    || currentSegment.started_at >= trace.active_expires_at) dataFail();
  return state;
}

function validateTraceProjection(db, trace) {
  const state = validateTraceAuthorityProjection(db,trace);

  const segments = db.prepare(`SELECT * FROM diagnostic_segments
    WHERE trace_id=? ORDER BY started_at,segment_id`).all(trace.trace_id);
  if (segments.length === 0 || segments.length > DIAGNOSTIC_LIMITS.traceSegments) dataFail();
  const segmentById = new Map();
  for (const segment of segments) {
    if (!validUuid(segment.segment_id) || !validUuid(segment.trace_id)
      || !validUuid(segment.lease_id) || segment.trace_id !== trace.trace_id
      || segment.started_at < trace.started_at || segment.started_at >= trace.active_expires_at) {
      dataFail();
    }
    segmentById.set(segment.segment_id, segment);
  }
  const currentSegment = segmentById.get(trace.current_segment_id);
  if (!currentSegment || currentSegment.lease_id !== state.segment.leaseId
    || currentSegment.started_at !== state.segment.startedAtMs) dataFail();
  const retainedSegments = new Set([trace.current_segment_id]);

  let issuanceBytes = 0;
  for (const row of db.prepare(`SELECT * FROM diagnostic_issuances
    WHERE trace_id=?`).all(trace.trace_id)) {
    const stored = retained(() => restoreStoredIssuance(row.canonical_issuance));
    const value = stored.issuance;
    if (value.sampleId !== row.sample_id || value.instanceId !== row.instance_id
      || stored.traceId !== row.trace_id
      || value.timebaseId !== row.timebase_id || value.serverReceiveMs !== row.server_receive_ms
      || value.serverSendMs !== row.server_send_ms
      || row.expires_at !== value.serverSendMs + 120_000
      || !sameBytes(row.canonical_issuance,
        retained(() => canonicalStoredIssuanceBytes(row.trace_id,value)))) {
      dataFail();
    }
    issuanceBytes += row.canonical_issuance.byteLength;
  }

  for (const row of db.prepare(`SELECT * FROM diagnostic_consents
    WHERE trace_id=?`).all(trace.trace_id)) {
    const value = retained(() => restoreConsentStateFromTrustedStore(row.canonical_state));
    if (value.traceId !== row.trace_id || value.listenerInstanceId !== row.listener_instance_id
      || value.generation !== row.generation || value.status !== row.status
      || value.firstAllowedSequence !== row.first_allowed_sequence
      || value.localConsentStartedMs !== row.local_consent_started_ms
      || value.changedAtMs !== row.changed_at
      || !sameBytes(row.canonical_state,
        retained(() => canonicalConsentStateBytes(value)))) dataFail();
  }

  for (const row of db.prepare(`SELECT * FROM diagnostic_relay_bindings
    WHERE trace_id=?`).all(trace.trace_id)) {
    const value = retained(() => restoreRelayBindingFromTrustedStore(row.canonical_state));
    const segment = segmentById.get(row.segment_id);
    if (value.relayGenerationId !== row.relay_generation_id
      || value.traceId !== row.trace_id || value.segmentId !== row.segment_id
      || value.leaseId !== row.lease_id || !segment || segment.lease_id !== row.lease_id
      || !sameBytes(row.canonical_state,
        retained(() => canonicalRelayBindingBytes(value)))) dataFail();
    retainedSegments.add(row.segment_id);
  }

  const rows = db.prepare(`SELECT * FROM diagnostic_reports WHERE trace_id=?
    ORDER BY mapped_start_earliest,mapped_end_latest,kind,instance_id,sequence`)
    .all(trace.trace_id);
  let periodic = 0;
  let transitions = 0;
  let canonicalBytes = 0;
  let maxOrdinal = 0;
  for (const row of rows) {
    let envelope;
    try {
      envelope = restoreUploadedEnvelopeFromTrustedStore(row.canonical_envelope);
    } catch (error) {
      dataFail(error);
    }
    const core = envelope.measurementCore;
    const context = envelope.serverContext;
    const canonical = canonicalUploadedEnvelopeBytes(envelope);
    const segment = segmentById.get(row.segment_id);
    if (context.traceId !== trace.trace_id || core.instanceId !== row.instance_id
      || core.sequence !== row.sequence || core.kind !== row.kind
      || context.correlationSegmentId !== row.segment_id
      || row.bucket !== (core.kind.endsWith('_window') ? 'periodic' : 'transition')
      || !segment || segment.lease_id !== context.leaseId
      || digest(canonicalMeasurementBytes(core)) !== row.core_digest
      || digest(canonical) !== row.envelope_digest
      || !sameBytes(row.canonical_envelope, canonical)
      || envelope.alignment.mappedStartEarliestMs !== row.mapped_start_earliest
      || envelope.alignment.mappedEndLatestMs !== row.mapped_end_latest) dataFail();
    row.envelope = envelope;
    retainedSegments.add(row.segment_id);
    periodic += row.bucket === 'periodic' ? 1 : 0;
    transitions += row.bucket === 'transition' ? 1 : 0;
    canonicalBytes += canonical.byteLength;
    maxOrdinal = Math.max(maxOrdinal, row.row_ordinal);
  }
  const ordinals = rows.map((row) => row.row_ordinal).sort((left, right) => left - right);
  if (periodic !== trace.periodic_count || transitions !== trace.transition_count
    || canonicalBytes !== trace.canonical_bytes || maxOrdinal !== trace.report_revision
    || trace.report_revision !== rows.length
    || ordinals.some((ordinal, index) => ordinal !== index + 1)
    || rows.length !== periodic + transitions
    || segments.some((segment) => !retainedSegments.has(segment.segment_id))) dataFail();

  return {
    state, rows, reportBytes: canonicalBytes, issuanceBytes,
    metadata: Object.freeze({
      traceId: trace.trace_id,
      status: trace.status,
      startedAtMs: trace.started_at,
      endedAtMs: trace.ended_at,
      endReason: trace.end_reason,
      reportCount: rows.length,
    }),
  };
}

export class DiagnosticCollector {
  constructor(path, options = {}) {
    this.clock = options.clock ?? Date.now;
    this.databasePath = resolve(path);
    this.observePhysicalUsage = options.observePhysicalUsage
      ?? (() => defaultPhysicalObservation(this.databasePath));
    this.readSessions = new Map();
    this.db = createDiagnosticStore(path, options);
    try {
      this.validate();
      this.retentionSweep(options.now ?? this.clock());
    } catch (error) {
      if (error instanceof E7StoreError && error.code === 'collector_degraded') {
        try {
          transaction(this.db, () => this.db.prepare(`UPDATE diagnostic_store
            SET mode='data_degraded',degraded_reason='retained_data_invalid'
            WHERE singleton='diagnostics'`).run());
        } catch {}
      }
      closeDiagnosticStore(this.db);
      throw error;
    }
  }

  close() {
    if (!this.db) return;
    const db = this.db;
    this.db = null;
    this.readSessions.clear();
    closeDiagnosticStore(db);
  }

  #assertPhysicalAdmission() {
    let observation;
    try {
      observation = this.observePhysicalUsage();
    } catch {
      fail('collector_degraded');
    }
    if (physicalReason(observation)) fail('collector_degraded');
  }

  traceContext(locator = {}) {
    if (!locator || typeof locator !== 'object' || Array.isArray(locator)) {
      fail('request_invalid');
    }
    const keys = Object.keys(locator);
    const key = keys[0];
    if (keys.length !== 1 || !['traceId', 'activeRunId', 'active'].includes(key)
      || (key === 'active'
        ? locator.active !== true
        : typeof locator[key] !== 'string' || !UUID.test(locator[key]))) {
      fail('request_invalid');
    }
    const traceId = key === 'traceId' ? locator.traceId : null;
    const activeRunId = key === 'activeRunId' ? locator.activeRunId : null;
    return transaction(this.db, () => {
      expireActiveIfDue(this.db, this.clock());
      const row = traceId === null ? activeTraceRow(this.db) : traceRow(this.db,traceId);
      if (!row) {
        return { status: 'trace_absent' };
      }
      const state = validateTraceAuthorityProjection(this.db,row);
      if (activeRunId !== null && state.runId !== activeRunId) {
        return { status: 'trace_absent' };
      }
      return { status: 'found',state };
    });
  }

  issuanceContext(sampleId, now = this.clock()) {
    if (!UUID.test(sampleId) || !Number.isSafeInteger(now) || now < 0) {
      fail('request_invalid');
    }
    return transaction(this.db, () => {
      const row = this.db.prepare(`SELECT * FROM diagnostic_issuances
        WHERE sample_id=?`).get(sampleId);
      if (!row) return { status: 'sample_absent' };
      const stored = retained(() => restoreStoredIssuance(row.canonical_issuance));
      const issuance = stored.issuance;
      if (issuance.sampleId !== row.sample_id || issuance.instanceId !== row.instance_id
        || stored.traceId !== row.trace_id
        || issuance.timebaseId !== row.timebase_id
        || issuance.serverReceiveMs !== row.server_receive_ms
        || issuance.serverSendMs !== row.server_send_ms
        || row.expires_at !== issuance.serverSendMs + 120_000
        || !sameBytes(row.canonical_issuance,
          retained(() => canonicalStoredIssuanceBytes(row.trace_id,issuance)))) dataFail();
      if (now >= row.expires_at) return { status: 'sample_absent' };
      return {
        status: 'found',
        traceId: row.trace_id,
        issuance,
      };
    });
  }

  traceStartReceiptContext(requestId) {
    if (!validUuid(requestId)) fail('request_invalid');
    return transaction(this.db, () => {
      const row = this.db.prepare(`SELECT * FROM diagnostic_requests
        WHERE request_id=? AND operation='trace_start'`).get(requestId);
      if (!row) return { status: 'trace_absent' };
      const receipt = retained(() => restoreReceipt(row));
      if (receipt.requestId !== row.request_id || receipt.operation !== 'trace_start'
        || receipt.result.traceId !== row.trace_id
        || !sameBytes(row.canonical_receipt,
          retained(() => canonicalE2OperationReceiptBytes(receipt)))) dataFail();
      return { status: 'found',receipt };
    });
  }

  startTrace(command, authority) {
    return transaction(this.db, () => {
      expireActiveIfDue(this.db, authority.nowMs);
      const lookup = requestLookup(this.db, command);
      if (lookup.tombstoned) return { status: 'trace_absent' };
      if (this.db.prepare(`SELECT 1 FROM diagnostic_requests
        WHERE operation='trace_purge' AND trace_id=? LIMIT 1`).get(authority.issuedTraceId)) {
        fail('stale_correlation');
      }
      const current = restoreTrace(activeTraceRow(this.db));
      const outcome = startDiagnosticTrace(current, command, authority, lookup.receipt);
      if (outcome.status === 'replayed' || outcome.status === 'trace_busy') return outcome;
      this.#assertPhysicalAdmission();
      if (traceRow(this.db, outcome.state.traceId)) fail('stale_correlation');
      const count = this.db.prepare('SELECT trace_count FROM diagnostic_store').get().trace_count;
      if (count >= 32) fail('quota_exhausted');
      persistTrace(this.db, outcome.state, { insert: true });
      insertReceipt(this.db, outcome.state.traceId, command, lookup.fingerprint,
        outcome.receipt, authority.nowMs, outcome.state.expiresAtMs + 172_800_000);
      return outcome;
    });
  }

  endTrace(command, authority) {
    return transaction(this.db, () => {
      const lookup = requestLookup(this.db, command);
      if (lookup.tombstoned) return { status: 'trace_absent' };
      if (lookup.receipt) {
        return endDiagnosticTrace(null, command, authority, lookup.receipt);
      }
      expireActiveIfDue(this.db, authority.nowMs);
      const current = restoreTrace(traceRow(this.db, authority.traceId));
      const outcome = endDiagnosticTrace(current, command, authority);
      persistTrace(this.db, outcome.state);
      insertReceipt(this.db, outcome.state.traceId, command, lookup.fingerprint,
        outcome.receipt, outcome.state.ended.endedAtMs,
        outcome.state.ended.endedAtMs + 172_800_000);
      return outcome;
    });
  }

  rotateSegment(authority) {
    return transaction(this.db, () => {
      expireActiveIfDue(this.db, authority.nowMs);
      const current = restoreTrace(traceRow(this.db, authority.traceId));
      const next = rotateCorrelationSegment(current, authority);
      if (next === current) return { status: 'replayed',state: next };
      this.#assertPhysicalAdmission();
      const segmentCount = this.db.prepare(`SELECT COUNT(*) AS n
        FROM diagnostic_segments WHERE trace_id=?`).get(next.traceId).n;
      if (segmentCount >= DIAGNOSTIC_LIMITS.traceSegments) fail('quota_exhausted');
      const priorSegmentId = current.segment.segmentId;
      this.db.prepare(`INSERT INTO diagnostic_segments
        (segment_id,trace_id,lease_id,started_at) VALUES (?,?,?,?)`).run(
        next.segment.segmentId, next.traceId, next.segment.leaseId, next.segment.startedAtMs,
      );
      persistTrace(this.db, next);
      this.db.prepare(`DELETE FROM diagnostic_segments WHERE segment_id=?
        AND NOT EXISTS (SELECT 1 FROM diagnostic_reports WHERE segment_id=?)
        AND NOT EXISTS (SELECT 1 FROM diagnostic_relay_bindings WHERE segment_id=?)`)
        .run(priorSegmentId, priorSegmentId, priorSegmentId);
      return { status: 'accepted',state: next };
    });
  }

  putIssuance(traceId, issuance) {
    return transaction(this.db, () => {
      const canonical = canonicalStoredIssuanceBytes(traceId,issuance);
      const restored = restoreStoredIssuance(canonical).issuance;
      if (restored.sampleId !== issuance.sampleId) fail('report_invalid');
      const existing = this.db.prepare(`SELECT trace_id,canonical_issuance
        FROM diagnostic_issuances
        WHERE sample_id=?`).get(issuance.sampleId);
      if (existing) {
        if (existing.trace_id !== traceId
          || !sameBytes(existing.canonical_issuance, canonical)) fail('report_conflict');
        return 'replayed';
      }
      this.#assertPhysicalAdmission();
      expireActiveIfDue(this.db, this.clock());
      const trace = traceRow(this.db, traceId);
      if (!trace || trace.status !== 'active') fail('trace_inactive');
      const store = this.db.prepare('SELECT canonical_bytes FROM diagnostic_store').get();
      if (store.canonical_bytes + canonical.byteLength > DIAGNOSTIC_LIMITS.globalBytes) {
        fail('quota_exhausted');
      }
      this.db.prepare(`INSERT INTO diagnostic_issuances
        (sample_id,trace_id,instance_id,timebase_id,server_receive_ms,server_send_ms,
         expires_at,canonical_issuance) VALUES (?,?,?,?,?,?,?,?)`).run(
        issuance.sampleId, traceId, issuance.instanceId, issuance.timebaseId,
        issuance.serverReceiveMs, issuance.serverSendMs,
        issuance.serverSendMs + 120_000, canonical,
      );
      this.db.prepare(`UPDATE diagnostic_store SET canonical_bytes=canonical_bytes+?
        WHERE singleton='diagnostics'`).run(canonical.byteLength);
      return 'accepted';
    });
  }

  #consentOperation(reducer, command, authority) {
    return transaction(this.db, () => {
      expireActiveIfDue(this.db, authority.nowMs);
      const lookup = requestLookup(this.db, command);
      if (lookup.tombstoned) return { status: 'trace_absent' };
      const row = this.db.prepare(`SELECT canonical_state FROM diagnostic_consents
        WHERE trace_id=? AND listener_instance_id=?`).get(
        authority.traceId, authority.listenerInstanceId,
      );
      const current = row ? restoreConsentStateFromTrustedStore(row.canonical_state) : null;
      const outcome = reducer(current, command, authority, lookup.receipt);
      if (outcome.status === 'replayed') return outcome;
      if (command.operation === 'consent_opt_in') this.#assertPhysicalAdmission();
      if (!traceRow(this.db, outcome.state.traceId)) fail('trace_inactive');
      const canonical = bytes(canonicalConsentStateBytes(outcome.state));
      this.db.prepare(`INSERT INTO diagnostic_consents
        (trace_id,listener_instance_id,generation,status,first_allowed_sequence,
         local_consent_started_ms,changed_at,canonical_state) VALUES (?,?,?,?,?,?,?,?)
        ON CONFLICT(trace_id,listener_instance_id) DO UPDATE SET
          generation=excluded.generation,status=excluded.status,
          first_allowed_sequence=excluded.first_allowed_sequence,
          local_consent_started_ms=excluded.local_consent_started_ms,
          changed_at=excluded.changed_at,canonical_state=excluded.canonical_state`).run(
        outcome.state.traceId, outcome.state.listenerInstanceId, outcome.state.generation,
        outcome.state.status, outcome.state.firstAllowedSequence,
        outcome.state.localConsentStartedMs, outcome.state.changedAtMs, canonical,
      );
      insertReceipt(this.db, outcome.state.traceId, command, lookup.fingerprint,
        outcome.receipt, authority.nowMs,
        traceRow(this.db, outcome.state.traceId).active_expires_at + 172_800_000);
      return outcome;
    });
  }

  optIn(command, authority) {
    return this.#consentOperation(optInDiagnosticSharing, command, authority);
  }

  stopSharing(command, authority) {
    return this.#consentOperation(stopDiagnosticSharing, command, authority);
  }

  bindRelay(command, authority) {
    return transaction(this.db, () => {
      const lookup = requestLookup(this.db, command);
      if (lookup.tombstoned) return { status: 'trace_absent' };
      const acceptedAt = this.clock();
      expireActiveIfDue(this.db, acceptedAt);
      const currentTrace = restoreTrace(traceRow(this.db, authority.traceId));
      const row = this.db.prepare(`SELECT canonical_state FROM diagnostic_relay_bindings
        WHERE relay_generation_id=?`).get(authority.relayGenerationId);
      const binding = row ? restoreRelayBindingFromTrustedStore(row.canonical_state) : null;
      const outcome = bindRelayGeneration(
        currentTrace, binding, command, authority, lookup.receipt,
      );
      if (outcome.status === 'replayed') return outcome;
      this.#assertPhysicalAdmission();
      const canonical = bytes(canonicalRelayBindingBytes(outcome.state));
      this.db.prepare(`INSERT INTO diagnostic_relay_bindings
        (relay_generation_id,trace_id,segment_id,lease_id,canonical_state)
        VALUES (?,?,?,?,?)`).run(
        outcome.state.relayGenerationId, outcome.state.traceId,
        outcome.state.segmentId, outcome.state.leaseId, canonical,
      );
      const trace = traceRow(this.db, outcome.state.traceId);
      insertReceipt(this.db, outcome.state.traceId, command, lookup.fingerprint,
        outcome.receipt, acceptedAt, trace.active_expires_at + 172_800_000);
      return outcome;
    });
  }

  ingestReport(incomingEnvelope, { receivedAt, grantGeneration = null } = {}) {
    finiteTime(receivedAt);
    return transaction(this.db, () => {
      const canonical = bytes(canonicalUploadedEnvelopeBytes(incomingEnvelope));
      const { measurementCore: core, alignment, serverContext: context } = incomingEnvelope;
      const existingRow = this.db.prepare(`SELECT * FROM diagnostic_reports
        WHERE trace_id=? AND instance_id=? AND sequence=?`).get(
        context.traceId, core.instanceId, core.sequence,
      );
      const existingEnvelope = existingRow
        ? restoreUploadedEnvelopeFromTrustedStore(existingRow.canonical_envelope) : null;
      let consent = null;
      if (context.authorityKind === 'listener') {
        const row = this.db.prepare(`SELECT canonical_state FROM diagnostic_consents
          WHERE trace_id=? AND listener_instance_id=?`).get(context.traceId, core.instanceId);
        consent = row ? restoreConsentStateFromTrustedStore(row.canonical_state) : null;
      }
      const decision = classifyDiagnosticReportIngest({
        existingEnvelope, incomingEnvelope, consent, grantGeneration,
      });
      if (decision === 'replayed') {
        return { status: 'replayed', envelope: existingEnvelope, receivedAt: existingRow.received_at };
      }
      if (decision !== 'accepted') return { status: decision };
      this.#assertPhysicalAdmission();
      expireActiveIfDue(this.db, receivedAt);
      const trace = traceRow(this.db, context.traceId);
      if (!trace || trace.status !== 'active' || receivedAt >= trace.active_expires_at) {
        return { status: 'trace_inactive' };
      }
      if (trace.run_id !== context.runId || trace.run_generation !== context.runGeneration) {
        return { status: 'stale_correlation' };
      }
      const segment = this.db.prepare(`SELECT lease_id FROM diagnostic_segments
        WHERE trace_id=? AND segment_id=?`).get(context.traceId, context.correlationSegmentId);
      if (!segment || segment.lease_id !== context.leaseId) return { status: 'stale_correlation' };
      const issuanceRow = this.db.prepare(`SELECT * FROM diagnostic_issuances
        WHERE sample_id=? AND trace_id=?`).get(alignment.sample.sampleId, context.traceId);
      if (!issuanceRow || receivedAt >= issuanceRow.expires_at) {
        return { status: 'stale_correlation' };
      }
      const storedIssuance = retained(() => restoreStoredIssuance(
        issuanceRow.canonical_issuance,
      ));
      const issuance = storedIssuance.issuance;
      if (storedIssuance.traceId !== issuanceRow.trace_id
        || !sameBytes(issuanceRow.canonical_issuance,
          retained(() => canonicalStoredIssuanceBytes(issuanceRow.trace_id,issuance)))) {
        dataFail();
      }
      if (!exactIssuanceMatchesSample(issuance, alignment.sample)) {
        return { status: 'stale_correlation' };
      }
      if (context.authorityKind === 'relay') {
        const binding = this.db.prepare(`SELECT trace_id,segment_id,lease_id
          FROM diagnostic_relay_bindings WHERE relay_generation_id=?`)
          .get(context.relayGenerationId);
        if (!binding || binding.trace_id !== context.traceId
          || binding.segment_id !== context.correlationSegmentId
          || binding.lease_id !== context.leaseId) return { status: 'stale_correlation' };
      }
      if (context.authorityKind === 'listener') {
        const prior = this.db.prepare(`SELECT received_at FROM diagnostic_reports
          WHERE trace_id=? AND instance_id=? ORDER BY row_ordinal DESC LIMIT 1`)
          .get(context.traceId, core.instanceId);
        if (prior && receivedAt - prior.received_at < 1000) return { status: 'rate_limited' };
      }
      const bucket = core.kind.endsWith('_window') ? 'periodic' : 'transition';
      const store = this.db.prepare(`SELECT report_count,canonical_bytes
        FROM diagnostic_store WHERE singleton='diagnostics'`).get();
      if (!reportQuotaAllows({
        tracePeriodic: trace.periodic_count,
        traceTransitions: trace.transition_count,
        globalReports: store.report_count,
        traceBytes: trace.canonical_bytes,
        globalBytes: store.canonical_bytes,
      }, bucket, canonical.byteLength)) {
        return { status: 'quota_exhausted' };
      }
      const ordinal = trace.report_revision + 1;
      const coreBytes = canonicalMeasurementBytes(core);
      this.db.prepare(`INSERT INTO diagnostic_reports
        (trace_id,instance_id,sequence,row_ordinal,segment_id,kind,bucket,received_at,
         mapped_start_earliest,mapped_end_latest,core_digest,envelope_digest,
         canonical_envelope) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        context.traceId, core.instanceId, core.sequence, ordinal,
        context.correlationSegmentId, core.kind, bucket,
        receivedAt, alignment.mappedStartEarliestMs, alignment.mappedEndLatestMs,
        digest(coreBytes), digest(canonical), canonical,
      );
      const counter = bucket === 'periodic' ? 'periodic_count' : 'transition_count';
      this.db.prepare(`UPDATE diagnostic_traces SET report_revision=?,${counter}=${counter}+1,
        canonical_bytes=canonical_bytes+? WHERE trace_id=?`).run(
        ordinal, canonical.byteLength, context.traceId,
      );
      this.db.prepare(`UPDATE diagnostic_store SET report_count=report_count+1,
        canonical_bytes=canonical_bytes+? WHERE singleton='diagnostics'`).run(canonical.byteLength);
      return { status: 'accepted', envelope: incomingEnvelope, receivedAt };
    });
  }

  #invalidateTraceSessions(traceId) {
    for (const [id, session] of this.readSessions) {
      if (session.traceId === traceId) this.readSessions.delete(id);
    }
  }

  #validatedSnapshot(traceId, maxRowOrdinal = null) {
    if (this.db.prepare('PRAGMA foreign_key_check').all().length !== 0) dataFail();
    const trace = traceRow(this.db, traceId);
    if (!trace) return null;
    const projection = validateTraceProjection(this.db, trace);
    const limit = maxRowOrdinal ?? trace.report_revision;
    const allRows = projection.rows;
    const rows = allRows.filter((row) => row.row_ordinal <= limit);
    const expectedCount = this.db.prepare(`SELECT COUNT(*) AS n FROM diagnostic_reports
      WHERE trace_id=? AND row_ordinal<=?`).get(traceId, limit).n;
    if (rows.length !== expectedCount) dataFail();
    return {
      trace,
      metadata: projection.metadata,
      maxRowOrdinal: limit,
      rows,
      digest: snapshotDigest(rows),
      traceStateDigest: digest(trace.canonical_state),
    };
  }

  readTrace(input) {
    const request = validateReadRequestJson(input);
    const now = this.clock();
    for (const [id, session] of this.readSessions) {
      if (session.expiresAt <= now) this.readSessions.delete(id);
    }
    return transaction(this.db, () => {
      expireActiveIfDue(this.db, now);
      if (request.cursor === null) {
        const snapshot = this.#validatedSnapshot(request.traceId);
        if (!snapshot) return { status: 'trace_absent' };
        const pageRows = snapshot.rows.slice(0, 256);
        const reports = pageRows.map((row) => row.envelope);
        if (snapshot.rows.length <= 256) {
          return { status: 'found', complete: true, metadata: snapshot.metadata,
            reports, cursor: null };
        }
        if (this.readSessions.size >= READ_SESSION_LIMIT) {
          return { status: 'collector_busy' };
        }
        const readSessionId = randomUUID();
        const expectedLast = tupleFromRow(pageRows.at(-1));
        this.readSessions.set(readSessionId, {
          traceId: request.traceId,
          maxRowOrdinal: snapshot.maxRowOrdinal,
          reportCount: snapshot.rows.length,
          digest: snapshot.digest,
          traceStateDigest: snapshot.traceStateDigest,
          metadata: snapshot.metadata,
          expectedLast,
          nextIndex: 256,
          expiresAt: now + READ_SESSION_TTL,
        });
        return { status: 'found', complete: false, metadata: snapshot.metadata, reports,
          cursor: { readSessionId, last: expectedLast } };
      }

      const { readSessionId, last } = request.cursor;
      const session = this.readSessions.get(readSessionId);
      if (!session || session.traceId !== request.traceId
        || session.expiresAt <= now || !sameTuple(session.expectedLast, last)) {
        if (session) this.readSessions.delete(readSessionId);
        return { status: 'read_expired' };
      }
      this.readSessions.delete(readSessionId);
      const snapshot = this.#validatedSnapshot(session.traceId, session.maxRowOrdinal);
      if (!snapshot || snapshot.rows.length !== session.reportCount
        || snapshot.digest !== session.digest
        || snapshot.traceStateDigest !== session.traceStateDigest) {
        return { status: 'read_expired' };
      }
      const pageRows = snapshot.rows.slice(session.nextIndex, session.nextIndex + 256);
      if (pageRows.length === 0) return { status: 'read_expired' };
      const reports = pageRows.map((row) => row.envelope);
      const nextIndex = session.nextIndex + pageRows.length;
      if (nextIndex >= snapshot.rows.length) {
        return { status: 'found', complete: true, metadata: session.metadata,
          reports, cursor: null };
      }
      const expectedLast = tupleFromRow(pageRows.at(-1));
      this.readSessions.set(readSessionId, {
        ...session, expectedLast, nextIndex, expiresAt: now + READ_SESSION_TTL,
      });
      return { status: 'found', complete: false, metadata: session.metadata, reports,
        cursor: { readSessionId, last: expectedLast } };
    });
  }

  purgeTrace(input, now = this.clock()) {
    finiteTime(now);
    const command = validatePurgeCommandJson(input);
    const commandBytes = canonicalPurgeCommandBytes(command);
    const fingerprint = digest(commandBytes);
    const result = transaction(this.db, () => {
      const existing = this.db.prepare(`SELECT * FROM diagnostic_requests
        WHERE request_id=?`).get(command.requestId);
      if (existing) {
        if (existing.fingerprint !== fingerprint || existing.operation !== 'trace_purge') {
          fail('request_conflict');
        }
        return restorePurgeReceipt(existing.canonical_receipt).result;
      }
      const tombstone = this.db.prepare(`SELECT fingerprint
        FROM diagnostic_request_tombstones WHERE request_id=?`).get(command.requestId);
      if (tombstone) {
        if (tombstone.fingerprint !== fingerprint) fail('request_conflict');
        return { status: 'trace_absent', traceId: command.parameters.traceId };
      }
      const trace = traceRow(this.db, command.parameters.traceId);
      if (!trace) return { status: 'trace_absent', traceId: command.parameters.traceId };
      if (trace.status !== 'ended') return { status: 'trace_inactive', traceId: trace.trace_id };
      const purged = canonicalPurgeResult(command);
      const receiptBytes = canonicalPurgeReceiptBytes(command, purged);
      const storeBefore = this.db.prepare(`SELECT request_count,canonical_bytes
        FROM diagnostic_store WHERE singleton='diagnostics'`).get();
      if (!requestQuotaAllows(storeBefore.request_count, 0, true)) fail('quota_exhausted');
      purgeTraceRows(this.db, trace.trace_id, now);
      const storeAfterPurge = this.db.prepare(`SELECT canonical_bytes
        FROM diagnostic_store WHERE singleton='diagnostics'`).get();
      if (storeAfterPurge.canonical_bytes + receiptBytes.byteLength
        > DIAGNOSTIC_LIMITS.globalBytes) fail('quota_exhausted');
      this.db.prepare(`INSERT INTO diagnostic_requests
        (request_id,trace_id,operation,fingerprint,canonical_receipt,accepted_at,expires_at)
        VALUES (?,?,?,?,?,?,?)`).run(
        command.requestId, trace.trace_id, 'trace_purge', fingerprint,
        receiptBytes, now, now + 172_800_000,
      );
      this.db.prepare(`UPDATE diagnostic_store SET request_count=request_count+1,
        canonical_bytes=canonical_bytes+? WHERE singleton='diagnostics'`)
        .run(receiptBytes.byteLength);
      return purged;
    });
    if (result.status === 'purged') this.#invalidateTraceSessions(result.traceId);
    return result;
  }

  retentionSweep(now = this.clock()) {
    finiteTime(now);
    let removedTraceId = null;
    const result = transaction(this.db, () => {
      expireActiveIfDue(this.db, now);
      const expiredIssuance = this.db.prepare(`SELECT
        COALESCE(SUM(length(canonical_issuance)),0) AS bytes
        FROM diagnostic_issuances WHERE expires_at<=?`).get(now);
      this.db.prepare('DELETE FROM diagnostic_issuances WHERE expires_at<=?').run(now);
      const expiredPurgeReceipts = this.db.prepare(`SELECT COUNT(*) AS count,
        COALESCE(SUM(length(canonical_receipt)),0) AS bytes FROM diagnostic_requests
        WHERE operation='trace_purge' AND expires_at<=?`).get(now);
      this.db.prepare(`DELETE FROM diagnostic_requests
        WHERE operation='trace_purge' AND expires_at<=?`).run(now);
      const expiredTombstones = this.db.prepare(`SELECT COUNT(*) AS count
        FROM diagnostic_request_tombstones WHERE expires_at<=?`).get(now);
      this.db.prepare('DELETE FROM diagnostic_request_tombstones WHERE expires_at<=?').run(now);
      this.db.prepare(`UPDATE diagnostic_store SET
        request_count=request_count-?,canonical_bytes=canonical_bytes-?
        WHERE singleton='diagnostics'`).run(
        expiredPurgeReceipts.count + expiredTombstones.count,
        expiredIssuance.bytes + expiredPurgeReceipts.bytes,
      );
      const eligible = this.db.prepare(`SELECT trace_id FROM diagnostic_traces
        WHERE status='ended' AND purge_after<=? ORDER BY purge_after,trace_id LIMIT 1`).get(now);
      if (eligible) {
        removedTraceId = eligible.trace_id;
        purgeTraceRows(this.db, eligible.trace_id, now);
      }
      return {
        status: 'completed', expiredIssuancesBytes: expiredIssuance.bytes,
        expiredPurgeReceipts: expiredPurgeReceipts.count,
        expiredTombstones: expiredTombstones.count,
        removedTraceId,
      };
    });
    if (removedTraceId) this.#invalidateTraceSessions(removedTraceId);
    let checkpoint;
    try {
      checkpoint = this.db.prepare('PRAGMA wal_checkpoint(PASSIVE)').get();
    } catch {
      checkpoint = { busy: 1, log: 0, checkpointed: 0 };
    }
    return { ...result, checkpoint };
  }

  status() {
    let observation;
    try {
      observation = this.observePhysicalUsage();
    } catch {
      observation = null;
    }
    const reason = physicalReason(observation);
    const stored = this.db.prepare(`SELECT trace_count,report_count,request_count,
      canonical_bytes,mode,degraded_reason FROM diagnostic_store
      WHERE singleton='diagnostics'`).get();
    return {
      status: stored.mode === 'healthy' && reason === null ? 'healthy' : 'degraded',
      reason: stored.mode === 'healthy' ? reason : stored.degraded_reason,
      schemaGeneration: 1,
      traceCount: stored.trace_count,
      reportCount: stored.report_count,
      requestCount: stored.request_count,
      canonicalBytes: stored.canonical_bytes,
    };
  }

  validate() {
    const db = this.db;
    try {
      if (db.prepare('PRAGMA foreign_key_check').all().length !== 0) dataFail();
      const traces = db.prepare('SELECT * FROM diagnostic_traces').all();
      let reportBytes = 0;
      let issuanceBytes = 0;
      for (const trace of traces) {
        const projection = validateTraceProjection(db, trace);
        reportBytes += projection.reportBytes;
        issuanceBytes += projection.issuanceBytes;
      }
      let requestBytes = 0;
      for (const row of db.prepare('SELECT * FROM diagnostic_requests').all()) {
        const receipt = restoreReceipt(row);
        const resultTraceId = receipt.result.traceId;
        const retainedTrace = traceRow(db, row.trace_id);
        const fingerprint = row.operation === 'trace_purge'
          ? digest(canonicalPurgeCommandBytes(receipt.canonicalCommand))
          : digest(canonicalE2OperationCommandBytes(receipt.canonicalCommand));
        const canonicalReceipt = row.operation === 'trace_purge'
          ? canonicalPurgeReceiptBytes(receipt.canonicalCommand, receipt.result)
          : canonicalE2OperationReceiptBytes(receipt);
        const expectedExpiry = row.operation === 'trace_purge'
          ? row.accepted_at + 172_800_000
          : retainedTrace?.status === 'ended'
            ? retainedTrace.purge_after
            : retainedTrace?.active_expires_at + 172_800_000;
        if (receipt.requestId !== row.request_id || receipt.operation !== row.operation
          || resultTraceId !== row.trace_id
          || fingerprint !== row.fingerprint
          || !sameBytes(row.canonical_receipt, canonicalReceipt)
          || row.expires_at !== expectedExpiry
          || (row.operation === 'trace_purge' ? retainedTrace !== undefined : !retainedTrace)) {
          dataFail();
        }
        requestBytes += row.canonical_receipt.byteLength;
      }
      const tombstoneCount = db.prepare(`SELECT COUNT(*) AS n
        FROM diagnostic_request_tombstones`).get().n;
      for (const row of db.prepare('SELECT * FROM diagnostic_request_tombstones').all()) {
        if (!validUuid(row.request_id) || !/^[0-9a-f]{64}$/.test(row.fingerprint)
          || typeof row.created_at !== 'number' || !Number.isFinite(row.created_at)
          || row.created_at < 0 || row.expires_at !== row.created_at + 172_800_000) dataFail();
      }
      const duplicateRequestIdentity = db.prepare(`SELECT 1 FROM diagnostic_requests r
        JOIN diagnostic_request_tombstones t ON t.request_id=r.request_id LIMIT 1`).get();
      if (duplicateRequestIdentity) dataFail();
      const actual = {
        traceCount: traces.length,
        reportCount: db.prepare('SELECT COUNT(*) AS n FROM diagnostic_reports').get().n,
        requestCount: db.prepare('SELECT COUNT(*) AS n FROM diagnostic_requests').get().n
          + tombstoneCount,
        canonicalBytes: reportBytes + requestBytes + issuanceBytes,
      };
      const stored = db.prepare('SELECT * FROM diagnostic_store WHERE singleton=?')
        .get('diagnostics');
      const cleanupObligations = db.prepare(`SELECT
        (SELECT COUNT(*)*2 FROM diagnostic_traces WHERE status='active')
        +(SELECT COUNT(*) FROM diagnostic_traces WHERE status='ended')
        +(SELECT COUNT(*) FROM diagnostic_consents WHERE status='enabled') AS n`).get().n;
      if (stored.mode !== 'healthy' || stored.degraded_reason !== null
        || stored.trace_count !== actual.traceCount || stored.report_count !== actual.reportCount
        || stored.request_count !== actual.requestCount
        || stored.canonical_bytes !== actual.canonicalBytes
        || stored.request_count + cleanupObligations > DIAGNOSTIC_LIMITS.requests) {
        dataFail();
      }
      return { status: 'healthy', ...actual };
    } catch (error) {
      if (error instanceof E7StoreError) throw error;
      dataFail(error);
    }
  }
}
