#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync, closeSync, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync,
  openSync, readFileSync, readdirSync, readSync, renameSync, rmSync, statfsSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { backup as sqliteBackup, DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

import {
  MAX_CADDYFILE_BYTES, MAX_COMPOSE_BYTES, MAX_RELEASE_MANIFEST_BYTES,
  canonicalReleaseManifest, deploymentDigest, readRelease, readReleaseState,
} from './release-state.mjs';
import { withOperationsLock } from './operations-lock.mjs';
import {
  RELEASE_SCHEMA_DIGEST, RELEASE_SCHEMA_GENERATION, canonicalSchemaDigest,
} from '../../web/lib/server/release/schema.mjs';

export const BACKUP_FORMAT_VERSION = 1;
export const MAX_BACKUP_RECEIPTS = 1024;
export const DAILY_BACKUP_RETENTION = 14;
export const PRECHANGE_BACKUP_RETENTION = 1;
export const MAX_RETAINED_BACKUPS = DAILY_BACKUP_RETENTION + PRECHANGE_BACKUP_RETENTION;
export const MAX_BACKUP_SLOTS = MAX_RETAINED_BACKUPS + 1;
export const MAX_DATABASE_BACKUP_BYTES = 1024 * 1024 * 1024;
export const MIN_BACKUP_FREE_BYTES = 256 * 1024 * 1024;

export const PRODUCTION_BACKUP_ROOT = '/var/backups/cannabeats/sqlite';
export const PRODUCTION_DATABASE = '/var/lib/cannabeats/cannabeats.sqlite3';
export const PRODUCTION_RELEASE_ROOT = '/opt/cannabeats/releases';
export const PRODUCTION_INGEST_TOKEN = '/etc/cannabeats/secrets/relay-ingest-token';
export const PRODUCTION_LISTEN_TOKEN = '/etc/cannabeats/secrets/relay-listen-token';

const BACKUP_ID = /^backup-\d{13}-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const REQUEST_ID = /^sha256:[0-9a-f]{64}$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const RELEASE_ID = /^[a-z0-9][a-z0-9._-]{6,79}$/u;
const REASONS = new Set(['daily', 'manual', 'pre_release', 'pre_rollback']);
const ROUTINE_REASONS = new Set(['daily', 'manual']);
const PRECHANGE_REASONS = new Set(['pre_release', 'pre_rollback']);
const TOKEN = /^[A-Za-z0-9_-]{43}$/u;
const MAX_MANIFEST_BYTES = 32 * 1024;
const MAX_RECEIPT_BYTES = 48 * 1024;
const MAX_INDEX_BYTES = 2 * 1024 * 1024;
const BACKUP_FILES = Object.freeze([
  'database.sqlite3', 'manifest.json', 'relay-ingest-token', 'relay-listen-token', 'release',
]);
const RELEASE_FILES = Object.freeze([
  'Caddyfile', 'compose.yaml', 'manifest.json', 'manifest.sha256',
]);

export class BackupError extends Error {
  constructor(code) { super(code); this.code = code; }
}

function fail(code) { throw new BackupError(code); }
function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}
function digest(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}
function canonical(value) { return JSON.stringify(value); }
function byteLength(value) { return Buffer.byteLength(value, 'utf8'); }
function paths(root) {
  return {
    backups: join(root, 'backups'), receipts: join(root, 'receipts'),
    index: join(root, 'index.json'),
  };
}
function syncPath(path) {
  const descriptor = openSync(path, 'r');
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}
function ensureDirectory(path, create = false) {
  if (!existsSync(path)) {
    if (!create) fail('backup_corrupt');
    mkdirSync(path, { recursive: false, mode: 0o700 });
    return;
  }
  const retained = lstatSync(path);
  if (retained.isSymbolicLink() || !retained.isDirectory()) fail('backup_corrupt');
}
function atomicWrite(path, bytes, mode = 0o400) {
  const temporary = `${path}.tmp-${randomUUID()}`;
  let descriptor;
  try {
    descriptor = openSync(temporary, 'wx', mode);
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
    syncPath(dirname(path));
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temporary)) rmSync(temporary);
  }
}
function readRegular(path, maximum) {
  const retained = lstatSync(path);
  if (retained.isSymbolicLink() || !retained.isFile()
      || retained.size < 1 || retained.size > maximum) fail('backup_corrupt');
  return readFileSync(path, 'utf8');
}
function hashFile(path) {
  const hash = createHash('sha256');
  const descriptor = openSync(path, 'r');
  const chunk = Buffer.alloc(1024 * 1024);
  try {
    for (;;) {
      const count = readSync(descriptor, chunk, 0, chunk.byteLength, null);
      if (count === 0) break;
      hash.update(chunk.subarray(0, count));
    }
    return `sha256:${hash.digest('hex')}`;
  } finally { closeSync(descriptor); }
}
function validateToken(path) {
  const value = readRegular(path, 43);
  if (!TOKEN.test(value)) fail('backup_corrupt');
  return value;
}
export function verifyDatabaseFile(path) {
  const retained = lstatSync(path);
  if (retained.isSymbolicLink() || !retained.isFile()
      || retained.size < 1 || retained.size > MAX_DATABASE_BACKUP_BYTES) fail('backup_corrupt');
  let database;
  try {
    database = new DatabaseSync(path, { readOnly: true });
    database.exec('PRAGMA query_only=ON; PRAGMA foreign_keys=ON');
    const quick = database.prepare('PRAGMA quick_check').all();
    const integrity = database.prepare('PRAGMA integrity_check').all();
    const foreignKeys = database.prepare('PRAGMA foreign_key_check').all();
    const generations = database.prepare(
      'SELECT generation,contract_digest FROM schema_generations ORDER BY generation',
    ).all();
    if (quick.length !== 1 || quick[0].quick_check !== 'ok'
        || integrity.length !== 1 || integrity[0].integrity_check !== 'ok'
        || foreignKeys.length !== 0 || generations.length !== 1
        || generations[0].generation !== RELEASE_SCHEMA_GENERATION
        || generations[0].contract_digest !== RELEASE_SCHEMA_DIGEST
        || canonicalSchemaDigest(database) !== RELEASE_SCHEMA_DIGEST) fail('backup_corrupt');
    const catalogs = database.prepare(
      'SELECT catalog_version FROM catalog_releases ORDER BY catalog_version',
    ).all().map((row) => row.catalog_version);
    return Object.freeze({
      bytes: retained.size, sha256: hashFile(path),
      schemaGeneration: generations[0].generation, catalogs: Object.freeze(catalogs),
    });
  } catch (error) {
    if (error instanceof BackupError) throw error;
    fail('backup_corrupt');
  } finally { database?.close(); }
}

function canonicalManifest(input) {
  if (!exactKeys(input, [
    'version', 'ordinal', 'backupId', 'requestId', 'requestDigest', 'reason',
    'operationReleaseId', 'stateSequence', 'createdAt', 'database', 'tokens', 'release',
  ]) || input.version !== BACKUP_FORMAT_VERSION
      || !Number.isSafeInteger(input.ordinal) || input.ordinal < 1
      || typeof input.backupId !== 'string' || !BACKUP_ID.test(input.backupId)
      || typeof input.requestId !== 'string' || !REQUEST_ID.test(input.requestId)
      || typeof input.requestDigest !== 'string' || !DIGEST.test(input.requestDigest)
      || !REASONS.has(input.reason)
      || typeof input.operationReleaseId !== 'string' || !RELEASE_ID.test(input.operationReleaseId)
      || !Number.isSafeInteger(input.stateSequence) || input.stateSequence < 0
      || !Number.isSafeInteger(input.createdAt) || input.createdAt < 0
      || !exactKeys(input.database, ['bytes', 'sha256', 'schemaGeneration', 'catalogs'])
      || !Number.isSafeInteger(input.database.bytes) || input.database.bytes < 1
      || input.database.bytes > MAX_DATABASE_BACKUP_BYTES
      || typeof input.database.sha256 !== 'string' || !DIGEST.test(input.database.sha256)
      || input.database.schemaGeneration !== RELEASE_SCHEMA_GENERATION
      || !Array.isArray(input.database.catalogs)
      || input.database.catalogs.some((value) => typeof value !== 'string' || !DIGEST.test(value))
      || !exactKeys(input.tokens, ['ingest', 'listen'])
      || !Object.values(input.tokens).every((value) => typeof value === 'string' && DIGEST.test(value))
      || input.tokens.ingest === input.tokens.listen
      || !exactKeys(input.release, ['releaseId', 'manifestDigest', 'recordDigest'])
      || typeof input.release.releaseId !== 'string' || !RELEASE_ID.test(input.release.releaseId)
      || typeof input.release.manifestDigest !== 'string' || !DIGEST.test(input.release.manifestDigest)
      || typeof input.release.recordDigest !== 'string' || !DIGEST.test(input.release.recordDigest)) {
    fail('backup_corrupt');
  }
  const value = canonical(input);
  if (byteLength(value) > MAX_MANIFEST_BYTES) fail('backup_corrupt');
  return value;
}

function releaseRecordDigest(files) {
  const hash = createHash('sha256');
  for (const name of RELEASE_FILES) {
    const value = files[name];
    const bytes = Buffer.from(value);
    hash.update(`${name.length}:${name}:${bytes.length}:`);
    hash.update(bytes);
  }
  return `sha256:${hash.digest('hex')}`;
}

function readReleaseBundle(path) {
  const retained = lstatSync(path);
  if (retained.isSymbolicLink() || !retained.isDirectory()
      || JSON.stringify(readdirSync(path).sort()) !== JSON.stringify([...RELEASE_FILES].sort())) {
    fail('backup_corrupt');
  }
  const limits = {
    Caddyfile: MAX_CADDYFILE_BYTES, 'compose.yaml': MAX_COMPOSE_BYTES,
    'manifest.json': MAX_RELEASE_MANIFEST_BYTES, 'manifest.sha256': 72,
  };
  const files = Object.fromEntries(RELEASE_FILES.map((name) => [
    name, readRegular(join(path, name), limits[name]),
  ]));
  const canonicalRelease = canonicalReleaseManifest(JSON.parse(files['manifest.json']));
  if (canonicalRelease !== files['manifest.json']) fail('backup_corrupt');
  const manifest = JSON.parse(canonicalRelease);
  const manifestDigest = digest(canonicalRelease);
  if (files['manifest.sha256'] !== `${manifestDigest}\n`
      || deploymentDigest({ Caddyfile: files.Caddyfile, 'compose.yaml': files['compose.yaml'] })
        !== manifest.deploymentDigest) fail('backup_corrupt');
  return Object.freeze({
    files: Object.freeze(files), manifest, manifestDigest,
    recordDigest: releaseRecordDigest(files),
  });
}

export function verifyBackupBundle(root, backupId) {
  if (typeof backupId !== 'string' || !BACKUP_ID.test(backupId)) fail('backup_corrupt');
  const path = join(paths(root).backups, backupId);
  try {
    const retained = lstatSync(path);
    if (retained.isSymbolicLink() || !retained.isDirectory()
        || JSON.stringify(readdirSync(path).sort()) !== JSON.stringify([...BACKUP_FILES].sort())) {
      fail('backup_corrupt');
    }
    const manifestBytes = readRegular(join(path, 'manifest.json'), MAX_MANIFEST_BYTES);
    const canonicalBytes = canonicalManifest(JSON.parse(manifestBytes));
    if (canonicalBytes !== manifestBytes) fail('backup_corrupt');
    const manifest = JSON.parse(canonicalBytes);
    if (manifest.backupId !== backupId) fail('backup_corrupt');
    const ingest = validateToken(join(path, 'relay-ingest-token'));
    const listen = validateToken(join(path, 'relay-listen-token'));
    if (ingest === listen || digest(ingest) !== manifest.tokens.ingest
        || digest(listen) !== manifest.tokens.listen) fail('backup_corrupt');
    const database = verifyDatabaseFile(join(path, 'database.sqlite3'));
    if (canonical(database) !== canonical(manifest.database)) fail('backup_corrupt');
    const release = readReleaseBundle(join(path, 'release'));
    if (release.manifest.releaseId !== manifest.release.releaseId
        || release.manifestDigest !== manifest.release.manifestDigest
        || release.recordDigest !== manifest.release.recordDigest
        || release.manifest.schema.target !== database.schemaGeneration
        || !database.catalogs.includes(release.manifest.catalogVersion)) fail('backup_corrupt');
    return Object.freeze({ manifest: Object.freeze(manifest), manifestDigest: digest(canonicalBytes), path });
  } catch (error) {
    if (error instanceof BackupError) throw error;
    fail('backup_corrupt');
  }
}

function canonicalReceipt(input) {
  if (!exactKeys(input, ['ordinal', 'requestId', 'requestDigest', 'backupId', 'manifestDigest', 'manifest'])
      || !Number.isSafeInteger(input.ordinal) || input.ordinal < 1
      || typeof input.requestId !== 'string' || !REQUEST_ID.test(input.requestId)
      || typeof input.requestDigest !== 'string' || !DIGEST.test(input.requestDigest)
      || typeof input.backupId !== 'string' || !BACKUP_ID.test(input.backupId)
      || typeof input.manifestDigest !== 'string' || !DIGEST.test(input.manifestDigest)) {
    fail('backup_corrupt');
  }
  const manifestBytes = canonicalManifest(input.manifest);
  if (input.ordinal !== input.manifest.ordinal || input.requestId !== input.manifest.requestId
      || input.requestDigest !== input.manifest.requestDigest
      || input.backupId !== input.manifest.backupId
      || input.manifestDigest !== digest(manifestBytes)) fail('backup_corrupt');
  const value = canonical(input);
  if (byteLength(value) > MAX_RECEIPT_BYTES) fail('backup_corrupt');
  return value;
}

function readIndex(root) {
  const path = paths(root).index;
  if (!existsSync(path)) return [];
  const value = JSON.parse(readRegular(path, MAX_INDEX_BYTES));
  if (!exactKeys(value, ['version', 'receipts']) || value.version !== 1
      || !Array.isArray(value.receipts) || value.receipts.length > MAX_BACKUP_RECEIPTS) {
    fail('backup_corrupt');
  }
  return value.receipts.map((receipt, index) => {
    if (receipt.ordinal !== index + 1) fail('backup_corrupt');
    canonicalReceipt(receipt);
    return Object.freeze(receipt);
  });
}
function writeIndex(root, receipts) {
  const bytes = canonical({ version: 1, receipts });
  if (byteLength(bytes) > MAX_INDEX_BYTES) fail('backup_capacity');
  atomicWrite(paths(root).index, bytes);
}

export function validateBackupDomain(root, { create = false } = {}) {
  try {
    if (!existsSync(root)) {
      if (!create) fail('backup_corrupt');
      mkdirSync(root, { recursive: false, mode: 0o700 });
    }
    ensureDirectory(root);
    const retainedPaths = paths(root);
    for (const path of [retainedPaths.backups, retainedPaths.receipts]) {
      ensureDirectory(path, create);
    }
    const allowedRoot = new Set([
      'backups', 'receipts', 'restore-receipts', 'index.json', 'restore-index.json',
    ]);
    for (const name of readdirSync(root)) {
      if (name.startsWith('.tmp-')) {
        const temporary = join(root, name);
        const retained = lstatSync(temporary);
        if (retained.isSymbolicLink() || !retained.isDirectory()) fail('backup_corrupt');
        rmSync(temporary, { recursive: true });
      } else if (!allowedRoot.has(name)) fail('backup_corrupt');
    }
    const restoreReceipts = join(root, 'restore-receipts');
    if (existsSync(restoreReceipts)) ensureDirectory(restoreReceipts);
    const indexReceipts = readIndex(root);
    const receipts = [];
    const receiptFiles = readdirSync(retainedPaths.receipts).sort();
    for (let index = 0; index < receiptFiles.length; index += 1) {
      const expectedName = `${String(index + 1).padStart(4, '0')}.json`;
      if (receiptFiles[index] !== expectedName) fail('backup_corrupt');
      const receipt = JSON.parse(readRegular(
        join(retainedPaths.receipts, expectedName), MAX_RECEIPT_BYTES,
      ));
      if (receipt.ordinal !== index + 1 || canonicalReceipt(receipt)
          !== readFileSync(join(retainedPaths.receipts, expectedName), 'utf8')) fail('backup_corrupt');
      receipts.push(Object.freeze(receipt));
    }
    const maximum = Math.max(receipts.length, indexReceipts.length);
    if (maximum > MAX_BACKUP_RECEIPTS) fail('backup_corrupt');
    for (let index = 0; index < maximum; index += 1) {
      const fileReceipt = receipts[index];
      const indexReceipt = indexReceipts[index];
      if (fileReceipt && indexReceipt && canonical(fileReceipt) !== canonical(indexReceipt)) {
        fail('backup_corrupt');
      }
      const retained = fileReceipt ?? indexReceipt;
      if (!fileReceipt) atomicWrite(
        join(retainedPaths.receipts, `${String(index + 1).padStart(4, '0')}.json`),
        canonicalReceipt(retained),
      );
      if (!indexReceipt && index !== indexReceipts.length) fail('backup_corrupt');
      if (!indexReceipt) indexReceipts.push(retained);
    }
    if (indexReceipts.length !== readIndex(root).length) writeIndex(root, indexReceipts);
    const bundles = readdirSync(retainedPaths.backups);
    if (bundles.length > MAX_BACKUP_SLOTS) fail('backup_corrupt');
    const verifiedBundles = bundles.map((backupId) => verifyBackupBundle(root, backupId))
      .sort((left, right) => left.manifest.ordinal - right.manifest.ordinal);
    let receiptByBackup = new Map(indexReceipts.map((receipt) => [receipt.backupId, receipt]));
    for (const verified of verifiedBundles) {
      if (receiptByBackup.has(verified.manifest.backupId)) continue;
      if (verified.manifest.ordinal !== indexReceipts.length + 1
          || indexReceipts.length >= MAX_BACKUP_RECEIPTS) fail('backup_corrupt');
      const receipt = Object.freeze({
        ordinal: verified.manifest.ordinal, requestId: verified.manifest.requestId,
        requestDigest: verified.manifest.requestDigest, backupId: verified.manifest.backupId,
        manifestDigest: verified.manifestDigest, manifest: verified.manifest,
      });
      atomicWrite(
        join(retainedPaths.receipts, `${String(receipt.ordinal).padStart(4, '0')}.json`),
        canonicalReceipt(receipt),
      );
      indexReceipts.push(receipt);
      receiptByBackup.set(receipt.backupId, receipt);
    }
    if (indexReceipts.length !== readIndex(root).length) writeIndex(root, indexReceipts);
    receiptByBackup = new Map(indexReceipts.map((receipt) => [receipt.backupId, receipt]));
    const requestMap = new Map();
    for (const receipt of indexReceipts) {
      if (requestMap.has(receipt.requestId) || receiptByBackup.get(receipt.backupId) !== receipt) {
        fail('backup_corrupt');
      }
      requestMap.set(receipt.requestId, receipt);
    }
    for (const verified of verifiedBundles) {
      const receipt = receiptByBackup.get(verified.manifest.backupId);
      if (!receipt) fail('backup_corrupt');
      if (receipt.manifestDigest !== verified.manifestDigest
          || canonical(receipt.manifest) !== canonical(verified.manifest)) fail('backup_corrupt');
    }
    return Object.freeze({
      receipts: Object.freeze([...indexReceipts]), requestMap, receiptByBackup,
      bundles: Object.freeze([...bundles]),
    });
  } catch (error) {
    if (error instanceof BackupError) throw error;
    fail('backup_corrupt');
  }
}

function copyReleaseRecord(release, destination) {
  mkdirSync(destination, { mode: 0o700 });
  for (const name of RELEASE_FILES) {
    const bytes = name === 'manifest.json' ? canonicalReleaseManifest(release.manifest)
      : name === 'manifest.sha256' ? `${release.manifestDigest}\n` : release.files[name];
    writeFileSync(join(destination, name), bytes, { flag: 'wx', mode: 0o400 });
    syncPath(join(destination, name));
  }
  chmodSync(destination, 0o500);
  syncPath(destination);
}
function freeBytes(path, statfs = statfsSync) {
  const value = statfs(path);
  return BigInt(value.bavail) * BigInt(value.bsize);
}
function requestFingerprint(input) {
  return digest(canonical({
    reason: input.reason, operationReleaseId: input.operationReleaseId,
    stateSequence: input.stateSequence,
  }));
}

export async function createBackup({
  root, databasePath, releaseRoot, ingestTokenPath, listenTokenPath,
  requestId, reason, operationReleaseId, stateSequence, createdAt = Date.now(),
  backupDatabase = sqliteBackup, statfs = statfsSync,
}) {
  if (typeof requestId !== 'string' || !REQUEST_ID.test(requestId)
      || !REASONS.has(reason) || typeof operationReleaseId !== 'string'
      || !RELEASE_ID.test(operationReleaseId) || !Number.isSafeInteger(stateSequence)
      || stateSequence < 0 || !Number.isSafeInteger(createdAt) || createdAt < 0) {
    fail('invalid_arguments');
  }
  const requestDigest = requestFingerprint({ reason, operationReleaseId, stateSequence });
  if (existsSync(join(dirname(databasePath), '.restore-journal.json'))) fail('restore_pending');
  const domain = validateBackupDomain(root, { create: true });
  const replay = domain.requestMap.get(requestId);
  if (replay) {
    if (replay.requestDigest !== requestDigest) fail('backup_conflict');
    if (domain.bundles.includes(replay.backupId)) verifyBackupBundle(root, replay.backupId);
    return Object.freeze({
      code: 'backup_created', replayed: true, backupId: replay.backupId,
      manifest: replay.manifest,
    });
  }
  if (domain.receipts.length >= MAX_BACKUP_RECEIPTS
      || domain.bundles.length >= MAX_BACKUP_SLOTS) fail('backup_capacity');
  const state = readReleaseState(releaseRoot);
  if (state.pending !== null || state.sequence !== stateSequence) fail('backup_conflict');
  if (!existsSync(databasePath)) {
    if (state.current !== null) fail('backup_corrupt');
    return Object.freeze({ code: 'backup_not_required', replayed: false });
  }
  const releaseId = state.current ?? operationReleaseId;
  const release = readRelease(releaseRoot, releaseId);
  const ingest = validateToken(ingestTokenPath);
  const listen = validateToken(listenTokenPath);
  if (ingest === listen) fail('backup_corrupt');
  const source = lstatSync(databasePath);
  if (source.isSymbolicLink() || !source.isFile()
      || source.size < 1 || source.size > MAX_DATABASE_BACKUP_BYTES) fail('backup_corrupt');
  const sourceBytes = source.size;
  const reserve = BigInt(Math.max(MIN_BACKUP_FREE_BYTES, sourceBytes * 2));
  if (freeBytes(root, statfs) < reserve) fail('backup_capacity');
  const ordinal = domain.receipts.length + 1;
  const backupId = `backup-${String(createdAt).padStart(13, '0')}-${randomUUID()}`;
  const temporary = join(root, `.tmp-${backupId}`);
  const destination = join(paths(root).backups, backupId);
  try {
    mkdirSync(temporary, { mode: 0o700 });
    const databaseCopy = join(temporary, 'database.sqlite3');
    let database;
    try {
      database = new DatabaseSync(databasePath, { readOnly: true });
      await backupDatabase(database, databaseCopy);
    } finally { database?.close(); }
    try {
      database = new DatabaseSync(databaseCopy);
      database.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE');
    } finally { database?.close(); }
    chmodSync(databaseCopy, 0o400);
    syncPath(databaseCopy);
    writeFileSync(join(temporary, 'relay-ingest-token'), ingest, { flag: 'wx', mode: 0o400 });
    writeFileSync(join(temporary, 'relay-listen-token'), listen, { flag: 'wx', mode: 0o400 });
    syncPath(join(temporary, 'relay-ingest-token'));
    syncPath(join(temporary, 'relay-listen-token'));
    copyReleaseRecord(release, join(temporary, 'release'));
    const proof = verifyDatabaseFile(databaseCopy);
    if (release.manifest.schema.target !== proof.schemaGeneration
        || !proof.catalogs.includes(release.manifest.catalogVersion)) fail('backup_corrupt');
    const releaseFiles = Object.fromEntries(RELEASE_FILES.map((name) => [
      name, readFileSync(join(temporary, 'release', name), 'utf8'),
    ]));
    const manifest = {
      version: BACKUP_FORMAT_VERSION, ordinal, backupId, requestId, requestDigest,
      reason, operationReleaseId, stateSequence, createdAt,
      database: proof,
      tokens: { ingest: digest(ingest), listen: digest(listen) },
      release: {
        releaseId, manifestDigest: release.manifestDigest,
        recordDigest: releaseRecordDigest(releaseFiles),
      },
    };
    const manifestBytes = canonicalManifest(manifest);
    writeFileSync(join(temporary, 'manifest.json'), manifestBytes, { flag: 'wx', mode: 0o400 });
    syncPath(join(temporary, 'manifest.json'));
    syncPath(temporary);
    renameSync(temporary, destination);
    syncPath(paths(root).backups);
    const verified = verifyBackupBundle(root, backupId);
    const receipt = {
      ordinal, requestId, requestDigest, backupId,
      manifestDigest: verified.manifestDigest, manifest: verified.manifest,
    };
    atomicWrite(
      join(paths(root).receipts, `${String(ordinal).padStart(4, '0')}.json`),
      canonicalReceipt(receipt),
    );
    writeIndex(root, [...domain.receipts, receipt]);
    pruneBackups(root);
    return Object.freeze({ code: 'backup_created', replayed: false, backupId, manifest });
  } catch (error) {
    if (existsSync(temporary)) rmSync(temporary, { recursive: true });
    if (error instanceof BackupError) throw error;
    fail('backup_failed');
  }
}

export function pruneBackups(root) {
  const domain = validateBackupDomain(root);
  const available = domain.bundles.map((backupId) => domain.receiptByBackup.get(backupId));
  const ordered = (values) => [...values].sort((left, right) =>
    right.manifest.createdAt - left.manifest.createdAt
      || right.backupId.localeCompare(left.backupId));
  const keep = new Set([
    ...ordered(available.filter((receipt) => ROUTINE_REASONS.has(receipt.manifest.reason)))
      .slice(0, DAILY_BACKUP_RETENTION).map((receipt) => receipt.backupId),
    ...ordered(available.filter((receipt) => PRECHANGE_REASONS.has(receipt.manifest.reason)))
      .slice(0, PRECHANGE_BACKUP_RETENTION).map((receipt) => receipt.backupId),
  ]);
  if (keep.size === 0 && available.length > 0) keep.add(ordered(available)[0].backupId);
  const removed = [];
  for (const receipt of available) {
    if (keep.has(receipt.backupId)) continue;
    const target = join(paths(root).backups, receipt.backupId);
    const discarded = join(root, `.tmp-prune-${receipt.backupId}-${randomUUID()}`);
    chmodSync(join(target, 'release'), 0o700);
    renameSync(target, discarded);
    syncPath(paths(root).backups);
    syncPath(root);
    rmSync(discarded, { recursive: true });
    removed.push(receipt.backupId);
  }
  if (removed.length > 0) syncPath(paths(root).backups);
  return Object.freeze({ code: 'backups_pruned', removed: Object.freeze(removed) });
}

export function retainedBackupReleaseIds(root) {
  const domain = validateBackupDomain(root);
  return Object.freeze([...new Set(domain.bundles.map((backupId) =>
    domain.receiptByBackup.get(backupId).manifest.release.releaseId))].sort());
}

export function listBackups(root) {
  const domain = validateBackupDomain(root);
  const available = domain.bundles.map((backupId) => domain.receiptByBackup.get(backupId))
    .sort((left, right) => right.manifest.createdAt - left.manifest.createdAt
      || right.backupId.localeCompare(left.backupId));
  return Object.freeze({
    code: 'backup_list', backups: Object.freeze(available.map((receipt) => Object.freeze({
      backupId: receipt.backupId, createdAt: receipt.manifest.createdAt,
      reason: receipt.manifest.reason,
      releaseId: receipt.manifest.release.releaseId,
    }))),
  });
}

function parseArguments(argv) {
  if (argv.length === 1 && ['daily', 'list', 'prune'].includes(argv[0])) {
    return { command: argv[0] };
  }
  if (argv.length === 3 && argv[0] === 'verify' && argv[1] === '--backup-id'
      && BACKUP_ID.test(argv[2])) return { command: 'verify', backupId: argv[2] };
  if (argv[0] !== 'create' || argv.length !== 9) fail('invalid_arguments');
  const values = {};
  for (let index = 1; index < argv.length; index += 2) {
    const name = argv[index];
    if (!['--request-id', '--reason', '--release-id', '--state-sequence'].includes(name)
        || Object.hasOwn(values, name) || !argv[index + 1]) fail('invalid_arguments');
    values[name] = argv[index + 1];
  }
  if (Object.keys(values).length !== 4 || !/^\d+$/u.test(values['--state-sequence'])) {
    fail('invalid_arguments');
  }
  return { command: 'create', values };
}

export async function executeBackupCommand(argv, {
  root = PRODUCTION_BACKUP_ROOT, databasePath = PRODUCTION_DATABASE,
  releaseRoot = PRODUCTION_RELEASE_ROOT, ingestTokenPath = PRODUCTION_INGEST_TOKEN,
  listenTokenPath = PRODUCTION_LISTEN_TOKEN, now = Date.now,
  create = createBackup, lock = withOperationsLock,
  restorePending = () => existsSync(join(dirname(databasePath), '.restore-journal.json')),
} = {}) {
  const parsed = parseArguments(argv);
  return lock(async () => {
    if (parsed.command === 'list') return listBackups(root);
    if (parsed.command === 'verify') {
      validateBackupDomain(root);
      const verified = verifyBackupBundle(root, parsed.backupId);
      return Object.freeze({ code: 'backup_verified', backupId: verified.manifest.backupId });
    }
    if (restorePending()) fail('restore_pending');
    if (parsed.command === 'prune') return pruneBackups(root);
    let values = parsed.values;
    if (parsed.command === 'daily') {
      const state = readReleaseState(releaseRoot);
      if (!state.current || state.pending) fail('backup_unavailable');
      const createdAt = now();
      const day = new Date(createdAt).toISOString().slice(0, 10);
      values = {
        '--request-id': digest(canonical({
          reason: 'daily', day, releaseId: state.current, stateSequence: state.sequence,
        })),
        '--reason': 'daily', '--release-id': state.current,
        '--state-sequence': String(state.sequence), '--created-at': createdAt,
      };
    }
    return create({
      root, databasePath, releaseRoot, ingestTokenPath, listenTokenPath,
      requestId: values['--request-id'], reason: values['--reason'],
      operationReleaseId: values['--release-id'],
      stateSequence: Number(values['--state-sequence']),
      ...(values['--created-at'] === undefined ? {} : { createdAt: values['--created-at'] }),
    });
  });
}

async function main() {
  try {
    const result = await executeBackupCommand(process.argv.slice(2));
    process.stdout.write(result.code === 'backup_list'
      ? `${JSON.stringify(result)}\n` : `${result.code}\n`);
  } catch (error) {
    const code = error instanceof BackupError ? error.code
      : typeof error?.code === 'string' ? error.code : 'backup_failed';
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
