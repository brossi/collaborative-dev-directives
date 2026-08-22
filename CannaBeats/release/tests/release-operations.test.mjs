import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  closeSync, mkdirSync, mkdtempSync, openSync, rmSync, symlinkSync, unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { afterEach } from 'node:test';

import {
  createProductionConverger, executeReleaseCommand, loadBundle, withOperationsLock,
  productionBackup,
} from '../scripts/release-operations.mjs';
import {
  MAX_CADDYFILE_BYTES, ReleaseStateError, deploymentDigest,
} from '../scripts/release-state.mjs';

const roots = [];
afterEach(() => {
  while (roots.length) {
    const path = roots.pop();
    execFileSync('chmod', ['-R', 'u+w', path]);
    rmSync(path, { recursive: true, force: true });
  }
});
const digest = (value) => `sha256:${value.repeat(64)}`;
function bundle() {
  const root = mkdtempSync(join(tmpdir(), 'cannabeats-fr82-bundle-'));
  roots.push(root);
  const files = { Caddyfile: 'example.test {}\n', 'compose.yaml': 'services: {}\n' };
  const manifest = {
    version: 1, releaseId: 'release-0001', sourceRevision: 'a'.repeat(40),
    catalogVersion: digest('b'), createdAt: 1,
    schema: { min: 1, max: 1, target: 1 },
    images: { caddy: digest('c'), web: digest('d'), relay: digest('e') },
    deploymentDigest: deploymentDigest(files),
  };
  writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest));
  for (const [name, value] of Object.entries(files)) writeFileSync(join(root, name), value);
  return root;
}

test('operations lock holds one file descriptor across the complete callback', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'cannabeats-fr82-lock-'));
  roots.push(directory);
  const path = join(directory, 'operations.lock');
  const calls = [];
  let openDescriptor;
  const result = await withOperationsLock(async () => {
    calls.push('work');
    return 'done';
  }, {
    lockPath: path,
    open: (...args) => { openDescriptor = openSync(...args); return openDescriptor; },
    close: (fd) => { calls.push(`close:${fd}`); closeSync(fd); },
    spawn: (command, args, options) => {
      calls.push({ command, args, descriptor: options.stdio[3] });
      return { status: 0 };
    },
  });
  assert.equal(result, 'done');
  assert.deepEqual(calls[0], { command: 'flock', args: ['--nonblock', '3'], descriptor: openDescriptor });
  assert.equal(calls[1], 'work');
  assert.equal(calls[2], `close:${openDescriptor}`);
});

test('held operations lock returns finite busy without entering work', async () => {
  let entered = false;
  await assert.rejects(withOperationsLock(async () => { entered = true; }, {
    lockPath: join(mkdtempSync(join(tmpdir(), 'cannabeats-fr82-busy-')), 'lock'),
    spawn: () => ({ status: 1 }),
  }), (error) => error instanceof ReleaseStateError && error.code === 'busy');
  assert.equal(entered, false);
});

test('deploy CLI boundary holds lock and accepts only one absolute bundle shape', async () => {
  const releaseRoot = mkdtempSync(join(tmpdir(), 'cannabeats-fr82-state-'));
  roots.push(releaseRoot);
  const bundlePath = bundle();
  const order = [];
  const dependencies = {
    root: releaseRoot,
    lock: async (work) => { order.push('lock'); return work(); },
    readSchema: async () => { order.push('schema'); return 1; },
    backup: async () => { order.push('backup'); },
    converge: async () => { order.push('converge'); },
    pruneRecords: async () => { order.push('prune'); },
  };
  const result = await executeReleaseCommand(['deploy', '--bundle', bundlePath], dependencies);
  assert.equal(result.code, 'release_activated');
  assert.deepEqual(order, ['lock', 'prune', 'schema', 'backup', 'converge', 'schema']);
  for (const argv of [[], ['deploy'], ['deploy', '--bundle', 'relative']]) {
    await assert.rejects(executeReleaseCommand(argv, dependencies),
      (error) => error instanceof ReleaseStateError
        && ['invalid_arguments', 'invalid_release'].includes(error.code));
  }
});

test('production convergence uses only retained compose and exact manifest images', async () => {
  const calls = [];
  const converge = createProductionConverger({
    spawn: (command, args, options) => { calls.push({ command, args, env: options.env }); return { status: 0 }; },
  });
  const release = {
    recordPath: '/opt/cannabeats/releases/records/release-0001',
    manifest: { images: { caddy: digest('a'), web: digest('b'), relay: digest('c') } },
  };
  await converge(release);
  assert.equal(calls[0].command, 'docker');
  assert.deepEqual(calls[0].args.slice(-4), ['up', '--detach', '--wait', '--remove-orphans']);
  assert.equal(calls[0].args.includes(`${release.recordPath}/compose.yaml`), true);
  assert.equal(calls[0].env.CANNABEATS_WEB_IMAGE, digest('b'));
  await converge(release, { stop: true });
  assert.deepEqual(calls[1].args.slice(-2), ['down', '--remove-orphans']);
});

test('bundle loader accepts only the exact bounded regular file set', () => {
  const path = bundle();
  writeFileSync(join(path, 'extra'), 'unexpected');
  assert.throws(() => loadBundle(path), (error) => error instanceof ReleaseStateError
    && error.code === 'invalid_release');
  unlinkSync(join(path, 'extra'));
  writeFileSync(join(path, 'Caddyfile'), 'x'.repeat(MAX_CADDYFILE_BYTES));
  assert.equal(loadBundle(path).files.Caddyfile.length, MAX_CADDYFILE_BYTES);
  writeFileSync(join(path, 'Caddyfile'), 'x'.repeat(MAX_CADDYFILE_BYTES + 1));
  assert.throws(() => loadBundle(path), (error) => error instanceof ReleaseStateError
    && error.code === 'invalid_release');
  unlinkSync(join(path, 'Caddyfile'));
  symlinkSync(join(path, 'compose.yaml'), join(path, 'Caddyfile'));
  assert.throws(() => loadBundle(path), (error) => error instanceof ReleaseStateError
    && error.code === 'invalid_release');
});

test('release backup identity is deterministic for the exact state transition', async () => {
  const calls = [];
  await productionBackup({ reason: 'pre_release', releaseId: 'release-0001', stateSequence: 4 }, {
    create: async (input) => { calls.push(input); return { code: 'backup_created' }; },
  });
  await productionBackup({ reason: 'pre_release', releaseId: 'release-0001', stateSequence: 4 }, {
    create: async (input) => { calls.push(input); return { code: 'backup_created' }; },
  });
  assert.deepEqual(calls[0], calls[1]);
  assert.match(calls[0].requestId, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(calls[0].stateSequence, 4);
});

test('every release command fails closed while restore recovery is pending', async () => {
  let converged = false;
  await assert.rejects(executeReleaseCommand(['reconcile'], {
    lock: async (work) => work(), restorePending: () => true,
    converge: async () => { converged = true; },
  }), (error) => error instanceof ReleaseStateError && error.code === 'restore_pending');
  assert.equal(converged, false);
});
