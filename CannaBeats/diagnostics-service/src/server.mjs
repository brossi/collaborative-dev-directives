import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

import { DiagnosticCollector } from './collector.mjs';
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
  const collector = createCollector(databasePath, collectorOptions);
  const lifecycle = (event) => {
    try {
      onLifecycle(event);
    } catch {}
  };
  let timer = null;
  let closing = null;
  const server = createServer((request, response) => {
    if (request.method !== 'GET') {
      json(response, 404, { status: 'not_found' });
      return;
    }
    if (request.url === '/live') {
      json(response, 200, { status: 'live' });
      return;
    }
    if (request.url === '/ready') {
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
    if (request.url === '/v1/status') {
      try {
        json(response, 200, collector.status());
      } catch {
        json(response, 503, { status: 'degraded', reason: 'collector_degraded' });
      }
      return;
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

export async function runDiagnosticServiceFromEnvironment() {
  const service = createDiagnosticService({
    databasePath: process.env.CANNABEATS_DIAGNOSTIC_DATABASE_PATH
      || '/diagnostics/cannabeats-diagnostics.sqlite',
    port: process.env.PORT ?? DEFAULT_PORT,
    collectorOptions: {
      lockDirectory: process.env.CANNABEATS_DIAGNOSTIC_LOCK_DIRECTORY
        || '/diagnostics/.locks',
    },
    volumeTopology: volumeTopologyFromEnvironment(process.env),
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
