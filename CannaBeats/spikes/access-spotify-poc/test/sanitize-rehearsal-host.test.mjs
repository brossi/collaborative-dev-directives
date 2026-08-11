import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = mkdtempSync(join(tmpdir(), 'cannabeats-sanitize-test-'));
const script = resolve('../../tools/sanitize-rehearsal-host.sh');
after(() => rmSync(root, { recursive: true, force: true }));

function fixture(name) {
  const directory = join(root, name);
  mkdirSync(directory, { recursive: true });
  return directory;
}

function writeFixture(rootDirectory, logicalPath, content = 'sensitive') {
  const path = join(rootDirectory, logicalPath.replace(/^\//, ''));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  chmodSync(path, 0o600);
  return path;
}

test('sanitizer is dry-run by default and requires an explicit role', async () => {
  await assert.rejects(
    run(script, ['--expected-hostname', 'test-host']),
    (error) => /--role is required/.test(error.stderr),
  );

  const testRoot = fixture('dry-run');
  const secret = writeFixture(
    testRoot,
    '/opt/cannabeats/CannaBeats/spikes/access-spotify-poc/secrets/game-service-token',
  );
  const { stdout } = await run(script, [
    '--role', 'application',
    '--expected-hostname', 'test-host',
    '--test-root', testRoot,
  ]);
  assert.match(stdout, /Mode: dry-run/);
  assert.match(stdout, /No changes were made/);
  assert.equal(existsSync(secret), true);
});

test('application role removes data and credentials but preserves rebuildable source', async () => {
  const testRoot = fixture('application');
  const compose = '/opt/cannabeats/CannaBeats/spikes/access-spotify-poc';
  const preserved = writeFixture(testRoot, `${compose}/server.mjs`, 'source');
  const secret = writeFixture(testRoot, `${compose}/secrets/game-service-token`);
  const backup = writeFixture(testRoot, `${compose}/backups/example.cbbackup`);
  const database = writeFixture(
    testRoot,
    '/var/lib/docker/volumes/cannabeats_poc_data/_data/cannabeats-poc.sqlite',
  );
  const passphrase = writeFixture(testRoot, '/var/tmp/cannabeats-p2e-backup-passphrase');
  const unrelated = writeFixture(testRoot, '/var/tmp/unrelated-file', 'keep');

  await run(script, [
    '--role', 'application',
    '--expected-hostname', 'test-host',
    '--test-root', testRoot,
    '--execute',
  ]);

  assert.equal(existsSync(preserved), true);
  assert.equal(readFileSync(preserved, 'utf8'), 'source');
  for (const path of [secret, backup, database, passphrase]) {
    assert.equal(existsSync(path), false);
  }
  assert.equal(existsSync(unrelated), true);
});

test('managed-source role clears every credential-bearing state directory', async () => {
  const testRoot = fixture('managed-source');
  const runtime = writeFixture(testRoot, '/opt/cannabeats-managed-source/controller.py', 'source');
  const profile = writeFixture(
    testRoot,
    '/var/lib/cannabeats-source/chrome-profile/Default/Cookies',
  );
  const sourceToken = writeFixture(
    testRoot,
    '/etc/cannabeats-managed-source/source-token',
  );
  const tailnetIdentity = writeFixture(testRoot, '/var/lib/tailscale/tailscaled.state');
  const vncPassword = writeFixture(
    testRoot,
    '/etc/cannabeats-managed-source/vnc.pass',
  );
  const hosts = writeFixture(
    testRoot,
    '/etc/hosts',
    '127.0.0.1 localhost\n127.0.0.1 relay # cannabeats-p2e-relay\n',
  );

  await run(script, [
    '--role', 'managed-source',
    '--expected-hostname', 'test-host',
    '--test-root', testRoot,
    '--execute',
  ]);

  assert.equal(existsSync(runtime), true);
  for (const path of [profile, sourceToken, tailnetIdentity, vncPassword]) {
    assert.equal(existsSync(path), false);
  }
  assert.doesNotMatch(readFileSync(hosts, 'utf8'), /cannabeats-p2e-relay/);
  assert.equal(existsSync(join(testRoot, 'var/lib/tailscale')), true);
  assert.equal(existsSync(join(testRoot, 'var/lib/cannabeats-source')), true);
});
