import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync,mkdtempSync,rmSync } from 'node:fs';
import { createServer } from 'node:http';
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

test('state-owned CLI fails closed instead of mutating legacy managed-source rows', async () => {
  const databasePath = join(root,'state-required.sqlite');
  await assert.rejects(run(process.execPath,[
    'cli.mjs','managed-source','register','--name','Must Not Persist',
  ],{ env: {
    ...process.env,DATABASE_PATH: databasePath,CANNABEATS_STATE_WRITES_REQUIRED: 'true',
  } }),/State operator configuration is required/i);
  assert.equal(existsSync(databasePath),false);
});

test('bounded operator status preserves broad component checks and adds State authority', async () => {
  const databasePath = join(root,'operator-status.sqlite');
  openDatabase(databasePath).close();
  const server = createServer((request,response) => {
    response.setHeader('content-type','application/json');
    if (request.url.startsWith('/v1/admin/report')) return response.end(JSON.stringify({
      generatedAt: Date.now(),authority: { status: 'active' },sessions: [],
      sources: [{ enabled: true,lastSeenAt: Date.now(),lastErrorCategory: null }],
      sanitizationPending: 0,
    }));
    if (request.url === '/v1/admin/validate') return response.end(JSON.stringify({ valid: true }));
    if (request.url === '/api/ready' || request.url === '/game/api/ready') {
      return response.end(JSON.stringify({ ready: true }));
    }
    response.statusCode = 404;
    return response.end(JSON.stringify({ code: 'not_found' }));
  });
  await new Promise((resolve) => server.listen(0,'127.0.0.1',resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const result = JSON.parse((await run(process.execPath,[
      'cli.mjs','operator-status','--format','json','--fail-on','unavailable',
    ],{ env: {
      ...process.env,DATABASE_PATH: databasePath,APP_ORIGIN: origin,
      GAME_SERVICE_INTERNAL_ORIGIN: origin,CANNABEATS_STATE_SERVICE_ORIGIN: origin,
      CANNABEATS_STATE_OPERATOR_TOKEN: 'bounded-operator-token',
      CANNABEATS_STATE_WRITES_REQUIRED: 'true',
    } })).stdout);
    assert.equal(result.components.access.status,'healthy');
    assert.equal(result.components.game.status,'healthy');
    assert.equal(result.components.database.status,'healthy');
    assert.equal(result.components.managedSource.status,'healthy');
    assert.equal(result.components.state.status,'healthy');
    assert.equal(result.validation.valid,true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
