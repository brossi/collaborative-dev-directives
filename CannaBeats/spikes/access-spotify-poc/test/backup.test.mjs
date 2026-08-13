import assert from 'node:assert/strict';
import {
  createCipheriv,
  createHash,
  randomBytes,
  randomUUID,
  scryptSync,
} from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import {
  createBackup,
  pruneBackups,
  restoreBackup,
  verifyBackup,
} from '../operations/backup.mjs';
import { openDatabase } from '../db.mjs';
import { database as gameDatabase } from '../../../web/lib/server/database.ts';
import {
  acquireManagedAudioLease,
  beginManagedAudioCommand,
  claimManagedAudioCommand,
  completeManagedAudioCommand,
  enqueueManagedAudioCommand,
  pollManagedAudioSource,
  releaseManagedAudioLease,
} from '../../../web/lib/server/managed-audio.ts';

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
  const runId = randomUUID();
  const receiptId = randomUUID();
  db.close();
  process.env.CANNABEATS_DATABASE_PATH = databasePath;
  const gameDb = gameDatabase();
  gameDb.prepare(`
    INSERT INTO game_runs (id, session_code, state, created_at, updated_at)
    VALUES (?, 'BKP234', '{"phase":"playing","round":2}', ?, ?)
  `).run(runId, Date.now(), Date.now());
  gameDb.prepare('UPDATE game_sessions SET active_run_id = ? WHERE code = ?').run(runId, 'BKP234');
  gameDb.prepare(`
    INSERT INTO game_action_receipts
      (run_id, actor_id, action_id, action, request_fingerprint, accepted_at)
    VALUES (?, ?, ?, 'place', 'backup-fingerprint', ?)
  `).run(runId, userId, receiptId, Date.now());
  gameDb.prepare(`
    INSERT INTO game_events
      (run_id, sequence, event_type, outcome, actor_type, actor_ref, action_id,
       round, detail_code, occurred_at)
    VALUES (?, 1, 'placement_locked', 'accepted', 'host', ?, ?, 2, 'correct', ?)
  `).run(runId, userId, receiptId, Date.now());
  const sourceId = randomUUID();
  gameDb.prepare(`
    INSERT INTO managed_audio_sources (id, display_name, token_hash, enabled, created_at)
    VALUES (?, 'Backup Test Source', 'test-source-token-hash', 1, ?)
  `).run(sourceId, Date.now());
  pollManagedAudioSource(sourceId);
  acquireManagedAudioLease('BKP234', userId);
  const command = enqueueManagedAudioCommand(
    'BKP234', userId, 'play', 'spotify:track:backupOutcomeFixture',
  );
  const claimGeneration = randomUUID();
  claimManagedAudioCommand(sourceId, command.commandId, claimGeneration);
  beginManagedAudioCommand(sourceId, command.commandId, claimGeneration);
  assert.deepEqual(
    completeManagedAudioCommand(
      sourceId, command.commandId, true, 'playing', null, claimGeneration,
    ),
    { status: 'completed' },
  );
  releaseManagedAudioLease('BKP234');
  gameDb.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  return {
    directory, databasePath, backupPath, restoredPath, passphraseFile,
    userId, runId, receiptId, sourceId, commandId: command.commandId, claimGeneration,
  };
}

function legacyEnvelope(snapshot, metadata, secret) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const kdf = { name: 'scrypt', N: 16_384, r: 8, p: 1, keyLength: 32 };
  const header = Buffer.from(JSON.stringify({
    format: 'cannabeats-sqlite-backup',
    formatVersion: 1,
    createdAt: metadata.createdAt,
    applicationVersion: metadata.applicationVersion,
    catalogVersion: metadata.catalogVersion,
    database: {
      bytes: snapshot.byteLength,
      sha256: createHash('sha256').update(snapshot).digest('hex'),
      userVersion: metadata.userVersion,
      tables: metadata.tables,
    },
    crypto: {
      cipher: 'aes-256-gcm',
      kdf,
      salt: salt.toString('base64'),
      iv: iv.toString('base64'),
    },
  }));
  const key = scryptSync(secret, salt, kdf.keyLength, { ...kdf, maxmem: 64 * 1024 * 1024 });
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(header);
  const ciphertext = Buffer.concat([cipher.update(snapshot), cipher.final()]);
  return {
    header: header.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    authenticationTag: cipher.getAuthTag().toString('base64'),
  };
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
  assert.equal(db.prepare('SELECT actor_id FROM game_action_receipts WHERE action_id = ?')
    .get(paths.receiptId).actor_id, paths.userId);
  assert.deepEqual(db.prepare(`
    SELECT event_type, outcome, round FROM game_events WHERE run_id = ? ORDER BY sequence
  `).all(paths.runId).map((event) => ({ ...event })), [
    { event_type: 'placement_locked', outcome: 'accepted', round: 2 },
    { event_type: 'audio_command_completed', outcome: 'completed', round: null },
  ]);
  assert.deepEqual({ ...db.prepare(`
    SELECT baseline_revision, last_recorded_revision
    FROM game_event_coverage WHERE run_id = ?
  `).get(paths.runId) }, {
    baseline_revision: 0,
    last_recorded_revision: 0,
  });
  assert.equal(db.prepare("SELECT terminal_outcome FROM game_runs WHERE id = ?")
    .get(paths.runId).terminal_outcome, null);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM sqlite_schema
    WHERE type = 'trigger' AND name IN ('game_runs_advance_revision', 'game_sessions_advance_run_generation')
  `).get().count, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM managed_audio_sources').get().count, 1);
  assert.equal(
    db.prepare('SELECT device_id FROM managed_audio_sources WHERE id = ?').get(paths.sourceId).device_id,
    null,
  );
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM managed_audio_command_outcomes
    WHERE command_id = ? AND completed_at > 0
  `).get(paths.commandId).count, 1);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  db.close();
  process.env.CANNABEATS_DATABASE_PATH = paths.restoredPath;
  assert.deepEqual(
    completeManagedAudioCommand(
      paths.sourceId, paths.commandId, true, 'playing', null, paths.claimGeneration,
    ),
    { status: 'replayed' },
  );
});

test('restoring a legacy source device identifier clears it during current initialization', async () => {
  const directory = mkdtempSync(join(root, 'legacy-device-'));
  const databasePath = join(directory, 'legacy.sqlite');
  const backupPath = join(directory, 'legacy.cbbackup');
  const restoredPath = join(directory, 'restored.sqlite');
  const passphraseFile = join(directory, 'passphrase');
  writeFileSync(passphraseFile, 'correct horse battery staple for legacy device\n', { mode: 0o600 });
  const legacy = openDatabase(databasePath);
  const sourceId = randomUUID();
  legacy.exec(`
    CREATE TABLE managed_audio_sources (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER,
      device_id TEXT,
      last_error TEXT
    );
  `);
  legacy.prepare(`
    INSERT INTO managed_audio_sources
      (id, display_name, token_hash, enabled, created_at, device_id)
    VALUES (?, 'Legacy Source', ?, 1, ?, 'private-provider-device-sentinel')
  `).run(sourceId, `legacy-${randomUUID()}`, Date.now());
  legacy.close();
  await createBackup({ databasePath, outputPath: backupPath, passphraseFile });
  restoreBackup({ backupPath, outputPath: restoredPath, passphraseFile });
  process.env.CANNABEATS_DATABASE_PATH = restoredPath;
  const migrated = gameDatabase();
  assert.equal(
    migrated.prepare('SELECT device_id FROM managed_audio_sources WHERE id = ?').get(sourceId).device_id,
    null,
  );
});

test('online backup remains consistent while a WAL writer stays open and commits', async () => {
  const paths = fixture();
  const writer = new DatabaseSync(paths.databasePath);
  writer.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE backup_activity (
      id INTEGER PRIMARY KEY,
      marker TEXT NOT NULL,
      padding BLOB NOT NULL
    );
    BEGIN;
  `);
  const insert = writer.prepare('INSERT INTO backup_activity (marker, padding) VALUES (?, randomblob(8192))');
  for (let index = 0; index < 1_024; index += 1) insert.run(`before-${index}`);
  writer.exec('COMMIT');

  let concurrentWrites = 0;
  const writesFinished = new Promise((finish) => {
    const write = () => {
      insert.run(`during-${concurrentWrites}`);
      concurrentWrites += 1;
      if (concurrentWrites === 5) finish();
      else setTimeout(write, 2);
    };
    setImmediate(write);
  });
  try {
    const backupFinished = createBackup({
      databasePath: paths.databasePath,
      outputPath: paths.backupPath,
      passphraseFile: paths.passphraseFile,
    });
    await Promise.all([backupFinished, writesFinished]);
  } finally {
    writer.close();
  }
  assert.ok(concurrentWrites > 0, 'the writer should commit while the backup is running');

  restoreBackup({
    backupPath: paths.backupPath,
    outputPath: paths.restoredPath,
    passphraseFile: paths.passphraseFile,
  });
  const restored = new DatabaseSync(paths.restoredPath, { readOnly: true });
  assert.ok(restored.prepare('SELECT COUNT(*) AS count FROM backup_activity').get().count >= 1_024);
  assert.equal(restored.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  restored.close();
});

test('a failed atomic publication leaves no final or partial backup artifact', async () => {
  const paths = fixture();
  await assert.rejects(createBackup({
    databasePath: paths.databasePath,
    outputPath: paths.backupPath,
    passphraseFile: paths.passphraseFile,
    beforePublish() {
      throw new Error('injected publication failure');
    },
  }), /injected publication failure/);
  assert.equal(existsSync(paths.backupPath), false);
  assert.deepEqual(readdirSync(join(paths.directory, 'backups')), []);
});

test('atomic publication never overwrites a target created by a racing process', async () => {
  const paths = fixture();
  await assert.rejects(createBackup({
    databasePath: paths.databasePath,
    outputPath: paths.backupPath,
    passphraseFile: paths.passphraseFile,
    beforePublish() {
      writeFileSync(paths.backupPath, 'racing artifact', { flag: 'wx' });
    },
  }), /EEXIST/);
  assert.equal(readFileSync(paths.backupPath, 'utf8'), 'racing artifact');
  assert.deepEqual(readdirSync(join(paths.directory, 'backups')), [basename(paths.backupPath)]);
});

test('new backups stream databases larger than the former tmpfs limit', async () => {
  const paths = fixture();
  const writer = new DatabaseSync(paths.databasePath);
  writer.exec('CREATE TABLE large_backup_payload (payload BLOB NOT NULL)');
  writer.prepare('INSERT INTO large_backup_payload (payload) VALUES (zeroblob(?))')
    .run(66 * 1024 * 1024);
  writer.close();

  await createBackup({
    databasePath: paths.databasePath,
    outputPath: paths.backupPath,
    passphraseFile: paths.passphraseFile,
  });
  assert.ok(statSync(paths.backupPath).size > 64 * 1024 * 1024);
  const backup = openSync(paths.backupPath, 'r');
  const prefix = Buffer.alloc(18);
  readSync(backup, prefix, 0, prefix.byteLength, 0);
  closeSync(backup);
  assert.equal(prefix.toString('utf8'), 'CANNABEATS-BACKUP\n');

  restoreBackup({
    backupPath: paths.backupPath,
    outputPath: paths.restoredPath,
    passphraseFile: paths.passphraseFile,
  });
  const restored = new DatabaseSync(paths.restoredPath, { readOnly: true });
  assert.equal(restored.prepare('SELECT length(payload) AS bytes FROM large_backup_payload').get().bytes,
    66 * 1024 * 1024);
  restored.close();

  const compose = readFileSync(resolve('compose.yaml'), 'utf8');
  const backupService = compose.split('\n  backup:')[1].split('\n  history:')[0];
  assert.doesNotMatch(backupService, /\n    tmpfs:/);
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

  const artifact = openSync(paths.backupPath, 'r+');
  const tamperPosition = Math.floor(statSync(paths.backupPath).size / 2);
  const byte = Buffer.alloc(1);
  readSync(artifact, byte, 0, 1, tamperPosition);
  byte[0] ^= 1;
  writeSync(artifact, byte, 0, 1, tamperPosition);
  closeSync(artifact);
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

test('retention authenticates every candidate before removing recognized older backups', async () => {
  const directory = mkdtempSync(join(root, 'retention-'));
  const paths = fixture();
  for (let day = 1; day <= 4; day += 1) {
    await createBackup({
      databasePath: paths.databasePath,
      outputPath: join(directory, `cannabeats-2026-08-0${day}T120000Z.cbbackup`),
      passphraseFile: paths.passphraseFile,
      now: new Date(`2026-08-0${day}T12:00:00Z`),
    });
  }
  const corrupt = join(directory, 'cannabeats-2026-08-01T110000Z.cbbackup');
  writeFileSync(corrupt, 'not an authenticated CannaBeats backup');
  writeFileSync(join(directory, 'keep-me.txt'), 'not a backup');

  assert.throws(() => pruneBackups({
    directory,
    keep: 2,
    passphraseFile: paths.passphraseFile,
  }));
  assert.equal(readdirSync(directory).filter((name) => name.endsWith('.cbbackup')).length, 5);

  rmSync(corrupt);
  const result = pruneBackups({ directory, keep: 2, passphraseFile: paths.passphraseFile });
  assert.equal(result.removed.length, 2);
  assert.equal(readFileSync(join(directory, 'keep-me.txt'), 'utf8'), 'not a backup');
  assert.deepEqual(result.kept, [
    'cannabeats-2026-08-04T120000Z.cbbackup',
    'cannabeats-2026-08-03T120000Z.cbbackup',
  ]);
});

test('version-1 JSON envelopes remain verifiable and restorable', () => {
  const paths = fixture();
  const snapshot = readFileSync(paths.databasePath);
  const db = new DatabaseSync(paths.databasePath, { readOnly: true });
  const metadata = {
    createdAt: '2026-08-11T12:00:00.000Z',
    applicationVersion: 'legacy-app',
    catalogVersion: 'legacy-catalog',
    userVersion: db.prepare('PRAGMA user_version').get().user_version,
    tables: db.prepare(`
      SELECT name FROM sqlite_schema
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).all().map((row) => row.name),
  };
  db.close();
  const secret = readFileSync(paths.passphraseFile, 'utf8').trimEnd();
  mkdirSync(join(paths.directory, 'backups'));
  writeFileSync(paths.backupPath, `${JSON.stringify(legacyEnvelope(snapshot, metadata, secret))}\n`);

  const verified = verifyBackup({
    backupPath: paths.backupPath,
    passphraseFile: paths.passphraseFile,
  });
  assert.equal(verified.formatVersion, 1);
  const restored = restoreBackup({
    backupPath: paths.backupPath,
    outputPath: paths.restoredPath,
    passphraseFile: paths.passphraseFile,
  });
  assert.equal(restored.applicationVersion, 'legacy-app');
});
