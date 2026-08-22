#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { validateDeploymentEnvironment } from './deployment-config.mjs';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
export const PRODUCTION_COMPOSE = resolve(scriptDirectory, '../deploy/compose.yaml');
export const PRODUCTION_LOCK = '/run/lock/cannabeats-operations.lock';

export function runProductionStart({
  argv = process.argv.slice(2), environment = process.env, spawn = spawnSync,
} = {}) {
  const action = argv.length === 1 ? argv[0] : null;
  if (action !== '--render') {
    return Object.freeze({ status: 'invalid_arguments' });
  }
  const validation = validateDeploymentEnvironment(environment);
  if (validation.status !== 'valid') {
    return Object.freeze({ status: 'invalid_configuration', issues: validation.issues });
  }
  const composeArguments = ['compose', '--project-name', 'cannabeats',
    '-f', PRODUCTION_COMPOSE];
  composeArguments.push('config', '--quiet');
  const result = spawn('flock', [
    '--nonblock', '--conflict-exit-code', '75', PRODUCTION_LOCK,
    'docker', ...composeArguments,
  ], {
    env: environment, stdio: 'inherit', timeout: 30_000,
  });
  return Object.freeze({
    status: result.status === 0 ? 'ready'
      : result.status === 75 ? 'busy' : 'compose_failed',
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = runProductionStart();
  if (result.status === 'ready') process.stdout.write('production_topology_ready\n');
  else {
    process.stderr.write(`production_topology_${result.status}\n`);
    process.exitCode = 1;
  }
}
