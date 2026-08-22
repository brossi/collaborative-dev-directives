import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, readdirSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

export const RELEASE_MANIFEST_VERSION = 1;
export const RELEASE_IDENTITY_LEDGER_VERSION = 1;
export const MAX_RELEASE_IDENTITIES = 64;
export const MAX_RELEASE_RECORDS = 18;
export const MAX_RELEASE_MANIFEST_BYTES = 16 * 1024;
export const MAX_CADDYFILE_BYTES = 64 * 1024;
export const MAX_COMPOSE_BYTES = 128 * 1024;

const MAX_IDENTITY_LEDGER_BYTES = 16 * 1024;
const MAX_STATE_BYTES = 1024;
const MAX_DIGEST_FILE_BYTES = 72;
const RELEASE_ID = /^[a-z0-9][a-z0-9._-]{6,79}$/u;
const SOURCE_REVISION = /^[0-9a-f]{40}$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const IMAGE = /^(?:sha256:[0-9a-f]{64}|[a-z0-9]+(?:[._/-][a-z0-9]+)*(?::[a-zA-Z0-9._-]+)?@sha256:[0-9a-f]{64})$/u;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const ROOT_TEMP = new RegExp(
  `^(?:state\\.json|state-authority\\.json|identities\\.json)\\.tmp-${UUID}$`, 'u',
);
const IDENTITY_TEMP = new RegExp(`^[a-z0-9][a-z0-9._-]{6,79}\\.json\\.tmp-${UUID}$`, 'u');
const RECORD_TEMP = new RegExp(`^\\.tmp-[a-z0-9][a-z0-9._-]{6,79}-${UUID}$`, 'u');
const FILE_NAMES = Object.freeze(['Caddyfile', 'compose.yaml']);
const RECORD_FILES = Object.freeze(['Caddyfile', 'compose.yaml', 'manifest.json', 'manifest.sha256']);
const FILE_LIMITS = Object.freeze({
  Caddyfile: MAX_CADDYFILE_BYTES,
  'compose.yaml': MAX_COMPOSE_BYTES,
});
const INITIAL_STATE = Object.freeze({
  current: null, previous: null, pending: null, revision: 0, sequence: 0,
});

export class ReleaseStateError extends Error {
  constructor(code) { super(code); this.code = code; }
}

function fail(code) { throw new ReleaseStateError(code); }
function sha256(bytes) { return `sha256:${createHash('sha256').update(bytes).digest('hex')}`; }
function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}
function byteLength(value) { return Buffer.byteLength(value, 'utf8'); }
function boundedString(value, maximum) {
  return typeof value === 'string' && value.length > 0 && !value.includes('\0')
    && byteLength(value) <= maximum;
}

export function deploymentDigest(files) {
  if (!exactKeys(files, FILE_NAMES)) fail('invalid_release');
  const hash = createHash('sha256');
  for (const name of FILE_NAMES) {
    const value = files[name];
    if (!boundedString(value, FILE_LIMITS[name])) fail('invalid_release');
    const bytes = Buffer.from(value);
    hash.update(`${name.length}:${name}:${bytes.length}:`);
    hash.update(bytes);
  }
  return `sha256:${hash.digest('hex')}`;
}

export function canonicalReleaseManifest(input) {
  if (!exactKeys(input, [
    'version', 'releaseId', 'sourceRevision', 'catalogVersion', 'createdAt',
    'schema', 'images', 'deploymentDigest',
  ]) || input.version !== RELEASE_MANIFEST_VERSION
      || typeof input.releaseId !== 'string' || !RELEASE_ID.test(input.releaseId)
      || typeof input.sourceRevision !== 'string' || !SOURCE_REVISION.test(input.sourceRevision)
      || typeof input.catalogVersion !== 'string' || !DIGEST.test(input.catalogVersion)
      || !Number.isSafeInteger(input.createdAt) || input.createdAt < 0
      || typeof input.deploymentDigest !== 'string' || !DIGEST.test(input.deploymentDigest)
      || !exactKeys(input.schema, ['min', 'max', 'target'])
      || ![input.schema.min, input.schema.max, input.schema.target]
        .every((value) => Number.isSafeInteger(value) && value >= 1)
      || input.schema.min > input.schema.target || input.schema.target > input.schema.max
      || !exactKeys(input.images, ['caddy', 'web', 'relay'])
      || !Object.values(input.images).every((value) => typeof value === 'string'
        && IMAGE.test(value))) fail('invalid_release');
  const canonical = JSON.stringify({
    version: RELEASE_MANIFEST_VERSION,
    releaseId: input.releaseId,
    sourceRevision: input.sourceRevision,
    catalogVersion: input.catalogVersion,
    createdAt: input.createdAt,
    schema: { min: input.schema.min, max: input.schema.max, target: input.schema.target },
    images: {
      caddy: input.images.caddy, web: input.images.web, relay: input.images.relay,
    },
    deploymentDigest: input.deploymentDigest,
  });
  if (byteLength(canonical) > MAX_RELEASE_MANIFEST_BYTES) fail('invalid_release');
  return canonical;
}

function paths(root) {
  return {
    records: join(root, 'records'), identityFiles: join(root, 'identities'),
    identityLedger: join(root, 'identities.json'), state: join(root, 'state.json'),
    stateAuthority: join(root, 'state-authority.json'),
  };
}

function ensureDirectory(path) {
  if (existsSync(path)) {
    const retained = lstatSync(path);
    if (retained.isSymbolicLink() || !retained.isDirectory()) fail('release_corrupt');
  } else mkdirSync(path, { recursive: false, mode: 0o750 });
}

function syncPath(path) {
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function atomicWrite(path, bytes, mode = 0o440) {
  const temporary = `${path}.tmp-${randomUUID()}`;
  let fd;
  try {
    fd = openSync(temporary, 'wx', mode);
    writeFileSync(fd, bytes);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, path);
    syncPath(dirname(path));
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temporary)) rmSync(temporary);
  }
}

function readBoundedRegular(path, maximum) {
  const retained = lstatSync(path);
  if (retained.isSymbolicLink() || !retained.isFile()
      || retained.size < 1 || retained.size > maximum) fail('release_corrupt');
  return readFileSync(path, 'utf8');
}

function cleanupInterruptedWrites(root) {
  for (const name of readdirSync(root)) {
    if (!ROOT_TEMP.test(name)) continue;
    const target = join(root, name);
    const retained = lstatSync(target);
    if (retained.isSymbolicLink() || !retained.isFile()) fail('release_corrupt');
    rmSync(target);
  }
  const recordRoot = paths(root).records;
  for (const name of readdirSync(recordRoot)) {
    if (!RECORD_TEMP.test(name)) continue;
    const target = join(recordRoot, name);
    const retained = lstatSync(target);
    if (retained.isSymbolicLink() || !retained.isDirectory()) fail('release_corrupt');
    rmSync(target, { recursive: true });
  }
  const identityRoot = paths(root).identityFiles;
  for (const name of readdirSync(identityRoot)) {
    if (!IDENTITY_TEMP.test(name)) continue;
    const target = join(identityRoot, name);
    const retained = lstatSync(target);
    if (retained.isSymbolicLink() || !retained.isFile()) fail('release_corrupt');
    rmSync(target);
  }
}

function readIdentityLedger(root) {
  const path = paths(root).identityLedger;
  if (!existsSync(path)) return Object.freeze([]);
  try {
    const value = JSON.parse(readBoundedRegular(path, MAX_IDENTITY_LEDGER_BYTES));
    if (!exactKeys(value, ['version', 'receipts'])
        || value.version !== RELEASE_IDENTITY_LEDGER_VERSION
        || !Array.isArray(value.receipts)
        || value.receipts.length > MAX_RELEASE_IDENTITIES) fail('release_corrupt');
    const seen = new Set();
    for (let index = 0; index < value.receipts.length; index += 1) {
      const receipt = value.receipts[index];
      if (!exactKeys(receipt, ['ordinal', 'releaseId', 'manifestDigest'])
          || receipt.ordinal !== index + 1
          || typeof receipt.releaseId !== 'string' || !RELEASE_ID.test(receipt.releaseId)
          || typeof receipt.manifestDigest !== 'string' || !DIGEST.test(receipt.manifestDigest)
          || seen.has(receipt.releaseId)) fail('release_corrupt');
      seen.add(receipt.releaseId);
    }
    return Object.freeze(value.receipts.map((receipt) => Object.freeze({ ...receipt })));
  } catch (error) {
    if (error instanceof ReleaseStateError) throw error;
    fail('release_corrupt');
  }
}

function writeIdentityLedger(root, receipts) {
  const canonical = JSON.stringify({ version: RELEASE_IDENTITY_LEDGER_VERSION, receipts });
  if (byteLength(canonical) > MAX_IDENTITY_LEDGER_BYTES) fail('release_capacity');
  atomicWrite(paths(root).identityLedger, canonical);
}

function readIdentityFile(path, expectedReleaseId) {
  try {
    const value = JSON.parse(readBoundedRegular(path, 256));
    if (!exactKeys(value, ['ordinal', 'releaseId', 'manifestDigest'])
        || !Number.isSafeInteger(value.ordinal) || value.ordinal < 1
        || value.releaseId !== expectedReleaseId
        || typeof value.manifestDigest !== 'string' || !DIGEST.test(value.manifestDigest)) {
      fail('release_corrupt');
    }
    return Object.freeze(value);
  } catch (error) {
    if (error instanceof ReleaseStateError) throw error;
    fail('release_corrupt');
  }
}

function reconcileIdentityEvidence(root, ledgerReceipts) {
  const identityRoot = paths(root).identityFiles;
  const fileReceipts = new Map();
  for (const name of readdirSync(identityRoot)) {
    if (!name.endsWith('.json')) fail('release_corrupt');
    const releaseId = name.slice(0, -5);
    if (!RELEASE_ID.test(releaseId)) fail('release_corrupt');
    const receipt = readIdentityFile(join(identityRoot, name), releaseId);
    fileReceipts.set(releaseId, receipt);
  }
  const receipts = [...ledgerReceipts];
  const receiptMap = new Map(receipts.map((receipt) => [receipt.releaseId, receipt]));
  for (const [releaseId, fileReceipt] of fileReceipts) {
    const ledgerReceipt = receiptMap.get(releaseId);
    if (ledgerReceipt && (ledgerReceipt.manifestDigest !== fileReceipt.manifestDigest
        || ledgerReceipt.ordinal !== fileReceipt.ordinal)) {
      fail('release_corrupt');
    }
  }
  const orphans = [...fileReceipts.values()]
    .filter((receipt) => !receiptMap.has(receipt.releaseId))
    .sort((left, right) => left.ordinal - right.ordinal);
  if (receipts.length + orphans.length > MAX_RELEASE_IDENTITIES) fail('release_corrupt');
  for (const receipt of orphans) {
    if (receipt.ordinal !== receipts.length + 1) fail('release_corrupt');
    const appended = {
      ordinal: receipt.ordinal,
      releaseId: receipt.releaseId,
      manifestDigest: receipt.manifestDigest,
    };
    receipts.push(appended);
    receiptMap.set(appended.releaseId, appended);
  }
  for (const receipt of receipts) {
    const fileReceipt = fileReceipts.get(receipt.releaseId);
    if (!fileReceipt) {
      atomicWrite(join(identityRoot, `${receipt.releaseId}.json`), JSON.stringify({
        ordinal: receipt.ordinal, releaseId: receipt.releaseId,
        manifestDigest: receipt.manifestDigest,
      }));
    }
  }
  if (orphans.length > 0 || (!existsSync(paths(root).identityLedger) && receipts.length > 0)) {
    writeIdentityLedger(root, receipts);
  }
  return Object.freeze({
    receipts: Object.freeze(receipts.map((receipt) => Object.freeze({ ...receipt }))),
    receiptMap,
  });
}

function readReleaseRecord(root, releaseId, receiptMap) {
  if (typeof releaseId !== 'string' || !RELEASE_ID.test(releaseId)) fail('release_corrupt');
  const recordPath = join(paths(root).records, releaseId);
  try {
    const directory = lstatSync(recordPath);
    if (directory.isSymbolicLink() || !directory.isDirectory()) fail('release_corrupt');
    if (JSON.stringify(readdirSync(recordPath).sort()) !== JSON.stringify([...RECORD_FILES].sort())) {
      fail('release_corrupt');
    }
    const manifestBytes = readBoundedRegular(
      join(recordPath, 'manifest.json'), MAX_RELEASE_MANIFEST_BYTES,
    );
    const digestBytes = readBoundedRegular(
      join(recordPath, 'manifest.sha256'), MAX_DIGEST_FILE_BYTES,
    );
    const canonical = canonicalReleaseManifest(JSON.parse(manifestBytes));
    if (canonical !== manifestBytes) fail('release_corrupt');
    const manifest = JSON.parse(canonical);
    if (manifest.releaseId !== releaseId) fail('release_corrupt');
    const manifestDigest = sha256(canonical);
    if (digestBytes !== `${manifestDigest}\n`) fail('release_corrupt');
    const receipt = receiptMap.get(releaseId);
    if (!receipt || receipt.manifestDigest !== manifestDigest) fail('release_corrupt');
    const files = Object.fromEntries(FILE_NAMES.map((name) => [
      name, readBoundedRegular(join(recordPath, name), FILE_LIMITS[name]),
    ]));
    if (deploymentDigest(files) !== manifest.deploymentDigest) fail('release_corrupt');
    return Object.freeze({ releaseId, manifestDigest, manifest, recordPath, files });
  } catch (error) {
    if (error instanceof ReleaseStateError) throw error;
    fail('release_corrupt');
  }
}

export function validateReleaseDomain(root, { create = false } = {}) {
  try {
    if (!existsSync(root)) {
      if (!create) fail('release_corrupt');
      mkdirSync(root, { recursive: false, mode: 0o750 });
    }
    ensureDirectory(root);
    const retainedPaths = paths(root);
    if (!existsSync(retainedPaths.records)) {
      if (!create) fail('release_corrupt');
      ensureDirectory(retainedPaths.records);
    } else ensureDirectory(retainedPaths.records);
    if (!existsSync(retainedPaths.identityFiles)) {
      if (!create) fail('release_corrupt');
      ensureDirectory(retainedPaths.identityFiles);
    } else ensureDirectory(retainedPaths.identityFiles);
    cleanupInterruptedWrites(root);
    const allowedRoot = new Set([
      'records', 'identities', 'identities.json', 'state.json', 'state-authority.json',
    ]);
    if (readdirSync(root).some((name) => !allowedRoot.has(name))) fail('release_corrupt');
    const identityDomain = reconcileIdentityEvidence(root, readIdentityLedger(root));
    const { receipts, receiptMap } = identityDomain;
    const recordNames = readdirSync(retainedPaths.records);
    if (recordNames.length > MAX_RELEASE_RECORDS) fail('release_corrupt');
    for (const releaseId of recordNames) {
      if (!RELEASE_ID.test(releaseId)) fail('release_corrupt');
      readReleaseRecord(root, releaseId, receiptMap);
    }
    if (recordNames.length > 0 && receipts.length === 0) fail('release_corrupt');
    if (!existsSync(retainedPaths.state) && !existsSync(retainedPaths.stateAuthority)) {
      if (receipts.length > 0 || recordNames.length > 0 || !create) fail('release_corrupt');
      atomicWrite(retainedPaths.stateAuthority, JSON.stringify(INITIAL_STATE), 0o440);
      atomicWrite(retainedPaths.state, JSON.stringify(INITIAL_STATE), 0o640);
    } else {
      readStatePair(root);
    }
    return Object.freeze({ receipts, receiptMap, records: Object.freeze([...recordNames]) });
  } catch (error) {
    if (error instanceof ReleaseStateError) throw error;
    fail('release_corrupt');
  }
}

export function registerRelease(root, manifest, files) {
  const canonical = canonicalReleaseManifest(manifest);
  if (deploymentDigest(files) !== manifest.deploymentDigest) fail('release_conflict');
  const manifestDigest = sha256(canonical);
  const domain = validateReleaseDomain(root, { create: true });
  const existingReceipt = domain.receiptMap.get(manifest.releaseId);
  if (existingReceipt) {
    if (existingReceipt.manifestDigest !== manifestDigest) fail('release_conflict');
  } else {
    if (domain.receipts.length >= MAX_RELEASE_IDENTITIES) fail('release_capacity');
    const recordPath = join(paths(root).records, manifest.releaseId);
    if (!existsSync(recordPath) && domain.records.length >= MAX_RELEASE_RECORDS) {
      fail('release_capacity');
    }
    const ordinal = domain.receipts.length + 1;
    atomicWrite(join(paths(root).identityFiles, `${manifest.releaseId}.json`), JSON.stringify({
      ordinal, releaseId: manifest.releaseId, manifestDigest,
    }));
    writeIdentityLedger(root, [...domain.receipts, {
      ordinal, releaseId: manifest.releaseId, manifestDigest,
    }]);
  }

  const recordPath = join(paths(root).records, manifest.releaseId);
  if (existsSync(recordPath)) {
    const retained = readRelease(root, manifest.releaseId);
    if (retained.manifestDigest !== manifestDigest) fail('release_conflict');
    return Object.freeze({ code: 'release_registered', replayed: true, ...retained });
  }
  if (domain.records.length >= MAX_RELEASE_RECORDS) fail('release_capacity');
  const temporary = join(paths(root).records, `.tmp-${manifest.releaseId}-${randomUUID()}`);
  try {
    mkdirSync(temporary, { mode: 0o750 });
    writeFileSync(join(temporary, 'manifest.json'), canonical, { flag: 'wx', mode: 0o440 });
    writeFileSync(join(temporary, 'manifest.sha256'), `${manifestDigest}\n`, {
      flag: 'wx', mode: 0o440,
    });
    for (const name of FILE_NAMES) {
      writeFileSync(join(temporary, name), files[name], { flag: 'wx', mode: 0o440 });
    }
    for (const name of RECORD_FILES) {
      chmodSync(join(temporary, name), 0o440);
      syncPath(join(temporary, name));
    }
    syncPath(temporary);
    renameSync(temporary, recordPath);
    chmodSync(recordPath, 0o550);
    syncPath(paths(root).records);
  } catch (error) {
    if (existsSync(temporary)) rmSync(temporary, { recursive: true });
    if (existsSync(recordPath)) {
      const retained = readRelease(root, manifest.releaseId);
      if (retained.manifestDigest === manifestDigest) {
        return Object.freeze({ code: 'release_registered', replayed: true, ...retained });
      }
    }
    if (error instanceof ReleaseStateError) throw error;
    fail('release_unavailable');
  }
  const retained = readRelease(root, manifest.releaseId);
  return Object.freeze({ code: 'release_registered', replayed: false, ...retained });
}

export function readRelease(root, releaseId) {
  const domain = validateReleaseDomain(root);
  return readReleaseRecord(root, releaseId, domain.receiptMap);
}

export function pruneReleaseRecords(root, retainedReleaseIds = [], { reserve = 1 } = {}) {
  if (!Array.isArray(retainedReleaseIds) || !Number.isSafeInteger(reserve)
      || reserve < 0 || reserve >= MAX_RELEASE_RECORDS) fail('invalid_release');
  const domain = validateReleaseDomain(root);
  const state = readReleaseState(root);
  const protectedIds = new Set([state.current, state.previous, state.pending].filter(Boolean));
  for (const releaseId of retainedReleaseIds) {
    if (typeof releaseId !== 'string' || !RELEASE_ID.test(releaseId)) fail('invalid_release');
    protectedIds.add(releaseId);
  }
  const records = new Set(domain.records);
  const protectedRecords = [...protectedIds].filter((releaseId) => records.has(releaseId));
  const target = MAX_RELEASE_RECORDS - reserve;
  if (protectedRecords.length > target) fail('release_capacity');
  const ordinal = new Map(domain.receipts.map((receipt) => [receipt.releaseId, receipt.ordinal]));
  const candidates = domain.records.filter((releaseId) => !protectedIds.has(releaseId))
    .sort((left, right) => ordinal.get(left) - ordinal.get(right));
  const removed = [];
  while (records.size > target && candidates.length > 0) {
    const releaseId = candidates.shift();
    const recordPath = join(paths(root).records, releaseId);
    const discarded = join(paths(root).records, `.tmp-${releaseId}-${randomUUID()}`);
    chmodSync(recordPath, 0o700);
    renameSync(recordPath, discarded);
    syncPath(paths(root).records);
    rmSync(discarded, { recursive: true });
    records.delete(releaseId);
    removed.push(releaseId);
  }
  if (records.size > target) fail('release_capacity');
  if (removed.length > 0) syncPath(paths(root).records);
  validateReleaseDomain(root);
  return Object.freeze({
    code: 'release_records_pruned', removed: Object.freeze(removed), reserve,
  });
}

function defaultState() {
  return INITIAL_STATE;
}

function parseState(path) {
  const value = JSON.parse(readBoundedRegular(path, MAX_STATE_BYTES));
  const validCurrent = value.current === null
    || (typeof value.current === 'string' && RELEASE_ID.test(value.current));
  const validPrevious = value.previous === null
    || (typeof value.previous === 'string' && RELEASE_ID.test(value.previous));
  const validPending = value.pending === null
    || (typeof value.pending === 'string' && RELEASE_ID.test(value.pending));
  if (!exactKeys(value, ['current', 'previous', 'pending', 'revision', 'sequence'])
      || !validCurrent || !validPrevious || !validPending
      || (value.current === null && (value.previous !== null || value.revision !== 0))
      || (value.current !== null && (!Number.isSafeInteger(value.revision) || value.revision < 1))
      || (value.current === value.previous && value.current !== null)
      || (value.current === value.pending && value.current !== null)
      || !Number.isSafeInteger(value.revision) || value.revision < 0
      || !Number.isSafeInteger(value.sequence) || value.sequence < 0) fail('release_corrupt');
  return value;
}

function validStateTransition(before, after) {
  if (after.sequence !== before.sequence + 1) return false;
  const sameAuthority = after.current === before.current
    && after.previous === before.previous && after.revision === before.revision;
  const startsPending = before.pending === null && after.pending !== null && sameAuthority;
  const clearsPending = before.pending !== null && after.pending === null && sameAuthority;
  const activatesPending = before.pending !== null && after.pending === null
    && after.current === before.pending && after.previous === before.current
    && after.revision === before.revision + 1;
  return startsPending || clearsPending || activatesPending;
}

function readStatePair(root) {
  const retainedPaths = paths(root);
  if (!existsSync(retainedPaths.stateAuthority)) fail('release_corrupt');
  const authority = parseState(retainedPaths.stateAuthority);
  if (!existsSync(retainedPaths.state)) {
    atomicWrite(retainedPaths.state, JSON.stringify(authority), 0o640);
    return authority;
  }
  const projection = parseState(retainedPaths.state);
  if (JSON.stringify(authority) === JSON.stringify(projection)) return authority;
  if (!validStateTransition(projection, authority)) fail('release_corrupt');
  atomicWrite(retainedPaths.state, JSON.stringify(authority), 0o640);
  return authority;
}

export function readReleaseState(root) {
  const domain = validateReleaseDomain(root);
  try {
    const value = readStatePair(root);
    for (const releaseId of [value.current, value.previous, value.pending]) {
      if (releaseId !== null) readReleaseRecord(root, releaseId, domain.receiptMap);
    }
    return Object.freeze(value);
  } catch (error) {
    if (error instanceof ReleaseStateError) throw error;
    fail('release_corrupt');
  }
}

export function writeReleaseState(root, value) {
  const current = readStatePair(root);
  const canonical = JSON.stringify(value);
  parseStateBytes(canonical);
  if (!validStateTransition(current, value)) fail('release_corrupt');
  try {
    atomicWrite(paths(root).stateAuthority, canonical, 0o440);
  } catch (error) {
    try {
      if (JSON.stringify(parseState(paths(root).stateAuthority)) !== canonical) throw error;
    } catch {
      throw error;
    }
  }
  try { atomicWrite(paths(root).state, canonical, 0o640); } catch {
    // The authority rename is the commit point. Restart repairs its projection.
  }
}

function parseStateBytes(bytes) {
  if (Buffer.byteLength(bytes, 'utf8') > MAX_STATE_BYTES) fail('release_corrupt');
  const temporary = JSON.parse(bytes);
  const validCurrent = temporary.current === null
    || (typeof temporary.current === 'string' && RELEASE_ID.test(temporary.current));
  const validPrevious = temporary.previous === null
    || (typeof temporary.previous === 'string' && RELEASE_ID.test(temporary.previous));
  const validPending = temporary.pending === null
    || (typeof temporary.pending === 'string' && RELEASE_ID.test(temporary.pending));
  if (!exactKeys(temporary, ['current', 'previous', 'pending', 'revision', 'sequence'])
      || !validCurrent || !validPrevious || !validPending
      || (temporary.current === null
        && (temporary.previous !== null || temporary.revision !== 0))
      || (temporary.current !== null
        && (!Number.isSafeInteger(temporary.revision) || temporary.revision < 1))
      || (temporary.current === temporary.previous && temporary.current !== null)
      || (temporary.current === temporary.pending && temporary.current !== null)
      || !Number.isSafeInteger(temporary.revision) || temporary.revision < 0
      || !Number.isSafeInteger(temporary.sequence) || temporary.sequence < 0) {
    fail('release_corrupt');
  }
  return temporary;
}

function schemaSupported(manifest, generation) {
  return Number.isSafeInteger(generation) && generation >= manifest.schema.min
    && generation <= manifest.schema.max;
}

async function exactSchema(readSchema, manifest) {
  let generation;
  try { generation = await readSchema(); } catch { fail('schema_unavailable'); }
  if (!schemaSupported(manifest, generation) || generation !== manifest.schema.target) {
    fail('schema_incompatible');
  }
  return generation;
}

async function restoreCurrent(current, readSchema, converge) {
  try {
    if (current) {
      await converge(current);
      await exactSchema(readSchema, current.manifest);
    }
  } catch { fail('rollback_failed'); }
}

function clearPending(root, state, publishState) {
  publishState(root, { ...state, pending: null, sequence: state.sequence + 1 });
}

export async function deployRelease({
  root, manifest, files, readSchema, backup, converge, publishState = writeReleaseState,
}) {
  const registered = registerRelease(root, manifest, files);
  const state = readReleaseState(root);
  if (state.pending !== null) fail('deployment_pending');
  if (state.current === manifest.releaseId) {
    return Object.freeze({ code: 'already_active', releaseId: manifest.releaseId });
  }
  let generation;
  try { generation = await readSchema(); } catch { fail('schema_unavailable'); }
  const fresh = generation === null && state.current === null;
  if (!fresh && (!schemaSupported(manifest, generation)
      || manifest.schema.target !== generation)) fail('schema_incompatible');
  const current = state.current ? readRelease(root, state.current) : null;
  if (current && !schemaSupported(current.manifest, manifest.schema.target)) {
    fail('rollback_incompatible');
  }
  try {
    await backup({
      reason: 'pre_release', releaseId: manifest.releaseId, stateSequence: state.sequence,
    });
  }
  catch { fail('backup_failed'); }
  const pendingState = {
    ...state, pending: manifest.releaseId, sequence: state.sequence + 1,
  };
  try { publishState(root, pendingState); } catch { fail('release_unavailable'); }
  try {
    await converge(registered);
    await exactSchema(readSchema, manifest);
  } catch {
    try {
      if (current) await restoreCurrent(current, readSchema, converge);
      else await converge(registered, { stop: true });
      clearPending(root, pendingState, publishState);
    } catch (error) {
      if (error instanceof ReleaseStateError && error.code === 'rollback_failed') throw error;
      fail('release_unavailable');
    }
    fail('candidate_failed');
  }
  const next = {
    current: manifest.releaseId, previous: state.current, pending: null,
    revision: state.revision + 1, sequence: state.sequence + 2,
  };
  try { publishState(root, next); } catch {
    try {
      if (current) await restoreCurrent(current, readSchema, converge);
      else await converge(registered, { stop: true });
    } catch (error) {
      if (error instanceof ReleaseStateError && error.code === 'rollback_failed') throw error;
      fail('rollback_failed');
    }
    fail('release_unavailable');
  }
  return Object.freeze({ code: 'release_activated', ...next });
}

export async function rollbackRelease({
  root, readSchema, backup, converge, publishState = writeReleaseState,
}) {
  const state = readReleaseState(root);
  if (state.pending !== null) fail('deployment_pending');
  if (!state.current || !state.previous) fail('rollback_unavailable');
  const current = readRelease(root, state.current);
  const previous = readRelease(root, state.previous);
  let generation;
  try { generation = await readSchema(); } catch { fail('schema_unavailable'); }
  if (!schemaSupported(previous.manifest, generation)) fail('rollback_incompatible');
  try {
    await backup({
      reason: 'pre_rollback', releaseId: previous.releaseId, stateSequence: state.sequence,
    });
  }
  catch { fail('backup_failed'); }
  const pendingState = {
    ...state, pending: previous.releaseId, sequence: state.sequence + 1,
  };
  try { publishState(root, pendingState); } catch { fail('release_unavailable'); }
  try {
    await converge(previous);
    await exactSchema(readSchema, previous.manifest);
  } catch {
    try {
      await restoreCurrent(current, readSchema, converge);
      clearPending(root, pendingState, publishState);
    } catch (error) {
      if (error instanceof ReleaseStateError && error.code === 'rollback_failed') throw error;
      fail('release_unavailable');
    }
    fail('candidate_failed');
  }
  const next = {
    current: previous.releaseId, previous: current.releaseId, pending: null,
    revision: state.revision + 1, sequence: state.sequence + 2,
  };
  try { publishState(root, next); } catch {
    await restoreCurrent(current, readSchema, converge);
    fail('release_unavailable');
  }
  return Object.freeze({ code: 'release_rolled_back', ...next });
}

export async function reconcileRelease({
  root, readSchema, converge, publishState = writeReleaseState,
}) {
  const state = readReleaseState(root);
  if (state.pending !== null) {
    const pending = readRelease(root, state.pending);
    if (state.current === null) {
      try { await converge(pending, { stop: true }); } catch { fail('candidate_failed'); }
      try { clearPending(root, state, publishState); } catch { fail('release_unavailable'); }
      return Object.freeze({ code: 'release_reconciled', releaseId: null });
    }
    const current = readRelease(root, state.current);
    try { await converge(current); } catch { fail('candidate_failed'); }
    await exactSchema(readSchema, current.manifest);
    try { clearPending(root, state, publishState); } catch { fail('release_unavailable'); }
    return Object.freeze({ code: 'release_reconciled', releaseId: current.releaseId });
  }
  if (!state.current) fail('release_unavailable');
  const current = readRelease(root, state.current);
  await exactSchema(readSchema, current.manifest);
  try { await converge(current); } catch { fail('candidate_failed'); }
  await exactSchema(readSchema, current.manifest);
  return Object.freeze({ code: 'release_reconciled', releaseId: current.releaseId });
}
