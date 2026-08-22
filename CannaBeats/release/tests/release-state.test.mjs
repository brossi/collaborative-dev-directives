import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync,
  symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { afterEach } from 'node:test';

import {
  MAX_CADDYFILE_BYTES, MAX_COMPOSE_BYTES, MAX_RELEASE_RECORDS,
  ReleaseStateError, canonicalReleaseManifest, deployRelease, deploymentDigest,
  pruneReleaseRecords, readRelease, readReleaseState, reconcileRelease, registerRelease, rollbackRelease,
  validateReleaseDomain, writeReleaseState,
} from '../scripts/release-state.mjs';

const roots = [];
afterEach(() => {
  while (roots.length) {
    const path = roots.pop();
    execFileSync('chmod', ['-R', 'u+w', path]);
    rmSync(path, { recursive: true, force: true });
  }
});
const digest = (character) => `sha256:${character.repeat(64)}`;
const image = (name, character) => `${name}@${digest(character)}`;
const files = Object.freeze({
  Caddyfile: 'play.cannabeats.social { reverse_proxy web:3000 }\n',
  'compose.yaml': 'name: cannabeats\nservices: {}\n',
});
function manifest(releaseId, overrides = {}) {
  return {
    version: 1, releaseId, sourceRevision: 'a'.repeat(40),
    catalogVersion: digest('b'), createdAt: 1000,
    schema: { min: 1, max: 1, target: 1 },
    images: {
      caddy: image('caddy', 'c'), web: image('cannabeats/web', 'd'),
      relay: image('cannabeats/relay', 'e'),
    },
    deploymentDigest: deploymentDigest(files), ...overrides,
  };
}
function root() { const value = mkdtempSync(join(tmpdir(), 'cannabeats-fr82-')); roots.push(value); return value; }
function code(work, expected) {
  assert.throws(work, (error) => error instanceof ReleaseStateError && error.code === expected);
}
async function rejects(work, expected) {
  await assert.rejects(work, (error) => error instanceof ReleaseStateError && error.code === expected);
}

test('release identity registers once, replays exactly, and conflicts before active state', () => {
  const directory = root();
  const first = registerRelease(directory, manifest('release-0001'), files);
  assert.equal(first.replayed, false);
  assert.equal(registerRelease(directory, manifest('release-0001'), files).replayed, true);
  code(() => registerRelease(directory, manifest('release-0001', { createdAt: 1001 }), files),
    'release_conflict');
  assert.deepEqual(readReleaseState(directory), {
    current: null, previous: null, pending: null, revision: 0, sequence: 0,
  });
  assert.equal(canonicalReleaseManifest(first.manifest), readFileSync(
    join(first.recordPath, 'manifest.json'), 'utf8',
  ));
});

test('deployment durably records pending before candidate convergence and publishes authority last', async () => {
  const directory = root();
  const order = [];
  const first = await deployRelease({
    root: directory, manifest: manifest('release-0001'), files,
    readSchema: async () => { order.push('schema'); return 1; },
    backup: async () => { order.push('backup'); },
    converge: async ({ releaseId }) => { order.push(`converge:${releaseId}`); },
    publishState: (releaseRoot, state) => {
      order.push(`publish:${state.pending ?? state.current}`);
      writeReleaseState(releaseRoot, state);
    },
  });
  assert.equal(first.code, 'release_activated');
  assert.deepEqual(order, [
    'schema', 'backup', 'publish:release-0001', 'converge:release-0001', 'schema',
    'publish:release-0001',
  ]);
  assert.deepEqual(readReleaseState(directory), {
    current: 'release-0001', previous: null, pending: null, revision: 1, sequence: 2,
  });
  order.length = 0;
  assert.deepEqual(await deployRelease({
    root: directory, manifest: manifest('release-0001'), files,
    readSchema: async () => { order.push('schema'); return 1; },
    backup: async () => { order.push('backup'); }, converge: async () => order.push('converge'),
  }), { code: 'already_active', releaseId: 'release-0001' });
  assert.deepEqual(order, []);
});

test('failed candidate restores the exact current release without switching state', async () => {
  const directory = root();
  const converged = [];
  const common = { root: directory, files, readSchema: async () => 1, backup: async () => {} };
  await deployRelease({
    ...common, manifest: manifest('release-0001'),
    converge: async ({ releaseId }) => { converged.push(releaseId); },
  });
  await rejects(deployRelease({
    ...common, manifest: manifest('release-0002', { sourceRevision: 'f'.repeat(40) }),
    converge: async ({ releaseId }) => {
      converged.push(releaseId);
      if (releaseId === 'release-0002') throw new Error('native candidate failure');
    },
  }), 'candidate_failed');
  assert.deepEqual(converged.slice(-2), ['release-0002', 'release-0001']);
  assert.deepEqual(readReleaseState(directory), {
    current: 'release-0001', previous: null, pending: null, revision: 1, sequence: 4,
  });
});

test('rollback toggles exact current and previous records while retaining database authority', async () => {
  const directory = root();
  const converged = [];
  const common = {
    root: directory, files, readSchema: async () => 1, backup: async () => {},
    converge: async ({ releaseId }) => { converged.push(releaseId); },
  };
  await deployRelease({ ...common, manifest: manifest('release-0001') });
  await deployRelease({
    ...common, manifest: manifest('release-0002', { sourceRevision: 'f'.repeat(40) }),
  });
  assert.deepEqual(await rollbackRelease(common), {
    code: 'release_rolled_back', current: 'release-0001', previous: 'release-0002',
    pending: null, revision: 3, sequence: 6,
  });
  assert.equal(converged.at(-1), 'release-0001');
  assert.equal((await reconcileRelease(common)).releaseId, 'release-0001');
  assert.equal(converged.at(-1), 'release-0001');
});

test('schema incompatibility fails before backup or candidate convergence', async () => {
  const directory = root();
  const effects = [];
  await rejects(deployRelease({
    root: directory, manifest: manifest('release-0001'), files,
    readSchema: async () => 2, backup: async () => effects.push('backup'),
    converge: async () => effects.push('converge'),
  }), 'schema_incompatible');
  assert.deepEqual(effects, []);
});

test('fresh deployment proves the created schema before publishing authority', async () => {
  const directory = root();
  let schema = null;
  const effects = [];
  await deployRelease({
    root: directory, manifest: manifest('release-0001'), files,
    readSchema: async () => schema,
    backup: async () => effects.push('backup'),
    converge: async () => { effects.push('converge'); schema = 1; },
  });
  assert.deepEqual(effects, ['backup', 'converge']);
  assert.equal(readReleaseState(directory).current, 'release-0001');
});

test('fresh candidate with wrong resulting schema is stopped by its retained identity', async () => {
  const directory = root();
  let schema = null;
  const converged = [];
  await rejects(deployRelease({
    root: directory, manifest: manifest('release-0001'), files,
    readSchema: async () => schema, backup: async () => {},
    converge: async (release, options = {}) => {
      converged.push([release.releaseId, options.stop === true]);
      if (!options.stop) schema = 2;
    },
  }), 'candidate_failed');
  assert.deepEqual(converged, [['release-0001', false], ['release-0001', true]]);
  assert.deepEqual(readReleaseState(directory), {
    current: null, previous: null, pending: null, revision: 0, sequence: 2,
  });
});

test('final state publication failure reconverges current and retains pending recovery evidence', async () => {
  const directory = root();
  const converged = [];
  const common = {
    root: directory, files, readSchema: async () => 1, backup: async () => {},
    converge: async (release) => { converged.push(release?.releaseId ?? null); },
  };
  await deployRelease({ ...common, manifest: manifest('release-0001') });
  let publications = 0;
  await rejects(deployRelease({
    ...common, manifest: manifest('release-0002', { sourceRevision: 'f'.repeat(40) }),
    publishState: (releaseRoot, state) => {
      publications += 1;
      if (publications === 2) throw new Error('lost atomic rename');
      writeReleaseState(releaseRoot, state);
    },
  }), 'release_unavailable');
  assert.deepEqual(converged.slice(-2), ['release-0002', 'release-0001']);
  assert.deepEqual(readReleaseState(directory), {
    current: 'release-0001', previous: null, pending: 'release-0002', revision: 1,
    sequence: 3,
  });
});

test('backup failure is finite and precedes candidate convergence', async () => {
  const directory = root();
  let converged = false;
  await rejects(deployRelease({
    root: directory, manifest: manifest('release-0001'), files,
    readSchema: async () => 1, backup: async () => { throw new Error('path detail'); },
    converge: async () => { converged = true; },
  }), 'backup_failed');
  assert.equal(converged, false);
});

test('release identity capacity proves max minus one, max, and max plus one', () => {
  const directory = root();
  for (let index = 0; index < 63; index += 1) {
    const releaseId = `release-${String(index).padStart(4, '0')}`;
    const registered = registerRelease(directory, manifest(releaseId), files);
    execFileSync('chmod', ['-R', 'u+w', registered.recordPath]);
    rmSync(registered.recordPath, { recursive: true });
  }
  assert.equal(validateReleaseDomain(directory).receipts.length, 63);
  const final = registerRelease(directory, manifest('release-0063'), files);
  assert.equal(validateReleaseDomain(directory).receipts.length, 64);
  execFileSync('chmod', ['-R', 'u+w', final.recordPath]);
  rmSync(final.recordPath, { recursive: true });
  code(() => registerRelease(directory, manifest('release-0064'), files), 'release_capacity');
});

test('relationship-preserving manifest and deployment corruption fails closed on restart', () => {
  const directory = root();
  const registered = registerRelease(directory, manifest('release-0001'), files);
  chmodSync(join(registered.recordPath, 'Caddyfile'), 0o640);
  writeFileSync(join(registered.recordPath, 'Caddyfile'), files.Caddyfile.replace('web', 'evil'));
  code(() => readRelease(directory, 'release-0001'), 'release_corrupt');
});

test('manifest rejects omitted, expanded, reordered-domain, and non-digest authority', () => {
  const base = manifest('release-0001');
  for (const invalid of [
    { ...base, extra: true },
    { ...base, images: { ...base.images, web: 'cannabeats/web:latest' } },
    { ...base, schema: { min: 2, max: 1, target: 1 } },
    { ...base, releaseId: '../escape' },
  ]) code(() => canonicalReleaseManifest(invalid), 'invalid_release');
});

test('restart reconciliation stops a durably pending first candidate by exact record', async () => {
  const directory = root();
  registerRelease(directory, manifest('release-0001'), files);
  writeReleaseState(directory, {
    current: null, previous: null, pending: 'release-0001', revision: 0, sequence: 1,
  });
  const effects = [];
  assert.deepEqual(await reconcileRelease({
    root: directory, readSchema: async () => 1,
    converge: async (release, options) => effects.push([release.releaseId, options]),
  }), { code: 'release_reconciled', releaseId: null });
  assert.deepEqual(effects, [['release-0001', { stop: true }]]);
  assert.deepEqual(readReleaseState(directory), {
    current: null, previous: null, pending: null, revision: 0, sequence: 2,
  });
});

test('restart repairs an authority-first crash before reconciling the pending candidate', async () => {
  const directory = root();
  registerRelease(directory, manifest('release-0001'), files);
  const authority = join(directory, 'state-authority.json');
  chmodSync(authority, 0o640);
  writeFileSync(authority, JSON.stringify({
    current: null, previous: null, pending: 'release-0001', revision: 0, sequence: 1,
  }));
  const effects = [];
  await reconcileRelease({
    root: directory, readSchema: async () => 1,
    converge: async (release, options) => effects.push([release.releaseId, options.stop]),
  });
  assert.deepEqual(effects, [['release-0001', true]]);
  assert.equal(readReleaseState(directory).sequence, 2);
});

test('restart reconciliation restores recorded current before clearing a pending candidate', async () => {
  const directory = root();
  const common = {
    root: directory, files, readSchema: async () => 1, backup: async () => {},
    converge: async () => {},
  };
  await deployRelease({ ...common, manifest: manifest('release-0001') });
  registerRelease(directory, manifest('release-0002', { sourceRevision: 'f'.repeat(40) }), files);
  writeReleaseState(directory, {
    current: 'release-0001', previous: null, pending: 'release-0002', revision: 1,
    sequence: 3,
  });
  const converged = [];
  await reconcileRelease({
    root: directory, readSchema: async () => 1,
    converge: async ({ releaseId }) => converged.push(releaseId),
  });
  assert.deepEqual(converged, ['release-0001']);
  assert.deepEqual(readReleaseState(directory), {
    current: 'release-0001', previous: null, pending: null, revision: 1, sequence: 4,
  });
});

test('pending reconciliation reconverges recorded current before proving a candidate-changed schema', async () => {
  const directory = root();
  let generation = 1;
  await deployRelease({
    root: directory, manifest: manifest('release-0001'), files,
    readSchema: async () => generation, backup: async () => {}, converge: async () => {},
  });
  registerRelease(directory, manifest('release-0002', { sourceRevision: 'f'.repeat(40) }), files);
  writeReleaseState(directory, {
    current: 'release-0001', previous: null, pending: 'release-0002', revision: 1,
    sequence: 3,
  });
  generation = 2;
  await reconcileRelease({
    root: directory, readSchema: async () => generation,
    converge: async ({ releaseId }) => {
      assert.equal(releaseId, 'release-0001');
      generation = 1;
    },
  });
  assert.equal(generation, 1);
  assert.equal(readReleaseState(directory).pending, null);
});

test('a retained pending transition blocks deploy and rollback until reconciliation', async () => {
  const directory = root();
  const common = {
    root: directory, files, readSchema: async () => 1, backup: async () => {},
    converge: async () => {},
  };
  await deployRelease({ ...common, manifest: manifest('release-0001') });
  registerRelease(directory, manifest('release-0002', { sourceRevision: 'f'.repeat(40) }), files);
  writeReleaseState(directory, {
    current: 'release-0001', previous: null, pending: 'release-0002', revision: 1,
    sequence: 3,
  });
  await rejects(deployRelease({
    ...common, manifest: manifest('release-0003', { sourceRevision: '9'.repeat(40) }),
  }), 'deployment_pending');
  await rejects(rollbackRelease(common), 'deployment_pending');
});

test('rollback proves post-convergence schema and restores current on mismatch', async () => {
  const directory = root();
  let generation = 1;
  const common = {
    root: directory, files, readSchema: async () => generation, backup: async () => {},
    converge: async ({ releaseId }) => { generation = releaseId === 'release-0001' ? 2 : 1; },
  };
  await deployRelease({
    ...common, manifest: manifest('release-0001'),
    converge: async () => { generation = 1; },
  });
  await deployRelease({
    ...common, manifest: manifest('release-0002', { sourceRevision: 'f'.repeat(40) }),
    converge: async () => { generation = 1; },
  });
  await rejects(rollbackRelease(common), 'candidate_failed');
  assert.equal(generation, 1);
  assert.deepEqual(readReleaseState(directory), {
    current: 'release-0002', previous: 'release-0001', pending: null, revision: 2,
    sequence: 6,
  });
});

test('reconciliation rejects retained current schema drift before convergence', async () => {
  const directory = root();
  await deployRelease({
    root: directory, manifest: manifest('release-0001'), files,
    readSchema: async () => 1, backup: async () => {}, converge: async () => {},
  });
  let converged = false;
  await rejects(reconcileRelease({
    root: directory, readSchema: async () => 2,
    converge: async () => { converged = true; },
  }), 'schema_incompatible');
  assert.equal(converged, false);
});

test('complete identity domain repairs one missing copy and prevents pruned ID reuse', () => {
  const directory = root();
  const registered = registerRelease(directory, manifest('release-0001'), files);
  execFileSync('chmod', ['-R', 'u+w', registered.recordPath]);
  rmSync(registered.recordPath, { recursive: true });
  unlinkSync(join(directory, 'identities', 'release-0001.json'));
  validateReleaseDomain(directory);
  assert.equal(readFileSync(join(directory, 'identities', 'release-0001.json'), 'utf8')
    .includes('release-0001'), true);
  chmodSync(join(directory, 'identities.json'), 0o640);
  writeFileSync(join(directory, 'identities.json'), JSON.stringify({ version: 1, receipts: [] }));
  validateReleaseDomain(directory);
  assert.equal(JSON.parse(readFileSync(join(directory, 'identities.json'), 'utf8')).receipts.length, 1);
  code(() => registerRelease(directory, manifest('release-0001', { createdAt: 1001 }), files),
    'release_conflict');
});

test('identity reconstruction preserves immutable registration ordinals', () => {
  const directory = root();
  const first = registerRelease(directory, manifest('release-0001'), files);
  const second = registerRelease(directory, manifest('release-0002'), files);
  for (const record of [first.recordPath, second.recordPath]) {
    execFileSync('chmod', ['-R', 'u+w', record]);
    rmSync(record, { recursive: true });
  }
  const ledgerPath = join(directory, 'identities.json');
  const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
  chmodSync(ledgerPath, 0o640);
  writeFileSync(ledgerPath, JSON.stringify({
    version: 1,
    receipts: [{ ...ledger.receipts[1], ordinal: 1 }],
  }));
  code(() => validateReleaseDomain(directory), 'release_corrupt');
});

test('complete retained domain rejects unrecognized and symlinked evidence', () => {
  const directory = root();
  registerRelease(directory, manifest('release-0001'), files);
  writeFileSync(join(directory, 'unexpected'), 'value');
  code(() => validateReleaseDomain(directory), 'release_corrupt');
  unlinkSync(join(directory, 'unexpected'));
  const identity = join(directory, 'identities', 'release-0001.json');
  unlinkSync(identity);
  symlinkSync(join(directory, 'identities.json'), identity);
  code(() => validateReleaseDomain(directory), 'release_corrupt');
});

test('reading current validates every older retained record rather than only state references', async () => {
  const directory = root();
  const common = {
    root: directory, files, readSchema: async () => 1, backup: async () => {},
    converge: async () => {},
  };
  await deployRelease({ ...common, manifest: manifest('release-0001') });
  await deployRelease({
    ...common, manifest: manifest('release-0002', { sourceRevision: 'f'.repeat(40) }),
  });
  registerRelease(directory, manifest('release-0003', { sourceRevision: '9'.repeat(40) }), files);
  const aged = join(directory, 'records', 'release-0003', 'Caddyfile');
  chmodSync(aged, 0o640);
  writeFileSync(aged, 'preserved shape, changed bytes\n');
  code(() => readReleaseState(directory), 'release_corrupt');
});

test('state authority repairs one missing projection and rejects an apparent fresh reset', async () => {
  const directory = root();
  await deployRelease({
    root: directory, manifest: manifest('release-0001'), files,
    readSchema: async () => 1, backup: async () => {}, converge: async () => {},
  });
  unlinkSync(join(directory, 'state.json'));
  assert.equal(readReleaseState(directory).current, 'release-0001');
  chmodSync(join(directory, 'state.json'), 0o640);
  writeFileSync(join(directory, 'state.json'), JSON.stringify({
    current: null, previous: null, pending: null, revision: 0, sequence: 0,
  }));
  code(() => readReleaseState(directory), 'release_corrupt');
  code(() => registerRelease(directory, manifest('release-0002'), files), 'release_corrupt');
});

test('release record capacity proves max minus one, max, and max plus one without consuming identity', () => {
  const directory = root();
  for (let index = 0; index < MAX_RELEASE_RECORDS - 1; index += 1) {
    registerRelease(directory, manifest(`release-${String(index).padStart(4, '0')}`), files);
  }
  assert.equal(validateReleaseDomain(directory).records.length, MAX_RELEASE_RECORDS - 1);
  registerRelease(directory, manifest(`release-${String(MAX_RELEASE_RECORDS - 1).padStart(4, '0')}`), files);
  assert.equal(validateReleaseDomain(directory).records.length, MAX_RELEASE_RECORDS);
  code(() => registerRelease(
    directory, manifest(`release-${String(MAX_RELEASE_RECORDS).padStart(4, '0')}`), files,
  ), 'release_capacity');
  assert.equal(validateReleaseDomain(directory).receipts.length, MAX_RELEASE_RECORDS);
});

test('record pruning preserves current, previous, every retained backup release, and one candidate slot', async () => {
  const directory = root();
  const common = {
    root: directory, files, readSchema: async () => 1,
    backup: async () => {}, converge: async () => {},
  };
  await deployRelease({ ...common, manifest: manifest('release-0000') });
  await deployRelease({ ...common, manifest: manifest('release-0001') });
  for (let index = 2; index < MAX_RELEASE_RECORDS; index += 1) {
    registerRelease(directory, manifest(`release-${String(index).padStart(4, '0')}`), files);
  }
  const backupReleases = Array.from({ length: 15 }, (_, index) =>
    `release-${String(index + 2).padStart(4, '0')}`);
  const pruned = pruneReleaseRecords(directory, backupReleases, { reserve: 1 });
  assert.deepEqual(pruned.removed, ['release-0017']);
  const domain = validateReleaseDomain(directory);
  assert.equal(domain.records.length, MAX_RELEASE_RECORDS - 1);
  assert.equal(domain.receipts.length, MAX_RELEASE_RECORDS);
  for (const releaseId of ['release-0000', 'release-0001', ...backupReleases]) {
    assert.equal(domain.records.includes(releaseId), true);
  }
  registerRelease(directory, manifest('release-0018'), files);
  assert.equal(validateReleaseDomain(directory).records.length, MAX_RELEASE_RECORDS);
  code(() => pruneReleaseRecords(directory, [
    ...backupReleases, 'release-0017', 'release-0018',
  ], { reserve: 1 }), 'release_capacity');
});

test('restart completes only a safely renamed unreferenced record prune', () => {
  const directory = root();
  registerRelease(directory, manifest('release-0001'), files);
  const discarded = `.tmp-release-0001-${randomUUID()}`;
  const recordRoot = join(directory, 'records');
  chmodSync(join(recordRoot, 'release-0001'), 0o700);
  renameSync(join(recordRoot, 'release-0001'), join(recordRoot, discarded));
  const domain = validateReleaseDomain(directory);
  assert.deepEqual(domain.records, []);
  assert.equal(domain.receipts.length, 1);
  assert.deepEqual(readdirSync(recordRoot), []);
});

test('deployment file byte bounds prove max minus one, max, max plus one, and UTF-8 bytes', () => {
  for (const [name, maximum] of [
    ['Caddyfile', MAX_CADDYFILE_BYTES], ['compose.yaml', MAX_COMPOSE_BYTES],
  ]) {
    for (const size of [maximum - 1, maximum]) {
      assert.match(deploymentDigest({ ...files, [name]: 'x'.repeat(size) }), /^sha256:/u);
    }
    code(() => deploymentDigest({ ...files, [name]: 'x'.repeat(maximum + 1) }),
      'invalid_release');
  }
  assert.match(deploymentDigest({ ...files, Caddyfile: 'é'.repeat(MAX_CADDYFILE_BYTES / 2) }),
    /^sha256:/u);
  code(() => deploymentDigest({
    ...files, Caddyfile: `${'é'.repeat(MAX_CADDYFILE_BYTES / 2)}x`,
  }), 'invalid_release');
});
