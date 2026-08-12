import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { promisify } from 'node:util';
import { adoptLegacyState, bootstrapState } from '../operations/release-state.mjs';

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
if [ -n "\${CANNABEATS_TEST_DOCKER_FAIL_MATCH:-}" ]; then
  case "$*" in *"$CANNABEATS_TEST_DOCKER_FAIL_MATCH"*) exit 42 ;; esac
fi
if [ -n "\${CANNABEATS_TEST_DOCKER_FAIL_ONCE_MATCH:-}" ] && [ ! -e "$CANNABEATS_TEST_FAILURE_MARKER" ]; then
  case "$*" in
    *"$CANNABEATS_TEST_DOCKER_FAIL_ONCE_MATCH"*) touch "$CANNABEATS_TEST_FAILURE_MARKER"; exit 42 ;;
  esac
fi
case "$*" in
  *"PRAGMA user_version"*)
    if [ -n "\${CANNABEATS_TEST_SCHEMA_SEQUENCE_FILE:-}" ] && [ -s "$CANNABEATS_TEST_SCHEMA_SEQUENCE_FILE" ]; then
      schema_version="$(sed -n '1p' "$CANNABEATS_TEST_SCHEMA_SEQUENCE_FILE")"
      sed '1d' "$CANNABEATS_TEST_SCHEMA_SEQUENCE_FILE" > "$CANNABEATS_TEST_SCHEMA_SEQUENCE_FILE.next"
      mv "$CANNABEATS_TEST_SCHEMA_SEQUENCE_FILE.next" "$CANNABEATS_TEST_SCHEMA_SEQUENCE_FILE"
      printf '%s\\n' "$schema_version"
    else
      printf '%s\\n' "\${CANNABEATS_TEST_SCHEMA_VERSION:-1}"
    fi
    ;;
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
  writeFileSync(join(binaries, 'node'), `#!/bin/sh
if [ -n "\${CANNABEATS_TEST_NODE_FAIL_MATCH:-}" ]; then
  case "$*" in *"$CANNABEATS_TEST_NODE_FAIL_MATCH"*) exit 42 ;; esac
fi
exec "${process.execPath}" "$@"
`);
  writeFileSync(join(binaries, 'curl'), `#!/bin/sh
printf 'curl %s\\n' "$*" >> "$CANNABEATS_TEST_COMMAND_LOG"
if [ "\${CANNABEATS_TEST_CURL_FAIL:-}" = 1 ]; then exit 22; fi
`);
  writeFileSync(join(binaries, 'sleep'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(binaries, 'docker'), 0o755);
  chmodSync(join(binaries, 'curl'), 0o755);
  chmodSync(join(binaries, 'npm'), 0o755);
  chmodSync(join(binaries, 'node'), 0o755);
  chmodSync(join(binaries, 'sleep'), 0o755);
  return {
    directory,
    composeDirectory,
    releaseDirectory,
    commandLog,
    env: {
      ...process.env,
      PATH: `${binaries}:${process.env.PATH}`,
      CANNABEATS_COMPOSE_DIR: composeDirectory,
      CANNABEATS_RELEASE_DIR: releaseDirectory,
      CANNABEATS_TEST_COMMAND_LOG: commandLog,
      CANNABEATS_TEST_FAILURE_MARKER: join(directory, 'docker-failure-used'),
      CANNABEATS_TEST_SCHEMA_SEQUENCE_FILE: join(directory, 'schema-sequence'),
      CANNABEATS_BOOTSTRAP_SCHEMA_MIN_VERSION: '0',
      CANNABEATS_BOOTSTRAP_SCHEMA_MAX_VERSION: '1',
      CANNABEATS_BOOTSTRAP_SCHEMA_TARGET_VERSION: '0',
      CANNABEATS_WEB_DIR: resolve('../../web'),
    },
  };
}

function promotionRelease(paths) {
  const project = join(paths.directory, 'promotion-project');
  const deploy = join(project, 'deploy');
  const operations = join(project, 'operations');
  mkdirSync(deploy, { recursive: true });
  mkdirSync(operations, { recursive: true });
  for (const file of ['release.sh', 'release-common.sh']) {
    writeFileSync(join(deploy, file), readFileSync(resolve('deploy', file)));
  }
  writeFileSync(join(deploy, 'schema-compatibility.env'), [
    'CANNABEATS_SCHEMA_MIN_VERSION=0',
    'CANNABEATS_SCHEMA_MAX_VERSION=2',
    'CANNABEATS_SCHEMA_TARGET_VERSION=2',
    '',
  ].join('\n'));
  writeFileSync(
    join(operations, 'release-state.mjs'),
    readFileSync(resolve('operations/release-state.mjs')),
  );
  chmodSync(join(deploy, 'release.sh'), 0o755);
  return join(deploy, 'release.sh');
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
  const schemaChecks = log.map((line, index) => [line, index])
    .filter(([line]) => line.includes('PRAGMA user_version'))
    .map(([, index]) => index);
  assert.ok(schemaChecks[0] < backup);
  assert.ok(schemaChecks.some((index) => index > build));
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

test('release rejects a database schema newer than the candidate before build or replacement', async () => {
  const paths = fixture();
  await assert.rejects(
    run(resolve('deploy/release.sh'), ['release-a1', catalogVersion], {
      env: { ...paths.env, CANNABEATS_TEST_SCHEMA_VERSION: '3' },
    }),
    (error) => /schema version 3.*candidate/i.test(error.stderr),
  );
  const commands = readFileSync(paths.commandLog, 'utf8');
  assert.doesNotMatch(commands, /build app game| up /);
});

test('release preserves a newer supported schema instead of requiring a downgrade to target', async () => {
  const paths = fixture();
  const release = resolve('deploy/release.sh');
  await run(release, ['release-a1', catalogVersion], { env: paths.env });
  await run(release, ['release-b2', catalogVersion], {
    env: { ...paths.env, CANNABEATS_TEST_SCHEMA_VERSION: '2' },
  });
  assert.match(readFileSync(join(paths.releaseDirectory, 'current-compose.yaml'), 'utf8'), /release-b2/);
});

test('a failed schema promotion leaves the bridge as rollback floor and blocks the Slice 1 image', async () => {
  const paths = fixture();
  const bridgeRelease = resolve('deploy/release.sh');
  await run(bridgeRelease, ['bridge-a1', catalogVersion], { env: paths.env });

  writeFileSync(paths.env.CANNABEATS_TEST_SCHEMA_SEQUENCE_FILE, '1\n2\n');
  await assert.rejects(
    run(promotionRelease(paths), ['promote-b2', catalogVersion], {
      env: { ...paths.env, CANNABEATS_TEST_NODE_FAIL_MATCH: 'release-state.mjs promote' },
    }),
    (error) => /restoring the exact previous application images/i.test(error.stderr),
  );

  assert.match(readFileSync(join(paths.releaseDirectory, 'current-compose.yaml'), 'utf8'), /bridge-a1/);
  assert.match(readFileSync(join(paths.releaseDirectory, 'previous-compose.yaml'), 'utf8'), /bootstrap-a/);
  assert.doesNotMatch(
    readFileSync(join(paths.releaseDirectory, 'used-application-versions'), 'utf8'),
    /promote-b2/,
  );
  const beforeRollback = readFileSync(paths.commandLog, 'utf8')
    .split('\n').filter((line) => line.includes(' up ')).length;

  await assert.rejects(
    run(resolve('deploy/rollback-release.sh'), [], {
      env: { ...paths.env, CANNABEATS_TEST_SCHEMA_VERSION: '2' },
    }),
    (error) => /schema version 2 is not supported by previous range 0-1/i.test(error.stderr),
  );
  const afterRollback = readFileSync(paths.commandLog, 'utf8')
    .split('\n').filter((line) => line.includes(' up ')).length;
  assert.equal(afterRollback, beforeRollback);
  assert.match(readFileSync(join(paths.releaseDirectory, 'current-compose.yaml'), 'utf8'), /bridge-a1/);
});

test('release rejects a migration target that the current application could not roll back from', async () => {
  const paths = fixture();
  await assert.rejects(
    run(resolve('deploy/release.sh'), ['release-a1', catalogVersion], {
      env: {
        ...paths.env,
        CANNABEATS_TEST_SCHEMA_VERSION: '0',
        CANNABEATS_BOOTSTRAP_SCHEMA_MAX_VERSION: '0',
      },
    }),
    (error) => /schema target 1 cannot be rolled back to current range 0-0/i.test(error.stderr),
  );
  assert.doesNotMatch(readFileSync(paths.commandLog, 'utf8'), /build app game| up /);
});

test('release refuses to start while another release or rollback owns the host lock', async () => {
  const paths = fixture();
  mkdirSync(join(paths.releaseDirectory, 'operation.lock'), { recursive: true });
  await assert.rejects(
    run(resolve('deploy/release.sh'), ['release-a1', catalogVersion], { env: paths.env }),
    (error) => /another CannaBeats release or rollback is active/i.test(error.stderr),
  );
  assert.equal(readFileSync(paths.commandLog, 'utf8'), '');
  assert.equal(existsSync(join(paths.releaseDirectory, 'operation.lock')), true);
});

test('build interruption preserves the bootstrap state without recording the candidate', async () => {
  const paths = fixture();
  await assert.rejects(
    run(resolve('deploy/release.sh'), ['release-a1', catalogVersion], {
      env: { ...paths.env, CANNABEATS_TEST_DOCKER_FAIL_MATCH: 'build app game' },
    }),
  );
  assert.match(readFileSync(join(paths.releaseDirectory, 'current-compose.yaml'), 'utf8'), /bootstrap-a/);
  assert.equal(existsSync(join(paths.releaseDirectory, 'previous-compose.yaml')), false);
  assert.equal(existsSync(join(paths.releaseDirectory, 'used-application-versions')), false);
});

test('container-start interruption restores current images without advancing release state', async () => {
  const paths = fixture();
  await assert.rejects(
    run(resolve('deploy/release.sh'), ['release-a1', catalogVersion], {
      env: { ...paths.env, CANNABEATS_TEST_DOCKER_FAIL_ONCE_MATCH: 'up -d --no-deps app game' },
    }),
    (error) => /restoring the exact previous application images/i.test(error.stderr),
  );
  assert.match(readFileSync(join(paths.releaseDirectory, 'current-compose.yaml'), 'utf8'), /bootstrap-a/);
  assert.equal(existsSync(join(paths.releaseDirectory, 'used-application-versions')), false);
  const upCommands = readFileSync(paths.commandLog, 'utf8').split('\n').filter((line) => line.includes(' up '));
  assert.match(upCommands.at(-1), /current-compose\.yaml up -d --no-deps app game$/);
});

test('an interrupted state promotion preserves the complete prior release state', async () => {
  const paths = fixture();
  const release = resolve('deploy/release.sh');
  await run(release, ['release-a1', catalogVersion], { env: paths.env });
  await run(release, ['release-b2', catalogVersion], { env: paths.env });
  await assert.rejects(
    run(release, ['release-c3', catalogVersion], {
      env: { ...paths.env, CANNABEATS_TEST_STATE_FAIL: 'before-switch' },
    }),
    (error) => /injected release-state failure/i.test(error.stderr),
  );
  assert.match(readFileSync(join(paths.releaseDirectory, 'current-compose.yaml'), 'utf8'), /release-b2/);
  assert.match(readFileSync(join(paths.releaseDirectory, 'previous-compose.yaml'), 'utf8'), /release-a1/);
  assert.doesNotMatch(readFileSync(join(paths.releaseDirectory, 'used-application-versions'), 'utf8'), /release-c3/);
});

test('a failure after the active-link rename restores durable prior release state', async () => {
  const paths = fixture();
  const release = resolve('deploy/release.sh');
  await run(release, ['release-a1', catalogVersion], { env: paths.env });
  await run(release, ['release-b2', catalogVersion], { env: paths.env });
  await assert.rejects(
    run(release, ['release-c3', catalogVersion], {
      env: { ...paths.env, CANNABEATS_TEST_STATE_FAIL: 'after-rename' },
    }),
    (error) => /injected release-state failure after-rename/i.test(error.stderr),
  );
  assert.match(readFileSync(join(paths.releaseDirectory, 'current-compose.yaml'), 'utf8'), /release-b2/);
  assert.match(readFileSync(join(paths.releaseDirectory, 'previous-compose.yaml'), 'utf8'), /release-a1/);
  assert.doesNotMatch(readFileSync(join(paths.releaseDirectory, 'used-application-versions'), 'utf8'), /release-c3/);
});

test('bootstrap and legacy adoption roll back completely when their first active switch fails', () => {
  for (const operation of ['bootstrap', 'adopt']) {
    const directory = mkdtempSync(join(root, `${operation}-atomic-`));
    const candidate = join(directory, 'candidate.yaml');
    writeFileSync(candidate, 'services: {}\n');
    process.env.CANNABEATS_TEST_STATE_FAIL = 'after-rename';
    try {
      assert.throws(
        () => operation === 'bootstrap'
          ? bootstrapState({ releaseDirectory: directory, candidate })
          : adoptLegacyState({ releaseDirectory: directory, currentSource: candidate }),
        /after-rename/,
      );
    } finally {
      delete process.env.CANNABEATS_TEST_STATE_FAIL;
    }
    assert.equal(existsSync(join(directory, 'active')), false, `${operation} left an active link`);
    assert.deepEqual(readdirSync(join(directory, 'states')), [], `${operation} leaked a candidate state`);
    assert.equal(existsSync(join(directory, 'current-compose.yaml')), false);
  }
});

test('legacy adoption cleans up a state created before an interrupted switch', () => {
  const directory = mkdtempSync(join(root, 'adopt-before-switch-'));
  const candidate = join(directory, 'candidate.yaml');
  writeFileSync(candidate, 'services: {}\n');
  process.env.CANNABEATS_TEST_STATE_FAIL = 'before-switch';
  try {
    assert.throws(
      () => adoptLegacyState({ releaseDirectory: directory, currentSource: candidate }),
      /before-switch/,
    );
  } finally {
    delete process.env.CANNABEATS_TEST_STATE_FAIL;
  }
  assert.deepEqual(readdirSync(join(directory, 'states')), []);
});

test('stable-link failures after bootstrap or adoption preserve an active target that retry can heal', () => {
  for (const mode of ['bootstrap', 'adopt']) {
    const directory = mkdtempSync(join(root, `${mode}-stable-link-failure-`));
    const candidate = join(directory, 'candidate.yaml');
    writeFileSync(candidate, 'services: {}\n');
    mkdirSync(join(directory, 'current-compose.yaml'));
    assert.throws(
      () => mode === 'bootstrap'
        ? bootstrapState({ releaseDirectory: directory, candidate })
        : adoptLegacyState({ releaseDirectory: directory, currentSource: candidate }),
      /directory|EISDIR/i,
    );
    const activeTarget = readlinkSync(join(directory, 'active'));
    assert.equal(existsSync(join(directory, activeTarget)), true, `${mode} deleted its active target`);
    rmSync(join(directory, 'current-compose.yaml'), { recursive: true });
    adoptLegacyState({ releaseDirectory: directory, currentSource: candidate });
    assert.equal(readFileSync(join(directory, 'current-compose.yaml'), 'utf8'), 'services: {}\n');
  }
});

test('the first P2 release atomically adopts legacy P1 records and their used identities', async () => {
  const paths = fixture();
  mkdirSync(paths.releaseDirectory);
  writeFileSync(join(paths.releaseDirectory, 'current-compose.yaml'), `services:
  app:
    image: sha256:${'6'.repeat(64)}
    environment:
      CANNABEATS_APP_VERSION: "legacy-current"
  game:
    image: sha256:${'7'.repeat(64)}
`);
  writeFileSync(join(paths.releaseDirectory, 'previous-compose.yaml'), `services:
  app:
    image: sha256:${'8'.repeat(64)}
    environment:
      CANNABEATS_APP_VERSION: "legacy-previous"
  game:
    image: sha256:${'9'.repeat(64)}
`);
  writeFileSync(join(paths.releaseDirectory, 'used-application-versions'), 'legacy-current\n');

  await run(resolve('deploy/release.sh'), ['release-a1', catalogVersion], { env: paths.env });
  assert.match(readFileSync(join(paths.releaseDirectory, 'current-compose.yaml'), 'utf8'), /release-a1/);
  const previous = readFileSync(join(paths.releaseDirectory, 'previous-compose.yaml'), 'utf8');
  assert.match(previous, /legacy-current/);
  assert.match(previous, /schema-min-version: 0/);
  assert.deepEqual(
    readFileSync(join(paths.releaseDirectory, 'used-application-versions'), 'utf8').trim().split('\n'),
    ['legacy-current', 'release-a1'],
  );
});

test('the first P2 rollback can adopt and safely swap legacy P1 records', async () => {
  const paths = fixture();
  mkdirSync(paths.releaseDirectory);
  writeFileSync(join(paths.releaseDirectory, 'current-compose.yaml'), `services:
  app:
    image: sha256:${'6'.repeat(64)}
    environment:
      CANNABEATS_APP_VERSION: "legacy-current"
  game:
    image: sha256:${'7'.repeat(64)}
`);
  writeFileSync(join(paths.releaseDirectory, 'previous-compose.yaml'), `services:
  app:
    image: sha256:${'8'.repeat(64)}
    environment:
      CANNABEATS_APP_VERSION: "legacy-previous"
  game:
    image: sha256:${'9'.repeat(64)}
`);

  await run(resolve('deploy/rollback-release.sh'), [], { env: paths.env });
  assert.match(readFileSync(join(paths.releaseDirectory, 'current-compose.yaml'), 'utf8'), /legacy-previous/);
  assert.match(readFileSync(join(paths.releaseDirectory, 'previous-compose.yaml'), 'utf8'), /legacy-current/);
});

test('rollback rejects an incompatible previous schema before replacing containers', async () => {
  const paths = fixture();
  const release = resolve('deploy/release.sh');
  await run(release, ['release-a1', catalogVersion], { env: paths.env });
  await run(release, ['release-b2', catalogVersion], { env: paths.env });
  const previousPath = join(paths.releaseDirectory, 'previous-compose.yaml');
  const incompatible = readFileSync(previousPath, 'utf8')
    .replace('schema-max-version: 2', 'schema-max-version: 0')
    .replace('schema-target-version: 1', 'schema-target-version: 0');
  writeFileSync(previousPath, incompatible);
  const upBefore = readFileSync(paths.commandLog, 'utf8').split('\n').filter((line) => line.includes(' up ')).length;
  await assert.rejects(
    run(resolve('deploy/rollback-release.sh'), [], { env: paths.env }),
    (error) => /schema version 1 is not supported by previous range 0-0/i.test(error.stderr),
  );
  const upAfter = readFileSync(paths.commandLog, 'utf8').split('\n').filter((line) => line.includes(' up ')).length;
  assert.equal(upAfter, upBefore);
  assert.match(readFileSync(join(paths.releaseDirectory, 'current-compose.yaml'), 'utf8'), /release-b2/);
});

test('an interrupted rollback state switch restores current containers and preserves records', async () => {
  const paths = fixture();
  const release = resolve('deploy/release.sh');
  await run(release, ['release-a1', catalogVersion], { env: paths.env });
  await run(release, ['release-b2', catalogVersion], { env: paths.env });
  await assert.rejects(
    run(resolve('deploy/rollback-release.sh'), [], {
      env: { ...paths.env, CANNABEATS_TEST_STATE_FAIL: 'before-switch' },
    }),
    (error) => /injected release-state failure/i.test(error.stderr),
  );
  assert.match(readFileSync(join(paths.releaseDirectory, 'current-compose.yaml'), 'utf8'), /release-b2/);
  assert.match(readFileSync(join(paths.releaseDirectory, 'previous-compose.yaml'), 'utf8'), /release-a1/);
  const upCommands = readFileSync(paths.commandLog, 'utf8').split('\n').filter((line) => line.includes(' up '));
  assert.match(upCommands.at(-1), /current-compose\.yaml up -d --no-deps app game$/);
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
