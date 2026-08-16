import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const composeDirectory = resolve(repositoryRoot, 'spikes/access-spotify-poc');

function renderedCompose(environment = {}) {
  const result = spawnSync('docker', [
    'compose', '-f', 'compose.yaml', '-f', 'compose.state-cutover.yaml',
    '--profile', 'diagnostics', '--profile', 'state-cutover', '--profile', 'operations',
    'config', '--format', 'json',
  ], {
    cwd: composeDirectory,
    encoding: 'utf8',
    env: {
      ...process.env,
      CANNABEATS_RELEASE_EPOCH: 'e73-topology-test',
      ...environment,
    },
  });
  if (result.error?.code === 'ENOENT') return null;
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function renderedS2fCompose() {
  const result = spawnSync('docker', [
    'compose', '-f', 'compose.yaml', '-f', 'compose.state-cutover.yaml',
    '-f', 'compose.s2f.yaml', '--profile', 'diagnostics', '--profile', 'state-cutover',
    '--profile', 's2f', 'config', '--format', 'json',
  ], {
    cwd: composeDirectory,
    encoding: 'utf8',
    env: {
      ...process.env,
      CANNABEATS_RELEASE_EPOCH: 's2f-topology-test',
      CANNABEATS_GAME_IMAGE: 'cannabeats/game:s2f-exact',
      S2F_EPHEMERAL_ROLE_MAP:
        '{"123e4567-e89b-42d3-a456-426614174000":"source"}',
      S2F_TRACE_ID: '123e4567-e89b-42d3-a456-426614174001',
    },
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
  assert.deepEqual(diagnostics.volumes.filter((volume) => volume.type === 'volume'), [{
    type: 'volume', source: 'cannabeats_diagnostics_data', target: '/diagnostics', volume: {},
  }]);
  assert.deepEqual(diagnostics.volumes.filter((volume) => volume.type === 'bind')
    .map((volume) => volume.target).sort(),[
    '/run/secrets/cannabeats/diagnostics-game-token',
    '/run/secrets/cannabeats/diagnostics-maintenance-token',
  ]);
  assert.equal(diagnostics.environment.CANNABEATS_DIAGNOSTICS_AUTHENTICATED_API_REQUIRED,'true');
  assert.equal(diagnostics.environment.CANNABEATS_DIAGNOSTICS_DATA_VOLUME,
    'cannabeats_diagnostics_data');
  assert.equal(diagnostics.environment.CANNABEATS_DATA_VOLUME, 'cannabeats_poc_data');
  assert.equal(diagnostics.environment.CANNABEATS_STATE_DATA_VOLUME, 'cannabeats_state_data');
  assert.ok(compose.volumes.cannabeats_diagnostics_data);
  assert.equal(diagnostics.logging.driver, 'json-file');
  assert.equal(diagnostics.logging.options['max-size'], '1m');
  assert.equal(diagnostics.logging.options['max-file'], '4');
});

test('authenticated topology keeps collector credentials scoped and optional', (context) => {
  const compose = renderedCompose();
  if (!compose) {
    context.skip('Docker Compose is unavailable');
    return;
  }
  const game = compose.services.game;
  assert.equal(game.environment.CANNABEATS_DIAGNOSTICS_SERVICE_ORIGIN,'http://diagnostics:3020');
  assert.equal(game.environment.CANNABEATS_DIAGNOSTICS_GAME_TOKEN_FILE,
    '/run/secrets/cannabeats/diagnostics-game-token');
  assert.equal(game.environment.CANNABEATS_DIAGNOSTICS_RELAY_TOKEN_FILE,
    '/run/secrets/cannabeats/diagnostics-relay-token');
  assert.equal(game.volumes.some((volume) =>
    volume.target === '/run/secrets/cannabeats/diagnostics-game-token'),true);
  assert.equal(game.volumes.some((volume) =>
    volume.target === '/run/secrets/cannabeats/diagnostics-relay-token'),true);
  assert.equal(game.volumes.some((volume) =>
    volume.target === '/run/secrets/cannabeats/diagnostics-maintenance-token'),false);
  assert.equal(Object.hasOwn(game.depends_on ?? {},'diagnostics'),false);
  for (const name of ['app','state','backup','history','operator']) {
    assert.equal((compose.services[name].volumes ?? []).some((volume) =>
      String(volume.target).includes('diagnostics-')),false,name);
  }

  const maintenance = compose.services['diagnostics-maintenance'];
  assert.deepEqual(maintenance.profiles,['operations']);
  assert.equal(maintenance.read_only,true);
  assert.equal(maintenance.user,'node');
  assert.equal(maintenance.ports,undefined);
  assert.equal(maintenance.depends_on,undefined);
  assert.equal(maintenance.environment.CANNABEATS_DIAGNOSTICS_SERVICE_ORIGIN,
    'http://diagnostics:3020');
  assert.deepEqual((maintenance.volumes ?? []).map((volume) => volume.target),[
    '/run/secrets/cannabeats/diagnostics-maintenance-token',
  ]);
  assert.equal((maintenance.volumes ?? []).some((volume) =>
    volume.target === '/diagnostics'),false);
  assert.equal(maintenance.environment.CANNABEATS_DIAGNOSTICS_GAME_TOKEN_FILE,undefined);
  assert.equal(maintenance.environment.CANNABEATS_DIAGNOSTICS_RELAY_TOKEN_FILE,undefined);
});

test('rendered volume identities are passed to the runtime collision preflight', (context) => {
  const compose = renderedCompose({
    CANNABEATS_DIAGNOSTICS_DATA_VOLUME: 'collision_demo',
    CANNABEATS_DATA_VOLUME: 'collision_demo',
    CANNABEATS_STATE_DATA_VOLUME: 'distinct_state',
  });
  if (!compose) {
    context.skip('Docker Compose is unavailable');
    return;
  }
  assert.equal(compose.services.diagnostics.environment.CANNABEATS_DIAGNOSTICS_DATA_VOLUME,
    'collision_demo');
  assert.equal(compose.services.diagnostics.environment.CANNABEATS_DATA_VOLUME,
    'collision_demo');
  assert.equal(compose.volumes.cannabeats_diagnostics_data.name, 'collision_demo');
  assert.equal(compose.volumes.cannabeats_poc_data.name, 'collision_demo');
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

test('S2-F evidence profile attaches one private collector proxy with scoped Game authority', (context) => {
  const compose = renderedS2fCompose();
  if (!compose) {
    context.skip('Docker Compose is unavailable');
    return;
  }
  const game = compose.services.game;
  const evidence = compose.services['diagnostics-evidence'];
  assert.equal(game.image, 'cannabeats/game:s2f-exact');
  assert.equal(evidence.image, game.image);
  assert.equal(game.environment.CANNABEATS_DIAGNOSTICS_SERVICE_ORIGIN,
    'http://127.0.0.1:3021');
  assert.deepEqual(evidence.profiles, ['s2f']);
  assert.equal(evidence.network_mode, 'service:game');
  assert.equal(evidence.ports, undefined);
  assert.equal(evidence.read_only, true);
  assert.deepEqual(evidence.cap_drop, ['ALL']);
  assert.deepEqual(evidence.security_opt, ['no-new-privileges:true']);
  assert.equal(evidence.environment.CANNABEATS_DIAGNOSTICS_SERVICE_ORIGIN,
    'http://diagnostics:3020');
  assert.equal(evidence.environment.CANNABEATS_DIAGNOSTICS_MAINTENANCE_TOKEN_FILE, undefined);
  assert.equal(evidence.environment.S2F_TRACE_ID,
    '123e4567-e89b-42d3-a456-426614174001');
  assert.deepEqual(evidence.volumes.map((volume) => volume.target), [
    '/run/secrets/cannabeats/diagnostics-game-token',
  ]);
  assert.deepEqual(evidence.entrypoint, ['node', '/app/tools/s2f-evidence.mjs']);
  assert.deepEqual(evidence.command.slice(0, 2), ['proxy', '--upstream']);

  const dockerfile = readFileSync(resolve(repositoryRoot, 'web/Dockerfile'), 'utf8');
  assert.match(dockerfile, /COPY --chown=node:node tools\/s2f-evidence\.mjs/);
  assert.match(dockerfile, /diagnostic-collector-client\.mjs/);
  const wrapper = readFileSync(resolve(repositoryRoot, 'tools/run-s2f-host-sample.sh'), 'utf8');
  assert.match(wrapper, /id -u/);
  assert.match(wrapper, /\/usr\/bin\/python3/);
  assert.doesNotMatch(wrapper, /docker run/);
  assert.match(wrapper, /S2F_ALLOWLISTED_PIDS_JSON/);
  const companion = readFileSync(resolve(repositoryRoot, 'tools/s2f-host-sample.py'), 'utf8');
  assert.match(companion, /os\.geteuid\(\) != 0/);
  assert.match(companion, /os\.readlink/);
});
