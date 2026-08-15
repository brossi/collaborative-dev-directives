import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { DiagnosticCollector } from './collector.mjs';
import {
  authenticateDiagnosticRequest,
  E8HttpError,
  readBoundedRequestBody,
  validateDiagnosticCredentials,
  validateGameCollectorRequest,
  validateMaintenancePurgeRequest,
} from './http-boundary.mjs';
import {
  validateDiagnosticVolumeTopology,
  volumeTopologyFromEnvironment,
} from './topology.mjs';

const DEFAULT_PORT = 3020;
const DEFAULT_MAINTENANCE_INTERVAL_MS = 60_000;
const CLOSE_DEADLINE_MS = 2_000;
const FINITE_FAILURES = new Set([
  'collector_busy',
  'collector_degraded',
  'schema_incompatible',
]);
const GAME_PATHS = new Set([
  '/v1/game/trace/context',
  '/v1/game/trace/start-context',
  '/v1/game/synchronization/context',
  '/v1/game/trace/start',
  '/v1/game/trace/end',
  '/v1/game/segment/rotate',
  '/v1/game/synchronization/issue',
  '/v1/game/consent/opt-in',
  '/v1/game/consent/stop',
  '/v1/game/relay/bind',
  '/v1/game/report/ingest',
  '/v1/game/trace/read',
]);
const MAINTENANCE_STATUS = '/v1/maintenance/status';
const MAINTENANCE_PURGE = '/v1/maintenance/trace/purge';
const HTTP_FAILURES = new Map([
  ['authentication_required', 401],
  ['not_authorized', 403],
  ['request_timeout', 408],
  ['request_invalid', 400],
  ['authority_invalid', 400],
  ['sample_invalid', 400],
  ['alignment_invalid', 400],
  ['report_invalid', 400],
  ['report_too_large', 400],
  ['request_conflict', 409],
  ['report_conflict', 409],
  ['stale_correlation', 409],
  ['sample_expired', 409],
  ['read_expired', 409],
  ['trace_inactive', 409],
  ['sharing_disabled', 409],
  ['collector_busy', 503],
  ['collector_degraded', 503],
  ['quota_exhausted', 503],
  ['schema_incompatible', 503],
]);

function json(response, statusCode, value) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(statusCode, {
    'cache-control': 'no-store',
    'content-length': String(body.byteLength),
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(body);
}

function finiteFailure(error) {
  return FINITE_FAILURES.has(error?.code) ? error.code : 'collector_degraded';
}

export function classifyDiagnosticHttpFailure(error) {
  const statusCode = HTTP_FAILURES.get(error?.code) ?? 503;
  const code = HTTP_FAILURES.has(error?.code) ? error.code : 'collector_unavailable';
  return Object.freeze({ statusCode, code });
}

function httpFailure(response, error) {
  const { statusCode, code } = classifyDiagnosticHttpFailure(error);
  if (!response.headersSent && !response.destroyed) {
    json(response, statusCode, { status: 'error', code });
  }
}

function noRequestBody(request) {
  return request.headers['content-length'] === undefined
    && request.headers['transfer-encoding'] === undefined;
}

export function delegateGameCollectorOperation(collector, operation, receivedAt) {
  if (operation.operation === 'traceContext') {
    return collector.traceContext(operation.locator);
  }
  if (operation.operation === 'traceStartReceiptContext') {
    return collector.traceStartReceiptContext(operation.requestId);
  }
  if (operation.operation === 'issuanceContext') {
    return collector.issuanceContext(operation.sampleId,receivedAt);
  }
  if (operation.operation === 'startTrace') {
    return collector.startTrace(operation.command, operation.authority);
  }
  if (operation.operation === 'endTrace') {
    return collector.endTrace(operation.command, operation.authority);
  }
  if (operation.operation === 'rotateSegment') {
    return { status: 'accepted', state: collector.rotateSegment(operation.authority) };
  }
  if (operation.operation === 'putIssuance') {
    return { status: collector.putIssuance(operation.traceId, operation.issuance) };
  }
  if (operation.operation === 'optIn') {
    return collector.optIn(operation.command, operation.authority);
  }
  if (operation.operation === 'stopSharing') {
    return collector.stopSharing(operation.command, operation.authority);
  }
  if (operation.operation === 'bindRelay') {
    return collector.bindRelay(operation.command, operation.authority);
  }
  if (operation.operation === 'ingestReport') {
    return collector.ingestReport(operation.envelope, {
      receivedAt, grantGeneration: operation.grantGeneration,
    });
  }
  if (operation.operation === 'readTrace') return collector.readTrace(operation.request);
  throw new E8HttpError('request_invalid');
}

function portNumber(value) {
  const port = Number(value ?? DEFAULT_PORT);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new Error('diagnostic_port_invalid');
  }
  return port;
}

function closeHttpServer(server) {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve();
    };
    const deadline = setTimeout(() => {
      server.closeAllConnections?.();
      finish();
    }, CLOSE_DEADLINE_MS);
    deadline.unref?.();
    server.close(finish);
  });
}

export function createDiagnosticService({
  databasePath,
  host = '0.0.0.0',
  port = DEFAULT_PORT,
  maintenanceIntervalMs = DEFAULT_MAINTENANCE_INTERVAL_MS,
  bodyDeadlineMs,
  authenticatedApi = null,
  clock = Date.now,
  collectorOptions,
  volumeTopology = volumeTopologyFromEnvironment(),
  createCollector = (path, options) => new DiagnosticCollector(path, options),
  onLifecycle = () => {},
} = {}) {
  if (typeof databasePath !== 'string' || databasePath.length === 0
    || !Number.isSafeInteger(maintenanceIntervalMs) || maintenanceIntervalMs < 1) {
    throw new Error('diagnostic_configuration_invalid');
  }

  validateDiagnosticVolumeTopology(volumeTopology);
  const credentials = authenticatedApi === null
    ? null : validateDiagnosticCredentials(authenticatedApi);
  const collector = createCollector(databasePath, { ...collectorOptions,clock });
  const lifecycle = (event) => {
    try {
      onLifecycle(event);
    } catch {}
  };
  let timer = null;
  let closing = null;
  const server = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/live') {
      json(response, 200, { status: 'live' });
      return;
    }
    if (request.method === 'GET' && request.url === '/ready') {
      try {
        const status = collector.status();
        json(response, status.status === 'healthy' ? 200 : 503,
          status.status === 'healthy'
            ? { status: 'ready' }
            : { status: 'degraded', reason: status.reason ?? 'collector_degraded' });
      } catch {
        json(response, 503, { status: 'degraded', reason: 'collector_degraded' });
      }
      return;
    }
    if (credentials === null && request.method === 'GET' && request.url === '/v1/status') {
      try {
        json(response, 200, collector.status());
      } catch {
        json(response, 503, { status: 'degraded', reason: 'collector_degraded' });
      }
      return;
    }
    if (credentials !== null) {
      const isGame = GAME_PATHS.has(request.url);
      const isMaintenanceStatus = request.url === MAINTENANCE_STATUS;
      const isMaintenancePurge = request.url === MAINTENANCE_PURGE;
      const expectedMethod = isMaintenanceStatus ? 'GET' : 'POST';
      if ((isGame || isMaintenanceStatus || isMaintenancePurge)
        && request.method === expectedMethod) {
        try {
          authenticateDiagnosticRequest(request.headers.authorization, credentials,
            isGame ? 'game' : 'maintenance');
          if (isMaintenanceStatus) {
            if (!noRequestBody(request)) throw new E8HttpError('request_invalid');
            json(response, 200, collector.status());
            return;
          }
          const body = await readBoundedRequestBody(request, {
            ...(bodyDeadlineMs === undefined ? {} : { deadlineMs: bodyDeadlineMs }),
          });
          if (isMaintenancePurge) {
            json(response, 200, collector.purgeTrace(
              validateMaintenancePurgeRequest(body), clock(),
            ));
            return;
          }
          const operation = validateGameCollectorRequest(request.url, body);
          const result = delegateGameCollectorOperation(collector, operation, clock());
          json(response, 200, result);
          return;
        } catch (error) {
          httpFailure(response, error);
          if (error?.code === 'request_timeout') {
            response.once('finish', () => request.destroy());
          }
          return;
        }
      }
    }
    json(response, 404, { status: 'not_found' });
  });
  server.headersTimeout = 5_000;
  server.requestTimeout = 5_000;
  server.keepAliveTimeout = 1_000;
  server.maxHeadersCount = 32;

  return Object.freeze({
    async start() {
      if (closing || server.listening) throw new Error('diagnostic_service_state');
      try {
        await new Promise((resolve, reject) => {
          const failed = (error) => {
            server.off('listening', listening);
            reject(error);
          };
          const listening = () => {
            server.off('error', failed);
            resolve();
          };
          server.once('error', failed);
          server.once('listening', listening);
          server.listen(portNumber(port), host);
        });
      } catch (error) {
        collector.close();
        throw error;
      }
      timer = setInterval(() => {
        try {
          collector.retentionSweep();
        } catch (error) {
          lifecycle({ event: 'maintenance_failed', code: finiteFailure(error) });
        }
      }, maintenanceIntervalMs);
      timer.unref?.();
      lifecycle({ event: 'started' });
      return server.address();
    },

    address() {
      return server.address();
    },

    close() {
      if (closing) return closing;
      closing = (async () => {
        if (timer) clearInterval(timer);
        timer = null;
        await closeHttpServer(server);
        collector.close();
        lifecycle({ event: 'stopped' });
      })();
      return closing;
    },
  });
}

export function authenticatedApiFromEnvironment(environment = process.env, read = readFileSync) {
  const required = environment.CANNABEATS_DIAGNOSTICS_AUTHENTICATED_API_REQUIRED;
  if (required !== undefined && !['true','false'].includes(required)) {
    throw new Error('diagnostic_configuration_invalid');
  }
  if (required !== 'true') return null;
  const gamePath = environment.CANNABEATS_DIAGNOSTICS_GAME_TOKEN_FILE;
  const maintenancePath = environment.CANNABEATS_DIAGNOSTICS_MAINTENANCE_TOKEN_FILE;
  if (!gamePath || !maintenancePath) throw new Error('diagnostic_configuration_invalid');
  return validateDiagnosticCredentials({
    gameToken: read(gamePath, 'utf8').trim(),
    maintenanceToken: read(maintenancePath, 'utf8').trim(),
  });
}

export async function runDiagnosticServiceFromEnvironment() {
  const authenticatedApi = authenticatedApiFromEnvironment();
  const service = createDiagnosticService({
    databasePath: process.env.CANNABEATS_DIAGNOSTIC_DATABASE_PATH
      || '/diagnostics/cannabeats-diagnostics.sqlite',
    port: process.env.PORT ?? DEFAULT_PORT,
    collectorOptions: {
      lockDirectory: process.env.CANNABEATS_DIAGNOSTIC_LOCK_DIRECTORY
        || '/diagnostics/.locks',
    },
    volumeTopology: volumeTopologyFromEnvironment(process.env),
    authenticatedApi,
    onLifecycle(event) {
      process.stdout.write(`${JSON.stringify(event)}\n`);
    },
  });
  await service.start();
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await service.close();
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  return service;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runDiagnosticServiceFromEnvironment().catch(() => {
    process.stderr.write('{"event":"startup_failed","code":"collector_degraded"}\n');
    process.exitCode = 1;
  });
}
