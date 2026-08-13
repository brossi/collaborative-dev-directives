#!/usr/bin/env node
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
} from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const FORMAT = 'cannabeats-sqlite-backup';
const LEGACY_FORMAT_VERSION = 1;
const FORMAT_VERSION = 2;
const MAGIC = Buffer.from('CANNABEATS-BACKUP\n');
const HEADER_LENGTH_BYTES = 4;
const AUTHENTICATION_TAG_BYTES = 16;
const MAX_HEADER_BYTES = 1024 * 1024;
const IO_CHUNK_BYTES = 1024 * 1024;
const KDF = Object.freeze({ name: 'scrypt', N: 16_384, r: 8, p: 1, keyLength: 32 });
const CIPHER = 'aes-256-gcm';
const BACKUP_NAME = /^cannabeats-\d{4}-\d{2}-\d{2}T\d{6}Z\.cbbackup$/;

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

function temporaryPath(directory, targetName, purpose) {
  return join(directory, `.${targetName}.${purpose}-${randomBytes(12).toString('hex')}.partial`);
}

function writeAll(file, data) {
  let offset = 0;
  while (offset < data.byteLength) {
    offset += writeSync(file, data, offset, data.byteLength - offset);
  }
}

function readExactly(file, bytes, position) {
  const data = Buffer.alloc(bytes);
  let offset = 0;
  while (offset < bytes) {
    const count = readSync(file, data, offset, bytes - offset, position + offset);
    if (count === 0) throw new Error('Backup artifact is truncated');
    offset += count;
  }
  return data;
}

function syncDirectory(directory) {
  const file = openSync(directory, 'r');
  try {
    fsyncSync(file);
  } finally {
    closeSync(file);
  }
}

function hashFile(path) {
  const hash = createHash('sha256');
  const file = openSync(path, 'r');
  const chunk = Buffer.alloc(IO_CHUNK_BYTES);
  try {
    for (;;) {
      const count = readSync(file, chunk, 0, chunk.byteLength, null);
      if (count === 0) break;
      hash.update(chunk.subarray(0, count));
    }
    return hash.digest('hex');
  } finally {
    closeSync(file);
  }
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

function decodedFixedLength(valueToDecode, bytes, name) {
  const decoded = Buffer.from(String(valueToDecode ?? ''), 'base64');
  if (decoded.byteLength !== bytes) throw new Error(`Backup ${name} is invalid`);
  return decoded;
}

function validateMetadata(metadata, supportedVersion) {
  if (!metadata || typeof metadata !== 'object'
      || metadata.format !== FORMAT || metadata.formatVersion !== supportedVersion) {
    throw new Error('Backup format is not supported');
  }
  if (metadata.crypto?.cipher !== CIPHER || metadata.crypto?.kdf?.name !== KDF.name) {
    throw new Error('Backup encryption parameters are not supported');
  }
  const kdf = metadata.crypto.kdf;
  if (kdf.N !== KDF.N || kdf.r !== KDF.r || kdf.p !== KDF.p || kdf.keyLength !== KDF.keyLength) {
    throw new Error('Backup key-derivation parameters are not supported');
  }
  if (!Number.isSafeInteger(metadata.database?.bytes) || metadata.database.bytes < 0
      || !/^[a-f0-9]{64}$/.test(metadata.database.sha256)
      || !Number.isSafeInteger(metadata.database.userVersion)
      || !Array.isArray(metadata.database.tables)
      || metadata.database.tables.some((table) => typeof table !== 'string')) {
    throw new Error('Backup database manifest is invalid');
  }
  if (metadata.databaseRole !== undefined && !['access', 'state'].includes(metadata.databaseRole)) {
    throw new Error('Backup database role is invalid');
  }
  if (metadata.releaseEpoch !== undefined
      && (typeof metadata.releaseEpoch !== 'string' || !/^[A-Za-z0-9._:-]{1,160}$/.test(metadata.releaseEpoch))) {
    throw new Error('Backup release epoch is invalid');
  }
  if (metadata.recoverySetId !== undefined
      && (typeof metadata.recoverySetId !== 'string'
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
          .test(metadata.recoverySetId))) {
    throw new Error('Backup recovery-set identity is invalid');
  }
  if (metadata.authorityFloor !== undefined) {
    const floor = metadata.authorityFloor;
    if (metadata.databaseRole !== 'state' || !floor || typeof floor !== 'object'
        || floor.releaseEpoch !== metadata.releaseEpoch
        || (floor.firstAdmittedAt !== null
          && (!Number.isSafeInteger(floor.firstAdmittedAt) || floor.firstAdmittedAt <= 0))) {
      throw new Error('Backup authority-floor metadata is invalid');
    }
  }
  decodedFixedLength(metadata.crypto.salt, 16, 'salt');
  decodedFixedLength(metadata.crypto.iv, 12, 'initialization vector');
  return metadata;
}

function deriveKey(metadata, secret) {
  const salt = decodedFixedLength(metadata.crypto.salt, 16, 'salt');
  const kdf = metadata.crypto.kdf;
  return scryptSync(secret, salt, kdf.keyLength, {
    N: kdf.N,
    r: kdf.r,
    p: kdf.p,
    maxmem: 64 * 1024 * 1024,
  });
}

function encryptSnapshot(snapshotPath, encryptedPath, metadata, secret) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const snapshotBytes = statSync(snapshotPath).size;
  const authenticatedMetadata = {
    format: FORMAT,
    formatVersion: FORMAT_VERSION,
    createdAt: metadata.createdAt,
    applicationVersion: metadata.applicationVersion,
    catalogVersion: metadata.catalogVersion,
    ...(metadata.databaseRole ? { databaseRole: metadata.databaseRole } : {}),
    ...(metadata.releaseEpoch ? { releaseEpoch: metadata.releaseEpoch } : {}),
    ...(metadata.recoverySetId ? { recoverySetId: metadata.recoverySetId } : {}),
    ...(metadata.authorityFloor ? { authorityFloor: metadata.authorityFloor } : {}),
    database: {
      bytes: snapshotBytes,
      sha256: hashFile(snapshotPath),
      userVersion: metadata.userVersion,
      tables: metadata.tables,
    },
    crypto: {
      cipher: CIPHER,
      kdf: KDF,
      salt: salt.toString('base64'),
      iv: iv.toString('base64'),
    },
  };
  const header = Buffer.from(JSON.stringify(authenticatedMetadata));
  if (header.byteLength > MAX_HEADER_BYTES) throw new Error('Backup header is too large');
  const headerLength = Buffer.alloc(HEADER_LENGTH_BYTES);
  headerLength.writeUInt32BE(header.byteLength);
  const key = deriveKey(authenticatedMetadata, secret);
  const cipher = createCipheriv(CIPHER, key, iv);
  cipher.setAAD(header);
  const source = openSync(snapshotPath, 'r');
  const destination = openSync(encryptedPath, 'wx', 0o600);
  const chunk = Buffer.alloc(IO_CHUNK_BYTES);
  try {
    writeAll(destination, MAGIC);
    writeAll(destination, headerLength);
    writeAll(destination, header);
    for (;;) {
      const count = readSync(source, chunk, 0, chunk.byteLength, null);
      if (count === 0) break;
      writeAll(destination, cipher.update(chunk.subarray(0, count)));
    }
    writeAll(destination, cipher.final());
    writeAll(destination, cipher.getAuthTag());
    fsyncSync(destination);
  } finally {
    closeSync(destination);
    closeSync(source);
  }
  return authenticatedMetadata;
}

function readVersion2Header(file, artifactBytes) {
  const prefix = readExactly(file, MAGIC.byteLength, 0);
  if (!prefix.equals(MAGIC)) throw new Error('Backup format is not supported');
  const headerLength = readExactly(file, HEADER_LENGTH_BYTES, MAGIC.byteLength).readUInt32BE();
  if (headerLength < 2 || headerLength > MAX_HEADER_BYTES) throw new Error('Backup header is invalid');
  const headerOffset = MAGIC.byteLength + HEADER_LENGTH_BYTES;
  const header = readExactly(file, headerLength, headerOffset);
  const metadata = validateMetadata(JSON.parse(header.toString('utf8')), FORMAT_VERSION);
  const ciphertextOffset = headerOffset + headerLength;
  const expectedBytes = ciphertextOffset + metadata.database.bytes + AUTHENTICATION_TAG_BYTES;
  if (artifactBytes !== expectedBytes) throw new Error('Backup artifact length does not match its manifest');
  return { ciphertextOffset, header, metadata };
}

function isVersion2Backup(path) {
  const file = openSync(path, 'r');
  try {
    if (statSync(path).size < MAGIC.byteLength) return false;
    return readExactly(file, MAGIC.byteLength, 0).equals(MAGIC);
  } finally {
    closeSync(file);
  }
}

function decryptVersion2ToPath(backupPath, outputPath, secret) {
  const source = openSync(backupPath, 'r');
  let destination;
  try {
    const artifactBytes = statSync(backupPath).size;
    const { ciphertextOffset, header, metadata } = readVersion2Header(source, artifactBytes);
    const tagPosition = artifactBytes - AUTHENTICATION_TAG_BYTES;
    const tag = readExactly(source, AUTHENTICATION_TAG_BYTES, tagPosition);
    const key = deriveKey(metadata, secret);
    const iv = decodedFixedLength(metadata.crypto.iv, 12, 'initialization vector');
    const decipher = createDecipheriv(CIPHER, key, iv);
    decipher.setAAD(header);
    decipher.setAuthTag(tag);
    destination = openSync(outputPath, 'wx', 0o600);
    const hash = createHash('sha256');
    let plaintextBytes = 0;
    let position = ciphertextOffset;
    let remaining = metadata.database.bytes;
    while (remaining > 0) {
      const bytes = Math.min(IO_CHUNK_BYTES, remaining);
      const encrypted = readExactly(source, bytes, position);
      const plaintext = decipher.update(encrypted);
      writeAll(destination, plaintext);
      hash.update(plaintext);
      plaintextBytes += plaintext.byteLength;
      position += bytes;
      remaining -= bytes;
    }
    const final = decipher.final();
    writeAll(destination, final);
    hash.update(final);
    plaintextBytes += final.byteLength;
    if (plaintextBytes !== metadata.database.bytes || hash.digest('hex') !== metadata.database.sha256) {
      throw new Error('Backup database digest does not match its authenticated manifest');
    }
    fsyncSync(destination);
    closeSync(destination);
    destination = undefined;
    return metadata;
  } catch (error) {
    if (destination !== undefined) closeSync(destination);
    rmSync(outputPath, { force: true });
    throw error;
  } finally {
    closeSync(source);
  }
}

function decryptLegacyEnvelope(envelope, secret) {
  if (!envelope || typeof envelope !== 'object') throw new Error('Backup envelope is invalid');
  const header = Buffer.from(String(envelope.header ?? ''), 'base64');
  const metadata = validateMetadata(JSON.parse(header.toString('utf8')), LEGACY_FORMAT_VERSION);
  const key = deriveKey(metadata, secret);
  const iv = decodedFixedLength(metadata.crypto.iv, 12, 'initialization vector');
  const decipher = createDecipheriv(CIPHER, key, iv);
  decipher.setAAD(header);
  decipher.setAuthTag(decodedFixedLength(
    envelope.authenticationTag, AUTHENTICATION_TAG_BYTES, 'authentication tag',
  ));
  const snapshot = Buffer.concat([
    decipher.update(Buffer.from(String(envelope.ciphertext ?? ''), 'base64')),
    decipher.final(),
  ]);
  if (snapshot.byteLength !== metadata.database.bytes
      || createHash('sha256').update(snapshot).digest('hex') !== metadata.database.sha256) {
    throw new Error('Backup database digest does not match its authenticated manifest');
  }
  return { metadata, snapshot };
}

function materializeBackup(backupPath, outputPath, secret) {
  if (isVersion2Backup(backupPath)) return decryptVersion2ToPath(backupPath, outputPath, secret);
  const envelope = JSON.parse(readFileSync(backupPath, 'utf8'));
  const { metadata, snapshot } = decryptLegacyEnvelope(envelope, secret);
  const destination = openSync(outputPath, 'wx', 0o600);
  try {
    writeAll(destination, snapshot);
    fsyncSync(destination);
  } catch (error) {
    closeSync(destination);
    rmSync(outputPath, { force: true });
    throw error;
  }
  closeSync(destination);
  return metadata;
}

function assertManifestMatchesDatabase(metadata, database) {
  if (metadata.database.userVersion !== database.userVersion
      || JSON.stringify(metadata.database.tables) !== JSON.stringify(database.tables)) {
    throw new Error('Backup database structure does not match its authenticated manifest');
  }
}

function publishPreparedFile(preparedPath, outputPath, beforePublish) {
  if (beforePublish) beforePublish();
  linkSync(preparedPath, outputPath);
  syncDirectory(dirname(outputPath));
  unlinkSync(preparedPath);
  syncDirectory(dirname(outputPath));
}

export async function createBackup({
  databasePath,
  outputPath,
  passphraseFile,
  applicationVersion = 'unknown',
  catalogVersion = 'unknown',
  databaseRole,
  releaseEpoch,
  recoverySetId,
  authorityFloor,
  now = new Date(),
  scratchDirectory = tmpdir(),
  beforePublish,
}) {
  if (!existsSync(databasePath) || !statSync(databasePath).isFile()) {
    throw new Error(`Database is missing or is not a regular file: ${databasePath}`);
  }
  if (existsSync(outputPath)) throw new Error(`Refusing to overwrite existing backup: ${outputPath}`);
  const outputDirectory = dirname(outputPath);
  mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
  mkdirSync(scratchDirectory, { recursive: true, mode: 0o700 });
  const snapshotDirectory = mkdtempSync(join(resolve(scratchDirectory), 'cannabeats-backup-'));
  const snapshotPath = join(snapshotDirectory, 'snapshot.sqlite');
  const preparedPath = temporaryPath(outputDirectory, basename(outputPath), 'create');
  try {
    const source = new DatabaseSync(databasePath, { readOnly: true });
    try {
      await backup(source, snapshotPath, { rate: 100 });
    } finally {
      source.close();
    }
    const database = validatedDatabase(snapshotPath);
    const metadata = encryptSnapshot(snapshotPath, preparedPath, {
      createdAt: now.toISOString(),
      applicationVersion,
      catalogVersion,
      databaseRole,
      releaseEpoch,
      recoverySetId,
      authorityFloor,
      ...database,
    }, passphrase(passphraseFile));
    publishPreparedFile(preparedPath, outputPath, beforePublish);
    return { outputPath, ...metadata };
  } finally {
    rmSync(preparedPath, { force: true });
    rmSync(snapshotDirectory, { recursive: true, force: true });
  }
}

export function verifyBackup({ backupPath, passphraseFile, scratchDirectory = tmpdir() }) {
  mkdirSync(scratchDirectory, { recursive: true, mode: 0o700 });
  const temporaryDirectory = mkdtempSync(join(resolve(scratchDirectory), 'cannabeats-verify-'));
  const databasePath = join(temporaryDirectory, 'verified.sqlite');
  try {
    const metadata = materializeBackup(backupPath, databasePath, passphrase(passphraseFile));
    const database = validatedDatabase(databasePath);
    assertManifestMatchesDatabase(metadata, database);
    return { backupPath, ...metadata, verified: true, verifiedDatabase: database };
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

export function restoreBackup({ backupPath, outputPath, passphraseFile }) {
  if (existsSync(outputPath)) throw new Error(`Refusing to overwrite restore target: ${outputPath}`);
  const outputDirectory = dirname(outputPath);
  mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
  const preparedPath = temporaryPath(outputDirectory, basename(outputPath), 'restore');
  try {
    const metadata = materializeBackup(backupPath, preparedPath, passphrase(passphraseFile));
    const database = validatedDatabase(preparedPath);
    assertManifestMatchesDatabase(metadata, database);
    publishPreparedFile(preparedPath, outputPath);
    return { outputPath, ...metadata, restored: true, restoredDatabase: database };
  } finally {
    rmSync(preparedPath, { force: true });
  }
}

export function pruneBackups({ directory, keep, passphraseFile, scratchDirectory = tmpdir() }) {
  const resolvedDirectory = resolve(directory);
  if (resolvedDirectory === '/' || resolvedDirectory === resolve('.')) {
    throw new Error('Backup pruning requires a dedicated directory');
  }
  if (!Number.isInteger(keep) || keep < 2 || keep > 365) {
    throw new Error('--keep must be an integer between 2 and 365');
  }
  if (!passphraseFile) throw new Error('Backup pruning requires --passphrase-file');
  const candidates = readdirSync(resolvedDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && BACKUP_NAME.test(entry.name))
    .map((entry) => ({
      name: entry.name,
      path: join(resolvedDirectory, entry.name),
    }))
    .sort((left, right) => right.name.localeCompare(left.name));

  for (const candidate of candidates) {
    try {
      verifyBackup({ backupPath: candidate.path, passphraseFile, scratchDirectory });
    } catch (error) {
      throw new Error(`Refusing to prune because ${candidate.name} failed verification: ${error.message}`);
    }
  }

  const removed = [];
  for (const candidate of candidates.slice(keep)) {
    rmSync(candidate.path);
    removed.push(candidate.name);
  }
  if (removed.length) syncDirectory(resolvedDirectory);
  return { directory: resolvedDirectory, kept: candidates.slice(0, keep).map((entry) => entry.name), removed };
}

function usage() {
  return [
    'Usage:',
    '  node operations/backup.mjs create --database PATH --passphrase-file PATH [--output PATH] [--directory PATH] [--application-version VERSION] [--catalog-version VERSION]',
    '  node operations/backup.mjs run --database PATH --passphrase-file PATH --directory PATH [--keep COUNT]',
    '  node operations/backup.mjs verify --backup PATH --passphrase-file PATH',
    '  node operations/backup.mjs restore --backup PATH --output PATH --passphrase-file PATH',
    '  node operations/backup.mjs prune --directory PATH --keep COUNT --passphrase-file PATH',
  ].join('\n');
}

async function main(args = process.argv.slice(2)) {
  const command = args[0];
  const scratchDirectory = resolve(value(
    args, 'scratch-directory', process.env.CANNABEATS_BACKUP_SCRATCH_DIRECTORY || tmpdir(),
  ));
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
      scratchDirectory,
    });
    const verified = verifyBackup({ backupPath: outputPath, passphraseFile, scratchDirectory });
    const retention = pruneBackups({
      directory,
      keep: Number(value(args, 'keep', process.env.CANNABEATS_BACKUP_KEEP || 14)),
      passphraseFile,
      scratchDirectory,
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
      scratchDirectory,
    });
    console.log(JSON.stringify(result));
    return;
  }
  if (command === 'verify') {
    console.log(JSON.stringify(verifyBackup({
      backupPath: resolve(required(args, 'backup')),
      passphraseFile: resolve(required(args, 'passphrase-file', process.env.CANNABEATS_BACKUP_PASSPHRASE_FILE || '')),
      scratchDirectory,
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
      passphraseFile: resolve(required(
        args, 'passphrase-file', process.env.CANNABEATS_BACKUP_PASSPHRASE_FILE || '',
      )),
      scratchDirectory,
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
