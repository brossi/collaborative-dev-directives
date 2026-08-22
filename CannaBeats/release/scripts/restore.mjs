#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync, chownSync, closeSync, copyFileSync, existsSync, fsyncSync, lstatSync,
  mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  BackupError, PRODUCTION_BACKUP_ROOT, PRODUCTION_DATABASE, PRODUCTION_INGEST_TOKEN,
  PRODUCTION_LISTEN_TOKEN, PRODUCTION_RELEASE_ROOT, retainedBackupReleaseIds, validateBackupDomain,
  verifyBackupBundle, verifyDatabaseFile,
} from './backup.mjs';
import { withOperationsLock } from './operations-lock.mjs';
import {
  ReleaseStateError, pruneReleaseRecords, readRelease, readReleaseState, registerRelease,
  validateReleaseDomain, writeReleaseState,
} from './release-state.mjs';
import { createProductionConverger, readSchemaGeneration } from './release-operations.mjs';

export const MAX_RESTORE_RECEIPTS = 64;
const REQUEST_ID = /^sha256:[0-9a-f]{64}$/u;
const BACKUP_ID = /^backup-\d{13}-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const RELEASE_ID = /^[a-z0-9][a-z0-9._-]{6,79}$/u;
const RESTORE_RECEIPT_VERSION = 1;
const RESTORE_JOURNAL_VERSION = 1;
const MAX_RECEIPT_BYTES = 2048;
const MAX_RECEIPT_INDEX_BYTES = 128 * 1024;
const MAX_JOURNAL_BYTES = 4096;

export class RestoreError extends Error {
  constructor(code) { super(code); this.code = code; }
}

function fail(code) { throw new RestoreError(code); }
function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}
function digest(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}
function syncPath(path) {
  const descriptor = openSync(path, 'r');
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
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
function regular(path, maximum) {
  const retained = lstatSync(path);
  if (retained.isSymbolicLink() || !retained.isFile()
      || retained.size < 1 || retained.size > maximum) fail('restore_corrupt');
  return readFileSync(path, 'utf8');
}
function receiptDirectory(backupRoot) { return join(backupRoot, 'restore-receipts'); }
function receiptIndexPath(backupRoot) { return join(backupRoot, 'restore-index.json'); }
function journalPath(databasePath) { return join(dirname(databasePath), '.restore-journal.json'); }
function suffix(requestId) { return requestId.slice(-16); }
function stagedPaths({ databasePath, ingestTokenPath, listenTokenPath }, requestId) {
  const id = suffix(requestId);
  return {
    database: { live: databasePath, old: `${databasePath}.restore-old-${id}`, new: `${databasePath}.restore-new-${id}` },
    ingest: { live: ingestTokenPath, old: `${ingestTokenPath}.restore-old-${id}`, new: `${ingestTokenPath}.restore-new-${id}` },
    listen: { live: listenTokenPath, old: `${listenTokenPath}.restore-old-${id}`, new: `${listenTokenPath}.restore-new-${id}` },
  };
}
function entryExists(path) {
  try { return lstatSync(path, { throwIfNoEntry: false }) !== undefined; }
  catch { fail('restore_corrupt'); }
}
function preflightStagePaths(locations, requestId) {
  const stage = stagedPaths(locations, requestId);
  for (const value of Object.values(stage)) {
    if (entryExists(value.old) || entryExists(value.new)) fail('restore_corrupt');
  }
  return stage;
}

function canonicalReceipt(value) {
  if (!exactKeys(value, ['version', 'ordinal', 'requestId', 'backupId', 'completedAt', 'code'])
      || value.version !== RESTORE_RECEIPT_VERSION
      || !Number.isSafeInteger(value.ordinal) || value.ordinal < 1
      || !REQUEST_ID.test(value.requestId)
      || !BACKUP_ID.test(value.backupId) || value.code !== 'backup_restored'
      || !Number.isSafeInteger(value.completedAt) || value.completedAt < 0) fail('restore_corrupt');
  const bytes = JSON.stringify(value);
  if (Buffer.byteLength(bytes) > MAX_RECEIPT_BYTES) fail('restore_corrupt');
  return bytes;
}
function readRestoreIndex(backupRoot) {
  const path = receiptIndexPath(backupRoot);
  if (!existsSync(path)) return [];
  const bytes = regular(path, MAX_RECEIPT_INDEX_BYTES);
  let value;
  try { value = JSON.parse(bytes); } catch { fail('restore_corrupt'); }
  if (!exactKeys(value, ['version', 'receipts']) || value.version !== 1
      || !Array.isArray(value.receipts) || value.receipts.length > MAX_RESTORE_RECEIPTS) {
    fail('restore_corrupt');
  }
  return value.receipts.map((receipt, index) => {
    if (receipt.ordinal !== index + 1 || canonicalReceipt(receipt) !== JSON.stringify(receipt)) {
      fail('restore_corrupt');
    }
    return Object.freeze(receipt);
  });
}
function writeRestoreIndex(backupRoot, receipts) {
  const bytes = JSON.stringify({ version: 1, receipts });
  if (Buffer.byteLength(bytes) > MAX_RECEIPT_INDEX_BYTES) fail('restore_capacity');
  atomicWrite(receiptIndexPath(backupRoot), bytes);
}
function readRestoreReceipts(backupRoot) {
  const directory = receiptDirectory(backupRoot);
  if (!existsSync(directory)) {
    mkdirSync(directory, { mode: 0o700 });
    syncPath(backupRoot);
  }
  const retained = lstatSync(directory);
  if (retained.isSymbolicLink() || !retained.isDirectory()) fail('restore_corrupt');
  const indexReceipts = readRestoreIndex(backupRoot);
  const fileReceipts = [];
  const names = readdirSync(directory).sort();
  if (names.length > MAX_RESTORE_RECEIPTS) fail('restore_corrupt');
  for (const name of names) {
    const match = /^(\d{4})\.json$/u.exec(name);
    if (!match) fail('restore_corrupt');
    const ordinal = Number(match[1]);
    if (ordinal < 1 || ordinal > MAX_RESTORE_RECEIPTS || fileReceipts[ordinal - 1]) {
      fail('restore_corrupt');
    }
    const path = join(directory, name);
    const bytes = regular(path, MAX_RECEIPT_BYTES);
    let value;
    try { value = JSON.parse(bytes); } catch { fail('restore_corrupt'); }
    if (value.ordinal !== ordinal || canonicalReceipt(value) !== bytes) fail('restore_corrupt');
    fileReceipts[ordinal - 1] = Object.freeze(value);
  }
  const maximum = Math.max(indexReceipts.length, fileReceipts.length);
  for (let index = 0; index < maximum; index += 1) {
    const fileReceipt = fileReceipts[index];
    const indexReceipt = indexReceipts[index];
    if (fileReceipt && indexReceipt
        && canonicalReceipt(fileReceipt) !== canonicalReceipt(indexReceipt)) fail('restore_corrupt');
    const retained = fileReceipt ?? indexReceipt;
    if (!fileReceipt) atomicWrite(
      join(directory, `${String(index + 1).padStart(4, '0')}.json`),
      canonicalReceipt(retained),
    );
    if (!indexReceipt && index !== indexReceipts.length) fail('restore_corrupt');
    if (!indexReceipt) indexReceipts.push(retained);
  }
  if (indexReceipts.length !== readRestoreIndex(backupRoot).length) {
    writeRestoreIndex(backupRoot, indexReceipts);
  }
  const receipts = new Map();
  for (const receipt of indexReceipts) {
    if (receipts.has(receipt.requestId)) fail('restore_corrupt');
    receipts.set(receipt.requestId, receipt);
  }
  return receipts;
}
function writeRestoreReceipt(backupRoot, receipt) {
  const directory = receiptDirectory(backupRoot);
  atomicWrite(
    join(directory, `${String(receipt.ordinal).padStart(4, '0')}.json`),
    canonicalReceipt(receipt),
  );
  const receipts = [...readRestoreReceipts(backupRoot).values()];
  if (receipts.length !== receipt.ordinal
      || canonicalReceipt(receipts.at(-1)) !== canonicalReceipt(receipt)) fail('restore_corrupt');
  writeRestoreIndex(backupRoot, receipts);
}

function canonicalJournal(value) {
  if (!exactKeys(value, [
    'version', 'requestId', 'backupId', 'targetReleaseId', 'phase', 'priorState',
    'databaseExisted', 'ingestExisted', 'listenExisted', 'completedAt',
  ]) || value.version !== RESTORE_JOURNAL_VERSION || !REQUEST_ID.test(value.requestId)
      || !BACKUP_ID.test(value.backupId) || typeof value.targetReleaseId !== 'string'
      || !RELEASE_ID.test(value.targetReleaseId)
      || !['prepared', 'installed', 'activated'].includes(value.phase)
      || typeof value.databaseExisted !== 'boolean' || typeof value.ingestExisted !== 'boolean'
      || typeof value.listenExisted !== 'boolean'
      || !Number.isSafeInteger(value.completedAt) || value.completedAt < 0
      || !validPriorState(value.priorState)) fail('restore_corrupt');
  const bytes = JSON.stringify(value);
  if (Buffer.byteLength(bytes) > MAX_JOURNAL_BYTES) fail('restore_corrupt');
  return bytes;
}

function validPriorState(value) {
  const release = (candidate) => candidate === null
    || (typeof candidate === 'string' && RELEASE_ID.test(candidate));
  return exactKeys(value, ['current', 'previous', 'pending', 'revision', 'sequence'])
    && release(value.current) && release(value.previous) && value.pending === null
    && Number.isSafeInteger(value.revision) && value.revision >= 0
    && Number.isSafeInteger(value.sequence) && value.sequence >= 0
    && (value.current !== null || (value.previous === null && value.revision === 0))
    && (value.current === null || value.revision >= 1)
    && (value.current === null || value.current !== value.previous);
}
function readJournal(databasePath) {
  const path = journalPath(databasePath);
  if (!existsSync(path)) return null;
  try {
    const bytes = regular(path, MAX_JOURNAL_BYTES);
    const value = JSON.parse(bytes);
    if (canonicalJournal(value) !== bytes) fail('restore_corrupt');
    return Object.freeze(value);
  } catch (error) {
    if (error instanceof RestoreError) throw error;
    fail('restore_corrupt');
  }
}
function writeJournal(databasePath, value) {
  atomicWrite(journalPath(databasePath), canonicalJournal(value), 0o400);
}
function removeJournal(databasePath) {
  rmSync(journalPath(databasePath));
  syncPath(dirname(databasePath));
}

function releaseFromBundle(bundle) {
  const path = join(bundle.path, 'release');
  const manifest = JSON.parse(readFileSync(join(path, 'manifest.json'), 'utf8'));
  return {
    manifest,
    files: {
      Caddyfile: readFileSync(join(path, 'Caddyfile'), 'utf8'),
      'compose.yaml': readFileSync(join(path, 'compose.yaml'), 'utf8'),
    },
  };
}
function applyOwner(path, { uid, gid, mode }) {
  chmodSync(path, mode);
  chownSync(path, uid, gid);
  syncPath(path);
}
function stageRestoreFiles(bundle, locations, owners, requestId) {
  const stage = preflightStagePaths(locations, requestId);
  const created = [];
  try {
    copyFileSync(join(bundle.path, 'database.sqlite3'), stage.database.new);
    created.push(stage.database.new);
    copyFileSync(join(bundle.path, 'relay-ingest-token'), stage.ingest.new);
    created.push(stage.ingest.new);
    copyFileSync(join(bundle.path, 'relay-listen-token'), stage.listen.new);
    created.push(stage.listen.new);
    applyOwner(stage.database.new, owners.database);
    applyOwner(stage.ingest.new, owners.token);
    applyOwner(stage.listen.new, owners.token);
    return stage;
  } catch (error) {
    const parents = new Set();
    for (const path of created) if (existsSync(path)) {
      rmSync(path);
      parents.add(dirname(path));
    }
    for (const parent of parents) syncPath(parent);
    throw error;
  }
}
function installStaged(stage, journal) {
  for (const [name, value] of Object.entries(stage)) {
    const existed = journal[`${name}Existed`];
    if (existed) renameSync(value.live, value.old);
    renameSync(value.new, value.live);
    syncPath(dirname(value.live));
  }
}
function restorePriorFiles(stage, journal) {
  const changedParents = new Set();
  for (const [name, value] of Object.entries(stage)) {
    const existed = journal[`${name}Existed`];
    if (existsSync(value.old)) {
      if (existsSync(value.live)) rmSync(value.live);
      renameSync(value.old, value.live);
      syncPath(dirname(value.live));
    } else if (!existed && existsSync(value.live) && !existsSync(value.new)) {
      rmSync(value.live);
      syncPath(dirname(value.live));
    }
    if (existsSync(value.new)) {
      rmSync(value.new);
      changedParents.add(dirname(value.new));
    }
  }
  for (const parent of changedParents) syncPath(parent);
}
function cleanupOldFiles(stage) {
  const changedParents = new Set();
  for (const value of Object.values(stage)) {
    for (const path of [value.old, value.new]) if (existsSync(path)) {
      rmSync(path);
      changedParents.add(dirname(path));
    }
  }
  for (const parent of changedParents) syncPath(parent);
}
function sameState(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
function expectedPendingState(journal) {
  return {
    ...journal.priorState, pending: journal.targetReleaseId,
    sequence: journal.priorState.sequence + 1,
  };
}
function expectedActivatedState(journal) {
  return {
    current: journal.targetReleaseId, previous: journal.priorState.current, pending: null,
    revision: journal.priorState.revision + 1, sequence: journal.priorState.sequence + 2,
  };
}
function expectedRollbackPendingState(journal) {
  const activated = expectedActivatedState(journal);
  return {
    ...activated, pending: journal.priorState.current, sequence: activated.sequence + 1,
  };
}
function expectedRolledBackState(journal) {
  const pending = expectedRollbackPendingState(journal);
  return {
    current: journal.priorState.current, previous: journal.targetReleaseId, pending: null,
    revision: pending.revision + 1, sequence: pending.sequence + 1,
  };
}
function recoveryStateKind(state, journal) {
  if (sameState(state, journal.priorState)) return 'prior';
  if (journal.priorState.current !== journal.targetReleaseId
      && sameState(state, expectedPendingState(journal))) return 'pending';
  if (journal.priorState.current !== journal.targetReleaseId
      && sameState(state, expectedActivatedState(journal))) return 'activated';
  if (journal.priorState.current !== null
      && journal.priorState.current !== journal.targetReleaseId
      && sameState(state, expectedRollbackPendingState(journal))) return 'rollback_pending';
  if (journal.priorState.current !== null
      && journal.priorState.current !== journal.targetReleaseId
      && sameState(state, expectedRolledBackState(journal))) return 'rolled_back';
  fail('restore_corrupt');
}
function cleanupNewFiles(stage) {
  const changedParents = new Set();
  for (const value of Object.values(stage)) if (existsSync(value.new)) {
    rmSync(value.new);
    changedParents.add(dirname(value.new));
  }
  for (const parent of changedParents) syncPath(parent);
}
function replaceTargetFilesFromBundle(bundle, locations, owners, requestId) {
  const stage = stagedPaths(locations, requestId);
  cleanupNewFiles(stage);
  copyFileSync(join(bundle.path, 'database.sqlite3'), stage.database.new);
  copyFileSync(join(bundle.path, 'relay-ingest-token'), stage.ingest.new);
  copyFileSync(join(bundle.path, 'relay-listen-token'), stage.listen.new);
  applyOwner(stage.database.new, owners.database);
  applyOwner(stage.ingest.new, owners.token);
  applyOwner(stage.listen.new, owners.token);
  for (const value of Object.values(stage)) {
    renameSync(value.new, value.live);
    syncPath(dirname(value.live));
  }
}
function liveMatches(bundle, locations) {
  try {
    const proof = verifyDatabaseFile(locations.databasePath);
    const ingest = regular(locations.ingestTokenPath, 43);
    const listen = regular(locations.listenTokenPath, 43);
    return JSON.stringify(proof) === JSON.stringify(bundle.manifest.database)
      && digest(ingest) === bundle.manifest.tokens.ingest
      && digest(listen) === bundle.manifest.tokens.listen;
  } catch { return false; }
}
async function exactSchema(readSchema, release) {
  let generation;
  try { generation = await readSchema(); } catch { fail('restore_failed'); }
  if (generation !== release.manifest.schema.target) fail('restore_failed');
}
async function finalizeSuccess({
  backupRoot, bundle, journal, locations, releaseRoot, converge, readSchema, completedAt,
  checkpoint = async () => {},
}) {
  const target = readRelease(releaseRoot, journal.targetReleaseId);
  if (!liveMatches(bundle, locations)) fail('restore_failed');
  try { await converge(target); } catch { fail('restore_failed'); }
  await exactSchema(readSchema, target);
  const current = readReleaseState(releaseRoot);
  if (current.current !== target.releaseId || current.pending !== null) fail('restore_failed');
  const receipts = readRestoreReceipts(backupRoot);
  let receipt = receipts.get(journal.requestId);
  if (receipt && receipt.backupId !== journal.backupId) fail('restore_conflict');
  if (!receipt) {
    if (receipts.size >= MAX_RESTORE_RECEIPTS) fail('restore_capacity');
    receipt = {
      version: RESTORE_RECEIPT_VERSION, ordinal: receipts.size + 1,
      requestId: journal.requestId, backupId: journal.backupId,
      completedAt: journal.completedAt, code: 'backup_restored',
    };
    writeRestoreReceipt(backupRoot, receipt);
  }
  await checkpoint('receipt');
  cleanupOldFiles(stagedPaths(locations, journal.requestId));
  removeJournal(locations.databasePath);
  return Object.freeze({ ...receipt, replayed: false });
}

export async function recoverInterruptedRestore({
  backupRoot, databasePath, releaseRoot, ingestTokenPath, listenTokenPath,
  converge, readSchema, completedAt = Date.now(),
  owners = {
    database: { uid: 10001, gid: 10001, mode: 0o640 },
    token: { uid: 0, gid: 10001, mode: 0o640 },
  },
  checkpoint = async () => {},
}) {
  const journal = readJournal(databasePath);
  if (!journal) return Object.freeze({ code: 'restore_not_pending' });
  const bundle = verifyBackupBundle(backupRoot, journal.backupId);
  const locations = { databasePath, ingestTokenPath, listenTokenPath };
  const state = readReleaseState(releaseRoot);
  const stateKind = recoveryStateKind(state, journal);
  const activated = (journal.priorState.current === journal.targetReleaseId
    ? stateKind === 'prior' && journal.phase === 'activated'
    : stateKind === 'activated');
  if (activated && liveMatches(bundle, locations)) {
    return finalizeSuccess({
      backupRoot, bundle, journal, locations, releaseRoot, converge, readSchema, completedAt,
    });
  }
  const stage = stagedPaths(locations, journal.requestId);
  const target = readRelease(releaseRoot, journal.targetReleaseId);
  const prior = journal.priorState.current === null
    ? null : readRelease(releaseRoot, journal.priorState.current);
  try {
    await converge(target, { stop: true });
    if (prior && prior.releaseId !== target.releaseId) await converge(prior, { stop: true });
  } catch { fail('restore_rollback_failed'); }
  if (stateKind === 'activated' && journal.priorState.current === null) {
    try {
      replaceTargetFilesFromBundle(bundle, locations, owners, journal.requestId);
      await converge(target);
      await exactSchema(readSchema, target);
      return await finalizeSuccess({
        backupRoot, bundle, journal, locations, releaseRoot, converge, readSchema, completedAt,
      });
    } catch { fail('restore_rollback_failed'); }
  }
  restorePriorFiles(stage, journal);
  await checkpoint('rollback_files');
  let afterFiles = readReleaseState(releaseRoot);
  if (stateKind === 'activated') {
    writeReleaseState(releaseRoot, {
      ...afterFiles, pending: journal.priorState.current, sequence: afterFiles.sequence + 1,
    });
    await checkpoint('rollback_pending');
    afterFiles = readReleaseState(releaseRoot);
  }
  if (stateKind === 'activated' || stateKind === 'rollback_pending') {
    writeReleaseState(releaseRoot, {
      current: journal.priorState.current, previous: journal.targetReleaseId, pending: null,
      revision: afterFiles.revision + 1, sequence: afterFiles.sequence + 1,
    });
    await checkpoint('rolled_back');
  } else if (stateKind !== 'rolled_back' && afterFiles.pending !== null) {
    writeReleaseState(releaseRoot, {
      ...afterFiles, pending: null, sequence: afterFiles.sequence + 1,
    });
  }
  if (journal.priorState.current !== null) {
    try { await converge(prior); } catch { fail('restore_rollback_failed'); }
    await exactSchema(readSchema, prior);
  }
  removeJournal(databasePath);
  return Object.freeze({ code: 'restore_recovered' });
}

export async function restoreBackup({
  backupRoot, backupId, requestId, databasePath, releaseRoot,
  ingestTokenPath, listenTokenPath, converge, readSchema, completedAt = Date.now(),
  checkpoint = async () => {},
  persistJournal = writeJournal,
  pruneRecords = pruneReleaseRecords,
  owners = {
    database: { uid: 10001, gid: 10001, mode: 0o640 },
    token: { uid: 0, gid: 10001, mode: 0o640 },
  },
}) {
  if (!BACKUP_ID.test(backupId) || !REQUEST_ID.test(requestId)
      || !Number.isSafeInteger(completedAt) || completedAt < 0) fail('invalid_arguments');
  validateBackupDomain(backupRoot);
  let receipts = readRestoreReceipts(backupRoot);
  let replay = receipts.get(requestId);
  const pendingJournal = readJournal(databasePath);
  if (replay) {
    if (replay.backupId !== backupId) fail('restore_conflict');
    if (pendingJournal) {
      if (pendingJournal.requestId !== requestId) fail('restore_pending');
      await recoverInterruptedRestore({
        backupRoot, databasePath, releaseRoot, ingestTokenPath, listenTokenPath,
        converge, readSchema, completedAt, owners,
      });
    }
    return Object.freeze({ ...replay, replayed: true });
  }
  if (pendingJournal && pendingJournal.requestId === requestId
      && pendingJournal.backupId !== backupId) fail('restore_conflict');
  if (pendingJournal) {
    const recovered = await recoverInterruptedRestore({
      backupRoot, databasePath, releaseRoot, ingestTokenPath, listenTokenPath,
      converge, readSchema, completedAt, owners,
    });
    if (pendingJournal.requestId === requestId && recovered.code === 'backup_restored') {
      return recovered;
    }
    if (pendingJournal.requestId === requestId) completedAt = pendingJournal.completedAt;
    receipts = readRestoreReceipts(backupRoot);
    replay = receipts.get(requestId);
    if (replay) {
      if (replay.backupId !== backupId) fail('restore_conflict');
      return Object.freeze({ ...replay, replayed: true });
    }
  }
  if (receipts.size >= MAX_RESTORE_RECEIPTS) fail('restore_capacity');
  const bundle = verifyBackupBundle(backupRoot, backupId);
  const targetBundle = releaseFromBundle(bundle);
  validateReleaseDomain(releaseRoot, { create: true });
  let priorState = readReleaseState(releaseRoot);
  if (priorState.pending !== null) fail('restore_pending');
  pruneRecords(releaseRoot, retainedBackupReleaseIds(backupRoot), { reserve: 1 });
  const target = registerRelease(releaseRoot, targetBundle.manifest, targetBundle.files);
  priorState = readReleaseState(releaseRoot);
  if (priorState.pending !== null) fail('restore_pending');
  const locations = { databasePath, ingestTokenPath, listenTokenPath };
  let journal = {
    version: RESTORE_JOURNAL_VERSION, requestId, backupId,
    targetReleaseId: target.releaseId, phase: 'prepared', priorState,
    databaseExisted: existsSync(databasePath), ingestExisted: existsSync(ingestTokenPath),
    listenExisted: existsSync(listenTokenPath), completedAt,
  };
  preflightStagePaths(locations, requestId);
  try {
    persistJournal(databasePath, journal);
  } catch {
    fail('restore_failed');
  }
  const switchesRelease = priorState.current !== target.releaseId;
  const prior = priorState.current ? readRelease(releaseRoot, priorState.current) : null;
  try {
    await checkpoint('journaled');
    const stage = stageRestoreFiles(bundle, locations, owners, requestId);
    await checkpoint('prepared');
    if (switchesRelease) {
      writeReleaseState(releaseRoot, {
        ...priorState, pending: target.releaseId, sequence: priorState.sequence + 1,
      });
    }
    if (prior) await converge(prior, { stop: true });
    else await converge(target, { stop: true });
    verifyBackupBundle(backupRoot, backupId);
    installStaged(stage, journal);
    journal = { ...journal, phase: 'installed' };
    persistJournal(databasePath, journal);
    await checkpoint('installed');
    await converge(target);
    await exactSchema(readSchema, target);
    if (switchesRelease) {
      writeReleaseState(releaseRoot, {
        current: target.releaseId, previous: priorState.current, pending: null,
        revision: priorState.revision + 1, sequence: priorState.sequence + 2,
      });
    }
    journal = { ...journal, phase: 'activated' };
    persistJournal(databasePath, journal);
    await checkpoint('activated');
    return await finalizeSuccess({
      backupRoot, bundle, journal, locations, releaseRoot, converge, readSchema, completedAt,
      checkpoint,
    });
  } catch (error) {
    if (error?.restoreProcessLoss === true) throw error;
    try {
      const recovered = await recoverInterruptedRestore({
        backupRoot, databasePath, releaseRoot, ingestTokenPath, listenTokenPath,
        converge, readSchema, completedAt, owners,
      });
      if (recovered.code === 'backup_restored') return recovered;
    } catch { fail('restore_rollback_failed'); }
    if (error instanceof RestoreError) throw error;
    fail('restore_failed');
  }
}

function parseArguments(argv) {
  if (argv.length === 1 && argv[0] === 'reconcile') return { command: 'reconcile' };
  if (argv.length !== 5 || argv[0] !== 'restore') fail('invalid_arguments');
  const values = {};
  for (let index = 1; index < argv.length; index += 2) {
    if (!['--backup-id', '--request-id'].includes(argv[index])
        || Object.hasOwn(values, argv[index]) || !argv[index + 1]) fail('invalid_arguments');
    values[argv[index]] = argv[index + 1];
  }
  return { command: 'restore', backupId: values['--backup-id'], requestId: values['--request-id'] };
}

export async function executeRestoreCommand(argv, {
  backupRoot = PRODUCTION_BACKUP_ROOT, databasePath = PRODUCTION_DATABASE,
  releaseRoot = PRODUCTION_RELEASE_ROOT, ingestTokenPath = PRODUCTION_INGEST_TOKEN,
  listenTokenPath = PRODUCTION_LISTEN_TOKEN, converge = createProductionConverger(),
  readSchema = () => readSchemaGeneration(databasePath), lock = withOperationsLock,
  restore = restoreBackup, recover = recoverInterruptedRestore,
} = {}) {
  const parsed = parseArguments(argv);
  return lock(() => parsed.command === 'reconcile'
    ? recover({
      backupRoot, databasePath, releaseRoot, ingestTokenPath, listenTokenPath,
      converge, readSchema,
    })
    : restore({
      backupRoot, backupId: parsed.backupId, requestId: parsed.requestId,
      databasePath, releaseRoot, ingestTokenPath, listenTokenPath, converge, readSchema,
    }));
}

async function main() {
  try {
    const result = await executeRestoreCommand(process.argv.slice(2));
    process.stdout.write(`${result.code}\n`);
  } catch (error) {
    const code = error instanceof RestoreError || error instanceof BackupError
      || error instanceof ReleaseStateError ? error.code : 'restore_failed';
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
