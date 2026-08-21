import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  chownSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  DEPLOYMENT_IMAGE_NAMES, DEPLOYMENT_PATHS, validateDeploymentEnvironment,
} from '../scripts/deployment-config.mjs';
import { runProductionStart } from '../scripts/start-production.mjs';

const compose = readFileSync('release/deploy/compose.yaml', 'utf8');
const caddy = readFileSync('release/deploy/Caddyfile', 'utf8');
const initializer = 'release/scripts/initialize-host.sh';
const initializerText = readFileSync(initializer, 'utf8');
const digest = (name, value) => `${name}@sha256:${value.repeat(64)}`;

function serviceSection(name, next) {
  const start = compose.indexOf(`\n  ${name}:\n`);
  const end = compose.indexOf(next === 'networks' ? '\nnetworks:\n' : `\n  ${next}:\n`, start + 1);
  return compose.slice(start, end);
}

test('production topology exposes only Caddy and keeps relay on the internal network', () => {
  assert.equal((compose.match(/^  (caddy|web|relay):$/gmu) ?? []).length, 3);
  assert.match(compose, /caddy:[\s\S]*ports:[\s\S]*- 80:80[\s\S]*- 443:443/u);
  assert.doesNotMatch(serviceSection('web', 'relay'), /^    ports:/mu);
  assert.doesNotMatch(serviceSection('relay', 'networks'), /^    ports:/mu);
  assert.match(compose, /audio:\n    internal: true/u);
  assert.match(compose, /relay:[\s\S]*networks: \[audio\]/u);
  assert.doesNotMatch(serviceSection('relay', 'networks'), /edge/u);
});

test('each service has exact images, least mounts, health, and finite resources', () => {
  for (const name of ['CADDY', 'WEB', 'RELAY']) {
    assert.equal(compose.includes(`image: \${CANNABEATS_${name}_IMAGE:?`), true);
  }
  assert.equal((compose.match(/healthcheck:/gu) ?? []).length, 3);
  assert.equal((compose.match(/pids_limit:/gu) ?? []).length, 3);
  assert.equal((compose.match(/mem_limit:/gu) ?? []).length, 3);
  assert.equal((compose.match(/cpus:/gu) ?? []).length, 3);
  const caddySection = serviceSection('caddy', 'web');
  const relaySection = serviceSection('relay', 'networks');
  assert.doesNotMatch(caddySection, /\/run\/secrets|CANNABEATS_DATABASE_PATH/u);
  assert.doesNotMatch(relaySection, /CANNABEATS_DATABASE_PATH|CANNABEATS_DATA_DIR/u);
  assert.match(compose, /web:[\s\S]*CANNABEATS_DATABASE_PATH:[\s\S]*\/run\/secrets/u);
  assert.equal((compose.match(/\/run\/secrets\/cannabeats-relay-ingest:ro/gu) ?? []).length, 2);
  assert.equal((compose.match(/\/run\/secrets\/cannabeats-relay-listen:ro/gu) ?? []).length, 2);
});

test('deployment environment accepts only exact image digests and production paths', () => {
  const environment = {
    ...DEPLOYMENT_PATHS,
    CANNABEATS_CADDY_IMAGE: digest('caddy', 'a'),
    CANNABEATS_WEB_IMAGE: digest('registry.example/cannabeats/web', 'b'),
    CANNABEATS_RELAY_IMAGE: digest('registry.example/cannabeats/relay', 'c'),
  };
  assert.deepEqual(validateDeploymentEnvironment(environment), { status: 'valid', issues: [] });
  for (const name of [...DEPLOYMENT_IMAGE_NAMES, ...Object.keys(DEPLOYMENT_PATHS)]) {
    const missing = { ...environment };
    delete missing[name];
    assert.deepEqual(validateDeploymentEnvironment(missing).issues, [{ code: 'missing', name }]);
  }
  for (const value of ['caddy:latest', 'caddy@sha256:ABC', 'caller-authored']) {
    assert.deepEqual(validateDeploymentEnvironment({
      ...environment, CANNABEATS_CADDY_IMAGE: value,
    }).issues, [{ code: 'invalid', name: 'CANNABEATS_CADDY_IMAGE' }]);
  }
  assert.deepEqual(validateDeploymentEnvironment({
    ...environment, CANNABEATS_DATA_DIR: '/tmp/caller-authored',
  }).issues, [{ code: 'invalid', name: 'CANNABEATS_DATA_DIR' }]);
});

test('the sole production start entrypoint validates before Compose dispatch', () => {
  const environment = {
    ...DEPLOYMENT_PATHS,
    CANNABEATS_CADDY_IMAGE: digest('caddy', 'a'),
    CANNABEATS_WEB_IMAGE: digest('cannabeats/web', 'b'),
    CANNABEATS_RELAY_IMAGE: digest('cannabeats/relay', 'c'),
  };
  const calls = [];
  const invoke = (command, args, options) => {
    calls.push({ command, args, options });
    return { status: 0 };
  };
  assert.deepEqual(runProductionStart({
    argv: ['--render'], environment, spawn: invoke,
  }), { status: 'ready' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'flock');
  assert.deepEqual(calls[0].args.slice(0, 5), [
    '--nonblock', '--conflict-exit-code', '75',
    '/run/lock/cannabeats-operations.lock', 'docker',
  ]);
  assert.deepEqual(calls[0].args.slice(-2), ['config', '--quiet']);
  for (const invalid of [
    { ...environment, CANNABEATS_WEB_IMAGE: 'node:latest' },
    { ...environment, CANNABEATS_DATA_DIR: '/tmp/caller-authored' },
  ]) {
    assert.equal(runProductionStart({
      argv: ['--start'], environment: invalid, spawn: invoke,
    }).status, 'invalid_configuration');
  }
  assert.equal(calls.length, 1);
});

test('production start reports held-lock and two-start contention before Compose races', () => {
  const environment = {
    ...DEPLOYMENT_PATHS,
    CANNABEATS_CADDY_IMAGE: digest('caddy', 'a'),
    CANNABEATS_WEB_IMAGE: digest('cannabeats/web', 'b'),
    CANNABEATS_RELAY_IMAGE: digest('cannabeats/relay', 'c'),
  };
  assert.deepEqual(runProductionStart({
    argv: ['--start'], environment, spawn: () => ({ status: 75 }),
  }), { status: 'busy' });

  let nested;
  const holdingSpawn = () => {
    nested = runProductionStart({
      argv: ['--start'],
      environment: { ...environment, CANNABEATS_WEB_IMAGE: digest('cannabeats/web', 'd') },
      spawn: () => ({ status: 75 }),
    });
    return { status: 0 };
  };
  assert.deepEqual(runProductionStart({
    argv: ['--start'], environment, spawn: holdingSpawn,
  }), { status: 'ready' });
  assert.deepEqual(nested, { status: 'busy' });
  assert.match(initializerText,
    /exec 9>"\$lock_directory"\n  flock --nonblock 9 \|\| finite_fail busy/u);
  assert.doesNotMatch(initializerText, /OPERATIONS_LOCK_HELD/u);
});

test('proxy limits ordinary bodies and redacts request identity without bounding audio stream duration', () => {
  assert.match(caddy,
    /@ordinary `!path_regexp\('\^\/api\/games\/[\s\S]*\/audio\/sessions\/[\s\S]*\/ingest\$'\)`/u);
  assert.match(caddy, /request_body @ordinary[\s\S]*max_size 1MB/u);
  assert.match(caddy, /request>uri delete/u);
  assert.match(caddy, /request>headers delete/u);
  assert.match(caddy, /read_header 5s/u);
  assert.doesNotMatch(caddy, /read_body|write_timeout/u);
  assert.match(caddy,
    /@retired path \/api\/audio-source \/api\/audio-stream \/api\/diagnostics\/\* \/api\/game \/desktop/u);
  assert.match(caddy, /respond @retired `\{"code":"not_found"\}` 404/u);
  const patternText = /@ordinary `!path_regexp\('([^']+)'\)`/u.exec(caddy)?.[1];
  assert.equal(typeof patternText, 'string');
  const ingest = new RegExp(patternText, 'u');
  const game = '12345678-1234-4234-8234-123456789abc';
  const session = 'abcdefab-cdef-4abc-8def-abcdefabcdef';
  assert.equal(ingest.test(`/api/games/${game}/audio/sessions/${session}/ingest`), true);
  for (const path of [
    '/api/audio/ingest',
    `/api/games/${game}/audio/sessions/not-a-uuid/ingest`,
    `/api/games/${game}/audio/sessions/${session}/ingest/extra`,
    `/api/games/${game}/audio/sessions/${session}/listen`,
  ]) assert.equal(ingest.test(path), false, path);
});

test('host initialization creates distinct private tokens and exact replay preserves them', () => {
  const root = mkdtempSync(join(tmpdir(), 'cannabeats-fr81-'));
  try {
    const environment = { ...process.env, CANNABEATS_INSTALL_ROOT: root };
    const first = execFileSync('bash', [initializer], { encoding: 'utf8', env: environment });
    assert.equal(first, 'host_initialization_ready\n');
    const secretDirectory = join(root, 'etc/cannabeats/secrets');
    const ingestPath = join(secretDirectory, 'relay-ingest-token');
    const listenPath = join(secretDirectory, 'relay-listen-token');
    const ingest = readFileSync(ingestPath, 'utf8');
    const listen = readFileSync(listenPath, 'utf8');
    assert.match(ingest, /^[A-Za-z0-9_-]{43}$/u);
    assert.match(listen, /^[A-Za-z0-9_-]{43}$/u);
    assert.notEqual(ingest, listen);
    assert.equal(statSync(ingestPath).mode & 0o777, 0o640);
    assert.equal(statSync(listenPath).mode & 0o777, 0o640);
    assert.equal(statSync(ingestPath).uid, process.getuid());
    assert.equal(statSync(ingestPath).gid, process.getgid());
    execFileSync('bash', [initializer], { env: environment });
    assert.equal(readFileSync(ingestPath, 'utf8'), ingest);
    assert.equal(readFileSync(listenPath, 'utf8'), listen);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('host initialization rejects wrong ownership, symlinked paths, and a held lock', () => {
  const root = mkdtempSync(join(tmpdir(), 'cannabeats-fr81-boundary-'));
  const environment = { ...process.env, CANNABEATS_INSTALL_ROOT: root };
  try {
    execFileSync('bash', [initializer], { env: environment });
    const ingest = join(root, 'etc/cannabeats/secrets/relay-ingest-token');
    const alternateGroup = process.getgroups().find((group) => group !== process.getgid());
    if (alternateGroup !== undefined) {
      chownSync(ingest, process.getuid(), alternateGroup);
      let result = spawnSync('bash', [initializer], { encoding: 'utf8', env: environment });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /host_initialization_secret_conflict/u);
      chownSync(ingest, process.getuid(), process.getgid());
    }

    const lock = join(root, 'run/lock/cannabeats-operations.lock');
    mkdirSync(lock, { mode: 0o700 });
    let result = spawnSync('bash', [initializer], { encoding: 'utf8', env: environment });
    assert.equal(result.status, 1);
    assert.equal(result.stderr, 'host_initialization_busy\n');
    rmSync(lock, { recursive: true });

    const caddyRoot = join(root, 'var/lib/cannabeats-caddy');
    rmSync(caddyRoot, { recursive: true });
    // The target is harmless and remains inside this disposable root.
    const target = join(root, 'caddy-target');
    mkdirSync(target);
    execFileSync('ln', ['-s', target, caddyRoot]);
    result = spawnSync('bash', [initializer], { encoding: 'utf8', env: environment });
    assert.equal(result.status, 1);
    assert.equal(result.stderr, 'host_initialization_path_conflict\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('concurrent initialization publishes one pair and leaves no temporary secret', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cannabeats-fr81-concurrent-'));
  const environment = { ...process.env, CANNABEATS_INSTALL_ROOT: root };
  try {
    const results = await Promise.all(Array.from({ length: 8 }, () => new Promise((resolve) => {
      const child = spawn('bash', [initializer], { env: environment });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (value) => { stdout += value; });
      child.stderr.on('data', (value) => { stderr += value; });
      child.on('close', (status) => resolve({ status, stdout, stderr }));
    })));
    assert.equal(results.some(({ status }) => status === 0), true);
    assert.equal(results.every(({ status, stderr }) => status === 0
      || (status === 1 && stderr === 'host_initialization_busy\n')), true);
    const secrets = join(root, 'etc/cannabeats/secrets');
    assert.deepEqual(readdirSync(secrets).sort(), ['relay-ingest-token', 'relay-listen-token']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('host initialization fails closed on retained secret or path conflict', () => {
  for (const mutate of ['secret', 'path']) {
    const root = mkdtempSync(join(tmpdir(), 'cannabeats-fr81-conflict-'));
    try {
      execFileSync('bash', [initializer], {
        env: { ...process.env, CANNABEATS_INSTALL_ROOT: root },
      });
      if (mutate === 'secret') {
        writeFileSync(join(root, 'etc/cannabeats/secrets/relay-ingest-token'), 'malformed');
      } else {
        rmSync(join(root, 'var/backups/cannabeats/sqlite'), { recursive: true });
        writeFileSync(join(root, 'var/backups/cannabeats/sqlite'), 'conflict');
      }
      const result = spawnSync('bash', [initializer], {
        encoding: 'utf8', env: { ...process.env, CANNABEATS_INSTALL_ROOT: root },
      });
      assert.equal(result.status, 1);
      assert.match(result.stderr, new RegExp(
        mutate === 'secret' ? 'host_initialization_secret_conflict' : 'host_initialization_path_conflict',
        'u',
      ));
      assert.doesNotMatch(result.stderr, /malformed|cannabeats-fr81-conflict-/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});
