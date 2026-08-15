import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const composeDirectory = resolve(repositoryRoot, 'spikes/access-spotify-poc');

function renderedCompose() {
  const result = spawnSync('docker', [
    'compose', '-f', 'compose.yaml', '-f', 'compose.state-cutover.yaml',
    '--profile', 'diagnostics', '--profile', 'state-cutover', '--profile', 'operations',
    'config', '--format', 'json',
  ], {
    cwd: composeDirectory,
    encoding: 'utf8',
    env: { ...process.env, CANNABEATS_RELEASE_EPOCH: 'e73-topology-test' },
  });
  if (result.error?.code === 'ENOENT') return null;
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('diagnostics is one private optional service with one disposable volume', (context) => {
  const compose = renderedCompose();
  if (!compose) {
    context.skip('Docker Compose is unavailable');
    return;
  }
  const diagnostics = compose.services.diagnostics;
  assert.ok(diagnostics);
  assert.deepEqual(diagnostics.profiles, ['diagnostics']);
  assert.equal(diagnostics.read_only, true);
  assert.equal(diagnostics.user, 'node');
  assert.equal(diagnostics.restart, 'unless-stopped');
  assert.deepEqual(diagnostics.cap_drop, ['ALL']);
  assert.deepEqual(diagnostics.security_opt, ['no-new-privileges:true']);
  assert.equal(diagnostics.mem_limit, '268435456');
  assert.equal(diagnostics.cpus, 0.25);
  assert.equal(diagnostics.pids_limit, 64);
  assert.equal(diagnostics.ports, undefined);
  assert.equal(diagnostics.depends_on, undefined);
  assert.deepEqual(diagnostics.volumes, [{
    type: 'volume', source: 'cannabeats_diagnostics_data', target: '/diagnostics', volume: {},
  }]);
  assert.ok(compose.volumes.cannabeats_diagnostics_data);
  assert.equal(diagnostics.logging.driver, 'json-file');
  assert.equal(diagnostics.logging.options['max-size'], '1m');
  assert.equal(diagnostics.logging.options['max-file'], '4');
});

test('authority operations and audio topology have no diagnostics dependency or mount', (context) => {
  const compose = renderedCompose();
  if (!compose) {
    context.skip('Docker Compose is unavailable');
    return;
  }
  for (const [name, service] of Object.entries(compose.services)) {
    if (name === 'diagnostics') continue;
    assert.equal(Object.hasOwn(service.depends_on ?? {}, 'diagnostics'), false, name);
    assert.equal((service.volumes ?? []).some((volume) =>
      volume.source === 'cannabeats_diagnostics_data'
      || volume.target === '/diagnostics'), false, name);
  }
  for (const name of ['app', 'game', 'state', 'backup', 'history', 'operator']) {
    assert.ok(compose.services[name], name);
  }

  const backup = readFileSync(resolve(composeDirectory, 'operations/coordinated-backup.mjs'), 'utf8');
  const restore = readFileSync(resolve(composeDirectory, 'deploy/restore-rehearsal.compose.yaml'), 'utf8');
  assert.doesNotMatch(backup, /diagnostic/i);
  assert.doesNotMatch(restore, /diagnostic/i);
});
