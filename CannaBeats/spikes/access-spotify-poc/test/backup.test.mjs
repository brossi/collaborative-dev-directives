import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import {
  createBackup,
  pruneBackups,
  restoreBackup,
  verifyBackup,
} from '../operations/backup.mjs';
import { openDatabase } from '../db.mjs';

const root = mkdtempSync(join(tmpdir(), 'cannabeats-backup-test-'));
after(() => rmSync(root, { recursive: true, force: true }));

function fixture() {
  const directory = mkdtempSync(join(root, 'case-'));
  const databasePath = join(directory, 'live.sqlite');
  const backupPath = join(directory, 'backups', 'cannabeats-2026-08-11T120000Z.cbbackup');
  const restoredPath = join(directory, 'restore', 'restored.sqlite');
  const passphraseFile = join(directory, 'backup-passphrase');
  writeFileSync(passphraseFile, 'correct horse battery staple for tests\n', { mode: 0o600 });
  const db = openDatabase(databasePath);
  const userId = randomUUID();
  db.prepare('INSERT INTO users (id, display_name, role, created_at) VALUES (?, ?, ?, ?)')
    .run(userId, 'Backup Test Host', 'host', Date.now());
  db.prepare(`
    INSERT INTO user_capabilities (user_id, capability, created_at) VALUES (?, 'manage_host_invitations', ?)
  `).run(userId, Date.now());
  db.prepare(`
    INSERT INTO desktop_sessions
      (token_hash, user_id, display_name, created_at, expires_at, last_seen_at)
    VALUES ('test-desktop-hash', ?, 'Backup Test Desktop', ?, ?, ?)
  `).run(userId, Date.now(), Date.now() + 60_000, Date.now());
  db.prepare(`
    INSERT INTO game_sessions (code, host_user_id, status, created_at, updated_at)
    VALUES ('BKP234', ?, 'playing', ?, ?)
  `).run(userId, Date.now(), Date.now());
  db.exec(`
    CREATE TABLE game_runs (
      id TEXT PRIMARY KEY,
      session_code TEXT NOT NULL REFERENCES game_sessions(code) ON DELETE CASCADE,
      state TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      ended_at INTEGER
    );
    CREATE TABLE managed_audio_sources (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      enabled INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER,
      device_id TEXT,
      last_error TEXT
    );
  `);
  const runId = randomUUID();
  db.prepare(`
    INSERT INTO game_runs (id, session_code, state, created_at, updated_at)
    VALUES (?, 'BKP234', '{"phase":"playing","round":2}', ?, ?)
  `).run(runId, Date.now(), Date.now());
  db.prepare('UPDATE game_sessions SET active_run_id = ? WHERE code = ?').run(runId, 'BKP234');
  db.prepare(`
    INSERT INTO managed_audio_sources (id, display_name, token_hash, enabled, created_at)
    VALUES (?, 'Backup Test Source', 'test-source-token-hash', 1, ?)
  `).run(randomUUID(), Date.now());
  db.close();
  return { directory, databasePath, backupPath, restoredPath, passphraseFile, userId, runId };
}

test('an encrypted online backup restores a consistent SQLite database', async () => {
  const paths = fixture();
  const created = await createBackup({
    databasePath: paths.databasePath,
    outputPath: paths.backupPath,
    passphraseFile: paths.passphraseFile,
    applicationVersion: 'git-test',
    catalogVersion: 'catalog-test',
    now: new Date('2026-08-11T12:00:00Z'),
  });
  assert.equal(created.applicationVersion, 'git-test');
  assert.equal(created.catalogVersion, 'catalog-test');
  assert.ok(created.database.tables.includes('users'));
  const serialized = readFileSync(paths.backupPath, 'utf8');
  assert.doesNotMatch(serialized, /Backup Test Host/);

  const verified = verifyBackup({
    backupPath: paths.backupPath,
    passphraseFile: paths.passphraseFile,
  });
  assert.equal(verified.verified, true);

  const restored = restoreBackup({
    backupPath: paths.backupPath,
    outputPath: paths.restoredPath,
    passphraseFile: paths.passphraseFile,
  });
  assert.equal(restored.restored, true);
  const db = new DatabaseSync(paths.restoredPath, { readOnly: true });
  assert.equal(db.prepare('SELECT display_name FROM users WHERE id = ?').get(paths.userId).display_name,
    'Backup Test Host');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM user_capabilities').get().count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM desktop_sessions').get().count, 1);
  assert.equal(db.prepare('SELECT active_run_id FROM game_sessions WHERE code = ?').get('BKP234').active_run_id,
    paths.runId);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM managed_audio_sources').get().count, 1);
  db.close();
});

test('wrong credentials and tampering fail authentication', async () => {
  const paths = fixture();
  await createBackup({
    databasePath: paths.databasePath,
    outputPath: paths.backupPath,
    passphraseFile: paths.passphraseFile,
  });
  const wrongPassphrase = join(paths.directory, 'wrong-passphrase');
  writeFileSync(wrongPassphrase, 'this is definitely not the right passphrase\n', { mode: 0o600 });
  assert.throws(() => verifyBackup({
    backupPath: paths.backupPath,
    passphraseFile: wrongPassphrase,
  }));

  const envelope = JSON.parse(readFileSync(paths.backupPath, 'utf8'));
  envelope.ciphertext = `${envelope.ciphertext.slice(0, -4)}AAAA`;
  writeFileSync(paths.backupPath, JSON.stringify(envelope));
  assert.throws(() => verifyBackup({
    backupPath: paths.backupPath,
    passphraseFile: paths.passphraseFile,
  }));
});

test('restore and create refuse to overwrite material', async () => {
  const paths = fixture();
  await createBackup({
    databasePath: paths.databasePath,
    outputPath: paths.backupPath,
    passphraseFile: paths.passphraseFile,
  });
  await assert.rejects(createBackup({
    databasePath: paths.databasePath,
    outputPath: paths.backupPath,
    passphraseFile: paths.passphraseFile,
  }), /Refusing to overwrite/);
  mkdirSync(join(paths.directory, 'restore'));
  writeFileSync(paths.restoredPath, 'existing', { flag: 'wx' });
  assert.throws(() => restoreBackup({
    backupPath: paths.backupPath,
    outputPath: paths.restoredPath,
    passphraseFile: paths.passphraseFile,
  }), /Refusing to overwrite/);
});

test('retention removes only recognized backup artifacts beyond the keep count', () => {
  const directory = mkdtempSync(join(root, 'retention-'));
  for (let day = 1; day <= 4; day += 1) {
    writeFileSync(join(directory, `cannabeats-2026-08-0${day}T120000Z.cbbackup`), String(day));
  }
  writeFileSync(join(directory, 'keep-me.txt'), 'not a backup');
  const result = pruneBackups({ directory, keep: 2 });
  assert.equal(result.removed.length, 2);
  assert.equal(readFileSync(join(directory, 'keep-me.txt'), 'utf8'), 'not a backup');
  assert.deepEqual(result.kept, [
    'cannabeats-2026-08-04T120000Z.cbbackup',
    'cannabeats-2026-08-03T120000Z.cbbackup',
  ]);
});
