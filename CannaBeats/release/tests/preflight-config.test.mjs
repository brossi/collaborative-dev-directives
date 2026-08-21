import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  RELEASE_CONFIG,
  parseReleaseConfig,
  runPreflight,
  validateReleaseConfig,
} from '../scripts/preflight-config.mjs';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const examplePath = join(testDirectory, '..', 'config', 'production.env.example');
const scriptPath = join(testDirectory, '..', 'scripts', 'preflight-config.mjs');
const example = readFileSync(examplePath, 'utf8');

test('the committed production example enumerates the complete fixed contract', () => {
  const result = validateReleaseConfig(example);
  assert.deepEqual(result, {
    status: 'valid',
    variableCount: Object.keys(RELEASE_CONFIG).length,
    issues: [],
  });
});

test('an omitted required value fails closed by variable name', () => {
  const withoutOrigin = example
    .split('\n')
    .filter((line) => !line.startsWith('CANNABEATS_PUBLIC_ORIGIN='))
    .join('\n');
  const result = validateReleaseConfig(withoutOrigin);
  assert.equal(result.status, 'invalid');
  assert.deepEqual(
    result.issues.filter(({ code }) => code === 'missing'),
    [{ code: 'missing', name: 'CANNABEATS_PUBLIC_ORIGIN' }],
  );
});

test('duplicate, unknown, and malformed entries have finite sanitized issues', () => {
  const parsed = parseReleaseConfig([
    'CANNABEATS_MAX_ACTIVE_GAMES=1',
    'CANNABEATS_MAX_ACTIVE_GAMES=2',
    'CANNABEATS_OLD_POC_HOST=do-not-use',
    'not an environment assignment',
  ].join('\n'));

  assert.deepEqual(parsed.issues, [
    { code: 'duplicate', name: 'CANNABEATS_MAX_ACTIVE_GAMES', line: 2 },
    { code: 'unknown', name: 'CANNABEATS_OLD_POC_HOST', line: 3 },
    { code: 'malformed', line: 4 },
  ]);
});

test('invalid values and secret-looking input never appear in CLI output', () => {
  const directory = mkdtempSync(join(tmpdir(), 'cannabeats-fr0-'));
  const path = join(directory, 'production.env');
  const secret = 'SUPER_SECRET_VALUE_MUST_NOT_ESCAPE';
  try {
    writeFileSync(
      path,
      example.replace(
        RELEASE_CONFIG.CANNABEATS_RELAY_INGEST_TOKEN_HOST_FILE,
        secret,
      ),
    );
    const result = spawnSync(process.execPath, [scriptPath, '--env-file', path], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /invalid: CANNABEATS_RELAY_INGEST_TOKEN_HOST_FILE/u);
    assert.doesNotMatch(result.stdout, new RegExp(secret, 'u'));
    assert.doesNotMatch(result.stderr, new RegExp(secret, 'u'));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('unreadable input and invalid invocation return finite results', () => {
  assert.deepEqual(runPreflight([], () => ''), { status: 'invalid_arguments' });
  assert.deepEqual(runPreflight(['--env-file', '/missing'], () => {
    throw new Error('native path disclosure');
  }), { status: 'unreadable' });
});

test('the release identity contains no PoC or destroyed-rehearsal locator', () => {
  const values = Object.values(RELEASE_CONFIG).join('\n').toLowerCase();
  assert.doesNotMatch(values, /\bpoc\b|s2f|cannabeats-p2e1|cannabeats-s2f/u);
  assert.equal(RELEASE_CONFIG.CANNABEATS_PUBLIC_ORIGIN, 'https://play.cannabeats.social');
  assert.equal(RELEASE_CONFIG.CANNABEATS_MAX_ACTIVE_GAMES, '1');
  assert.equal(RELEASE_CONFIG.CANNABEATS_MAX_PARTICIPANTS, '8');
});
