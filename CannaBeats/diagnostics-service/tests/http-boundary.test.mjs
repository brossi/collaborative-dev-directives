import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';

import { validateMeasurementJson } from '../../web/lib/s2e-e1-contract.mjs';
import {
  acceptSynchronizationSample,
  composeUploadedEnvelope,
  createServerContextFixtureForTest,
  mapMeasurementAlignment,
  validateSynchronizationIssuanceJson,
} from '../../web/lib/s2e-e2-correlation.mjs';
import {
  authenticateDiagnosticRequest,
  readBoundedRequestBody,
  validateDiagnosticCredentials,
  validateGameCollectorRequest,
} from '../src/http-boundary.mjs';

const GAME_TOKEN = 'game-token-000000000000000000000000';
const MAINTENANCE_TOKEN = 'maintenance-token-0000000000000000';
const TRACE = '423e4567-e89b-42d3-a456-426614174000';
const RUN = '523e4567-e89b-42d3-a456-426614174000';
const LEASE = '723e4567-e89b-42d3-a456-426614174000';
const SEGMENT = '623e4567-e89b-42d3-a456-426614174000';
const REQUEST = 'b23e4567-e89b-42d3-a456-426614174000';
const INSTANCE = '123e4567-e89b-42d3-a456-426614174000';
const SAMPLE = '223e4567-e89b-42d3-a456-426614174000';
const TIMEBASE = '323e4567-e89b-42d3-a456-426614174000';
const RELAY_GENERATION = '823e4567-e89b-42d3-a456-426614174000';
const json = (value) => Buffer.from(JSON.stringify(value));

function startBody() {
  return {
    command: { requestId: REQUEST, operation: 'trace_start', parameters: {} },
    authority: {
      authorityVersion: 1, operation: 'trace_start', nowMs: 1000, isHost: true,
      runId: RUN, runGeneration: 1, leaseId: LEASE,
      issuedTraceId: TRACE, issuedSegmentId: SEGMENT,
    },
  };
}

function issuanceValue() {
  return {
    sampleId: SAMPLE, timebaseId: TIMEBASE, instanceId: INSTANCE,
    serverReceiveMs: 1000, serverSendMs: 1005,
  };
}

function uploadedEnvelope() {
  const core = validateMeasurementJson(json({
    schemaVersion: 1, kind: 'listener_transition', instanceId: INSTANCE,
    sequence: 0, monotonicStartMs: 120, durationMs: 0,
    measurements: {
      type: 'request_started', category: 'observed',
      connectionAttemptSequence: 0, elapsedMs: 0,
    },
  }));
  const issuance = validateSynchronizationIssuanceJson(json(issuanceValue()));
  const sample = acceptSynchronizationSample(json({
    sampleId: SAMPLE, instanceId: INSTANCE, localSendMs: 100, localReceiveMs: 120,
  }), issuance);
  const context = createServerContextFixtureForTest(json({
    contextVersion: 1, traceId: TRACE, runId: RUN, runGeneration: 1,
    correlationSegmentId: SEGMENT, leaseId: LEASE,
    authorityKind: 'listener', role: 'member', listenerInstanceId: INSTANCE,
  }));
  return composeUploadedEnvelope(core, mapMeasurementAlignment(core, sample), context);
}

test('two exact distinct credentials implement one fixed scope decision', () => {
  const credentials = validateDiagnosticCredentials({
    gameToken: GAME_TOKEN, maintenanceToken: MAINTENANCE_TOKEN,
  });
  assert.equal(authenticateDiagnosticRequest(`Bearer ${GAME_TOKEN}`, credentials, 'game'),
    'game');
  assert.equal(authenticateDiagnosticRequest(
    `Bearer ${MAINTENANCE_TOKEN}`, credentials, 'maintenance'), 'maintenance');
  for (const [authorization, scope, code] of [
    [undefined, 'game', 'authentication_required'],
    ['Bearer unknown-token-000000000000000000000', 'game', 'authentication_required'],
    [`Bearer ${GAME_TOKEN}`, 'maintenance', 'not_authorized'],
    [`Bearer ${MAINTENANCE_TOKEN}`, 'game', 'not_authorized'],
  ]) {
    assert.throws(() => authenticateDiagnosticRequest(authorization, credentials, scope),
      (error) => error.code === code);
  }
});

test('credential configuration rejects missing malformed and equal values', () => {
  for (const value of [
    null,
    { gameToken: GAME_TOKEN },
    { gameToken: 'short', maintenanceToken: MAINTENANCE_TOKEN },
    { gameToken: GAME_TOKEN, maintenanceToken: GAME_TOKEN },
    { gameToken: GAME_TOKEN, maintenanceToken: `${MAINTENANCE_TOKEN}\n` },
  ]) {
    assert.throws(() => validateDiagnosticCredentials(value),
      (error) => error.code === 'credential_invalid');
  }
});

test('body reader accepts the exact 8 KiB boundary and rejects the next byte', async () => {
  assert.equal((await readBoundedRequestBody(Readable.from([Buffer.alloc(8192)]))).byteLength,
    8192);
  await assert.rejects(readBoundedRequestBody(Readable.from([Buffer.alloc(8193)])),
    (error) => error.code === 'request_invalid');
});

test('operation route and authority operation must agree exactly', () => {
  assert.equal(validateGameCollectorRequest('/v1/game/trace/start', json(startBody())).operation,
    'startTrace');
  const wrong = structuredClone(startBody());
  wrong.command.operation = 'trace_end';
  assert.throws(() => validateGameCollectorRequest('/v1/game/trace/start', json(wrong)),
    (error) => error.code === 'request_invalid');
  const extra = structuredClone(startBody());
  extra.callerRunId = RUN;
  assert.throws(() => validateGameCollectorRequest('/v1/game/trace/start', json(extra)),
    (error) => error.code === 'request_invalid');
  assert.throws(() => validateGameCollectorRequest(
    '/v1/game/trace/start', Buffer.from([0xff])),
    (error) => error.code === 'request_invalid');
});

test('every Game route has one exact request family', () => {
  const cases = [
    ['/v1/game/trace/start', startBody(), 'startTrace'],
    ['/v1/game/trace/end', {
      command: { requestId: REQUEST, operation: 'trace_end', parameters: {} },
      authority: {
        authorityVersion: 1, operation: 'trace_end', nowMs: 2000,
        traceId: TRACE, reason: 'host_stopped',
      },
    }, 'endTrace'],
    ['/v1/game/segment/rotate', { authority: {
      authorityVersion: 1, operation: 'segment_rotate', nowMs: 2000,
      traceId: TRACE, priorLeaseId: LEASE,
      leaseId: 'a23e4567-e89b-42d3-a456-426614174000',
      issuedSegmentId: '923e4567-e89b-42d3-a456-426614174000',
    } }, 'rotateSegment'],
    ['/v1/game/synchronization/issue', {
      traceId: TRACE, issuance: issuanceValue(),
    }, 'putIssuance'],
    ['/v1/game/consent/opt-in', {
      command: {
        requestId: REQUEST, operation: 'consent_opt_in', parameters: {
          listenerInstanceId: INSTANCE, firstAllowedSequence: 0,
          localConsentStartedMs: 120,
        },
      },
      authority: {
        authorityVersion: 1, operation: 'consent_opt_in', nowMs: 2000,
        traceId: TRACE, listenerInstanceId: INSTANCE,
      },
    }, 'optIn'],
    ['/v1/game/consent/stop', {
      command: {
        requestId: REQUEST, operation: 'consent_stop', parameters: {
          listenerInstanceId: INSTANCE, expectedGeneration: 1,
        },
      },
      authority: {
        authorityVersion: 1, operation: 'consent_stop', nowMs: 2000,
        traceId: TRACE, listenerInstanceId: INSTANCE,
      },
    }, 'stopSharing'],
    ['/v1/game/relay/bind', {
      command: {
        requestId: REQUEST, operation: 'relay_bind',
        parameters: { relayGenerationId: RELAY_GENERATION },
      },
      authority: {
        authorityVersion: 1, operation: 'relay_bind', traceId: TRACE,
        segmentId: SEGMENT, leaseId: LEASE, relayGenerationId: RELAY_GENERATION,
      },
    }, 'bindRelay'],
    ['/v1/game/report/ingest', {
      envelope: uploadedEnvelope(), grantGeneration: 1,
    }, 'ingestReport'],
    ['/v1/game/trace/read', { traceId: TRACE, cursor: null }, 'readTrace'],
  ];
  for (const [path, body, operation] of cases) {
    assert.equal(validateGameCollectorRequest(path, json(body)).operation, operation, path);
  }
});
