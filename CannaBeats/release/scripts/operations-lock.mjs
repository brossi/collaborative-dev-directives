import { spawnSync } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';

import { ReleaseStateError } from './release-state.mjs';

export const PRODUCTION_LOCK = '/run/lock/cannabeats-operations.lock';

export async function withOperationsLock(work, {
  lockPath = PRODUCTION_LOCK, open = openSync, close = closeSync, spawn = spawnSync,
} = {}) {
  let descriptor;
  try {
    descriptor = open(lockPath, 'a', 0o600);
    const result = spawn('flock', ['--nonblock', '3'], {
      stdio: ['ignore', 'ignore', 'ignore', descriptor], timeout: 5_000,
    });
    if (result.status !== 0) throw new ReleaseStateError(
      result.status === 1 ? 'busy' : 'operations_unavailable',
    );
    return await work();
  } catch (error) {
    if (error instanceof ReleaseStateError) throw error;
    throw new ReleaseStateError('operations_unavailable');
  } finally {
    if (descriptor !== undefined) close(descriptor);
  }
}
