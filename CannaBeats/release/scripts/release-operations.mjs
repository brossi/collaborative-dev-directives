#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import {
  closeSync, existsSync, lstatSync, openSync, readFileSync, readdirSync,
} from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { DEPLOYMENT_PATHS, validateDeploymentEnvironment } from './deployment-config.mjs';
import {
  MAX_CADDYFILE_BYTES, MAX_COMPOSE_BYTES, MAX_RELEASE_MANIFEST_BYTES,
  ReleaseStateError, deployRelease, reconcileRelease, rollbackRelease,
} from './release-state.mjs';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
export const PRODUCTION_RELEASE_ROOT = '/opt/cannabeats/releases';
export const PRODUCTION_DATABASE = '/var/lib/cannabeats/cannabeats.sqlite3';
export const PRODUCTION_LOCK = '/run/lock/cannabeats-operations.lock';
const BACKUP_SCRIPT = join(scriptDirectory, 'backup.mjs');

export async function withOperationsLock(work, {
  lockPath = PRODUCTION_LOCK, open = openSync, close = closeSync, spawn = spawnSync,
} = {}) {
  let fd;
  try {
    fd = open(lockPath, 'a', 0o600);
    const result = spawn('flock', ['--nonblock', '3'], {
      stdio: ['ignore', 'ignore', 'ignore', fd], timeout: 5_000,
    });
    if (result.status !== 0) throw new ReleaseStateError(
      result.status === 1 ? 'busy' : 'operations_unavailable',
    );
    return await work();
  } catch (error) {
    if (error instanceof ReleaseStateError) throw error;
    throw new ReleaseStateError('operations_unavailable');
  } finally {
    if (fd !== undefined) close(fd);
  }
}

export function readSchemaGeneration(path = PRODUCTION_DATABASE) {
  if (!existsSync(path)) return null;
  let database;
  try {
    database = new DatabaseSync(path, { readOnly: true });
    const rows = database.prepare(`SELECT generation FROM schema_generations`).all();
    if (rows.length !== 1 || !Number.isSafeInteger(rows[0].generation)
        || rows[0].generation < 1) throw new Error('invalid');
    return rows[0].generation;
  } catch {
    throw new ReleaseStateError('schema_unavailable');
  } finally {
    database?.close();
  }
}

export function createProductionConverger({ spawn = spawnSync } = {}) {
  return async (release, { stop = false } = {}) => {
    if (!release) throw new ReleaseStateError('candidate_failed');
    const selected = release;
    const environment = {
      ...process.env, ...DEPLOYMENT_PATHS,
      CANNABEATS_CADDY_IMAGE: selected.manifest.images.caddy,
      CANNABEATS_WEB_IMAGE: selected.manifest.images.web,
      CANNABEATS_RELAY_IMAGE: selected.manifest.images.relay,
    };
    if (validateDeploymentEnvironment(environment).status !== 'valid') {
      throw new ReleaseStateError('release_corrupt');
    }
    const base = ['compose', '--project-name', 'cannabeats',
      '-f', join(selected.recordPath, 'compose.yaml')];
    const args = stop
      ? [...base, 'down', '--remove-orphans']
      : [...base, 'up', '--detach', '--wait', '--remove-orphans'];
    const result = spawn('docker', args, {
      env: environment, stdio: 'inherit', timeout: 180_000,
    });
    if (result.status !== 0) throw new ReleaseStateError('candidate_failed');
  };
}

function readBoundedBundleFile(path, maximum) {
  const retained = lstatSync(path);
  if (retained.isSymbolicLink() || !retained.isFile()
      || retained.size < 1 || retained.size > maximum) {
    throw new ReleaseStateError('invalid_release');
  }
  return readFileSync(path, 'utf8');
}

export function loadBundle(path) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new ReleaseStateError('invalid_arguments');
  try {
    const retained = lstatSync(path);
    if (retained.isSymbolicLink() || !retained.isDirectory()
        || JSON.stringify(readdirSync(path).sort())
          !== JSON.stringify(['Caddyfile', 'compose.yaml', 'manifest.json'])) {
      throw new ReleaseStateError('invalid_release');
    }
    return {
      manifest: JSON.parse(readBoundedBundleFile(
        join(path, 'manifest.json'), MAX_RELEASE_MANIFEST_BYTES,
      )),
      files: {
        Caddyfile: readBoundedBundleFile(join(path, 'Caddyfile'), MAX_CADDYFILE_BYTES),
        'compose.yaml': readBoundedBundleFile(
          join(path, 'compose.yaml'), MAX_COMPOSE_BYTES,
        ),
      },
    };
  } catch (error) {
    if (error instanceof ReleaseStateError) throw error;
    throw new ReleaseStateError('invalid_release');
  }
}

function productionBackup({ reason, releaseId }, { spawn = spawnSync } = {}) {
  const result = spawn(process.execPath, [BACKUP_SCRIPT, 'create', '--reason', reason,
    '--release-id', releaseId], { stdio: 'inherit', timeout: 120_000 });
  if (result.status !== 0) throw new ReleaseStateError('backup_failed');
}

export async function executeReleaseCommand(argv, {
  root = PRODUCTION_RELEASE_ROOT,
  readSchema = () => readSchemaGeneration(),
  backup = (input) => productionBackup(input),
  converge = createProductionConverger(),
  lock = withOperationsLock,
} = {}) {
  return lock(async () => {
    if (argv.length === 3 && argv[0] === 'deploy' && argv[1] === '--bundle') {
      const bundle = loadBundle(argv[2]);
      return deployRelease({ root, ...bundle, readSchema, backup, converge });
    }
    if (argv.length === 1 && argv[0] === 'rollback') {
      return rollbackRelease({ root, readSchema, backup, converge });
    }
    if (argv.length === 1 && argv[0] === 'reconcile') {
      return reconcileRelease({ root, readSchema, converge });
    }
    throw new ReleaseStateError('invalid_arguments');
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await executeReleaseCommand(process.argv.slice(2));
    process.stdout.write(`${result.code}\n`);
  } catch (error) {
    const code = error instanceof ReleaseStateError ? error.code : 'operations_unavailable';
    process.stderr.write(`release_${code}\n`);
    process.exitCode = 1;
  }
}
