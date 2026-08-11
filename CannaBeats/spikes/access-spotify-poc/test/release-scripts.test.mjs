import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = mkdtempSync(join(tmpdir(), 'cannabeats-release-test-'));
const catalogVersion = JSON.parse(readFileSync(resolve('../../web/data/catalog-manifest.json'), 'utf8')).catalogVersion;
after(() => rmSync(root, { recursive: true, force: true }));

function fixture() {
  const directory = mkdtempSync(join(root, 'case-'));
  const composeDirectory = join(directory, 'compose');
  const releaseDirectory = join(directory, 'releases');
  const binaries = join(directory, 'bin');
  const commandLog = join(directory, 'commands.log');
  mkdirSync(composeDirectory);
  mkdirSync(binaries);
  writeFileSync(commandLog, '');
  writeFileSync(join(composeDirectory, 'compose.yaml'), 'services: {}\n');
  writeFileSync(join(binaries, 'docker'), `#!/bin/sh
printf 'docker %s\\n' "$*" >> "$CANNABEATS_TEST_COMMAND_LOG"
case "$*" in
  *"image inspect"*"cannabeats/access-spotify-poc:"*) printf 'sha256:%064d\\n' 1 ;;
  *"image inspect"*"cannabeats/game:"*) printf 'sha256:%064d\\n' 2 ;;
  *"inspect"*"{{.Image}}"*"cannabeats-access-poc"*) printf 'sha256:%064d\\n' 3 ;;
  *"inspect"*"{{.Image}}"*"cannabeats-game"*) printf 'sha256:%064d\\n' 4 ;;
  *"inspect"*"Config.Env"*"cannabeats-access-poc"*)
    printf 'CANNABEATS_APP_VERSION=bootstrap-a\\nCANNABEATS_CATALOG_VERSION=sha256:%064d\\n' 5 ;;
  *"inspect"*"Config.Env"*"cannabeats-game"*)
    printf 'CANNABEATS_APP_VERSION=bootstrap-a\\nCANNABEATS_CATALOG_VERSION=sha256:%064d\\n' 5 ;;
esac
`);
  writeFileSync(join(binaries, 'npm'), '#!/bin/sh\nprintf \'npm %s\\n\' "$*" >> "$CANNABEATS_TEST_COMMAND_LOG"\n');
  writeFileSync(join(binaries, 'curl'), `#!/bin/sh
printf 'curl %s\\n' "$*" >> "$CANNABEATS_TEST_COMMAND_LOG"
if [ "\${CANNABEATS_TEST_CURL_FAIL:-}" = 1 ]; then exit 22; fi
`);
  writeFileSync(join(binaries, 'sleep'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(binaries, 'docker'), 0o755);
  chmodSync(join(binaries, 'curl'), 0o755);
  chmodSync(join(binaries, 'npm'), 0o755);
  chmodSync(join(binaries, 'sleep'), 0o755);
  return {
    composeDirectory,
    releaseDirectory,
    commandLog,
    env: {
      ...process.env,
      PATH: `${binaries}:${process.env.PATH}`,
      CANNABEATS_COMPOSE_DIR: composeDirectory,
      CANNABEATS_RELEASE_DIR: releaseDirectory,
      CANNABEATS_TEST_COMMAND_LOG: commandLog,
      CANNABEATS_WEB_DIR: resolve('../../web'),
    },
  };
}

test('release backs up first and operates only the CannaBeats app/game boundary', async () => {
  const paths = fixture();
  const release = resolve('deploy/release.sh');
  await run(release, ['release-a1', catalogVersion], { env: paths.env });
  await run(release, ['release-b2', catalogVersion], { env: paths.env });
  const log = readFileSync(paths.commandLog, 'utf8').trim().split('\n');
  const backup = log.findIndex((line) => line.includes('--profile operations run --rm backup run'));
  const catalogCheck = log.findIndex((line) => line.includes('npm --prefix') && line.includes('catalog:check'));
  const build = log.findIndex((line) => line.includes('build app game'));
  assert.ok(backup >= 0 && build > backup);
  assert.ok(catalogCheck >= 0 && build > catalogCheck);
  for (const line of log.filter((entry) => entry.includes(' up '))) {
    assert.match(line, /up -d --no-deps app game$/);
  }
  assert.doesNotMatch(log.join('\n'), /vw-services/);
  assert.match(readFileSync(join(paths.releaseDirectory, 'current-compose.yaml'), 'utf8'), /release-b2/);
  assert.match(readFileSync(join(paths.releaseDirectory, 'previous-compose.yaml'), 'utf8'), /release-a1/);
});

test('rollback checks the previous release before swapping release records', async () => {
  const paths = fixture();
  const release = resolve('deploy/release.sh');
  await run(release, ['release-a1', catalogVersion], { env: paths.env });
  await run(release, ['release-b2', catalogVersion], { env: paths.env });
  await run(resolve('deploy/rollback-release.sh'), [], { env: paths.env });
  assert.match(readFileSync(join(paths.releaseDirectory, 'current-compose.yaml'), 'utf8'), /release-a1/);
  assert.match(readFileSync(join(paths.releaseDirectory, 'previous-compose.yaml'), 'utf8'), /release-b2/);
});

test('a named release cannot be reused after it has been recorded', async () => {
  const paths = fixture();
  const release = resolve('deploy/release.sh');
  await run(release, ['release-a1', catalogVersion], { env: paths.env });
  await assert.rejects(
    run(release, ['release-a1', catalogVersion], { env: paths.env }),
    (error) => /already exists|already recorded|immutable/i.test(error.stderr),
  );
});

test('release records pin exact image IDs instead of mutable tags', async () => {
  const paths = fixture();
  await run(resolve('deploy/release.sh'), ['release-a1', catalogVersion], { env: paths.env });
  const current = readFileSync(join(paths.releaseDirectory, 'current-compose.yaml'), 'utf8');
  assert.match(current, /image: sha256:[0-9a-f]{64}/);
  assert.doesNotMatch(current, /image: cannabeats\//);
});

test('a failed first managed release restores the exact bootstrap images', async () => {
  const paths = fixture();
  await assert.rejects(
    run(resolve('deploy/release.sh'), ['release-a1', catalogVersion], {
      env: { ...paths.env, CANNABEATS_TEST_CURL_FAIL: '1' },
    }),
    (error) => /restoring the exact previous application images/i.test(error.stderr),
  );
  const current = readFileSync(join(paths.releaseDirectory, 'current-compose.yaml'), 'utf8');
  assert.match(current, /image: sha256:0+3/);
  assert.match(current, /image: sha256:0+4/);
  assert.match(current, /CANNABEATS_APP_VERSION: "bootstrap-a"/);
  const upCommands = readFileSync(paths.commandLog, 'utf8').split('\n').filter((line) => line.includes(' up '));
  assert.match(upCommands.at(-1), /current-compose\.yaml up -d --no-deps app game$/);
  assert.throws(() => readFileSync(join(paths.releaseDirectory, 'used-application-versions')), /ENOENT/);
});

test('release rejects a catalog identity that does not match the checked-in manifest', async () => {
  const paths = fixture();
  await assert.rejects(
    run(resolve('deploy/release.sh'), ['release-a1', `sha256:${'f'.repeat(64)}`], { env: paths.env }),
    (error) => /does not match the checked-in manifest/i.test(error.stderr),
  );
  assert.equal(readFileSync(paths.commandLog, 'utf8'), '');
});

test('checked-in deployment files keep secrets out of build context and resolve the game build', () => {
  const compose = readFileSync(resolve('compose.yaml'), 'utf8');
  const environment = readFileSync(resolve('.env.example'), 'utf8');
  const dockerignore = readFileSync(resolve('.dockerignore'), 'utf8');
  const rootDockerignore = readFileSync(resolve('../../.dockerignore'), 'utf8');
  const gameDockerfile = readFileSync(resolve('../../web/Dockerfile'), 'utf8');
  assert.match(compose, /context:.*\.\.\/\.\./);
  assert.match(compose, /dockerfile:\s*web\/Dockerfile/);
  assert.doesNotMatch(environment, /CANNABEATS_GAME_CONTEXT=\.\/game/);
  assert.match(dockerignore, /(^|\n)secrets(\/|\n|$)/);
  assert.match(dockerignore, /(^|\n)backups(\/|\n|$)/);
  assert.match(rootDockerignore, /\*\*\/secrets/);
  assert.match(rootDockerignore, /\*\*\/backups/);
  assert.doesNotMatch(rootDockerignore, /^\*\*\/data$/m);
  assert.match(gameDockerfile, /COPY catalog\/ \/app\/catalog\//);
  assert.match(gameDockerfile, /RUN npm run catalog:check && npm run build:do/);
});

test('the restore rehearsal definition cannot bind live container names, ports, or volume', () => {
  const rehearsal = readFileSync(resolve('deploy/restore-rehearsal.compose.yaml'), 'utf8');
  assert.doesNotMatch(rehearsal, /container_name:/);
  assert.doesNotMatch(rehearsal, /cannabeats_poc_data/);
  assert.doesNotMatch(rehearsal, /127\.0\.0\.1:300[23]:/);
  assert.match(rehearsal, /CANNABEATS_REHEARSAL_DATA_DIR/);
});
