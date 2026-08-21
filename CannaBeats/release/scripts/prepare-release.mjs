#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import {
  chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { canonicalReleaseManifest, deploymentDigest } from './release-state.mjs';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, '../..');

function git(arguments_) {
  const result = spawnSync('git', arguments_, {
    cwd: repositoryRoot, encoding: 'utf8', timeout: 10_000,
  });
  if (result.status !== 0) throw new Error('git');
  return result.stdout.trim();
}

export function prepareReleaseBundle({
  output, releaseId, images, sourceRevision, catalogVersion, createdAt, files,
}) {
  if (!isAbsolute(output) || existsSync(output)) throw new Error('invalid_arguments');
  const manifest = {
    version: 1, releaseId, sourceRevision, catalogVersion, createdAt,
    schema: { min: 1, max: 1, target: 1 }, images,
    deploymentDigest: deploymentDigest(files),
  };
  const canonical = canonicalReleaseManifest(manifest);
  const temporary = `${output}.tmp-${process.pid}`;
  try {
    mkdirSync(temporary, { mode: 0o750 });
    writeFileSync(join(temporary, 'manifest.json'), canonical, { flag: 'wx', mode: 0o440 });
    for (const [name, value] of Object.entries(files)) {
      writeFileSync(join(temporary, name), value, { flag: 'wx', mode: 0o440 });
    }
    renameSync(temporary, output);
    chmodSync(output, 0o550);
    return Object.freeze({ code: 'release_bundle_prepared', releaseId });
  } catch (error) {
    if (existsSync(temporary)) rmSync(temporary, { recursive: true });
    throw error;
  }
}

function parseArguments(argv) {
  if (argv.length !== 10) throw new Error('arguments');
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    if (!['--release-id', '--caddy-image', '--web-image', '--relay-image', '--output']
      .includes(name) || Object.hasOwn(values, name)) throw new Error('arguments');
    values[name] = argv[index + 1];
  }
  if (Object.keys(values).length !== 5) throw new Error('arguments');
  return values;
}

export function prepareCurrentRelease(argv = process.argv.slice(2), {
  now = Date.now, runGit = git, read = readFileSync,
} = {}) {
  const values = parseArguments(argv);
  if (runGit(['status', '--porcelain']) !== '') throw new Error('dirty');
  const sourceRevision = runGit(['rev-parse', 'HEAD']);
  const catalog = JSON.parse(read(join(repositoryRoot, 'web/data/catalog-manifest.json'), 'utf8'));
  return prepareReleaseBundle({
    output: values['--output'], releaseId: values['--release-id'], sourceRevision,
    catalogVersion: catalog.catalogVersion, createdAt: now(),
    images: {
      caddy: values['--caddy-image'], web: values['--web-image'],
      relay: values['--relay-image'],
    },
    files: {
      Caddyfile: read(join(repositoryRoot, 'release/deploy/Caddyfile'), 'utf8'),
      'compose.yaml': read(join(repositoryRoot, 'release/deploy/compose.yaml'), 'utf8'),
    },
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = prepareCurrentRelease();
    process.stdout.write(`${result.code}\n`);
  } catch {
    process.stderr.write('release_bundle_invalid\n');
    process.exitCode = 1;
  }
}
