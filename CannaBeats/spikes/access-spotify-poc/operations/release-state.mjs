#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CURRENT = 'current-compose.yaml';
const PREVIOUS = 'previous-compose.yaml';
const USED = 'used-application-versions';

function syncPath(path) {
  const descriptor = openSync(path, 'r');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function copyDurably(source, destination) {
  copyFileSync(source, destination);
  chmodSync(destination, 0o644);
  syncPath(destination);
}

function stateName() {
  return `state-${Date.now()}-${randomBytes(8).toString('hex')}`;
}

function createState(releaseDirectory, { current, previous, usedContents }) {
  const statesDirectory = join(releaseDirectory, 'states');
  mkdirSync(statesDirectory, { recursive: true, mode: 0o755 });
  const name = stateName();
  const directory = join(statesDirectory, name);
  mkdirSync(directory, { mode: 0o755 });
  try {
    copyDurably(current, join(directory, CURRENT));
    if (previous) copyDurably(previous, join(directory, PREVIOUS));
    if (usedContents !== undefined) {
      const usedPath = join(directory, USED);
      writeFileSync(usedPath, usedContents, { flag: 'wx', mode: 0o644 });
      syncPath(usedPath);
    }
    syncPath(directory);
    syncPath(statesDirectory);
    return { directory, name };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

function ensureStableLink(releaseDirectory, name) {
  const path = join(releaseDirectory, name);
  const target = `active/${name}`;
  if (existsSync(path) || lstatExists(path)) {
    const status = lstatSync(path);
    if (status.isSymbolicLink() && readlinkSync(path) === target) return;
    rmSync(path, { force: true });
  }
  symlinkSync(target, path);
}

function lstatExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function switchActive(releaseDirectory, state) {
  if (process.env.CANNABEATS_TEST_STATE_FAIL === 'before-switch') {
    throw new Error('Injected release-state failure before-switch');
  }
  const activeLink = join(releaseDirectory, 'active');
  const previousTarget = lstatExists(activeLink) ? readlinkSync(activeLink) : undefined;
  const temporaryLink = join(releaseDirectory, `.active-${randomBytes(8).toString('hex')}`);
  symlinkSync(`states/${state.name}`, temporaryLink);
  let switched = false;
  try {
    renameSync(temporaryLink, activeLink);
    switched = true;
    if (process.env.CANNABEATS_TEST_STATE_FAIL === 'after-rename') {
      throw new Error('Injected release-state failure after-rename');
    }
    syncPath(releaseDirectory);
  } catch (error) {
    if (switched && previousTarget) {
      const recoveryLink = join(releaseDirectory, `.active-recovery-${randomBytes(8).toString('hex')}`);
      try {
        symlinkSync(previousTarget, recoveryLink);
        renameSync(recoveryLink, activeLink);
        syncPath(releaseDirectory);
        switched = false;
      } catch (recoveryError) {
        error.releaseStateActivated = true;
        error.cause = recoveryError;
      } finally {
        rmSync(recoveryLink, { force: true });
      }
    } else if (switched) {
      try {
        rmSync(activeLink, { force: true });
        syncPath(releaseDirectory);
        switched = false;
      } catch (recoveryError) {
        error.releaseStateActivated = true;
        error.cause = recoveryError;
      }
    }
    throw error;
  } finally {
    rmSync(temporaryLink, { force: true });
  }
}

function ensureLinks(releaseDirectory) {
  ensureStableLink(releaseDirectory, CURRENT);
  ensureStableLink(releaseDirectory, PREVIOUS);
  ensureStableLink(releaseDirectory, USED);
  syncPath(releaseDirectory);
}

function activePath(releaseDirectory, name) {
  return join(releaseDirectory, 'active', name);
}

function assertRegularFile(path, message) {
  if (!existsSync(path) || !lstatSync(path).isFile()) throw new Error(message);
}

export function bootstrapState({ releaseDirectory, candidate }) {
  const directory = resolve(releaseDirectory);
  mkdirSync(directory, { recursive: true, mode: 0o755 });
  if (lstatExists(join(directory, 'active'))) throw new Error('Release state is already initialized');
  assertRegularFile(candidate, 'Bootstrap release candidate is missing');
  const state = createState(directory, { current: candidate });
  try {
    switchActive(directory, state);
    ensureLinks(directory);
  } catch (error) {
    if (!lstatExists(join(directory, 'active'))) rmSync(state.directory, { recursive: true, force: true });
    throw error;
  }
}

export function adoptLegacyState({ releaseDirectory, currentSource, previousSource }) {
  const directory = resolve(releaseDirectory);
  mkdirSync(directory, { recursive: true, mode: 0o755 });
  if (lstatExists(join(directory, 'active'))) {
    ensureLinks(directory);
    return;
  }
  const current = currentSource ? resolve(currentSource) : join(directory, CURRENT);
  assertRegularFile(current, 'Legacy current release record is missing');
  const previous = previousSource ? resolve(previousSource) : join(directory, PREVIOUS);
  const used = join(directory, USED);
  const state = createState(directory, {
    current,
    previous: existsSync(previous) ? previous : undefined,
    usedContents: existsSync(used) ? readFileSync(used, 'utf8') : undefined,
  });
  try {
    switchActive(directory, state);
    ensureLinks(directory);
  } catch (error) {
    if (!error.releaseStateActivated) rmSync(state.directory, { recursive: true, force: true });
    throw error;
  }
}

export function promoteState({ releaseDirectory, candidate, applicationVersion }) {
  const directory = resolve(releaseDirectory);
  assertRegularFile(candidate, 'Candidate release record is missing');
  const current = activePath(directory, CURRENT);
  assertRegularFile(current, 'Active current release record is missing');
  const usedPath = activePath(directory, USED);
  const used = existsSync(usedPath) ? readFileSync(usedPath, 'utf8') : '';
  const versions = used.split(/\r?\n/).filter(Boolean);
  if (versions.includes(applicationVersion)) {
    throw new Error(`Application release identity is immutable and already recorded: ${applicationVersion}`);
  }
  const state = createState(directory, {
    current: candidate,
    previous: current,
    usedContents: `${used}${used && !used.endsWith('\n') ? '\n' : ''}${applicationVersion}\n`,
  });
  try {
    switchActive(directory, state);
  } catch (error) {
    if (!error.releaseStateActivated) rmSync(state.directory, { recursive: true, force: true });
    throw error;
  }
}

export function rollbackState({ releaseDirectory }) {
  const directory = resolve(releaseDirectory);
  const current = activePath(directory, CURRENT);
  const previous = activePath(directory, PREVIOUS);
  assertRegularFile(current, 'Active current release record is missing');
  assertRegularFile(previous, 'Active previous release record is missing');
  const usedPath = activePath(directory, USED);
  const state = createState(directory, {
    current: previous,
    previous: current,
    usedContents: existsSync(usedPath) ? readFileSync(usedPath, 'utf8') : undefined,
  });
  try {
    switchActive(directory, state);
  } catch (error) {
    if (!error.releaseStateActivated) rmSync(state.directory, { recursive: true, force: true });
    throw error;
  }
}

function required(args, index, name) {
  if (!args[index]) throw new Error(`${name} is required`);
  return args[index];
}

function main(args = process.argv.slice(2)) {
  const command = args[0];
  if (command === 'bootstrap') {
    bootstrapState({ releaseDirectory: required(args, 1, 'release directory'), candidate: required(args, 2, 'candidate') });
    return;
  }
  if (command === 'adopt') {
    adoptLegacyState({ releaseDirectory: required(args, 1, 'release directory'), currentSource: args[2], previousSource: args[3] });
    return;
  }
  if (command === 'promote') {
    promoteState({
      releaseDirectory: required(args, 1, 'release directory'),
      candidate: required(args, 2, 'candidate'),
      applicationVersion: required(args, 3, 'application version'),
    });
    return;
  }
  if (command === 'rollback') {
    rollbackState({ releaseDirectory: required(args, 1, 'release directory') });
    return;
  }
  throw new Error('Usage: release-state.mjs bootstrap|adopt|promote|rollback ...');
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath && invokedPath === resolve(fileURLToPath(import.meta.url))) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
