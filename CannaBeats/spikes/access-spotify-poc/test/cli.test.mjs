import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { promisify } from 'node:util';
import { openDatabase, sha256 } from '../db.mjs';

const run = promisify(execFile);
const root = mkdtempSync(join(tmpdir(), 'cannabeats-cli-test-'));
after(() => rmSync(root, { recursive: true, force: true }));

test('managed-source registration and rotation store only token hashes', async () => {
  const databasePath = join(root, 'managed-source.sqlite');
  const db = openDatabase(databasePath);
  db.exec(`
    CREATE TABLE managed_audio_sources (
      id TEXT PRIMARY KEY, display_name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
      enabled INTEGER NOT NULL, created_at INTEGER NOT NULL, last_seen_at INTEGER,
      device_id TEXT, last_error TEXT
    );
    CREATE TABLE managed_audio_leases (
      id TEXT PRIMARY KEY, source_id TEXT NOT NULL UNIQUE REFERENCES managed_audio_sources(id),
      session_code TEXT NOT NULL UNIQUE REFERENCES game_sessions(code),
      acquired_by TEXT NOT NULL REFERENCES users(id), acquired_at INTEGER NOT NULL,
      renewed_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      playback_status TEXT NOT NULL, last_error TEXT
    );
  `);
  db.close();
  const env = { ...process.env, DATABASE_PATH: databasePath };
  const registered = JSON.parse((await run(process.execPath,
    ['cli.mjs', 'managed-source', 'register', '--name', 'Test Source'], { env })).stdout);
  assert.equal(registered.shownOnce, true);

  const check = openDatabase(databasePath);
  assert.equal(check.prepare('SELECT token_hash FROM managed_audio_sources WHERE id = ?')
    .get(registered.sourceId).token_hash, sha256(registered.token));
  check.close();

  const listed = (await run(process.execPath, ['cli.mjs', 'managed-source', 'list'], { env })).stdout;
  assert.doesNotMatch(listed, new RegExp(registered.token));
  const rotated = JSON.parse((await run(process.execPath, [
    'cli.mjs', 'managed-source', 'rotate', '--source-id', registered.sourceId,
  ], { env })).stdout);
  assert.notEqual(rotated.token, registered.token);
  await run(process.execPath, [
    'cli.mjs', 'managed-source', 'disable', '--source-id', registered.sourceId,
  ], { env });
  const disabled = openDatabase(databasePath);
  assert.equal(disabled.prepare('SELECT enabled FROM managed_audio_sources WHERE id = ?')
    .get(registered.sourceId).enabled, 0);
  disabled.close();
});
