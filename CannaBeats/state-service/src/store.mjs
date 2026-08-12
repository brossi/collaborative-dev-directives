import { createHash } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { STATE_SCHEMA_GENERATION, STATE_SCHEMA_SQL } from "./schema.mjs";

function canonicalSchemaDigest(db) {
  const objects = db.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_schema
    WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name`).all().map((row) => ({ ...row }));
  return createHash("sha256").update(JSON.stringify(objects)).digest("hex");
}

function expectedSchemaDigest() {
  const expected = new DatabaseSync(":memory:");
  try {
    expected.exec("PRAGMA foreign_keys=ON");
    expected.exec(STATE_SCHEMA_SQL);
    return canonicalSchemaDigest(expected);
  } finally {
    expected.close();
  }
}

const EXPECTED_SCHEMA_DIGEST = expectedSchemaDigest();
const ownershipLocks = new WeakMap();

function acquireOwnershipLock(lockPath) {
  const lock = new DatabaseSync(lockPath);
  try {
    lock.exec("PRAGMA locking_mode=EXCLUSIVE; PRAGMA busy_timeout=1; BEGIN EXCLUSIVE");
  } catch (error) {
    lock.close();
    throw new Error("State database already has an operating-system owner.", { cause: error });
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (lock.isTransaction) lock.exec("ROLLBACK");
    lock.close();
  };
}

export function acquireStateOwnership(path, {
  lockDirectory = process.env.CANNABEATS_STATE_LOCK_DIRECTORY
    || resolve(tmpdir(), "cannabeats-state-locks"),
} = {}) {
  const databasePath = resolve(path);
  mkdirSync(dirname(databasePath), { recursive: true });
  const canonicalDatabasePath = existsSync(databasePath)
    ? realpathSync(databasePath)
    : resolve(realpathSync(dirname(databasePath)), databasePath.split("/").at(-1));
  const releases = [];
  const canonicalLockDirectory = resolve(lockDirectory);
  mkdirSync(canonicalLockDirectory, { recursive: true });
  const pathIdentity = createHash("sha256").update(canonicalDatabasePath).digest("hex");
  releases.push(acquireOwnershipLock(resolve(canonicalLockDirectory,
    `${pathIdentity}.owner.sqlite`)));
  const acquireInode = () => {
    if (!existsSync(canonicalDatabasePath) || releases.length > 1) return;
    const stat = statSync(canonicalDatabasePath);
    try {
      releases.push(acquireOwnershipLock(resolve(canonicalLockDirectory,
        `${stat.dev}-${stat.ino}.owner.sqlite`)));
    } catch (error) {
      releases.reverse().forEach((release) => release());
      throw error;
    }
  };
  acquireInode();
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    releases.reverse().forEach((close) => close());
  };
  release.ensureInode = acquireInode;
  return release;
}

export function validateStateStoreSchema(db) {
  const generation = db.prepare(`SELECT generation,contract_digest
    FROM state_schema_generations ORDER BY generation DESC LIMIT 1`).get();
  if (generation?.generation !== STATE_SCHEMA_GENERATION
      || generation?.contract_digest !== EXPECTED_SCHEMA_DIGEST
      || canonicalSchemaDigest(db) !== EXPECTED_SCHEMA_DIGEST) {
    throw new Error("State database generation is not compatible with this state service.");
  }
  return { generation: generation.generation, contractDigest: generation.contract_digest };
}

export function createStateStore(path, {
  now = Date.now(), ownershipAlreadyHeld = false, lockDirectory,
} = {}) {
  const databasePath = resolve(path);
  mkdirSync(dirname(databasePath), { recursive: true });
  const releaseOwnership = ownershipAlreadyHeld
    ? null : acquireStateOwnership(databasePath, { lockDirectory });
  let db;
  try {
    db = new DatabaseSync(databasePath);
    releaseOwnership?.ensureInode?.();
  } catch (error) {
    releaseOwnership?.();
    throw error;
  }
  try {
    db.exec("PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000");
    db.exec("BEGIN IMMEDIATE");
    const hasLedger = db.prepare(`SELECT 1 FROM sqlite_schema
      WHERE type='table' AND name='state_schema_generations'`).get();
    if (!hasLedger) {
      db.exec(STATE_SCHEMA_SQL);
      db.prepare(`INSERT INTO state_schema_generations
        (generation,contract_digest,applied_at) VALUES (?,?,?)`)
        .run(STATE_SCHEMA_GENERATION, EXPECTED_SCHEMA_DIGEST, now);
      db.prepare(`INSERT INTO state_authority
        (singleton,status) VALUES ('state','candidate')`).run();
    }
    validateStateStoreSchema(db);
    db.exec("COMMIT");
    if (releaseOwnership) ownershipLocks.set(db, releaseOwnership);
    return db;
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    db.close();
    releaseOwnership?.();
    throw error;
  }
}

export function closeStateStore(db) {
  const releaseOwnership = ownershipLocks.get(db);
  try {
    db.close();
  } finally {
    ownershipLocks.delete(db);
    releaseOwnership?.();
  }
}

export function openStateStoreReadOnly(path) {
  const db = new DatabaseSync(resolve(path), { readOnly: true });
  db.exec("PRAGMA query_only=ON; PRAGMA foreign_keys=ON");
  return db;
}
