#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  existsSync, lstatSync, readFileSync, readdirSync,
} from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

import { DEPLOYMENT_PATHS, validateDeploymentEnvironment } from './deployment-config.mjs';
import {
  PRODUCTION_BACKUP_ROOT, PRODUCTION_INGEST_TOKEN, PRODUCTION_LISTEN_TOKEN,
  createBackup, retainedBackupReleaseIds,
} from './backup.mjs';
import { withOperationsLock } from './operations-lock.mjs';
import {
  MAX_CADDYFILE_BYTES, MAX_COMPOSE_BYTES, MAX_RELEASE_MANIFEST_BYTES,
  ReleaseStateError, deployRelease, pruneReleaseRecords, reconcileRelease, rollbackRelease,
} from './release-state.mjs';

export const PRODUCTION_RELEASE_ROOT = '/opt/cannabeats/releases';
export const PRODUCTION_DATABASE = '/var/lib/cannabeats/cannabeats.sqlite3';
export const PRODUCTION_RESTORE_JOURNAL = '/var/lib/cannabeats/.restore-journal.json';
export { PRODUCTION_LOCK, withOperationsLock } from './operations-lock.mjs';

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

export async function productionBackup({ reason, releaseId, stateSequence }, {
  create = createBackup,
} = {}) {
  const requestId = `sha256:${createHash('sha256').update(JSON.stringify({
    reason, releaseId, stateSequence,
  })).digest('hex')}`;
  try {
    return await create({
      root: PRODUCTION_BACKUP_ROOT, databasePath: PRODUCTION_DATABASE,
      releaseRoot: PRODUCTION_RELEASE_ROOT, ingestTokenPath: PRODUCTION_INGEST_TOKEN,
      listenTokenPath: PRODUCTION_LISTEN_TOKEN, requestId, reason,
      operationReleaseId: releaseId, stateSequence,
    });
  } catch { throw new ReleaseStateError('backup_failed'); }
}

export async function executeReleaseCommand(argv, {
  root = PRODUCTION_RELEASE_ROOT,
  readSchema = () => readSchemaGeneration(),
  backup = (input) => productionBackup(input),
  converge = createProductionConverger(),
  lock = withOperationsLock,
  restorePending = () => existsSync(PRODUCTION_RESTORE_JOURNAL),
  backupRoot = PRODUCTION_BACKUP_ROOT,
  pruneRecords = () => {
    if (!existsSync(join(root, 'records'))) {
      return Object.freeze({ code: 'release_records_absent' });
    }
    const retained = existsSync(backupRoot) ? retainedBackupReleaseIds(backupRoot) : [];
    return pruneReleaseRecords(root, retained, { reserve: 1 });
  },
} = {}) {
  return lock(async () => {
    if (restorePending()) throw new ReleaseStateError('restore_pending');
    if (argv.length === 3 && argv[0] === 'deploy' && argv[1] === '--bundle') {
      const bundle = loadBundle(argv[2]);
      await pruneRecords();
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
