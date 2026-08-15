#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const TOKEN = /^[!-~]{32,256}$/;
const VARIABLES = [
  'DIAGNOSTICS_GAME_TOKEN_HOST_FILE',
  'DIAGNOSTICS_RELAY_TOKEN_HOST_FILE',
  'DIAGNOSTICS_MAINTENANCE_TOKEN_HOST_FILE',
];

export function validateDiagnosticCredentialFiles(environment = process.env,read = readFileSync) {
  const digests = [];
  for (const variable of VARIABLES) {
    const path = environment[variable];
    if (typeof path !== 'string' || !path) {
      throw new Error('diagnostic_credential_configuration_invalid');
    }
    let token;
    try { token = read(path,'utf8').trim(); }
    catch { throw new Error('diagnostic_credential_configuration_invalid'); }
    if (!TOKEN.test(token)) throw new Error('diagnostic_credential_configuration_invalid');
    digests.push(createHash('sha256').update(token).digest('hex'));
  }
  if (new Set(digests).size !== digests.length) {
    throw new Error('diagnostic_credential_collision');
  }
  return Object.freeze({ status: 'valid' });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    validateDiagnosticCredentialFiles();
    process.stdout.write('{"status":"valid"}\n');
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
