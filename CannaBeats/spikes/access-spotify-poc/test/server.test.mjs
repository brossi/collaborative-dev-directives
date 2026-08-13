import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import {
  createInvitation,
  grantUserCapability,
  MANAGE_HOST_INVITATIONS,
  openDatabase,
  purgeExpired,
  revokeUserCapability,
  sha256,
} from '../db.mjs';
import { createHostOnboarding, renderHostOnboardingEmail } from '../onboarding.mjs';
import { createApp, readConfig } from '../server.mjs';
import { StateClientError } from '../state-client.mjs';

const origin = 'https://poc.test';
const temporaryDirectory = mkdtempSync(join(tmpdir(), 'cannabeats-poc-test-'));
const databasePath = join(temporaryDirectory, 'test.sqlite');
const hostReleasePath = join(temporaryDirectory, 'CannaBeats-Host-universal.dmg');
writeFileSync(hostReleasePath, 'test-universal-host-release');
const config = readConfig({
  origin,
  rpID: 'poc.test',
  databasePath,
  spotifyClientId: 'public-test-client-id',
  audioRelayOrigin: 'https://relay.poc.test',
  audioRelayIngestToken: 'test-ingest-token-not-a-secret',
  audioRelayListenToken: 'test-listen-token-not-a-secret',
  gameServiceOrigin: 'http://game.test',
  gameServiceToken: 'test-game-service-token-not-a-secret',
  trustProxy: false,
  sessionTtlDays: 30,
  port: 0,
  hostReleasePath,
  hostReleaseName: 'CannaBeats-Host-universal.dmg',
  hostReleaseChannel: 'interim',
  environment: 'test',
  applicationVersion: 'app-test',
  catalogVersion: 'catalog-test',
});
const db = openDatabase(databasePath);
const gameRooms = new Map();
let nextGameCode = 0;
async function gameServiceFetch(_url, options) {
  assert.equal(options.headers['X-CannaBeats-Internal-Token'], config.gameServiceToken);
  const payload = JSON.parse(options.body);
  if (payload.action === 'create') {
    const code = `T22${String((nextGameCode += 1) + 1)}`;
    const room = { code, phase: 'lobby', ownerUserId: payload.ownerUserId };
    gameRooms.set(code, room);
    return Response.json({ room, created: true }, { status: 201 });
  }
  const room = gameRooms.get(payload.code);
  if (!room || room.ownerUserId !== payload.ownerUserId) {
    return Response.json({ error: 'Game room was not found for this host account.' }, { status: 404 });
  }
  return Response.json({ room, created: false });
}
const operationalLogs = [];
const { app } = createApp({
  config,
  db,
  gameServiceFetch,
  logWrite: (_level, line) => operationalLogs.push(JSON.parse(line)),
});
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

async function nativePost(path, body = {}, headers = {}) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

async function signedHostPost(path, agentId, privateKey, body = {}) {
  const challengeResponse = await post('/api/host-agents/challenge', { agentId });
  assert.equal(challengeResponse.status, 200);
  const challenge = await challengeResponse.json();
  const signature = sign('sha256', Buffer.from(challenge.challenge), privateKey).toString('base64');
  return post(path, {
    ...body,
    agentId,
    challengeToken: challenge.challengeToken,
    signature,
  });
}

test('health, public config, and defensive headers are present', async () => {
  const suppliedCorrelation = randomUUID();
  const response = await fetch(`${baseUrl}/api/health`, {
    headers: { 'X-CannaBeats-Correlation-ID': suppliedCorrelation },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, service: 'cannabeats-access' });
  assert.match(response.headers.get('x-cannabeats-correlation-id'), /^[0-9a-f-]{36}$/);
  assert.notEqual(response.headers.get('x-cannabeats-correlation-id'), suppliedCorrelation);
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match(response.headers.get('content-security-policy'), /frame-src https:\/\/sdk\.scdn\.co/);
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.equal(response.headers.get('cache-control'), 'no-store');

  const ready = await fetch(`${baseUrl}/api/ready`);
  assert.equal(ready.status, 200);
  assert.deepEqual(await ready.json(), { ready: true, service: 'cannabeats-access' });

  const configResponse = await fetch(`${baseUrl}/api/config`);
  assert.deepEqual(await configResponse.json(), {
    appOrigin: origin,
    rpID: 'poc.test',
    spotifyClientId: 'public-test-client-id',
    spotifyRedirectUri: `${origin}/spotify/callback`,
    hostInstallerChannel: 'interim',
  });

  const workerResponse = await fetch(`${baseUrl}/sw.js`);
  assert.equal(workerResponse.status, 200);
  assert.equal(workerResponse.headers.get('cache-control'), 'no-cache, no-store, must-revalidate');
  assert.equal(workerResponse.headers.get('service-worker-allowed'), '/');
});

test('repeated readiness failures emit one transition and keep a safe 503 envelope', async () => {
  const records = [];
  const sentinel = `private-database-failure-${randomUUID()}`;
  const unavailable = createApp({
    config,
    db: { prepare: () => { throw new Error(sentinel); } },
    logWrite: (_level, line) => records.push(JSON.parse(line)),
  }).app;
  const listener = unavailable.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    listener.once('listening', resolve);
    listener.once('error', reject);
  });
  try {
    const url = `http://127.0.0.1:${listener.address().port}/api/ready`;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const response = await fetch(url);
      assert.equal(response.status, 503);
      assert.equal((await response.json()).code, 'dependency_unavailable');
    }
  } finally {
    await new Promise((resolve) => listener.close(resolve));
  }
  assert.equal(records.filter((record) => record.event === 'service.readiness_changed').length, 1);
  assert.equal(records.filter((record) => record.event === 'http.request_failed').length, 0);
  assert.doesNotMatch(JSON.stringify(records), new RegExp(sentinel));
});

test('protected endpoints reject an anonymous caller', async () => {
  const anonymous = await fetch(`${baseUrl}/api/me`);
  assert.equal(anonymous.status, 401);
  const error = await anonymous.json();
  assert.equal(error.code, 'authentication_required');
  assert.equal(error.correlationId, anonymous.headers.get('x-cannabeats-correlation-id'));
  assert.ok(operationalLogs.some((entry) => entry.correlationId === error.correlationId
    && entry.event === 'http.request_failed'));
  assert.equal((await post('/api/host/prove')).status, 401);
  assert.equal((await fetch(`${baseUrl}/api/passkeys`)).status, 401);
});

test('the game gateway resolves principals only through its scoped internal credential', async () => {
  let host = db.prepare("SELECT * FROM users WHERE role='host' LIMIT 1").get();
  if (!host) {
    const id = randomUUID();
    db.prepare("INSERT INTO users (id,display_name,role,created_at) VALUES (?,?,'host',?)")
      .run(id,'Gateway Host',Date.now());
    host = db.prepare('SELECT * FROM users WHERE id=?').get(id);
  }
  const token = `principal-forward-${randomUUID()}`;
  const now = Date.now();
  db.prepare(`INSERT INTO sessions
    (token_hash,user_id,created_at,expires_at,last_seen_at) VALUES (?,?,?,?,?)`)
    .run(sha256(token),host.id,now,now + 60_000,now);
  const denied = await nativePost('/api/internal/game/principal', {
    cookie: `cb_session=${token}`,
  });
  assert.equal(denied.status, 403);
  const accepted = await nativePost('/api/internal/game/principal', {
    cookie: `cb_session=${token}`,
  }, { 'X-CannaBeats-Internal-Token': config.gameServiceToken });
  assert.equal(accepted.status, 200);
  assert.deepEqual((await accepted.json()).principal, {
    id: host.id, displayName: host.display_name, role: 'host', kind: 'account',
  });
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

test('host onboarding creates paste-ready instructions and a deliberate tokenized download', async () => {
  const onboarding = createHostOnboarding(db, {
    recipientName: 'Future Host',
    origin,
    releasePath: hostReleasePath,
    releaseName: 'CannaBeats-Host-universal.dmg',
    releaseChannel: 'interim',
    ttlHours: 2,
    maxDownloads: 2,
  });
  assert.match(onboarding.accountSetupUrl, /^https:\/\/poc\.test\/#invite=/);
  assert.match(onboarding.downloadUrl, /^https:\/\/poc\.test\/host-download#token=/);
  const email = renderHostOnboardingEmail(onboarding);
  assert.match(email, /Subject: Your private CannaBeats Host invitation/);
  assert.match(email, /Confirm managed Spotify/);
  assert.match(email, /Linux Spotify source/);
  assert.match(email, /private interim build/);
  assert.match(email, /Privacy & Security/);
  assert.match(email, /File > Add to Dock/);
  assert.match(email, /Host a game/);

  const downloadToken = new URL(onboarding.downloadUrl).hash.slice('#token='.length);
  assert.match(downloadToken, /^[A-Za-z0-9_-]{32,128}$/);
  assert.equal(db.prepare('SELECT 1 FROM host_release_downloads WHERE token_hash = ?').get(downloadToken), undefined);
  const stored = db.prepare('SELECT * FROM host_release_downloads WHERE token_hash = ?').get(sha256(downloadToken));
  assert.equal(stored.recipient_name, 'Future Host');
  assert.equal(stored.download_count, 0);

  const landing = await fetch(`${baseUrl}/host-download`);
  assert.equal(landing.status, 200);
  assert.match(await landing.text(), /id="download-host"/);
  const scannerStyleGet = await fetch(`${baseUrl}/api/host-release/download`);
  assert.equal(scannerStyleGet.status, 404);
  assert.equal(db.prepare('SELECT download_count FROM host_release_downloads WHERE token_hash = ?')
    .get(sha256(downloadToken)).download_count, 0);

  const wrongOrigin = await post('/api/host-release/download', { token: downloadToken }, { Origin: 'https://evil.test' });
  assert.equal(wrongOrigin.status, 403);
  for (let count = 1; count <= 2; count += 1) {
    const download = await post('/api/host-release/download', { token: downloadToken });
    assert.equal(download.status, 200);
    assert.equal(await download.text(), 'test-universal-host-release');
    assert.match(download.headers.get('content-disposition'), /attachment; filename="CannaBeats-Host-universal\.dmg"/);
    assert.equal(download.headers.get('cache-control'), 'private, no-store');
    assert.equal(db.prepare('SELECT download_count FROM host_release_downloads WHERE token_hash = ?')
      .get(sha256(downloadToken)).download_count, count);
  }
  const exhausted = await post('/api/host-release/download', { token: downloadToken });
  assert.equal(exhausted.status, 410);
});

test('host invitation administration is an assignable capability, not a hardcoded user', async () => {
  const now = Date.now();
  const userId = randomUUID();
  const sessionToken = 'test-session-invitation-administrator';
  db.prepare('INSERT INTO users (id, display_name, role, created_at) VALUES (?, ?, ?, ?)')
    .run(userId, 'Invite Administrator', 'player', now);
  db.prepare(`
    INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(sha256(sessionToken), userId, now, now + 60_000, now);
  const cookie = { Cookie: `cb_session=${sessionToken}` };

  assert.equal((await fetch(`${baseUrl}/admin/host-invitations`)).status, 401);
  assert.equal((await fetch(`${baseUrl}/admin/host-invitations`, { headers: cookie })).status, 403);
  assert.equal((await fetch(`${baseUrl}/api/admin/host-invitations`, { headers: cookie })).status, 403);

  grantUserCapability(db, { userId, capability: MANAGE_HOST_INVITATIONS });
  const page = await fetch(`${baseUrl}/admin/host-invitations`, { headers: cookie });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Generate invitation/);
  const me = await fetch(`${baseUrl}/api/me`, { headers: cookie });
  assert.deepEqual((await me.json()).user.capabilities, [MANAGE_HOST_INVITATIONS]);

  const generated = await post('/api/admin/host-invitations', {
    recipientName: 'Next Host', ttlHours: 24, maxDownloads: 3,
  }, cookie);
  assert.equal(generated.status, 201);
  const invitation = await generated.json();
  assert.equal(invitation.recipientName, 'Next Host');
  assert.match(invitation.email, /Subject: Your private CannaBeats Host invitation/);
  assert.match(invitation.email, /—Invite Administrator\n$/);
  assert.ok(db.prepare(`
    SELECT 1 FROM audit_events WHERE user_id = ? AND event = 'host_invitation.created'
  `).get(userId));

  assert.equal(revokeUserCapability(db, { userId, capability: MANAGE_HOST_INVITATIONS }), true);
  assert.equal((await post('/api/admin/host-invitations', {
    recipientName: 'Denied Host', ttlHours: 24, maxDownloads: 3,
  }, cookie)).status, 403);
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

  const relayChallengeResponse = await post('/api/host-agents/challenge', { agentId: claimed.agent.id });
  const relayChallenge = await relayChallengeResponse.json();
  const relaySignature = sign('sha256', Buffer.from(relayChallenge.challenge), privateKey).toString('base64');
  const grant = await post('/api/host-agents/relay-grant', {
    agentId: claimed.agent.id,
    challengeToken: relayChallenge.challengeToken,
    signature: relaySignature,
  });
  assert.equal(grant.status, 200);
  assert.deepEqual(await grant.json(), {
    relay: {
      origin: 'https://relay.poc.test',
      ingestToken: 'test-ingest-token-not-a-secret',
      listenToken: 'test-listen-token-not-a-secret',
      mode: 'poc-shared-static',
    },
  });

  const createdResponse = await signedHostPost(
    '/api/host-agents/game-sessions/prepare', claimed.agent.id, privateKey,
  );
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();
  assert.equal(created.created, true);
  assert.match(created.session.code, /^[A-Z2-9]{6}$/);
  assert.equal(created.session.host.id, host.id);
  assert.equal(created.session.members[0].id, host.id);
  assert.equal('activeRunId' in created.session, false);
  assert.equal(db.prepare('SELECT active_run_id FROM game_sessions WHERE code = ?')
    .get(created.session.code).active_run_id, null);
  assert.equal(created.launchPath, `/game?session=${created.session.code}`);

  const existingResponse = await signedHostPost(
    '/api/host-agents/game-sessions/prepare', claimed.agent.id, privateKey, { code: created.session.code },
  );
  assert.equal(existingResponse.status, 200);
  const existing = await existingResponse.json();
  assert.equal(existing.created, false);
  assert.equal(existing.session.code, created.session.code);

  const otherHostId = randomUUID();
  const otherCode = 'ZZ99ZZ';
  const now = Date.now();
  db.prepare('INSERT INTO users (id, display_name, role, created_at) VALUES (?, ?, ?, ?)')
    .run(otherHostId, 'Other Test Host', 'host', now);
  db.prepare(`
    INSERT INTO game_sessions (code, host_user_id, status, created_at, updated_at)
    VALUES (?, ?, 'lobby', ?, ?)
  `).run(otherCode, otherHostId, now, now);
  const otherHostSession = await signedHostPost(
    '/api/host-agents/game-sessions/prepare', claimed.agent.id, privateKey, { code: otherCode },
  );
  assert.equal(otherHostSession.status, 404);
});

test('a desktop installation needs explicit approval before its revocable credential works', async () => {
  const start = await nativePost('/api/desktop/authorizations/start', {
    displayName: 'CannaBeats Client on Test Laptop',
  });
  assert.equal(start.status, 201);
  const pairing = await start.json();
  assert.match(pairing.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.match(pairing.authorizationToken, /^[A-Za-z0-9_-]{32,128}$/);
  assert.equal(pairing.verificationUrl, `${origin}/desktop/approve?code=${pairing.code}`);
  const stored = db.prepare(`
    SELECT * FROM desktop_authorizations WHERE token_hash = ?
  `).get(sha256(pairing.authorizationToken));
  assert.ok(stored);
  assert.notEqual(stored.token_hash, pairing.authorizationToken);

  const pending = await nativePost('/api/desktop/authorizations/status', {
    authorizationToken: pairing.authorizationToken,
  });
  assert.deepEqual(await pending.json(), { status: 'pending' });

  const user = db.prepare("SELECT * FROM users WHERE role = 'host' LIMIT 1").get();
  const browserToken = `desktop-approval-browser-${randomUUID()}`;
  db.prepare(`
    INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(sha256(browserToken), user.id, Date.now(), Date.now() + 60_000, Date.now());
  const pendingSelection = await fetch(
    `${baseUrl}/api/desktop/authorizations/pending?code=${encodeURIComponent(pairing.code)}`,
    { headers: { Cookie: `cb_session=${browserToken}` } },
  );
  assert.equal(pendingSelection.status, 200);
  assert.deepEqual(await pendingSelection.json(), {
    application: { displayName: 'CannaBeats Client on Test Laptop' },
    code: pairing.code,
    expiresAt: pairing.expiresAt,
    approved: false,
  });
  const approvalPage = await fetch(`${baseUrl}/desktop/approve?code=${encodeURIComponent(pairing.code)}`);
  assert.equal(approvalPage.status, 200);
  assert.match(await approvalPage.text(), /id="desktop-approval-card"/);

  db.prepare(`
    UPDATE desktop_authorizations SET approved_at = ?, approved_by = ? WHERE token_hash = ?
  `).run(Date.now(), user.id, sha256(pairing.authorizationToken));
  const authorized = await nativePost('/api/desktop/authorizations/status', {
    authorizationToken: pairing.authorizationToken,
  });
  assert.equal(authorized.status, 200);
  const authorization = await authorized.json();
  assert.equal(authorization.status, 'authorized');
  assert.equal(authorization.user.id, user.id);

  const me = await fetch(`${baseUrl}/api/desktop/me`, {
    headers: { Authorization: `Bearer ${pairing.authorizationToken}` },
  });
  assert.equal(me.status, 200);
  assert.equal((await me.json()).application.displayName, 'CannaBeats Client on Test Laptop');

  const sessionCode = 'DESK23';
  db.prepare(`
    INSERT INTO game_sessions (code, host_user_id, status, created_at, updated_at)
    VALUES (?, ?, 'lobby', ?, ?)
  `).run(sessionCode, user.id, Date.now(), Date.now());
  const launchResponse = await nativePost('/api/desktop/game-launch', { code: sessionCode }, {
    Authorization: `Bearer ${pairing.authorizationToken}`,
  });
  assert.equal(launchResponse.status, 201);
  const launch = await launchResponse.json();
  const launchUrl = new URL(launch.launchUrl);
  assert.equal(launchUrl.origin, origin);
  assert.equal(launchUrl.pathname, '/game/desktop');
  const launchTicket = launchUrl.searchParams.get('ticket');
  assert.match(launchTicket, /^[A-Za-z0-9_-]{32,128}$/);
  assert.ok(db.prepare('SELECT 1 FROM desktop_web_tickets WHERE token_hash = ?')
    .get(sha256(launchTicket)));
  assert.ok(db.prepare(`
    SELECT 1 FROM game_session_members WHERE session_code = ? AND user_id = ?
  `).get(sessionCode, user.id));
  assert.equal(db.prepare(`
    SELECT session_code FROM desktop_web_tickets WHERE token_hash = ?
  `).get(sha256(launchTicket)).session_code, sessionCode);

  db.prepare('UPDATE desktop_sessions SET revoked_at = ? WHERE token_hash = ?')
    .run(Date.now(), sha256(pairing.authorizationToken));
  const revoked = await fetch(`${baseUrl}/api/desktop/me`, {
    headers: { Authorization: `Bearer ${pairing.authorizationToken}` },
  });
  assert.equal(revoked.status, 401);
});

test('the lobby API requires authority and exists independently of an engine run', async () => {
  assert.equal((await post('/api/game-sessions')).status, 401);
  assert.equal((await nativePost('/api/desktop/game-sessions/join', { code: 'ABC123' })).status, 401);

  const host = db.prepare("SELECT * FROM users WHERE role = 'host' LIMIT 1").get();
  const browserToken = `lobby-browser-${randomUUID()}`;
  const now = Date.now();
  db.prepare(`
    INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(sha256(browserToken), host.id, now, now + 60_000, now);
  const createdResponse = await post('/api/game-sessions', {}, { Cookie: `cb_session=${browserToken}` });
  assert.equal(createdResponse.status, 201);
  const { session } = await createdResponse.json();
  assert.match(session.code, /^[A-Z2-9]{6}$/);
  assert.equal('activeRunId' in session, false);
  assert.equal(db.prepare('SELECT 1 FROM rooms WHERE code = ?').get(session.code), undefined);

  const current = await fetch(`${baseUrl}/api/game-sessions/current`, {
    headers: { Cookie: `cb_session=${browserToken}` },
  });
  assert.equal(current.status, 200);
  assert.ok((await current.json()).sessions.some((candidate) => candidate.code === session.code));
});

test('cutover access routes use only the state client for lobby authority', async () => {
  const host = db.prepare("SELECT * FROM users WHERE role = 'host' LIMIT 1").get();
  const token = `state-lobby-browser-${randomUUID()}`;
  const now = Date.now();
  db.prepare(`INSERT INTO sessions
    (token_hash,user_id,created_at,expires_at,last_seen_at) VALUES (?,?,?,?,?)`)
    .run(sha256(token),host.id,now,now + 60_000,now);
  const stateLobbies = new Map();
  const calls = [];
  const stateClient = {
    async createLobby({ commandId, code, principalId }) {
      calls.push({ type: 'create', commandId, code, principalId });
      stateLobbies.set(code, {
        code, status: 'lobby', hostPrincipalId: principalId, runGeneration: 0,
        members: [{ principalId, joinedAt: now }], createdAt: now, updatedAt: now,
      });
      return { code, status: 'lobby' };
    },
    async lobby({ code, principalId }) {
      calls.push({ type: 'read', code, principalId });
      return stateLobbies.get(code);
    },
    async lobbies({ principalId }) {
      calls.push({ type: 'list', principalId });
      return { lobbies: [...stateLobbies.values()].map(({ members: _members, ...lobby }) => lobby) };
    },
    async addMembership() { throw new Error('not used'); },
  };
  const cutover = createApp({ config, db, stateClient }).app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    cutover.once('listening', resolve);
    cutover.once('error', reject);
  });
  try {
    const cutoverOrigin = `http://127.0.0.1:${cutover.address().port}`;
    const commandId = randomUUID();
    const created = await fetch(`${cutoverOrigin}/api/game-sessions`, {
      method: 'POST',
      headers: {
        Origin: origin, 'Content-Type': 'application/json',
        Cookie: `cb_session=${token}`, 'Idempotency-Key': commandId,
      },
      body: '{}',
    });
    assert.equal(created.status, 201);
    const session = (await created.json()).session;
    assert.equal(calls[0].commandId, commandId);
    assert.equal(calls[0].principalId, host.id);
    assert.equal(db.prepare('SELECT 1 FROM game_sessions WHERE code=?').get(session.code), undefined);
    const listed = await fetch(`${cutoverOrigin}/api/game-sessions/current`, {
      headers: { Cookie: `cb_session=${token}` },
    });
    assert.equal(listed.status, 200);
    assert.deepEqual((await listed.json()).sessions.map((entry) => entry.code), [session.code]);
    assert.ok(calls.some((call) => call.type === 'list'));
  } finally {
    await new Promise((resolve) => cutover.close(resolve));
  }
});

test('cutover guest admission reserves one access identity and delegates the player mutation', async () => {
  const host = db.prepare("SELECT * FROM users WHERE role = 'host' LIMIT 1").get();
  const browserToken = `state-admission-host-${randomUUID()}`;
  const now = Date.now();
  db.prepare(`INSERT INTO sessions
    (token_hash,user_id,created_at,expires_at,last_seen_at) VALUES (?,?,?,?,?)`)
    .run(sha256(browserToken),host.id,now,now + 60_000,now);
  const runId = randomUUID();
  const admitted = [];
  let guestLobbyRecoverable = true;
  let admissionRevision = 0;
  let raceNextAdmission = false;
  let failNextAdmission = false;
  let failNextAdmissionContext = false;
  const stateAdmissionReceipts = new Map();
  const stateClient = {
    async lobby({ code }) {
      return { code,hostPrincipalId: host.id,admissionOpen: true };
    },
    async admissionContext() {
      if (failNextAdmissionContext) {
        failNextAdmissionContext = false;
        throw new StateClientError(503,'state_unavailable');
      }
      const revision = admissionRevision;
      if (raceNextAdmission) {
        raceNextAdmission = false;
        admissionRevision += 1;
      }
      return { runId,runGeneration: 1,revision,admissionOpen: true };
    },
    async admit(input) {
      if (failNextAdmission) {
        failNextAdmission = false;
        throw new StateClientError(503,'state_unavailable');
      }
      const prior = stateAdmissionReceipts.get(input.actionId);
      if (!prior && input.expectedRevision !== admissionRevision) {
        throw new StateClientError(409,'state_conflict');
      }
      admitted.push(input);
      if (!prior) {
        stateAdmissionReceipts.set(input.actionId,input);
        admissionRevision += 1;
      }
      return {
        state: {
          runId,code: input.code,runGeneration: 1,revision: 1,phase: 'lobby',round: 0,
          players: [{ id: input.principalId,name: input.name,control: 'phone',timeline: [] }],
        },
        replayed: Boolean(prior),
      };
    },
    async lobbies({ principalId }) {
      return { lobbies: guestLobbyRecoverable ? [{
        code: 'ABC234',status: 'playing',hostPrincipalId: host.id,runGeneration: 1,
        principalId,
      }] : [] };
    },
    async recover({ principalId,pendingActionLobbyCode }) {
      return { outcome: 'action_reconciliation_required',lobbies: [{
        code: pendingActionLobbyCode,status: 'ended',isHost: false,principalId,
      }] };
    },
  };
  const cutover = createApp({ config,db,stateClient }).app.listen(0,'127.0.0.1');
  await new Promise((resolve, reject) => {
    cutover.once('listening',resolve);
    cutover.once('error',reject);
  });
  try {
    const cutoverOrigin = `http://127.0.0.1:${cutover.address().port}`;
    const inviteActionId = randomUUID();
    const inviteRequest = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CannaBeats-Internal-Token': config.gameServiceToken,
      },
      body: JSON.stringify({
        actionId: inviteActionId,cookie: `cb_session=${browserToken}`,code: 'ABC234',
      }),
    };
    const inviteResponse = await fetch(
      `${cutoverOrigin}/api/internal/game/guest-invite`,inviteRequest,
    );
    assert.equal(inviteResponse.status,200);
    const invitePayload = await inviteResponse.json();
    assert.equal(invitePayload.replayed,false);
    const invite = invitePayload.guestInvite;
    const inviteReplay = await fetch(
      `${cutoverOrigin}/api/internal/game/guest-invite`,inviteRequest,
    );
    assert.equal(inviteReplay.status,200);
    const replayedInvite = await inviteReplay.json();
    assert.equal(replayedInvite.guestInvite,invitePayload.guestInvite);
    assert.equal(replayedInvite.expiresAt,invitePayload.expiresAt);
    assert.equal(replayedInvite.replayed,true);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM state_guest_invites WHERE action_id=?')
      .get(inviteActionId).count,1);
    const authenticatedInviteBypass = await fetch(`${cutoverOrigin}/api/internal/game/admit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json','X-CannaBeats-Internal-Token': config.gameServiceToken },
      body: JSON.stringify({
        actionId: randomUUID(),cookie: `cb_session=${browserToken}`,code: 'ABC234',
        name: 'Host',requireInvitation: true,invite: 'definitely-invalid',
      }),
    });
    assert.equal(authenticatedInviteBypass.status,403,
      'an existing principal must not bypass invitation validation');
    const actionId = randomUUID();
    const body = { actionId,code: 'ABC234',name: 'Guest Phone',requireInvitation: true,invite };
    const first = await fetch(`${cutoverOrigin}/api/internal/game/admit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json','X-CannaBeats-Internal-Token': config.gameServiceToken },
      body: JSON.stringify(body),
    });
    assert.equal(first.status,200);
    const firstPayload = await first.json();
    assert.match(firstPayload.sessionCookie,/^cb_guest=/);
    const reusedInvite = await fetch(`${cutoverOrigin}/api/internal/game/admit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json','X-CannaBeats-Internal-Token': config.gameServiceToken },
      body: JSON.stringify({ ...body,actionId: randomUUID(),name: 'Second Guest' }),
    });
    assert.equal(reusedInvite.status,403);
    db.prepare('UPDATE state_guest_invites SET expires_at=? WHERE action_id=?')
      .run(now - 1,inviteActionId);
    const replay = await fetch(`${cutoverOrigin}/api/internal/game/admit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json','X-CannaBeats-Internal-Token': config.gameServiceToken },
      body: JSON.stringify(body),
    });
    assert.equal(replay.status,200);
    const replayPayload = await replay.json();
    assert.equal(replayPayload.principal.id,firstPayload.principal.id);
    assert.equal(
      /cb_guest=([^;]+)/.exec(replayPayload.sessionCookie)?.[1],
      /cb_guest=([^;]+)/.exec(firstPayload.sessionCookie)?.[1],
    );
    assert.equal(admitted.length,2);
    assert.equal(admitted[0].principalId,admitted[1].principalId);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM state_guest_admissions WHERE action_id=?')
      .get(actionId).count,1);
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM state_admission_reservations
      WHERE action_id=?`).get(actionId).count,1);
    assert.equal(db.prepare('SELECT 1 FROM game_sessions WHERE code=?').get('ABC234'),undefined);

    const recoveryInviteActionId = randomUUID();
    const recoveryInviteResponse = await fetch(
      `${cutoverOrigin}/api/internal/game/guest-invite`,{
        ...inviteRequest,
        body: JSON.stringify({
          actionId: recoveryInviteActionId,cookie: `cb_session=${browserToken}`,code: 'ABC234',
        }),
      },
    );
    const recoveryInvite = (await recoveryInviteResponse.json()).guestInvite;
    const recoveryActionId = randomUUID();
    const recoveryBody = {
      actionId: recoveryActionId,code: 'ABC234',name: 'Racing Guest',
      requireInvitation: true,invite: recoveryInvite,
    };
    raceNextAdmission = true;
    const conflicted = await fetch(`${cutoverOrigin}/api/internal/game/admit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json','X-CannaBeats-Internal-Token': config.gameServiceToken },
      body: JSON.stringify(recoveryBody),
    });
    const conflictedPayload = await conflicted.json();
    assert.equal(conflicted.status,200,JSON.stringify(conflictedPayload));
    const healed = await fetch(`${cutoverOrigin}/api/internal/game/admit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json','X-CannaBeats-Internal-Token': config.gameServiceToken },
      body: JSON.stringify(recoveryBody),
    });
    assert.equal(healed.status,200);
    const healedPayload = await healed.json();
    assert.match(healedPayload.sessionCookie,/^cb_guest=/);
    assert.equal(admitted.at(-1).expectedRevision,2);
    assert.ok(db.prepare(`SELECT completed_at FROM state_admission_requests
      WHERE action_id=?`).get(recoveryActionId).completed_at);

    const retryInviteActionId = randomUUID();
    const retryInviteResponse = await fetch(
      `${cutoverOrigin}/api/internal/game/guest-invite`,{
        ...inviteRequest,
        body: JSON.stringify({
          actionId: retryInviteActionId,cookie: `cb_session=${browserToken}`,code: 'ABC234',
        }),
      },
    );
    const retryInvite = (await retryInviteResponse.json()).guestInvite;
    const retryActionId = randomUUID();
    const retryBody = {
      actionId: retryActionId,code: 'ABC234',name: 'Retry Guest',
      requireInvitation: true,invite: retryInvite,
    };
    failNextAdmission = true;
    const unavailable = await fetch(`${cutoverOrigin}/api/internal/game/admit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json','X-CannaBeats-Internal-Token': config.gameServiceToken },
      body: JSON.stringify(retryBody),
    });
    assert.equal(unavailable.status,503);
    const reserved = db.prepare(`SELECT admission.user_id,request.completed_at
      FROM state_guest_admissions admission
      JOIN state_admission_requests request ON request.action_id=admission.action_id
      WHERE admission.action_id=?`).get(retryActionId);
    assert.ok(reserved.user_id);
    assert.equal(reserved.completed_at,null);
    const retried = await fetch(`${cutoverOrigin}/api/internal/game/admit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json','X-CannaBeats-Internal-Token': config.gameServiceToken },
      body: JSON.stringify(retryBody),
    });
    assert.equal(retried.status,200);
    const retriedPayload = await retried.json();
    assert.equal(retriedPayload.principal.id,reserved.user_id);
    assert.match(retriedPayload.sessionCookie,/^cb_guest=/);
    assert.ok(db.prepare(`SELECT completed_at FROM state_admission_requests
      WHERE action_id=?`).get(retryActionId).completed_at);
    db.prepare(`UPDATE state_admission_reservations SET retry_expires_at=?
      WHERE action_id=?`).run(now - 1,retryActionId);
    db.prepare(`UPDATE state_guest_admissions SET recovery_expires_at=?
      WHERE action_id=?`).run(now - 1,retryActionId);
    const staleRetry = await fetch(`${cutoverOrigin}/api/internal/game/admit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CannaBeats-Internal-Token': config.gameServiceToken,
      },
      body: JSON.stringify(retryBody),
    });
    assert.equal(staleRetry.status,410,
      'an expired admission reservation must fail at the authority read without waiting for cleanup');
    assert.equal((await staleRetry.json()).code,'expired');
    const originalGuestToken = /cb_guest=([^;]+)/.exec(firstPayload.sessionCookie)?.[1];
    assert.ok(originalGuestToken);
    db.prepare('UPDATE state_guest_sessions SET expires_at=? WHERE user_id=?')
      .run(now - 1,firstPayload.principal.id);

    const expiredPrincipal = await fetch(`${cutoverOrigin}/api/internal/game/principal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json','X-CannaBeats-Internal-Token': config.gameServiceToken },
      body: JSON.stringify({ cookie: `cb_guest=${originalGuestToken}` }),
    });
    assert.equal(expiredPrincipal.status,401);

    const recovered = await fetch(`${cutoverOrigin}/api/internal/game/recover-principal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json','X-CannaBeats-Internal-Token': config.gameServiceToken },
      body: JSON.stringify({ cookie: `cb_guest=${originalGuestToken}` }),
    });
    assert.equal(recovered.status,200);
    const recoveredPayload = await recovered.json();
    assert.equal(recoveredPayload.outcome,'authenticated');
    assert.equal(recoveredPayload.principal.id,firstPayload.principal.id);
    assert.match(recoveredPayload.sessionCookie,/^cb_guest=/);
    const rotatedGuestToken = /cb_guest=([^;]+)/.exec(recoveredPayload.sessionCookie)?.[1];
    assert.equal(rotatedGuestToken,originalGuestToken);

    const rotatedPrincipal = await fetch(`${cutoverOrigin}/api/internal/game/principal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json','X-CannaBeats-Internal-Token': config.gameServiceToken },
      body: JSON.stringify({ cookie: `cb_guest=${rotatedGuestToken}` }),
    });
    assert.equal(rotatedPrincipal.status,200);

    const recoveryBoundary = db.prepare(`SELECT recovery_expires_at
      FROM state_guest_sessions WHERE token_hash=?`).get(sha256(rotatedGuestToken));
    assert.ok(recoveryBoundary.recovery_expires_at > now);
    purgeExpired(db,now);
    assert.ok(db.prepare('SELECT 1 FROM users WHERE id=?').get(firstPayload.principal.id));

    guestLobbyRecoverable = false;
    db.prepare('UPDATE state_guest_sessions SET expires_at=? WHERE token_hash=?')
      .run(now - 1,sha256(rotatedGuestToken));
    const endedPending = await fetch(`${cutoverOrigin}/api/internal/game/recover-principal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json','X-CannaBeats-Internal-Token': config.gameServiceToken },
      body: JSON.stringify({
        cookie: `cb_guest=${rotatedGuestToken}`,pendingActionLobbyCode: 'ABC234',
      }),
    });
    assert.equal(endedPending.status,200);
    assert.equal((await endedPending.json()).outcome,'authenticated');
    db.prepare('UPDATE state_guest_sessions SET expires_at=? WHERE token_hash=?')
      .run(now - 1,sha256(rotatedGuestToken));
    const ended = await fetch(`${cutoverOrigin}/api/internal/game/recover-principal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json','X-CannaBeats-Internal-Token': config.gameServiceToken },
      body: JSON.stringify({ cookie: `cb_guest=${rotatedGuestToken}` }),
    });
    assert.equal(ended.status,200);
    assert.deepEqual(await ended.json(),{ outcome: 'credential_expired' });
    assert.equal(db.prepare('SELECT 1 FROM users WHERE id=?').get(firstPayload.principal.id),undefined);

    const accountInviteActionId = randomUUID();
    const accountInviteResponse = await fetch(
      `${cutoverOrigin}/api/internal/game/guest-invite`,{
        ...inviteRequest,
        body: JSON.stringify({
          actionId: accountInviteActionId,cookie: `cb_session=${browserToken}`,code: 'ABC234',
        }),
      },
    );
    const accountInvite = (await accountInviteResponse.json()).guestInvite;
    const accountAdmissionBody = {
      actionId: randomUUID(),cookie: `cb_session=${browserToken}`,code: 'ABC234',
      name: 'Host',requireInvitation: true,invite: accountInvite,
    };
    const accountAdmission = await fetch(`${cutoverOrigin}/api/internal/game/admit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json','X-CannaBeats-Internal-Token': config.gameServiceToken },
      body: JSON.stringify(accountAdmissionBody),
    });
    assert.equal(accountAdmission.status,200);
    db.prepare('UPDATE state_guest_invites SET expires_at=? WHERE action_id=?')
      .run(now - 1,accountInviteActionId);
    const accountAdmissionReplay = await fetch(`${cutoverOrigin}/api/internal/game/admit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json','X-CannaBeats-Internal-Token': config.gameServiceToken },
      body: JSON.stringify(accountAdmissionBody),
    });
    assert.equal(accountAdmissionReplay.status,200,
      'the exact authenticated admission action must replay after invitation expiry');

    const reservedInviteActionId = randomUUID();
    const reservedInviteResponse = await fetch(
      `${cutoverOrigin}/api/internal/game/guest-invite`,{
        ...inviteRequest,
        body: JSON.stringify({
          actionId: reservedInviteActionId,cookie: `cb_session=${browserToken}`,code: 'ABC234',
        }),
      },
    );
    const reservedInvite = (await reservedInviteResponse.json()).guestInvite;
    const reservedActionId = randomUUID();
    const reservedBody = {
      actionId: reservedActionId,cookie: `cb_session=${browserToken}`,code: 'ABC234',
      name: 'Host',requireInvitation: true,invite: reservedInvite,
    };
    failNextAdmissionContext = true;
    const contextUnavailable = await fetch(`${cutoverOrigin}/api/internal/game/admit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json','X-CannaBeats-Internal-Token': config.gameServiceToken },
      body: JSON.stringify(reservedBody),
    });
    assert.equal(contextUnavailable.status,503);
    assert.ok(db.prepare(`SELECT principal_id FROM state_admission_reservations
      WHERE action_id=?`).get(reservedActionId));
    db.prepare('DELETE FROM state_guest_invites WHERE action_id=?').run(reservedInviteActionId);
    const contextRetry = await fetch(`${cutoverOrigin}/api/internal/game/admit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json','X-CannaBeats-Internal-Token': config.gameServiceToken },
      body: JSON.stringify(reservedBody),
    });
    assert.equal(contextRetry.status,200,
      'a durable principal reservation must outlive invitation consumption and context failure');

  } finally {
    await new Promise((resolve) => cutover.close(resolve));
  }
});
