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

test('the expand bridge reads schema two without lowering its version', () => {
  const databasePath = join(root, 'bridge-v2.sqlite');
  const versionTwo = new DatabaseSync(databasePath);
  versionTwo.exec('PRAGMA user_version = 2');
  versionTwo.close();

  const bridged = openDatabase(databasePath);
  assert.equal(bridged.prepare('PRAGMA user_version').get().user_version, 2);
  assert.equal(bridged.prepare(`
    SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table' AND name = 'users'
  `).get().count, 1);
  bridged.close();
});

test('database initialization rejects versions newer than the bridge before changing structure', () => {
  const databasePath = join(root, 'newer.sqlite');
  const future = new DatabaseSync(databasePath);
  future.exec('PRAGMA user_version = 3');
  future.close();

  let unexpectedlyOpened;
  try {
    assert.throws(
      () => { unexpectedlyOpened = openDatabase(databasePath); },
      /schema version 3 is newer than supported version 2/i,
    );
  } finally {
    unexpectedlyOpened?.close();
  }

  const inspected = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal(inspected.prepare('PRAGMA user_version').get().user_version, 3);
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
  assert.match(gameDatabase, /DATABASE_SCHEMA_MAX_VERSION = 2/);
  assert.match(gameDatabase, /DATABASE_SCHEMA_TARGET_VERSION = 1/);
  assert.match(gameDatabase, /Math\.max\(startingVersion, DATABASE_SCHEMA_TARGET_VERSION\)/);
  assert.match(gameDatabase, /CREATE TABLE IF NOT EXISTS game_action_receipts/);
  assert.match(gameDatabase, /run_id TEXT NOT NULL REFERENCES game_runs\(id\) ON DELETE CASCADE/);

  const compose = readFileSync('compose.yaml', 'utf8');
  for (const [name, version] of Object.entries(contract)) {
    assert.equal(compose.match(new RegExp(`${name}: "${version}"`, 'g'))?.length, 3);
  }
});

test('runtime services reject deployment metadata that differs from their compiled schema contract', async () => {
  const previous = process.env.CANNABEATS_SCHEMA_TARGET_VERSION;
  process.env.CANNABEATS_SCHEMA_TARGET_VERSION = '2';
  try {
    assert.throws(
      () => openDatabase(join(root, 'access-contract-drift.sqlite')),
      /does not match compiled schema contract 1/i,
    );
    process.env.CANNABEATS_DATABASE_PATH = join(root, 'game-contract-drift.sqlite');
    const { database: gameDatabase } = await import('../../../web/lib/server/database.ts');
    assert.throws(
      () => gameDatabase(),
      /does not match compiled schema contract 1/i,
    );
  } finally {
    if (previous === undefined) delete process.env.CANNABEATS_SCHEMA_TARGET_VERSION;
    else process.env.CANNABEATS_SCHEMA_TARGET_VERSION = previous;
  }
});
