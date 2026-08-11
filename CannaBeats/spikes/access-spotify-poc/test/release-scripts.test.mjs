import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = mkdtempSync(join(tmpdir(), 'cannabeats-release-test-'));
after(() => rmSync(root, { recursive: true, force: true }));

function fixture() {
  const directory = mkdtempSync(join(root, 'case-'));
  const composeDirectory = join(directory, 'compose');
  const releaseDirectory = join(directory, 'releases');
  const binaries = join(directory, 'bin');
  const commandLog = join(directory, 'commands.log');
  mkdirSync(composeDirectory);
  mkdirSync(binaries);
  writeFileSync(join(composeDirectory, 'compose.yaml'), 'services: {}\n');
  writeFileSync(join(binaries, 'docker'), '#!/bin/sh\nprintf \'docker %s\\n\' "$*" >> "$CANNABEATS_TEST_COMMAND_LOG"\n');
  writeFileSync(join(binaries, 'curl'), '#!/bin/sh\nprintf \'curl %s\\n\' "$*" >> "$CANNABEATS_TEST_COMMAND_LOG"\n');
  chmodSync(join(binaries, 'docker'), 0o755);
  chmodSync(join(binaries, 'curl'), 0o755);
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
    },
  };
}

test('release backs up first and operates only the CannaBeats app/game boundary', async () => {
  const paths = fixture();
  const release = resolve('deploy/release.sh');
  const catalogA = `sha256:${'a'.repeat(64)}`;
  const catalogB = `sha256:${'b'.repeat(64)}`;
  await run(release, ['release-a1', catalogA], { env: paths.env });
  await run(release, ['release-b2', catalogB], { env: paths.env });
  const log = readFileSync(paths.commandLog, 'utf8').trim().split('\n');
  const backup = log.findIndex((line) => line.includes('--profile operations run --rm backup run'));
  const build = log.findIndex((line) => line.includes('build app game'));
  assert.ok(backup >= 0 && build > backup);
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
  await run(release, ['release-a1', `sha256:${'a'.repeat(64)}`], { env: paths.env });
  await run(release, ['release-b2', `sha256:${'b'.repeat(64)}`], { env: paths.env });
  await run(resolve('deploy/rollback-release.sh'), [], { env: paths.env });
  assert.match(readFileSync(join(paths.releaseDirectory, 'current-compose.yaml'), 'utf8'), /release-a1/);
  assert.match(readFileSync(join(paths.releaseDirectory, 'previous-compose.yaml'), 'utf8'), /release-b2/);
});
