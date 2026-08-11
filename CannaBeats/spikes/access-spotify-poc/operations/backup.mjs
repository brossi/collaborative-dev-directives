#!/usr/bin/env node
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
} from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const FORMAT = 'cannabeats-sqlite-backup';
const FORMAT_VERSION = 1;
const KDF = Object.freeze({ name: 'scrypt', N: 16_384, r: 8, p: 1, keyLength: 32 });
const CIPHER = 'aes-256-gcm';
const BACKUP_NAME = /^cannabeats-\d{4}-\d{2}-\d{2}T\d{6}Z\.cbbackup$/;

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

function value(args, name, fallback = '') {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return fallback;
  if (!args[index + 1] || args[index + 1].startsWith('--')) {
    throw new Error(`--${name} requires a value`);
  }
  return args[index + 1];
}

function required(args, name, fallback = '') {
  const result = value(args, name, fallback);
  if (!result) throw new Error(`--${name} is required`);
  return result;
}

function passphrase(path) {
  const secret = readFileSync(path, 'utf8').replace(/[\r\n]+$/, '');
  if (Buffer.byteLength(secret) < 20) {
    throw new Error('Backup passphrase must contain at least 20 bytes');
  }
  return secret;
}

function timestampName(now = new Date()) {
  return `cannabeats-${now.toISOString().replace(/:/g, '').replace(/\.\d{3}Z$/, 'Z')}.cbbackup`;
}

function validatedDatabase(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec('PRAGMA query_only = ON; PRAGMA foreign_keys = ON;');
    const integrity = db.prepare('PRAGMA integrity_check').all();
    if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') {
      throw new Error(`SQLite integrity check failed: ${JSON.stringify(integrity)}`);
    }
    const foreignKeys = db.prepare('PRAGMA foreign_key_check').all();
    if (foreignKeys.length) {
      throw new Error(`SQLite foreign-key check failed with ${foreignKeys.length} violation(s)`);
    }
    return {
      userVersion: db.prepare('PRAGMA user_version').get().user_version,
      tables: db.prepare(`
        SELECT name FROM sqlite_schema
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
        ORDER BY name
      `).all().map((row) => row.name),
    };
  } finally {
    db.close();
  }
}

function encryptSnapshot(snapshot, metadata, secret) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(secret, salt, KDF.keyLength, {
    N: KDF.N,
    r: KDF.r,
    p: KDF.p,
    maxmem: 64 * 1024 * 1024,
  });
  const header = Buffer.from(JSON.stringify({
    format: FORMAT,
    formatVersion: FORMAT_VERSION,
    createdAt: metadata.createdAt,
    applicationVersion: metadata.applicationVersion,
    catalogVersion: metadata.catalogVersion,
    database: {
      bytes: snapshot.byteLength,
      sha256: sha256(snapshot),
      userVersion: metadata.userVersion,
      tables: metadata.tables,
    },
    crypto: {
      cipher: CIPHER,
      kdf: KDF,
      salt: salt.toString('base64'),
      iv: iv.toString('base64'),
    },
  }));
  const cipher = createCipheriv(CIPHER, key, iv);
  cipher.setAAD(header);
  const ciphertext = Buffer.concat([cipher.update(snapshot), cipher.final()]);
  return {
    header: header.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    authenticationTag: cipher.getAuthTag().toString('base64'),
  };
}

function decryptEnvelope(envelope, secret) {
  if (!envelope || typeof envelope !== 'object') throw new Error('Backup envelope is invalid');
  const header = Buffer.from(String(envelope.header ?? ''), 'base64');
  const metadata = JSON.parse(header.toString('utf8'));
  if (metadata.format !== FORMAT || metadata.formatVersion !== FORMAT_VERSION) {
    throw new Error('Backup format is not supported');
  }
  if (metadata.crypto?.cipher !== CIPHER || metadata.crypto?.kdf?.name !== KDF.name) {
    throw new Error('Backup encryption parameters are not supported');
  }
  if (metadata.crypto.kdf.N !== KDF.N || metadata.crypto.kdf.r !== KDF.r
      || metadata.crypto.kdf.p !== KDF.p || metadata.crypto.kdf.keyLength !== KDF.keyLength) {
    throw new Error('Backup key-derivation parameters are not supported');
  }
  const salt = Buffer.from(metadata.crypto.salt, 'base64');
  const iv = Buffer.from(metadata.crypto.iv, 'base64');
  const kdf = metadata.crypto.kdf;
  const key = scryptSync(secret, salt, kdf.keyLength, {
    N: kdf.N,
    r: kdf.r,
    p: kdf.p,
    maxmem: 64 * 1024 * 1024,
  });
  const decipher = createDecipheriv(CIPHER, key, iv);
  decipher.setAAD(header);
  decipher.setAuthTag(Buffer.from(String(envelope.authenticationTag ?? ''), 'base64'));
  const snapshot = Buffer.concat([
    decipher.update(Buffer.from(String(envelope.ciphertext ?? ''), 'base64')),
    decipher.final(),
  ]);
  if (snapshot.byteLength !== metadata.database.bytes || sha256(snapshot) !== metadata.database.sha256) {
    throw new Error('Backup database digest does not match its authenticated manifest');
  }
  return { metadata, snapshot };
}

function readBackup(path, secret) {
  const envelope = JSON.parse(readFileSync(path, 'utf8'));
  return decryptEnvelope(envelope, secret);
}

function assertManifestMatchesDatabase(metadata, database) {
  if (metadata.database.userVersion !== database.userVersion
      || JSON.stringify(metadata.database.tables) !== JSON.stringify(database.tables)) {
    throw new Error('Backup database structure does not match its authenticated manifest');
  }
}

export async function createBackup({
  databasePath,
  outputPath,
  passphraseFile,
  applicationVersion = 'unknown',
  catalogVersion = 'unknown',
  now = new Date(),
}) {
  if (!existsSync(databasePath) || !statSync(databasePath).isFile()) {
    throw new Error(`Database is missing or is not a regular file: ${databasePath}`);
  }
  if (existsSync(outputPath)) throw new Error(`Refusing to overwrite existing backup: ${outputPath}`);
  mkdirSync(dirname(outputPath), { recursive: true, mode: 0o700 });
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'cannabeats-backup-'));
  const snapshotPath = join(temporaryDirectory, 'snapshot.sqlite');
  try {
    const source = new DatabaseSync(databasePath, { readOnly: true });
    try {
      await backup(source, snapshotPath, { rate: 100 });
    } finally {
      source.close();
    }
    const database = validatedDatabase(snapshotPath);
    const snapshot = readFileSync(snapshotPath);
    const envelope = encryptSnapshot(snapshot, {
      createdAt: now.toISOString(),
      applicationVersion,
      catalogVersion,
      ...database,
    }, passphrase(passphraseFile));
    writeFileSync(outputPath, `${JSON.stringify(envelope)}\n`, { flag: 'wx', mode: 0o600 });
    chmodSync(outputPath, 0o600);
    return { outputPath, ...JSON.parse(Buffer.from(envelope.header, 'base64').toString('utf8')) };
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

export function verifyBackup({ backupPath, passphraseFile }) {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'cannabeats-verify-'));
  const databasePath = join(temporaryDirectory, 'verified.sqlite');
  try {
    const { metadata, snapshot } = readBackup(backupPath, passphrase(passphraseFile));
    writeFileSync(databasePath, snapshot, { flag: 'wx', mode: 0o600 });
    const database = validatedDatabase(databasePath);
    assertManifestMatchesDatabase(metadata, database);
    return { backupPath, ...metadata, verified: true, verifiedDatabase: database };
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

export function restoreBackup({ backupPath, outputPath, passphraseFile }) {
  if (existsSync(outputPath)) throw new Error(`Refusing to overwrite restore target: ${outputPath}`);
  const { metadata, snapshot } = readBackup(backupPath, passphrase(passphraseFile));
  mkdirSync(dirname(outputPath), { recursive: true, mode: 0o700 });
  writeFileSync(outputPath, snapshot, { flag: 'wx', mode: 0o600 });
  try {
    const database = validatedDatabase(outputPath);
    assertManifestMatchesDatabase(metadata, database);
    return { outputPath, ...metadata, restored: true, restoredDatabase: database };
  } catch (error) {
    rmSync(outputPath, { force: true });
    throw error;
  }
}

export function pruneBackups({ directory, keep }) {
  const resolvedDirectory = resolve(directory);
  if (resolvedDirectory === '/' || resolvedDirectory === resolve('.')) {
    throw new Error('Backup pruning requires a dedicated directory');
  }
  if (!Number.isInteger(keep) || keep < 2 || keep > 365) {
    throw new Error('--keep must be an integer between 2 and 365');
  }
  const candidates = readdirSync(resolvedDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && BACKUP_NAME.test(entry.name))
    .map((entry) => ({
      name: entry.name,
      path: join(resolvedDirectory, entry.name),
    }))
    .sort((left, right) => right.name.localeCompare(left.name));
  const removed = [];
  for (const candidate of candidates.slice(keep)) {
    rmSync(candidate.path);
    removed.push(candidate.name);
  }
  return { directory: resolvedDirectory, kept: candidates.slice(0, keep).map((entry) => entry.name), removed };
}

function usage() {
  return [
    'Usage:',
    '  node operations/backup.mjs create --database PATH --passphrase-file PATH [--output PATH] [--directory PATH] [--application-version VERSION] [--catalog-version VERSION]',
    '  node operations/backup.mjs run --database PATH --passphrase-file PATH --directory PATH [--keep COUNT]',
    '  node operations/backup.mjs verify --backup PATH --passphrase-file PATH',
    '  node operations/backup.mjs restore --backup PATH --output PATH --passphrase-file PATH',
    '  node operations/backup.mjs prune --directory PATH --keep COUNT',
  ].join('\n');
}

async function main(args = process.argv.slice(2)) {
  const command = args[0];
  if (command === 'run') {
    const directory = resolve(required(args, 'directory', process.env.CANNABEATS_BACKUP_DIRECTORY || ''));
    const passphraseFile = resolve(required(
      args, 'passphrase-file', process.env.CANNABEATS_BACKUP_PASSPHRASE_FILE || '',
    ));
    const outputPath = resolve(value(args, 'output', join(directory, timestampName())));
    const created = await createBackup({
      databasePath: resolve(required(args, 'database', process.env.DATABASE_PATH || '')),
      outputPath,
      passphraseFile,
      applicationVersion: value(args, 'application-version', process.env.CANNABEATS_APP_VERSION || 'unknown'),
      catalogVersion: value(args, 'catalog-version', process.env.CANNABEATS_CATALOG_VERSION || 'unknown'),
    });
    const verified = verifyBackup({ backupPath: outputPath, passphraseFile });
    const retention = pruneBackups({
      directory,
      keep: Number(value(args, 'keep', process.env.CANNABEATS_BACKUP_KEEP || 14)),
    });
    console.log(JSON.stringify({ created, verified, retention }));
    return;
  }
  if (command === 'create') {
    const directory = resolve(value(args, 'directory', process.env.CANNABEATS_BACKUP_DIRECTORY || '/backups'));
    const outputPath = resolve(value(args, 'output', join(directory, timestampName())));
    const result = await createBackup({
      databasePath: resolve(required(args, 'database', process.env.DATABASE_PATH || '')),
      outputPath,
      passphraseFile: resolve(required(args, 'passphrase-file', process.env.CANNABEATS_BACKUP_PASSPHRASE_FILE || '')),
      applicationVersion: value(args, 'application-version', process.env.CANNABEATS_APP_VERSION || 'unknown'),
      catalogVersion: value(args, 'catalog-version', process.env.CANNABEATS_CATALOG_VERSION || 'unknown'),
    });
    console.log(JSON.stringify(result));
    return;
  }
  if (command === 'verify') {
    console.log(JSON.stringify(verifyBackup({
      backupPath: resolve(required(args, 'backup')),
      passphraseFile: resolve(required(args, 'passphrase-file', process.env.CANNABEATS_BACKUP_PASSPHRASE_FILE || '')),
    })));
    return;
  }
  if (command === 'restore') {
    console.log(JSON.stringify(restoreBackup({
      backupPath: resolve(required(args, 'backup')),
      outputPath: resolve(required(args, 'output')),
      passphraseFile: resolve(required(args, 'passphrase-file', process.env.CANNABEATS_BACKUP_PASSPHRASE_FILE || '')),
    })));
    return;
  }
  if (command === 'prune') {
    console.log(JSON.stringify(pruneBackups({
      directory: resolve(required(args, 'directory', process.env.CANNABEATS_BACKUP_DIRECTORY || '')),
      keep: Number(required(args, 'keep')),
    })));
    return;
  }
  if (command === 'help') {
    console.log(usage());
    return;
  }
  throw new Error(usage());
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath && invokedPath === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
