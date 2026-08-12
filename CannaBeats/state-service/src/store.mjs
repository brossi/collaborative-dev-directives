import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { STATE_SCHEMA_DIGEST, STATE_SCHEMA_GENERATION, STATE_SCHEMA_SQL } from "./schema.mjs";

export function createStateStore(path, { now = Date.now() } = {}) {
  const databasePath = resolve(path);
  mkdirSync(dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  try {
    db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000");
    db.exec("BEGIN IMMEDIATE");
    const hasLedger = db.prepare(`SELECT 1 FROM sqlite_schema
      WHERE type='table' AND name='state_schema_generations'`).get();
    if (!hasLedger) {
      db.exec(STATE_SCHEMA_SQL);
      db.prepare(`INSERT INTO state_schema_generations
        (generation,contract_digest,applied_at) VALUES (?,?,?)`)
        .run(STATE_SCHEMA_GENERATION, STATE_SCHEMA_DIGEST, now);
      db.prepare(`INSERT INTO state_authority
        (singleton,status) VALUES ('state','candidate')`).run();
    }
    const generation = db.prepare(`SELECT generation,contract_digest
      FROM state_schema_generations ORDER BY generation DESC LIMIT 1`).get();
    if (generation?.generation !== STATE_SCHEMA_GENERATION
        || generation?.contract_digest !== STATE_SCHEMA_DIGEST) {
      throw new Error("State database generation is not compatible with this state service.");
    }
    db.exec("COMMIT");
    return db;
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    db.close();
    throw error;
  }
}

export function openStateStoreReadOnly(path) {
  const db = new DatabaseSync(resolve(path), { readOnly: true });
  db.exec("PRAGMA query_only=ON; PRAGMA foreign_keys=ON");
  return db;
}
