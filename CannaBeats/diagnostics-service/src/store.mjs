import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  DIAGNOSTIC_SCHEMA_GENERATION,
  DIAGNOSTIC_SCHEMA_SQL,
} from './schema.mjs';

function canonicalSchemaDigest(db) {
  const objects = db.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_schema
    WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name`).all().map((row) => ({ ...row }));
  return createHash('sha256').update(JSON.stringify(objects)).digest('hex');
}

function expectedSchemaDigest() {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys=ON');
    db.exec(DIAGNOSTIC_SCHEMA_SQL);
    return canonicalSchemaDigest(db);
  } finally {
    db.close();
  }
}

export const DIAGNOSTIC_SCHEMA_DIGEST = expectedSchemaDigest();
const ownershipLocks = new WeakMap();

function acquireSqliteLock(path) {
  const lock = new DatabaseSync(path);
  try {
    lock.exec('PRAGMA locking_mode=EXCLUSIVE; PRAGMA busy_timeout=1; BEGIN EXCLUSIVE');
  } catch (error) {
    lock.close();
    throw new Error('Diagnostic database already has an operating-system owner.', { cause: error });
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (lock.isTransaction) lock.exec('ROLLBACK');
    lock.close();
  };
}

export function acquireDiagnosticOwnership(path, {
  lockDirectory = process.env.CANNABEATS_DIAGNOSTIC_LOCK_DIRECTORY
    || resolve(tmpdir(), 'cannabeats-diagnostic-locks'),
} = {}) {
  const databasePath = resolve(path);
  mkdirSync(dirname(databasePath), { recursive: true });
  const canonicalPath = existsSync(databasePath)
    ? realpathSync(databasePath)
    : resolve(realpathSync(dirname(databasePath)), databasePath.split('/').at(-1));
  mkdirSync(lockDirectory, { recursive: true });
  const releases = [];
  const pathIdentity = createHash('sha256').update(canonicalPath).digest('hex');
  releases.push(acquireSqliteLock(resolve(lockDirectory, `${pathIdentity}.owner.sqlite`)));
  const ensureInode = () => {
    if (!existsSync(canonicalPath) || releases.length > 1) return;
    const stat = statSync(canonicalPath);
    try {
      releases.push(acquireSqliteLock(resolve(lockDirectory,
        `${stat.dev}-${stat.ino}.owner.sqlite`)));
    } catch (error) {
      releases.reverse().forEach((release) => release());
      throw error;
    }
  };
  ensureInode();
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    releases.reverse().forEach((close) => close());
  };
  release.ensureInode = ensureInode;
  return release;
}

export function validateDiagnosticStoreSchema(db) {
  const generation = db.prepare(`SELECT generation,contract_digest
    FROM diagnostic_schema_generations ORDER BY generation DESC LIMIT 1`).get();
  if (db.prepare('PRAGMA page_size').get().page_size !== 4096
    || generation?.generation !== DIAGNOSTIC_SCHEMA_GENERATION
    || generation?.contract_digest !== DIAGNOSTIC_SCHEMA_DIGEST
    || canonicalSchemaDigest(db) !== DIAGNOSTIC_SCHEMA_DIGEST) {
    throw new Error('schema_incompatible');
  }
  return { generation: generation.generation, contractDigest: generation.contract_digest };
}

export function createDiagnosticStore(path, {
  now = Date.now(), ownershipAlreadyHeld = false, lockDirectory,
} = {}) {
  const databasePath = resolve(path);
  mkdirSync(dirname(databasePath), { recursive: true });
  const releaseOwnership = ownershipAlreadyHeld
    ? null : acquireDiagnosticOwnership(databasePath, { lockDirectory });
  let db;
  try {
    const existing = existsSync(databasePath) && statSync(databasePath).size > 0;
    if (existing) {
      let inspection;
      try {
        inspection = new DatabaseSync(databasePath, { readOnly: true });
        validateDiagnosticStoreSchema(inspection);
      } catch (error) {
        throw new Error('schema_incompatible', { cause: error });
      } finally {
        inspection?.close();
      }
    }
    db = new DatabaseSync(databasePath);
    releaseOwnership?.ensureInode?.();
    db.exec(`PRAGMA page_size=4096; PRAGMA foreign_keys=ON;
      PRAGMA busy_timeout=5000; PRAGMA temp_store=MEMORY`);
    db.exec('BEGIN IMMEDIATE');
    const hasLedger = db.prepare(`SELECT 1 FROM sqlite_schema
      WHERE type='table' AND name='diagnostic_schema_generations'`).get();
    if (!hasLedger) {
      db.exec(DIAGNOSTIC_SCHEMA_SQL);
      db.prepare(`INSERT INTO diagnostic_schema_generations
        (generation,contract_digest,applied_at) VALUES (?,?,?)`)
        .run(DIAGNOSTIC_SCHEMA_GENERATION, DIAGNOSTIC_SCHEMA_DIGEST, now);
      db.prepare(`INSERT INTO diagnostic_store(singleton)
        VALUES ('diagnostics')`).run();
    }
    validateDiagnosticStoreSchema(db);
    db.exec('COMMIT');
    db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=256');
    if (releaseOwnership) ownershipLocks.set(db, releaseOwnership);
    return db;
  } catch (error) {
    if (db?.isTransaction) db.exec('ROLLBACK');
    db?.close();
    releaseOwnership?.();
    throw error;
  }
}

export function closeDiagnosticStore(db) {
  const release = ownershipLocks.get(db);
  try {
    db.close();
  } finally {
    ownershipLocks.delete(db);
    release?.();
  }
}
