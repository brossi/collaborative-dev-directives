import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync,
  renameSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test, { afterEach } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
  BackupError, DAILY_BACKUP_RETENTION, MAX_BACKUP_RECEIPTS, MAX_RETAINED_BACKUPS,
  MIN_BACKUP_FREE_BYTES, createBackup,
  executeBackupCommand, pruneBackups, validateBackupDomain, verifyBackupBundle,
} from '../scripts/backup.mjs';
import {
  deployRelease, deploymentDigest, readReleaseState, registerRelease, writeReleaseState,
} from '../scripts/release-state.mjs';
import { loadCatalogArtifacts } from '../../web/lib/server/release/catalog.mjs';
import { createReleaseStore } from '../../web/lib/server/release/store.mjs';
import {
  MAX_RESTORE_RECEIPTS, RestoreError, recoverInterruptedRestore, restoreBackup,
  executeRestoreCommand,
} from '../scripts/restore.mjs';

const roots = [];
afterEach(() => {
  while (roots.length) {
    const path = roots.pop();
    execFileSync('chmod', ['-R', 'u+w', path]);
    rmSync(path, { recursive: true, force: true });
  }
});
const catalog = loadCatalogArtifacts({
  catalogPath: resolve('web/data/catalog.json'),
  manifestPath: resolve('web/data/catalog-manifest.json'),
});
const hash = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const digest = (character) => `sha256:${character.repeat(64)}`;
const files = Object.freeze({
  Caddyfile: 'play.cannabeats.social { reverse_proxy web:3000 }\n',
  'compose.yaml': 'name: cannabeats\nservices: {}\n',
});
function releaseManifest(releaseId = 'release-0001') {
  return {
    version: 1, releaseId, sourceRevision: 'a'.repeat(40),
    catalogVersion: catalog.version, createdAt: 1000,
    schema: { min: 1, max: 1, target: 1 },
    images: { caddy: digest('c'), web: digest('d'), relay: digest('e') },
    deploymentDigest: deploymentDigest(files),
  };
}
async function fixture() {
  const parent = mkdtempSync(join(tmpdir(), 'cannabeats-fr83-'));
  roots.push(parent);
  const databasePath = join(parent, 'data', 'cannabeats.sqlite3');
  const store = createReleaseStore(databasePath, { catalog, now: 1000 });
  store.issueEnrollment({
    enrollmentCode: 'Q'.repeat(32),
    requestId: '00000000-0000-4000-8000-000000000001', now: 1000,
  });
  store.close();
  const releaseRoot = join(parent, 'releases');
  await deployRelease({
    root: releaseRoot, manifest: releaseManifest(), files,
    readSchema: async () => 1, backup: async () => {}, converge: async () => {},
  });
  const secrets = join(parent, 'secrets');
  const ingestTokenPath = join(secrets, 'ingest');
  const listenTokenPath = join(secrets, 'listen');
  mkdirSync(secrets);
  writeFileSync(ingestTokenPath, 'A'.repeat(43));
  writeFileSync(listenTokenPath, 'B'.repeat(43));
  return {
    parent, root: join(parent, 'backups'), databasePath, releaseRoot,
    ingestTokenPath, listenTokenPath,
  };
}
function request(index) { return hash(`backup-request-${index}`); }
function options(base, index = 1, overrides = {}) {
  return {
    ...base, requestId: request(index), reason: 'daily',
    operationReleaseId: 'release-0001', stateSequence: 2,
    createdAt: 1_800_000_000_000 + index,
    statfs: () => ({ bavail: 1_000_000, bsize: 4096 }), ...overrides,
  };
}
function rejects(work, code) {
  return assert.rejects(work, (error) => error instanceof BackupError && error.code === code);
}

test('online backup binds SQLite, both secrets, and the exact active release and replays once', async () => {
  const base = await fixture();
  const localOperatorToken = 'O'.repeat(43);
  writeFileSync(join(dirname(base.ingestTokenPath), 'operator-token'), localOperatorToken);
  const created = await createBackup(options(base));
  assert.equal(created.code, 'backup_created');
  assert.equal(created.replayed, false);
  const verified = verifyBackupBundle(base.root, created.backupId);
  assert.equal(verified.manifest.release.releaseId, 'release-0001');
  assert.equal(verified.manifest.database.schemaGeneration, 1);
  assert.equal(readFileSync(join(verified.path, 'relay-ingest-token'), 'utf8'), 'A'.repeat(43));
  assert.equal(readFileSync(join(verified.path, 'relay-listen-token'), 'utf8'), 'B'.repeat(43));
  assert.equal(readdirSync(verified.path).includes('operator-token'), false);
  assert.equal(readFileSync(join(verified.path, 'manifest.json'), 'utf8').includes(localOperatorToken), false);
  const restored = new DatabaseSync(join(verified.path, 'database.sqlite3'), { readOnly: true });
  assert.equal(restored.prepare('SELECT COUNT(*) AS count FROM host_enrollments').get().count, 1);
  restored.close();
  const replay = await createBackup(options(base, 1, { createdAt: 1_900_000_000_000 }));
  assert.equal(replay.replayed, true);
  assert.equal(replay.backupId, created.backupId);
  assert.equal(validateBackupDomain(base.root).receipts.length, 1);
  await rejects(createBackup(options(base, 1, { reason: 'manual' })), 'backup_conflict');
});

test('backup verification rejects corruption in any retained component before pruning', async () => {
  const base = await fixture();
  const first = await createBackup(options(base, 1));
  const second = await createBackup(options(base, 2));
  const token = join(base.root, 'backups', first.backupId, 'relay-listen-token');
  chmodSync(token, 0o600);
  writeFileSync(token, 'C'.repeat(43));
  assert.throws(() => verifyBackupBundle(base.root, first.backupId),
    (error) => error instanceof BackupError && error.code === 'backup_corrupt');
  assert.throws(() => pruneBackups(base.root),
    (error) => error instanceof BackupError && error.code === 'backup_corrupt');
  assert.equal(existsSync(join(base.root, 'backups', second.backupId)), true);
});

test('a published bundle reconstructs receipt evidence after response-loss publication', async () => {
  const base = await fixture();
  const created = await createBackup(options(base, 1));
  unlinkSync(join(base.root, 'receipts', '0001.json'));
  unlinkSync(join(base.root, 'index.json'));
  const recovered = validateBackupDomain(base.root);
  assert.equal(recovered.receipts.length, 1);
  assert.equal(recovered.receipts[0].backupId, created.backupId);
  assert.equal(existsSync(join(base.root, 'receipts', '0001.json')), true);
  assert.equal(existsSync(join(base.root, 'index.json')), true);
});

test('restart completes only a safely renamed backup payload prune', async () => {
  const base = await fixture();
  const created = await createBackup(options(base, 1));
  const bundle = join(base.root, 'backups', created.backupId);
  const discarded = join(base.root, `.tmp-prune-${created.backupId}-interrupted`);
  chmodSync(join(bundle, 'release'), 0o700);
  renameSync(bundle, discarded);
  const domain = validateBackupDomain(base.root);
  assert.deepEqual(domain.bundles, []);
  assert.equal(domain.receipts.length, 1);
  assert.equal(existsSync(discarded), false);
});

test('retention keeps fourteen daily snapshots plus the newest pre-change reserve', async () => {
  const base = await fixture();
  const daily = [];
  for (let index = 1; index <= DAILY_BACKUP_RETENTION; index += 1) {
    daily.push((await createBackup(options(base, index))).backupId);
  }
  const reserve = await createBackup(options(base, 100, { reason: 'pre_release' }));
  assert.equal(validateBackupDomain(base.root).bundles.length, MAX_RETAINED_BACKUPS);
  const newestDaily = await createBackup(options(base, 101));
  const domain = validateBackupDomain(base.root);
  assert.equal(domain.bundles.length, MAX_RETAINED_BACKUPS);
  assert.equal(domain.receipts.length, MAX_RETAINED_BACKUPS + 1);
  assert.equal(existsSync(join(base.root, 'backups', daily[0])), false);
  assert.equal(existsSync(join(base.root, 'backups', daily[1])), true);
  assert.equal(existsSync(join(base.root, 'backups', reserve.backupId)), true);
  assert.equal(existsSync(join(base.root, 'backups', newestDaily.backupId)), true);
  const replay = await createBackup(options(base, 1, { createdAt: 1_900_000_000_000 }));
  assert.equal(replay.replayed, true);
  assert.equal(replay.backupId, daily[0]);
});

test('a newer manual backup cannot consume the pre-change reserve', async () => {
  const base = await fixture();
  const daily = [];
  for (let index = 1; index <= DAILY_BACKUP_RETENTION; index += 1) {
    daily.push((await createBackup(options(base, index))).backupId);
  }
  const reserve = await createBackup(options(base, 100, { reason: 'pre_rollback' }));
  const manual = await createBackup(options(base, 101, { reason: 'manual' }));
  const domain = validateBackupDomain(base.root);
  assert.equal(domain.bundles.length, MAX_RETAINED_BACKUPS);
  assert.equal(existsSync(join(base.root, 'backups', reserve.backupId)), true);
  assert.equal(existsSync(join(base.root, 'backups', manual.backupId)), true);
  assert.equal(existsSync(join(base.root, 'backups', daily[0])), false);
});

test('a clean first deployment without SQLite has no backup effect', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'cannabeats-fr83-empty-'));
  roots.push(parent);
  const releaseRoot = join(parent, 'releases');
  await assert.rejects(deployRelease({
    root: releaseRoot, manifest: releaseManifest(), files,
    readSchema: async () => null, backup: async () => { throw new Error('stop before candidate'); },
    converge: async () => {},
  }));
  const secrets = join(parent, 'secrets');
  mkdirSync(secrets);
  writeFileSync(join(secrets, 'ingest'), 'A'.repeat(43));
  writeFileSync(join(secrets, 'listen'), 'B'.repeat(43));
  const result = await createBackup({
    root: join(parent, 'backups'), databasePath: join(parent, 'missing.sqlite3'), releaseRoot,
    ingestTokenPath: join(secrets, 'ingest'), listenTokenPath: join(secrets, 'listen'),
    requestId: request(1), reason: 'pre_release', operationReleaseId: 'release-0001',
    stateSequence: 0, createdAt: 1_800_000_000_000,
    statfs: () => ({ bavail: 1_000_000, bsize: 4096 }),
  });
  assert.deepEqual(result, { code: 'backup_not_required', replayed: false });
  assert.equal(readdirSync(join(parent, 'backups', 'backups')).length, 0);
});

test('daily command holds the shared lock and derives one finite request from day and state', async () => {
  const base = await fixture();
  const order = [];
  let received;
  const result = await executeBackupCommand(['daily'], {
    ...base, now: () => 1_800_000_000_000,
    lock: async (work) => { order.push('lock'); return work(); },
    create: async (input) => { order.push('create'); received = input; return { code: 'backup_created' }; },
  });
  assert.equal(result.code, 'backup_created');
  assert.deepEqual(order, ['lock', 'create']);
  assert.equal(received.reason, 'daily');
  assert.equal(received.operationReleaseId, 'release-0001');
  assert.equal(received.stateSequence, 2);
  assert.equal(received.createdAt, 1_800_000_000_000);
  assert.match(received.requestId, /^sha256:[0-9a-f]{64}$/u);
  await assert.rejects(executeBackupCommand(['daily', 'extra'], {
    lock: async (work) => work(),
  }), (error) => error instanceof BackupError && error.code === 'invalid_arguments');
});

test('backup list is newest-first, bounded to available payloads, and redacted', async () => {
  const base = await fixture();
  const first = await createBackup(options(base, 1));
  const second = await createBackup(options(base, 2, { reason: 'manual' }));
  const order = [];
  const listed = await executeBackupCommand(['list'], {
    ...base, lock: async (work) => { order.push('lock'); return work(); },
  });
  assert.deepEqual(order, ['lock']);
  assert.deepEqual(listed.backups.map(({ backupId }) => backupId), [second.backupId, first.backupId]);
  assert.deepEqual(Object.keys(listed.backups[0]).sort(), [
    'backupId', 'createdAt', 'reason', 'releaseId',
  ]);
  const output = JSON.stringify(listed);
  for (const prohibited of [
    'A'.repeat(43), 'B'.repeat(43), base.parent, catalog.songs[0].uri,
  ]) assert.equal(output.includes(prohibited), false, prohibited);
});

test('mutating backup maintenance cannot run while restore recovery is pending', async () => {
  for (const command of [['prune'], ['daily'], [
    'create', '--request-id', request(700), '--reason', 'manual',
    '--release-id', 'release-0001', '--state-sequence', '2',
  ]]) {
    let entered = false;
    await assert.rejects(executeBackupCommand(command, {
      lock: async (work) => work(), restorePending: () => true,
      create: async () => { entered = true; },
    }), (error) => error instanceof BackupError && error.code === 'restore_pending');
    assert.equal(entered, false);
  }
});

test('backup domain rejects a symlinked restore receipt namespace', async () => {
  const base = await fixture();
  await createBackup(options(base, 1));
  symlinkSync(join(base.root, 'receipts'), join(base.root, 'restore-receipts'));
  assert.throws(() => validateBackupDomain(base.root),
    (error) => error instanceof BackupError && error.code === 'backup_corrupt');
});

test('online backup rejects a symlinked live database before snapshot dispatch', async () => {
  const base = await fixture();
  const retained = `${base.databasePath}.retained`;
  renameSync(base.databasePath, retained);
  symlinkSync(retained, base.databasePath);
  let dispatched = false;
  await rejects(createBackup(options(base, 709, {
    backupDatabase: async () => { dispatched = true; },
  })), 'backup_corrupt');
  assert.equal(dispatched, false);
});

test('free-space cleanup reserve accepts equality and rejects one byte below it', async () => {
  const below = await fixture();
  await rejects(createBackup(options(below, 710, {
    statfs: () => ({ bavail: MIN_BACKUP_FREE_BYTES - 1, bsize: 1 }),
  })), 'backup_capacity');
  const equality = await fixture();
  const equal = await createBackup(options(equality, 711, {
    statfs: () => ({ bavail: MIN_BACKUP_FREE_BYTES, bsize: 1 }),
  }));
  assert.equal(equal.code, 'backup_created');
  const above = await fixture();
  const more = await createBackup(options(above, 712, {
    statfs: () => ({ bavail: MIN_BACKUP_FREE_BYTES + 1, bsize: 1 }),
  }));
  assert.equal(more.code, 'backup_created');
});

function fillBackupReceiptHistory(base, total) {
  const indexPath = join(base.root, 'index.json');
  const index = JSON.parse(readFileSync(indexPath, 'utf8'));
  const template = index.receipts[0];
  for (let ordinal = index.receipts.length + 1; ordinal <= total; ordinal += 1) {
    const requestId = hash(`retained-backup-capacity-${ordinal}`);
    const backupId = `backup-${String(1_800_000_000_000 + ordinal)}-00000000-0000-4000-8000-${String(ordinal).padStart(12, '0')}`;
    const manifest = {
      ...template.manifest, ordinal, backupId, requestId,
      createdAt: 1_800_000_000_000 + ordinal,
    };
    const receipt = {
      ordinal, requestId, requestDigest: template.requestDigest, backupId,
      manifestDigest: hash(JSON.stringify(manifest)), manifest,
    };
    writeFileSync(
      join(base.root, 'receipts', `${String(ordinal).padStart(4, '0')}.json`),
      JSON.stringify(receipt), { mode: 0o400 },
    );
    index.receipts.push(receipt);
  }
  chmodSync(indexPath, 0o600);
  writeFileSync(indexPath, JSON.stringify(index));
}

test('backup receipt capacity proves max minus one, max, and max plus one', async () => {
  const base = await fixture();
  await createBackup(options(base, 1));
  fillBackupReceiptHistory(base, MAX_BACKUP_RECEIPTS - 1);
  assert.equal(validateBackupDomain(base.root).receipts.length, MAX_BACKUP_RECEIPTS - 1);
  await createBackup(options(base, 720));
  assert.equal(validateBackupDomain(base.root).receipts.length, MAX_BACKUP_RECEIPTS);
  await rejects(createBackup(options(base, 721)), 'backup_capacity');
  fillBackupReceiptHistory(base, MAX_BACKUP_RECEIPTS + 1);
  assert.throws(() => validateBackupDomain(base.root),
    (error) => error instanceof BackupError && error.code === 'backup_corrupt');
});

function testOwners() {
  return {
    database: { uid: process.getuid(), gid: process.getgid(), mode: 0o640 },
    token: { uid: process.getuid(), gid: process.getgid(), mode: 0o640 },
  };
}
function writeRestoreReceiptHistory(base, backupId, total) {
  const directory = join(base.root, 'restore-receipts');
  if (!existsSync(directory)) mkdirSync(directory, { mode: 0o700 });
  const indexPath = join(base.root, 'restore-index.json');
  const receipts = existsSync(indexPath)
    ? JSON.parse(readFileSync(indexPath, 'utf8')).receipts : [];
  for (let ordinal = receipts.length + 1; ordinal <= total; ordinal += 1) {
    const requestId = hash(`retained-restore-capacity-${ordinal}`);
    const receipt = {
      version: 1, ordinal, requestId, backupId,
      completedAt: 1_900_000_000_000 + ordinal,
      code: 'backup_restored',
    };
    writeFileSync(join(directory, `${String(ordinal).padStart(4, '0')}.json`),
      JSON.stringify(receipt), { mode: 0o400 });
    receipts.push(receipt);
  }
  if (existsSync(indexPath)) chmodSync(indexPath, 0o600);
  writeFileSync(indexPath, JSON.stringify({ version: 1, receipts }), { mode: 0o400 });
}
function addSecondEnrollment(base) {
  const store = createReleaseStore(base.databasePath, { catalog, now: 2000 });
  store.issueEnrollment({
    enrollmentCode: 'R'.repeat(32),
    requestId: '00000000-0000-4000-8000-000000000002', now: 2000,
  });
  store.close();
  writeFileSync(base.ingestTokenPath, 'C'.repeat(43));
  writeFileSync(base.listenTokenPath, 'D'.repeat(43));
}
async function activateSecondRelease(base) {
  await deployRelease({
    root: base.releaseRoot, manifest: releaseManifest('release-0002'), files,
    readSchema: async () => 1, backup: async () => {}, converge: async () => {},
  });
}

test('restore installs one verified offline database, secret pair, and release and then replays', async () => {
  const base = await fixture();
  const backed = await createBackup(options(base, 1));
  addSecondEnrollment(base);
  const effects = [];
  const requestId = request(500);
  const restored = await restoreBackup({
    backupRoot: base.root, backupId: backed.backupId, requestId,
    databasePath: base.databasePath, releaseRoot: base.releaseRoot,
    ingestTokenPath: base.ingestTokenPath, listenTokenPath: base.listenTokenPath,
    converge: async (release, options = {}) => effects.push([release.releaseId, options.stop === true]),
    readSchema: async () => 1, completedAt: 1_900_000_000_000, owners: testOwners(),
  });
  assert.equal(restored.code, 'backup_restored');
  assert.equal(restored.replayed, false);
  assert.deepEqual(effects, [
    ['release-0001', true], ['release-0001', false], ['release-0001', false],
  ]);
  const database = new DatabaseSync(base.databasePath, { readOnly: true });
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM host_enrollments').get().count, 1);
  database.close();
  assert.equal(readFileSync(base.ingestTokenPath, 'utf8'), 'A'.repeat(43));
  assert.equal(readFileSync(base.listenTokenPath, 'utf8'), 'B'.repeat(43));
  const replay = await restoreBackup({
    backupRoot: base.root, backupId: backed.backupId, requestId,
    databasePath: base.databasePath, releaseRoot: base.releaseRoot,
    ingestTokenPath: base.ingestTokenPath, listenTokenPath: base.listenTokenPath,
    converge: async () => { throw new Error('must not converge replay'); },
    readSchema: async () => 1, completedAt: 2_000_000_000_000, owners: testOwners(),
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.completedAt, 1_900_000_000_000);
  await assert.rejects(restoreBackup({
    backupRoot: base.root,
    backupId: 'backup-1800000000000-00000000-0000-4000-8000-000000000001', requestId,
    databasePath: base.databasePath, releaseRoot: base.releaseRoot,
    ingestTokenPath: base.ingestTokenPath, listenTokenPath: base.listenTokenPath,
    converge: async () => {}, readSchema: async () => 1, owners: testOwners(),
  }), (error) => error instanceof RestoreError && error.code === 'restore_conflict');
});

test('restore receipt capacity proves max minus one, max, and max plus one', async () => {
  const base = await fixture();
  const backed = await createBackup(options(base, 1));
  writeRestoreReceiptHistory(base, backed.backupId, MAX_RESTORE_RECEIPTS - 1);
  await restoreBackup({
    backupRoot: base.root, backupId: backed.backupId, requestId: request(730),
    databasePath: base.databasePath, releaseRoot: base.releaseRoot,
    ingestTokenPath: base.ingestTokenPath, listenTokenPath: base.listenTokenPath,
    converge: async () => {}, readSchema: async () => 1,
    completedAt: 1_900_000_000_000, owners: testOwners(),
  });
  assert.equal(readdirSync(join(base.root, 'restore-receipts')).length, MAX_RESTORE_RECEIPTS);
  await assert.rejects(restoreBackup({
    backupRoot: base.root, backupId: backed.backupId, requestId: request(731),
    databasePath: base.databasePath, releaseRoot: base.releaseRoot,
    ingestTokenPath: base.ingestTokenPath, listenTokenPath: base.listenTokenPath,
    converge: async () => {}, readSchema: async () => 1, owners: testOwners(),
  }), (error) => error instanceof RestoreError && error.code === 'restore_capacity');
  writeRestoreReceiptHistory(base, backed.backupId, MAX_RESTORE_RECEIPTS + 1);
  await assert.rejects(restoreBackup({
    backupRoot: base.root, backupId: backed.backupId, requestId: request(732),
    databasePath: base.databasePath, releaseRoot: base.releaseRoot,
    ingestTokenPath: base.ingestTokenPath, listenTokenPath: base.listenTokenPath,
    converge: async () => {}, readSchema: async () => 1, owners: testOwners(),
  }), (error) => error instanceof RestoreError && error.code === 'restore_corrupt');
});

test('failed restore replaces no accepted database, secret, or release authority', async () => {
  const base = await fixture();
  const backed = await createBackup(options(base, 1));
  addSecondEnrollment(base);
  let starts = 0;
  await assert.rejects(restoreBackup({
    backupRoot: base.root, backupId: backed.backupId, requestId: request(501),
    databasePath: base.databasePath, releaseRoot: base.releaseRoot,
    ingestTokenPath: base.ingestTokenPath, listenTokenPath: base.listenTokenPath,
    converge: async (_release, options = {}) => {
      if (!options.stop && starts++ === 0) throw new Error('candidate readiness failure');
    },
    readSchema: async () => 1, completedAt: 1_900_000_000_000, owners: testOwners(),
  }), (error) => error instanceof RestoreError && error.code === 'restore_failed');
  const database = new DatabaseSync(base.databasePath, { readOnly: true });
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM host_enrollments').get().count, 2);
  database.close();
  assert.equal(readFileSync(base.ingestTokenPath, 'utf8'), 'C'.repeat(43));
  assert.equal(readFileSync(base.listenTokenPath, 'utf8'), 'D'.repeat(43));
  assert.equal(existsSync(join(dirname(base.databasePath), '.restore-journal.json')), false);
});

test('retained release transition blocks restore before pruning or registration', async () => {
  const base = await fixture();
  const backed = await createBackup(options(base, 1));
  registerRelease(base.releaseRoot, releaseManifest('release-0002'), files);
  const state = readReleaseState(base.releaseRoot);
  writeReleaseState(base.releaseRoot, {
    ...state, pending: 'release-0002', sequence: state.sequence + 1,
  });
  let pruned = false;
  await assert.rejects(restoreBackup({
    backupRoot: base.root, backupId: backed.backupId, requestId: request(740),
    databasePath: base.databasePath, releaseRoot: base.releaseRoot,
    ingestTokenPath: base.ingestTokenPath, listenTokenPath: base.listenTokenPath,
    converge: async () => {}, readSchema: async () => 1,
    pruneRecords: () => { pruned = true; }, owners: testOwners(),
  }), (error) => error instanceof RestoreError && error.code === 'restore_pending');
  assert.equal(pruned, false);
  assert.deepEqual(readReleaseState(base.releaseRoot), {
    ...state, pending: 'release-0002', sequence: state.sequence + 1,
  });
});

test('blank replacement restore installs the backed release without prior local authority', async () => {
  const source = await fixture();
  const backed = await createBackup(options(source, 1));
  const target = join(source.parent, 'blank');
  const data = join(target, 'data');
  const secrets = join(target, 'secrets');
  mkdirSync(target);
  mkdirSync(data);
  mkdirSync(secrets);
  mkdirSync(join(target, 'releases'));
  const locations = {
    databasePath: join(data, 'cannabeats.sqlite3'), releaseRoot: join(target, 'releases'),
    ingestTokenPath: join(secrets, 'ingest'), listenTokenPath: join(secrets, 'listen'),
  };
  await restoreBackup({
    backupRoot: source.root, backupId: backed.backupId, requestId: request(600),
    ...locations, converge: async () => {}, readSchema: async () => 1,
    completedAt: 1_900_000_000_000, owners: testOwners(),
  });
  assert.deepEqual(readReleaseState(locations.releaseRoot), {
    current: 'release-0001', previous: null, pending: null, revision: 1, sequence: 2,
  });
  assert.equal(readFileSync(locations.ingestTokenPath, 'utf8'), 'A'.repeat(43));
  const database = new DatabaseSync(locations.databasePath, { readOnly: true });
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM host_enrollments').get().count, 1);
  database.close();
});

test('blank replacement recovery repairs its authorized target from the verified backup', async () => {
  const source = await fixture();
  const backed = await createBackup(options(source, 1));
  const target = join(source.parent, 'blank-repair');
  const data = join(target, 'data');
  const secrets = join(target, 'secrets');
  mkdirSync(target);
  mkdirSync(data);
  mkdirSync(secrets);
  const locations = {
    databasePath: join(data, 'cannabeats.sqlite3'), releaseRoot: join(target, 'releases'),
    ingestTokenPath: join(secrets, 'ingest'), listenTokenPath: join(secrets, 'listen'),
  };
  const crash = Object.assign(new Error('blank response loss'), { restoreProcessLoss: true });
  await assert.rejects(restoreBackup({
    backupRoot: source.root, backupId: backed.backupId, requestId: request(6010),
    ...locations, converge: async () => {}, readSchema: async () => 1,
    checkpoint: async (phase) => {
      if (phase === 'activated') {
        writeFileSync(locations.listenTokenPath, 'Z'.repeat(43));
        throw crash;
      }
    },
    completedAt: 1_900_000_000_000, owners: testOwners(),
  }), (error) => error === crash);
  const recovered = await recoverInterruptedRestore({
    backupRoot: source.root, ...locations, converge: async () => {},
    readSchema: async () => 1, owners: testOwners(),
  });
  assert.equal(recovered.code, 'backup_restored');
  assert.deepEqual(readReleaseState(locations.releaseRoot), {
    current: 'release-0001', previous: null, pending: null, revision: 1, sequence: 2,
  });
  assert.equal(readFileSync(locations.ingestTokenPath, 'utf8'), 'A'.repeat(43));
  assert.equal(readFileSync(locations.listenTokenPath, 'utf8'), 'B'.repeat(43));
});

test('restart rolls an installed but unauthoritative restore back to the complete prior set', async () => {
  const base = await fixture();
  const backed = await createBackup(options(base, 1));
  addSecondEnrollment(base);
  const crash = Object.assign(new Error('simulated process loss'), { restoreProcessLoss: true });
  await assert.rejects(restoreBackup({
    backupRoot: base.root, backupId: backed.backupId, requestId: request(601),
    databasePath: base.databasePath, releaseRoot: base.releaseRoot,
    ingestTokenPath: base.ingestTokenPath, listenTokenPath: base.listenTokenPath,
    converge: async () => {}, readSchema: async () => 1,
    checkpoint: async (phase) => { if (phase === 'installed') throw crash; },
    completedAt: 1_900_000_000_000, owners: testOwners(),
  }), (error) => error === crash);
  assert.equal(existsSync(join(dirname(base.databasePath), '.restore-journal.json')), true);
  assert.equal(readFileSync(base.ingestTokenPath, 'utf8'), 'A'.repeat(43));
  const recovered = await recoverInterruptedRestore({
    backupRoot: base.root, databasePath: base.databasePath, releaseRoot: base.releaseRoot,
    ingestTokenPath: base.ingestTokenPath, listenTokenPath: base.listenTokenPath,
    converge: async () => {}, readSchema: async () => 1,
  });
  assert.equal(recovered.code, 'restore_recovered');
  const database = new DatabaseSync(base.databasePath, { readOnly: true });
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM host_enrollments').get().count, 2);
  database.close();
  assert.equal(readFileSync(base.ingestTokenPath, 'utf8'), 'C'.repeat(43));
  assert.equal(readFileSync(base.listenTokenPath, 'utf8'), 'D'.repeat(43));
  assert.equal(existsSync(join(dirname(base.databasePath), '.restore-journal.json')), false);
});

test('restart completes an already authorized restore and preserves the original completion result', async () => {
  const base = await fixture();
  const backed = await createBackup(options(base, 1));
  addSecondEnrollment(base);
  const requestId = request(602);
  const crash = Object.assign(new Error('lost restore response'), { restoreProcessLoss: true });
  await assert.rejects(restoreBackup({
    backupRoot: base.root, backupId: backed.backupId, requestId,
    databasePath: base.databasePath, releaseRoot: base.releaseRoot,
    ingestTokenPath: base.ingestTokenPath, listenTokenPath: base.listenTokenPath,
    converge: async () => {}, readSchema: async () => 1,
    checkpoint: async (phase) => { if (phase === 'activated') throw crash; },
    completedAt: 1_900_000_000_000, owners: testOwners(),
  }), (error) => error === crash);
  const recovered = await recoverInterruptedRestore({
    backupRoot: base.root, databasePath: base.databasePath, releaseRoot: base.releaseRoot,
    ingestTokenPath: base.ingestTokenPath, listenTokenPath: base.listenTokenPath,
    converge: async () => {}, readSchema: async () => 1,
    completedAt: 2_000_000_000_000,
  });
  assert.equal(recovered.code, 'backup_restored');
  assert.equal(recovered.completedAt, 1_900_000_000_000);
  const replay = await restoreBackup({
    backupRoot: base.root, backupId: backed.backupId, requestId,
    databasePath: base.databasePath, releaseRoot: base.releaseRoot,
    ingestTokenPath: base.ingestTokenPath, listenTokenPath: base.listenTokenPath,
    converge: async () => { throw new Error('no replay effect'); }, readSchema: async () => 1,
    owners: testOwners(),
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.completedAt, 1_900_000_000_000);
});

test('response loss after restore receipt publication converges cleanup before exact replay', async () => {
  const base = await fixture();
  const backed = await createBackup(options(base, 1));
  addSecondEnrollment(base);
  const requestId = request(6021);
  const crash = Object.assign(new Error('receipt response loss'), { restoreProcessLoss: true });
  await assert.rejects(restoreBackup({
    backupRoot: base.root, backupId: backed.backupId, requestId,
    databasePath: base.databasePath, releaseRoot: base.releaseRoot,
    ingestTokenPath: base.ingestTokenPath, listenTokenPath: base.listenTokenPath,
    converge: async () => {}, readSchema: async () => 1,
    checkpoint: async (phase) => { if (phase === 'receipt') throw crash; },
    completedAt: 1_900_000_000_000, owners: testOwners(),
  }), (error) => error === crash);
  assert.equal(existsSync(join(dirname(base.databasePath), '.restore-journal.json')), true);
  const replay = await restoreBackup({
    backupRoot: base.root, backupId: backed.backupId, requestId,
    databasePath: base.databasePath, releaseRoot: base.releaseRoot,
    ingestTokenPath: base.ingestTokenPath, listenTokenPath: base.listenTokenPath,
    converge: async () => {}, readSchema: async () => 1, owners: testOwners(),
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.completedAt, 1_900_000_000_000);
  assert.equal(existsSync(join(dirname(base.databasePath), '.restore-journal.json')), false);
  for (const directory of [dirname(base.databasePath), dirname(base.ingestTokenPath)]) {
    assert.deepEqual(readdirSync(directory).filter((name) => name.includes('.restore-')), []);
  }
});

test('sequenced restore receipt authority repairs either omitted redundant copy', async () => {
  const base = await fixture();
  const backed = await createBackup(options(base, 1));
  const requestId = request(60211);
  await restoreBackup({
    backupRoot: base.root, backupId: backed.backupId, requestId,
    databasePath: base.databasePath, releaseRoot: base.releaseRoot,
    ingestTokenPath: base.ingestTokenPath, listenTokenPath: base.listenTokenPath,
    converge: async () => {}, readSchema: async () => 1,
    completedAt: 1_900_000_000_000, owners: testOwners(),
  });
  await restoreBackup({
    backupRoot: base.root, backupId: backed.backupId, requestId: request(60213),
    databasePath: base.databasePath, releaseRoot: base.releaseRoot,
    ingestTokenPath: base.ingestTokenPath, listenTokenPath: base.listenTokenPath,
    converge: async () => {}, readSchema: async () => 1,
    completedAt: 1_900_000_000_001, owners: testOwners(),
  });
  const receiptPath = join(base.root, 'restore-receipts', '0001.json');
  const indexPath = join(base.root, 'restore-index.json');
  unlinkSync(receiptPath);
  const replayFromIndex = await restoreBackup({
    backupRoot: base.root, backupId: backed.backupId, requestId,
    databasePath: base.databasePath, releaseRoot: base.releaseRoot,
    ingestTokenPath: base.ingestTokenPath, listenTokenPath: base.listenTokenPath,
    converge: async () => { throw new Error('receipt repair must not restore'); },
    readSchema: async () => 1, owners: testOwners(),
  });
  assert.equal(replayFromIndex.replayed, true);
  assert.equal(existsSync(receiptPath), true);
  unlinkSync(indexPath);
  const replayFromFile = await restoreBackup({
    backupRoot: base.root, backupId: backed.backupId, requestId,
    databasePath: base.databasePath, releaseRoot: base.releaseRoot,
    ingestTokenPath: base.ingestTokenPath, listenTokenPath: base.listenTokenPath,
    converge: async () => { throw new Error('index repair must not restore'); },
    readSchema: async () => 1, owners: testOwners(),
  });
  assert.equal(replayFromFile.replayed, true);
  assert.equal(existsSync(indexPath), true);
});

test('journaled intent owns a crash before staging and exact retry completes once', async () => {
  const base = await fixture();
  const backed = await createBackup(options(base, 1));
  addSecondEnrollment(base);
  const requestId = request(60212);
  const crash = Object.assign(new Error('pre-stage process loss'), { restoreProcessLoss: true });
  await assert.rejects(restoreBackup({
    backupRoot: base.root, backupId: backed.backupId, requestId,
    databasePath: base.databasePath, releaseRoot: base.releaseRoot,
    ingestTokenPath: base.ingestTokenPath, listenTokenPath: base.listenTokenPath,
    converge: async () => {}, readSchema: async () => 1,
    checkpoint: async (phase) => { if (phase === 'journaled') throw crash; },
    completedAt: 1_900_000_000_000, owners: testOwners(),
  }), (error) => error === crash);
  assert.equal(existsSync(join(dirname(base.databasePath), '.restore-journal.json')), true);
  for (const directory of [dirname(base.databasePath), dirname(base.ingestTokenPath)]) {
    assert.deepEqual(readdirSync(directory).filter((name) =>
      name.includes('.restore-new-') || name.includes('.restore-old-')), []);
  }
  const restored = await restoreBackup({
    backupRoot: base.root, backupId: backed.backupId, requestId,
    databasePath: base.databasePath, releaseRoot: base.releaseRoot,
    ingestTokenPath: base.ingestTokenPath, listenTokenPath: base.listenTokenPath,
    converge: async () => {}, readSchema: async () => 1,
    completedAt: 2_000_000_000_000, owners: testOwners(),
  });
  assert.equal(restored.code, 'backup_restored');
  assert.equal(restored.completedAt, 1_900_000_000_000);
});

test('a stale valid rollback-file collision fails before journal or live mutation', async () => {
  const base = await fixture();
  const backed = await createBackup(options(base, 1));
  addSecondEnrollment(base);
  const requestId = request(60214);
  const stale = `${base.databasePath}.restore-old-${requestId.slice(-16)}`;
  copyFileSync(join(base.root, 'backups', backed.backupId, 'database.sqlite3'), stale);
  await assert.rejects(restoreBackup({
    backupRoot: base.root, backupId: backed.backupId, requestId,
    databasePath: base.databasePath, releaseRoot: base.releaseRoot,
    ingestTokenPath: base.ingestTokenPath, listenTokenPath: base.listenTokenPath,
    converge: async () => { throw new Error('collision must precede convergence'); },
    readSchema: async () => 1, completedAt: 1_900_000_000_000, owners: testOwners(),
  }), (error) => error instanceof RestoreError && error.code === 'restore_corrupt');
  assert.equal(existsSync(join(dirname(base.databasePath), '.restore-journal.json')), false);
  const database = new DatabaseSync(base.databasePath, { readOnly: true });
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM host_enrollments').get().count, 2);
  database.close();
  assert.equal(readFileSync(base.ingestTokenPath, 'utf8'), 'C'.repeat(43));
  assert.equal(readFileSync(base.listenTokenPath, 'utf8'), 'D'.repeat(43));
  assert.equal(existsSync(stale), true);
});

test('journal-held request conflict fails before recovery or target lookup', async () => {
  const base = await fixture();
  const backed = await createBackup(options(base, 1));
  addSecondEnrollment(base);
  const requestId = request(6022);
  const crash = Object.assign(new Error('installed crash'), { restoreProcessLoss: true });
  await assert.rejects(restoreBackup({
    backupRoot: base.root, backupId: backed.backupId, requestId,
    databasePath: base.databasePath, releaseRoot: base.releaseRoot,
    ingestTokenPath: base.ingestTokenPath, listenTokenPath: base.listenTokenPath,
    converge: async () => {}, readSchema: async () => 1,
    checkpoint: async (phase) => { if (phase === 'installed') throw crash; },
    completedAt: 1_900_000_000_000, owners: testOwners(),
  }), (error) => error === crash);
  const conflictingBackup = 'backup-1800000000000-00000000-0000-4000-8000-000000000001';
  await assert.rejects(restoreBackup({
    backupRoot: base.root, backupId: conflictingBackup, requestId,
    databasePath: base.databasePath, releaseRoot: base.releaseRoot,
    ingestTokenPath: base.ingestTokenPath, listenTokenPath: base.listenTokenPath,
    converge: async () => { throw new Error('must not recover conflict'); },
    readSchema: async () => 1, owners: testOwners(),
  }), (error) => error instanceof RestoreError && error.code === 'restore_conflict');
  assert.equal(existsSync(join(dirname(base.databasePath), '.restore-journal.json')), true);
  assert.equal(readFileSync(base.listenTokenPath, 'utf8'), 'B'.repeat(43));
});

test('post-activation corruption restores the complete prior release authority and file set', async () => {
  const base = await fixture();
  const backed = await createBackup(options(base, 1));
  await activateSecondRelease(base);
  addSecondEnrollment(base);
  const effects = [];
  await assert.rejects(restoreBackup({
    backupRoot: base.root, backupId: backed.backupId, requestId: request(603),
    databasePath: base.databasePath, releaseRoot: base.releaseRoot,
    ingestTokenPath: base.ingestTokenPath, listenTokenPath: base.listenTokenPath,
    converge: async (release, command = {}) => {
      effects.push([release.releaseId, command.stop === true]);
    },
    readSchema: async () => 1,
    checkpoint: async (phase) => {
      if (phase === 'activated') {
        writeFileSync(base.listenTokenPath, 'Z'.repeat(43));
        throw new Error('failure after release authority publication');
      }
    },
    completedAt: 1_900_000_000_000, owners: testOwners(),
  }), (error) => error instanceof RestoreError && error.code === 'restore_failed');
  assert.deepEqual(readReleaseState(base.releaseRoot), {
    current: 'release-0002', previous: 'release-0001', pending: null,
    revision: 4, sequence: 8,
  });
  const database = new DatabaseSync(base.databasePath, { readOnly: true });
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM host_enrollments').get().count, 2);
  database.close();
  assert.equal(readFileSync(base.ingestTokenPath, 'utf8'), 'C'.repeat(43));
  assert.equal(readFileSync(base.listenTokenPath, 'utf8'), 'D'.repeat(43));
  assert.equal(existsSync(join(dirname(base.databasePath), '.restore-journal.json')), false);
  assert.deepEqual(effects, [
    ['release-0002', true], ['release-0001', false],
    ['release-0001', true], ['release-0002', true], ['release-0002', false],
  ]);
});

test('restart resumes process loss during each retained release-authority rollback edge', async () => {
  for (const recoveryPhase of ['rollback_pending', 'rolled_back']) {
    const base = await fixture();
    const backed = await createBackup(options(base, 1));
    await activateSecondRelease(base);
    addSecondEnrollment(base);
    const restoreCrash = Object.assign(new Error('activated crash'), { restoreProcessLoss: true });
    await assert.rejects(restoreBackup({
      backupRoot: base.root, backupId: backed.backupId,
      requestId: request(recoveryPhase === 'rollback_pending' ? 6031 : 6032),
      databasePath: base.databasePath, releaseRoot: base.releaseRoot,
      ingestTokenPath: base.ingestTokenPath, listenTokenPath: base.listenTokenPath,
      converge: async () => {}, readSchema: async () => 1,
      checkpoint: async (phase) => { if (phase === 'activated') throw restoreCrash; },
      completedAt: 1_900_000_000_000, owners: testOwners(),
    }), (error) => error === restoreCrash);
    writeFileSync(base.listenTokenPath, 'Z'.repeat(43));
    const recoveryCrash = new Error(`crash at ${recoveryPhase}`);
    await assert.rejects(recoverInterruptedRestore({
      backupRoot: base.root, databasePath: base.databasePath, releaseRoot: base.releaseRoot,
      ingestTokenPath: base.ingestTokenPath, listenTokenPath: base.listenTokenPath,
      converge: async () => {}, readSchema: async () => 1, owners: testOwners(),
      checkpoint: async (phase) => { if (phase === recoveryPhase) throw recoveryCrash; },
    }), (error) => error === recoveryCrash);
    assert.equal(existsSync(join(dirname(base.databasePath), '.restore-journal.json')), true);
    const recovered = await recoverInterruptedRestore({
      backupRoot: base.root, databasePath: base.databasePath, releaseRoot: base.releaseRoot,
      ingestTokenPath: base.ingestTokenPath, listenTokenPath: base.listenTokenPath,
      converge: async () => {}, readSchema: async () => 1, owners: testOwners(),
    });
    assert.equal(recovered.code, 'restore_recovered');
    assert.deepEqual(readReleaseState(base.releaseRoot), {
      current: 'release-0002', previous: 'release-0001', pending: null,
      revision: 4, sequence: 8,
    });
    assert.equal(readFileSync(base.ingestTokenPath, 'utf8'), 'C'.repeat(43));
    assert.equal(readFileSync(base.listenTokenPath, 'utf8'), 'D'.repeat(43));
  }
});

test('failure to retain the prepared journal removes every unowned staged file', async () => {
  const base = await fixture();
  const backed = await createBackup(options(base, 1));
  addSecondEnrollment(base);
  await assert.rejects(restoreBackup({
    backupRoot: base.root, backupId: backed.backupId, requestId: request(604),
    databasePath: base.databasePath, releaseRoot: base.releaseRoot,
    ingestTokenPath: base.ingestTokenPath, listenTokenPath: base.listenTokenPath,
    converge: async () => {}, readSchema: async () => 1,
    persistJournal: () => { throw new Error('journal device unavailable'); },
    completedAt: 1_900_000_000_000, owners: testOwners(),
  }), (error) => error instanceof RestoreError && error.code === 'restore_failed');
  for (const directory of [dirname(base.databasePath), dirname(base.ingestTokenPath)]) {
    assert.deepEqual(readdirSync(directory).filter((name) => name.includes('.restore-')), []);
  }
  const database = new DatabaseSync(base.databasePath, { readOnly: true });
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM host_enrollments').get().count, 2);
  database.close();
  assert.equal(readFileSync(base.ingestTokenPath, 'utf8'), 'C'.repeat(43));
  assert.equal(readFileSync(base.listenTokenPath, 'utf8'), 'D'.repeat(43));
});

test('tampered restore journal fails closed before mutating retained files or authority', async () => {
  const base = await fixture();
  const backed = await createBackup(options(base, 1));
  addSecondEnrollment(base);
  const crash = Object.assign(new Error('prepared crash'), { restoreProcessLoss: true });
  await assert.rejects(restoreBackup({
    backupRoot: base.root, backupId: backed.backupId, requestId: request(605),
    databasePath: base.databasePath, releaseRoot: base.releaseRoot,
    ingestTokenPath: base.ingestTokenPath, listenTokenPath: base.listenTokenPath,
    converge: async () => {}, readSchema: async () => 1,
    checkpoint: async (phase) => { if (phase === 'prepared') throw crash; },
    completedAt: 1_900_000_000_000, owners: testOwners(),
  }), (error) => error === crash);
  const journalPath = join(dirname(base.databasePath), '.restore-journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
  journal.priorState.revision = '1';
  chmodSync(journalPath, 0o600);
  writeFileSync(journalPath, JSON.stringify(journal));
  await assert.rejects(recoverInterruptedRestore({
    backupRoot: base.root, databasePath: base.databasePath, releaseRoot: base.releaseRoot,
    ingestTokenPath: base.ingestTokenPath, listenTokenPath: base.listenTokenPath,
    converge: async () => {}, readSchema: async () => 1, owners: testOwners(),
  }), (error) => error instanceof RestoreError && error.code === 'restore_corrupt');
  const database = new DatabaseSync(base.databasePath, { readOnly: true });
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM host_enrollments').get().count, 2);
  database.close();
  assert.equal(readFileSync(base.ingestTokenPath, 'utf8'), 'C'.repeat(43));
  assert.equal(readReleaseState(base.releaseRoot).current, 'release-0001');
});

test('restore command holds the shared lock across restore and boot reconciliation', async () => {
  const backupId = 'backup-1800000000000-00000000-0000-4000-8000-000000000001';
  const requestId = request(606);
  const order = [];
  let received;
  const common = {
    lock: async (work) => { order.push('lock'); return work(); },
    restore: async (input) => { order.push('restore'); received = input; return { code: 'backup_restored' }; },
    recover: async () => { order.push('recover'); return { code: 'restore_not_pending' }; },
    converge: async () => {}, readSchema: async () => 1,
  };
  const restored = await executeRestoreCommand([
    'restore', '--backup-id', backupId, '--request-id', requestId,
  ], common);
  assert.equal(restored.code, 'backup_restored');
  assert.deepEqual(order, ['lock', 'restore']);
  assert.equal(received.backupId, backupId);
  assert.equal(received.requestId, requestId);
  order.length = 0;
  assert.equal((await executeRestoreCommand(['reconcile'], common)).code, 'restore_not_pending');
  assert.deepEqual(order, ['lock', 'recover']);
  await assert.rejects(executeRestoreCommand(['restore', '--backup-id', backupId], common),
    (error) => error instanceof RestoreError && error.code === 'invalid_arguments');
});
