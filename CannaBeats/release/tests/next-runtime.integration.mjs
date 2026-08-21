import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import test from 'node:test';

const releaseRoot = resolve(fileURLToPath(new URL('..', import.meta.url)), '..');
const webRoot = resolve(releaseRoot, 'web');
const standaloneRoot = resolve(webRoot, '.next/standalone');
const serverPath = resolve(standaloneRoot, 'server.js');

async function availablePort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const { port } = server.address();
  await new Promise((resolveClose) => server.close(resolveClose));
  return port;
}

async function waitFor(origin, path) {
  const deadline = Date.now() + 20_000;
  let last = 'no response';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}${path}`);
      const body = await response.json();
      return { response, body };
    } catch (error) {
      last = String(error);
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
  }
  throw new Error(`standalone runtime did not answer (${last})`);
}

test('the standalone Next process owns unified health and readiness', async () => {
  const build = spawnSync('npm', ['run', 'build:do'], {
    cwd: webRoot,
    env: { ...process.env, NEXT_PUBLIC_CANNABEATS_BASE_PATH: '' },
    encoding: 'utf8',
  });
  assert.equal(build.status, 0, `${build.stdout}\n${build.stderr}`);
  const temporary = mkdtempSync(join(tmpdir(), 'cannabeats-next-runtime-'));
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  let output = '';
  const child = spawn(process.execPath, [serverPath], {
    cwd: standaloneRoot,
    env: {
      ...process.env,
      HOSTNAME: '127.0.0.1',
      PORT: String(port),
      CANNABEATS_RUNTIME: 'unified',
      CANNABEATS_DATABASE_PATH: join(temporary, 'cannabeats.sqlite3'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  try {
    const health = await waitFor(origin, '/api/health');
    assert.equal(health.response.status, 200, output);
    assert.deepEqual(health.body, { ok: true, service: 'cannabeats' });
    const readiness = await waitFor(origin, '/api/ready');
    assert.equal(readiness.response.status, 200, `${JSON.stringify(readiness.body)}\n${output}`);
    assert.equal(readiness.body.ready, true);
    assert.equal(readiness.body.reason, 'ready');
    assert.equal(readiness.body.schemaGeneration, 1);
    assert.match(readiness.body.catalogVersion, /^sha256:[0-9a-f]{64}$/u);
  } finally {
    child.kill('SIGTERM');
    if (child.exitCode === null) await new Promise((resolveExit) => child.once('exit', resolveExit));
    rmSync(temporary, { recursive: true, force: true });
  }
});
