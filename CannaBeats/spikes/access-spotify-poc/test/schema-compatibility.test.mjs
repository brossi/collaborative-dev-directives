import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import {
  DATABASE_SCHEMA_MAX_VERSION,
  DATABASE_SCHEMA_MIN_VERSION,
  DATABASE_SCHEMA_TARGET_VERSION,
  openDatabase,
} from '../db.mjs';

const root = mkdtempSync(join(tmpdir(), 'cannabeats-schema-test-'));
after(() => rmSync(root, { recursive: true, force: true }));

test('database initialization migrates schema version zero to the current version atomically', () => {
  const databasePath = join(root, 'migrate.sqlite');
  const db = openDatabase(databasePath);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table' AND name = 'users'
  `).get().count, 1);
  db.close();
});

test('database initialization rejects a newer schema before changing its structure', () => {
  const databasePath = join(root, 'newer.sqlite');
  const future = new DatabaseSync(databasePath);
  future.exec('PRAGMA user_version = 2');
  future.close();

  let unexpectedlyOpened;
  try {
    assert.throws(
      () => { unexpectedlyOpened = openDatabase(databasePath); },
      /schema version 2 is newer than supported version 1/i,
    );
  } finally {
    unexpectedlyOpened?.close();
  }

  const inspected = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal(inspected.prepare('PRAGMA user_version').get().user_version, 2);
  assert.equal(inspected.prepare(`
    SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table' AND name = 'users'
  `).get().count, 0);
  inspected.close();
});

test('access, game, Compose, and release tooling declare one schema compatibility contract', () => {
  const contract = Object.fromEntries(readFileSync('deploy/schema-compatibility.env', 'utf8')
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => line.split('=')));
  assert.deepEqual(contract, {
    CANNABEATS_SCHEMA_MIN_VERSION: String(DATABASE_SCHEMA_MIN_VERSION),
    CANNABEATS_SCHEMA_MAX_VERSION: String(DATABASE_SCHEMA_MAX_VERSION),
    CANNABEATS_SCHEMA_TARGET_VERSION: String(DATABASE_SCHEMA_TARGET_VERSION),
  });

  const gameDatabase = readFileSync(resolve('../../web/lib/server/database.ts'), 'utf8');
  assert.match(gameDatabase, /DATABASE_SCHEMA_MIN_VERSION = 0/);
  assert.match(gameDatabase, /DATABASE_SCHEMA_MAX_VERSION = 1/);
  assert.match(gameDatabase, /DATABASE_SCHEMA_TARGET_VERSION = 1/);

  const compose = readFileSync('compose.yaml', 'utf8');
  for (const [name, version] of Object.entries(contract)) {
    assert.equal(compose.match(new RegExp(`${name}: "${version}"`, 'g'))?.length, 3);
  }
});
