import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { createInvitation, openDatabase, sha256 } from '../db.mjs';
import { createApp, readConfig } from '../server.mjs';

const origin = 'https://poc.test';
const temporaryDirectory = mkdtempSync(join(tmpdir(), 'cannabeats-poc-test-'));
const databasePath = join(temporaryDirectory, 'test.sqlite');
const config = readConfig({
  origin,
  rpID: 'poc.test',
  databasePath,
  spotifyClientId: 'public-test-client-id',
  trustProxy: false,
  sessionTtlDays: 30,
  port: 0,
});
const db = openDatabase(databasePath);
const { app } = createApp({ config, db });
let server;
let baseUrl;

before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.close();
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

async function post(path, body = {}, headers = {}) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

test('health, public config, and defensive headers are present', async () => {
  const response = await fetch(`${baseUrl}/api/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, spotifyConfigured: true });
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match(response.headers.get('content-security-policy'), /frame-src https:\/\/sdk\.scdn\.co/);
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.equal(response.headers.get('cache-control'), 'no-store');

  const configResponse = await fetch(`${baseUrl}/api/config`);
  assert.deepEqual(await configResponse.json(), {
    appOrigin: origin,
    rpID: 'poc.test',
    spotifyClientId: 'public-test-client-id',
    spotifyRedirectUri: `${origin}/spotify/callback`,
  });

  const workerResponse = await fetch(`${baseUrl}/sw.js`);
  assert.equal(workerResponse.status, 200);
  assert.equal(workerResponse.headers.get('cache-control'), 'no-cache, no-store, must-revalidate');
  assert.equal(workerResponse.headers.get('service-worker-allowed'), '/');
});

test('protected endpoints reject an anonymous caller', async () => {
  assert.equal((await fetch(`${baseUrl}/api/me`)).status, 401);
  assert.equal((await post('/api/host/prove')).status, 401);
  assert.equal((await fetch(`${baseUrl}/api/passkeys`)).status, 401);
});

test('state-changing API calls require the exact configured origin', async () => {
  const missing = await fetch(`${baseUrl}/api/auth/sign-in/options`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(missing.status, 403);
  const wrong = await post('/api/auth/sign-in/options', {}, { Origin: 'https://evil.test' });
  assert.equal(wrong.status, 403);
});

test('a valid invitation creates registration options but remains unused until verification', async () => {
  const invitation = createInvitation(db, { role: 'host', note: 'test', ttlHours: 1 });
  const response = await post('/api/auth/enroll/options', {
    displayName: 'Test Host',
    invitationCode: invitation.code.toLowerCase(),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.options.rp.id, 'poc.test');
  assert.equal(body.options.authenticatorSelection.residentKey, 'required');
  assert.equal(body.options.authenticatorSelection.userVerification, 'required');
  assert.match(response.headers.get('set-cookie'), /cb_webauthn=/);
  const stored = db.prepare('SELECT used_at, note FROM invitations WHERE code_hash = ?')
    .get(sha256(invitation.code.replaceAll('-', '')));
  assert.equal(stored.used_at, null);
  assert.equal(stored.note, 'test');
});

test('invalid invitations reveal no registration ceremony', async () => {
  const response = await post('/api/auth/enroll/options', {
    displayName: 'Unknown Person',
    invitationCode: 'AAAAA-BBBBB-CCCCC-DDDDD',
  });
  assert.equal(response.status, 403);
});

test('host role is enforced from the server session', async () => {
  const now = Date.now();
  for (const role of ['player', 'host']) {
    const userId = randomUUID();
    const token = `test-session-${role}`;
    db.prepare('INSERT INTO users (id, display_name, role, created_at) VALUES (?, ?, ?, ?)')
      .run(userId, `Test ${role}`, role, now);
    db.prepare(`
      INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(sha256(token), userId, now, now + 60_000, now);
    const response = await post('/api/host/prove', {}, { Cookie: `cb_session=${token}` });
    assert.equal(response.status, role === 'host' ? 200 : 403);
  }
  const stored = db.prepare('SELECT token_hash FROM sessions WHERE user_id = (SELECT id FROM users WHERE role = ? LIMIT 1)')
    .get('host');
  assert.notEqual(stored.token_hash, 'test-session-host');
});

test('SQLite schema contains no Spotify token or account storage', () => {
  const schema = db.prepare(`
    SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name
  `).all();
  const applicationSchema = schema.filter((entry) => !entry.name.startsWith('sqlite_'));
  assert.equal(applicationSchema.some((entry) => /spotify|refresh_token|access_token/i.test(entry.sql)), false);
});

test('a native host application starts a secret-backed pairing without gaining authority', async () => {
  const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publicKeyDer = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const response = await post('/api/host-agents/pair/start', {
    displayName: 'Test Mac', publicKeyDer,
  });
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.match(body.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.match(body.pairingSecret, /^[A-Za-z0-9_-]+$/);
  assert.equal(body.verificationUrl, `${origin}/?pair=${body.code}`);

  const stored = db.prepare(`
    SELECT * FROM host_agent_pairings WHERE pairing_secret_hash = ?
  `).get(sha256(body.pairingSecret));
  assert.ok(stored);
  assert.notEqual(stored.pairing_secret_hash, body.pairingSecret);
  assert.notEqual(stored.code_hash, body.code.replace('-', ''));
  const status = await post('/api/host-agents/pair/status', { pairingSecret: body.pairingSecret });
  assert.deepEqual(await status.json(), { status: 'pending' });
});

test('an approved P-256 host application can prove its device identity once per challenge', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publicKeyDer = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const start = await post('/api/host-agents/pair/start', {
    displayName: 'Authorized Test Mac', publicKeyDer,
  });
  const pairing = await start.json();
  const host = db.prepare("SELECT * FROM users WHERE role = 'host' LIMIT 1").get();
  db.prepare(`
    UPDATE host_agent_pairings SET approved_at = ?, approved_by = ?
    WHERE pairing_secret_hash = ?
  `).run(Date.now(), host.id, sha256(pairing.pairingSecret));

  const claim = await post('/api/host-agents/pair/status', { pairingSecret: pairing.pairingSecret });
  const claimed = await claim.json();
  assert.equal(claimed.status, 'authorized');
  assert.equal(claimed.agent.userId, host.id);

  const challengeResponse = await post('/api/host-agents/challenge', { agentId: claimed.agent.id });
  const challenge = await challengeResponse.json();
  const signature = sign('sha256', Buffer.from(challenge.challenge), privateKey).toString('base64');
  const proof = await post('/api/host-agents/verify', {
    agentId: claimed.agent.id,
    challengeToken: challenge.challengeToken,
    signature,
  });
  assert.equal(proof.status, 200);
  const verified = await proof.json();
  assert.equal(verified.ok, true);
  assert.equal(verified.user.id, host.id);
  assert.match(verified.message, /Host application authorization confirmed/);

  const replay = await post('/api/host-agents/verify', {
    agentId: claimed.agent.id,
    challengeToken: challenge.challengeToken,
    signature,
  });
  assert.equal(replay.status, 400);
});
