import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import {
  createDiagnosticMaintenanceClient,maintenanceTokenFromEnvironment,
} from '../src/maintenance-client.mjs';

const TOKEN = 'maintenance-token-0000000000000000';
const status = {
  status: 'healthy',reason: null,schemaGeneration: 1,traceCount: 1,
  reportCount: 2,requestCount: 3,canonicalBytes: 4,
};

test('maintenance client exposes only exact bounded status and purge operations', async () => {
  const calls = [];
  const traceId = randomUUID();
  const client = createDiagnosticMaintenanceClient({
    origin: 'http://diagnostics:3020',token: TOKEN,
    fetchImpl: async (url,options) => {
      calls.push({ url,options });
      return Response.json(url.endsWith('/status') ? status : { status: 'purged',traceId });
    },
  });
  assert.deepEqual(await client.status(),status);
  const requestId = randomUUID();
  assert.deepEqual(await client.purge({ requestId,traceId }),{ status: 'purged',traceId });
  assert.equal(calls[0].options.headers.authorization,`Bearer ${TOKEN}`);
  assert.equal(calls[0].options.method,'GET');
  assert.equal(JSON.parse(calls[1].options.body).operation,'trace_purge');
  await assert.rejects(() => client.purge({ requestId: 'bad',traceId }),
    (error) => error.code === 'maintenance_request_invalid');
});

test('maintenance client rejects malformed oversized and caller-authored failures finitely', async () => {
  for (const response of [
    Response.json({ ...status,traceCount: '1' }),
    new Response('x'.repeat(8193)),
    new Response(Uint8Array.from([0xff])),
  ]) {
    const client = createDiagnosticMaintenanceClient({
      origin: 'http://diagnostics:3020',token: TOKEN,fetchImpl: async () => response,
    });
    await assert.rejects(() => client.status(),
      (error) => error.code === 'maintenance_response_invalid');
  }
  const hostile = createDiagnosticMaintenanceClient({
    origin: 'http://diagnostics:3020',token: TOKEN,
    fetchImpl: async () => Response.json({ code: 'native_database_secret' },{ status: 500 }),
  });
  await assert.rejects(() => hostile.status(),
    (error) => error.code === 'maintenance_unavailable');
});

test('maintenance deadlines and environment credentials fail closed', async () => {
  const hanging = createDiagnosticMaintenanceClient({
    origin: 'http://diagnostics:3020',token: TOKEN,deadlineMs: 5,
    fetchImpl: (_url,{ signal }) => new Promise((_resolve,reject) => {
      signal.addEventListener('abort',() => reject(signal.reason),{ once: true });
    }),
  });
  await assert.rejects(() => hanging.status(),
    (error) => error.code === 'maintenance_unavailable');
  assert.equal(maintenanceTokenFromEnvironment({
    CANNABEATS_DIAGNOSTICS_MAINTENANCE_TOKEN: ` ${TOKEN} `,
  }),TOKEN);
  assert.throws(() => maintenanceTokenFromEnvironment({}),
    /diagnostic_maintenance_configuration_invalid/);
});
