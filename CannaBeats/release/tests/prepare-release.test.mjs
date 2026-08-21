import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { afterEach } from 'node:test';

import { prepareCurrentRelease, prepareReleaseBundle } from '../scripts/prepare-release.mjs';
import { canonicalReleaseManifest, deploymentDigest } from '../scripts/release-state.mjs';

const roots = [];
afterEach(() => {
  while (roots.length) {
    const path = roots.pop();
    execFileSync('chmod', ['-R', 'u+w', path]);
    rmSync(path, { recursive: true, force: true });
  }
});
const digest = (value) => `sha256:${value.repeat(64)}`;

test('release bundle binds clean source, catalog, images, schema, and deployment bytes', () => {
  const parent = mkdtempSync(join(tmpdir(), 'cannabeats-fr82-prepare-'));
  roots.push(parent);
  const output = join(parent, 'release-0001');
  const files = { Caddyfile: 'example.test {}\n', 'compose.yaml': 'services: {}\n' };
  const result = prepareReleaseBundle({
    output, releaseId: 'release-0001', sourceRevision: 'a'.repeat(40),
    catalogVersion: digest('b'), createdAt: 1000,
    images: { caddy: digest('c'), web: digest('d'), relay: digest('e') }, files,
  });
  assert.deepEqual(result, { code: 'release_bundle_prepared', releaseId: 'release-0001' });
  const retained = JSON.parse(readFileSync(join(output, 'manifest.json'), 'utf8'));
  assert.equal(canonicalReleaseManifest(retained), JSON.stringify(retained));
  assert.equal(retained.deploymentDigest, deploymentDigest(files));
  assert.equal(readFileSync(join(output, 'Caddyfile'), 'utf8'), files.Caddyfile);
  assert.throws(() => prepareReleaseBundle({
    output, releaseId: 'release-0001', sourceRevision: 'a'.repeat(40),
    catalogVersion: digest('b'), createdAt: 1000,
    images: { caddy: digest('c'), web: digest('d'), relay: digest('e') }, files,
  }));
});

test('current release preparation rejects dirty source before creating output', () => {
  const parent = mkdtempSync(join(tmpdir(), 'cannabeats-fr82-dirty-'));
  roots.push(parent);
  const output = join(parent, 'release-0001');
  const argv = [
    '--release-id', 'release-0001', '--caddy-image', digest('c'),
    '--web-image', digest('d'), '--relay-image', digest('e'), '--output', output,
  ];
  assert.throws(() => prepareCurrentRelease(argv, {
    runGit: () => ' M caller-authored', read: () => { throw new Error('must not read'); },
  }));
  assert.throws(() => prepareCurrentRelease(argv.slice(0, -2), { runGit: () => '' }));
});
