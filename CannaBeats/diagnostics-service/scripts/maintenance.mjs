#!/usr/bin/env node
import { createDiagnosticMaintenanceClient,maintenanceTokenFromEnvironment } from '../src/maintenance-client.mjs';

const [operation,requestId,traceId] = process.argv.slice(2);
if (!['status','purge'].includes(operation)
  || (operation === 'status' ? requestId !== undefined : !requestId || !traceId)) {
  process.stderr.write('usage: maintenance.mjs status | purge REQUEST_UUID TRACE_UUID\n');
  process.exitCode = 2;
} else {
  try {
    const client = createDiagnosticMaintenanceClient({
      token: maintenanceTokenFromEnvironment(),
    });
    const result = operation === 'status'
      ? await client.status() : await client.purge({ requestId,traceId });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error?.code ?? 'maintenance_unavailable'}\n`);
    process.exitCode = 1;
  }
}
