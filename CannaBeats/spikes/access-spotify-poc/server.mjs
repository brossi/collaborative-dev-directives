import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import {
  normalizeInvitationCode,
  openDatabase,
  purgeExpired,
  sha256,
  uuidToBytes,
  writeAuditEvent,
} from './db.mjs';

const moduleDirectory = fileURLToPath(new URL('.', import.meta.url));
const SESSION_COOKIE = 'cb_session';
const PENDING_COOKIE = 'cb_webauthn';
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function integerEnvironment(name, fallback, minimum, maximum) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

export function readConfig(overrides = {}) {
  const origin = new URL(overrides.origin || process.env.APP_ORIGIN || 'http://localhost:3002');
  const rpID = overrides.rpID || process.env.RP_ID || origin.hostname;
  if (origin.hostname !== rpID && !origin.hostname.endsWith(`.${rpID}`)) {
    throw new Error('RP_ID must equal APP_ORIGIN hostname or be one of its parent domains');
  }
  if (process.env.NODE_ENV === 'production' && origin.protocol !== 'https:') {
    throw new Error('APP_ORIGIN must use HTTPS in production');
  }
  return {
    origin: origin.origin,
    rpID,
    rpName: overrides.rpName || process.env.RP_NAME || 'CannaBeats PoC',
    port: overrides.port ?? integerEnvironment('PORT', 3002, 1, 65535),
    databasePath: overrides.databasePath || process.env.DATABASE_PATH || resolve(moduleDirectory, 'data/cannabeats-poc.sqlite'),
    spotifyClientId: overrides.spotifyClientId ?? process.env.SPOTIFY_CLIENT_ID ?? '',
    sessionTtlDays: overrides.sessionTtlDays ?? integerEnvironment('SESSION_TTL_DAYS', 30, 1, 365),
    trustProxy: overrides.trustProxy ?? process.env.TRUST_PROXY ?? 'loopback',
  };
}

function parseCookies(header = '') {
  return Object.fromEntries(
    header.split(';').map((entry) => entry.trim()).filter(Boolean).map((entry) => {
      const separator = entry.indexOf('=');
      if (separator === -1) return [entry, ''];
      return [entry.slice(0, separator), decodeURIComponent(entry.slice(separator + 1))];
    }),
  );
}

function secureCookie(name, value, maxAgeSeconds) {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSeconds}`;
}

function clearCookie(name) {
  return `${name}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

function randomToken() {
  return randomBytes(32).toString('base64url');
}

function cleanText(value, { field, minimum = 1, maximum = 80 }) {
  const result = String(value ?? '').trim().replace(/\s+/g, ' ');
  if (result.length < minimum || result.length > maximum) {
    throw new HttpError(400, `${field} must be ${minimum}-${maximum} characters`);
  }
  return result;
}

function userView(row) {
  return { id: row.id, displayName: row.display_name, role: row.role };
}

function constantTimeTextEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

function createRateLimiter({ limit = 30, windowMs = 10 * 60 * 1000 } = {}) {
  const attempts = new Map();
  return (req, _res, next) => {
    const now = Date.now();
    const key = req.ip || req.socket.remoteAddress || 'unknown';
    const recent = (attempts.get(key) || []).filter((timestamp) => timestamp > now - windowMs);
    if (recent.length >= limit) return next(new HttpError(429, 'Too many authentication attempts; try again shortly'));
    recent.push(now);
    attempts.set(key, recent);
    if (attempts.size > 1_000) {
      for (const [address, timestamps] of attempts) {
        if (!timestamps.some((timestamp) => timestamp > now - windowMs)) attempts.delete(address);
      }
    }
    next();
  };
}

export function createApp({ config = readConfig(), db = openDatabase(config.databasePath) } = {}) {
  const app = express();
  const browserBundle = resolve(moduleDirectory, 'node_modules/@simplewebauthn/browser/dist/bundle/index.umd.min.js');
  const publicDirectory = resolve(moduleDirectory, 'public');

  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy': [
        "default-src 'self'",
        "base-uri 'none'",
        "frame-ancestors 'none'",
        "form-action 'self'",
        "script-src 'self' https://sdk.scdn.co",
        "style-src 'self'",
        "img-src 'self' data: https://i.scdn.co",
        "frame-src https://sdk.scdn.co",
        "connect-src 'self' https://accounts.spotify.com https://api.spotify.com wss://dealer.spotify.com",
        "media-src 'self' blob: https://*.scdn.co",
        "worker-src 'self' blob:",
      ].join('; '),
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), publickey-credentials-get=(self)',
      'Referrer-Policy': 'no-referrer',
      'Strict-Transport-Security': 'max-age=31536000',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
    });
    next();
  });
  app.use('/api', express.json({ limit: '64kb', type: 'application/json' }));
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const origin = req.get('origin');
      if (!origin || !constantTimeTextEqual(origin, config.origin)) {
        return next(new HttpError(403, 'Request origin was not accepted'));
      }
    }
    next();
  });

  function challengeFromRequest(req, expectedKind) {
    const token = parseCookies(req.get('cookie'))[PENDING_COOKIE];
    if (!token) throw new HttpError(400, 'Authentication ceremony expired; start again');
    const pending = db.prepare('SELECT * FROM webauthn_challenges WHERE token_hash = ?').get(sha256(token));
    db.prepare('DELETE FROM webauthn_challenges WHERE token_hash = ?').run(sha256(token));
    if (!pending || pending.kind !== expectedKind || pending.expires_at <= Date.now()) {
      throw new HttpError(400, 'Authentication ceremony expired; start again');
    }
    return pending;
  }

  function setChallenge(res, values) {
    const token = randomToken();
    const now = Date.now();
    db.prepare(`
      INSERT INTO webauthn_challenges
        (token_hash, kind, challenge, user_id, invitation_hash, display_name, label, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      sha256(token), values.kind, values.challenge, values.userId ?? null,
      values.invitationHash ?? null, values.displayName ?? null, values.label ?? null,
      now, now + CHALLENGE_TTL_MS,
    );
    res.append('Set-Cookie', secureCookie(PENDING_COOKIE, token, CHALLENGE_TTL_MS / 1000));
  }

  function currentUser(req) {
    const token = parseCookies(req.get('cookie'))[SESSION_COOKIE];
    if (!token) return null;
    const session = db.prepare(`
      SELECT sessions.token_hash, sessions.expires_at, users.*
      FROM sessions JOIN users ON users.id = sessions.user_id
      WHERE sessions.token_hash = ?
    `).get(sha256(token));
    if (!session || session.expires_at <= Date.now()) return null;
    db.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?').run(Date.now(), session.token_hash);
    return session;
  }

  function requireUser(req, _res, next) {
    const user = currentUser(req);
    if (!user) return next(new HttpError(401, 'Sign in required'));
    req.user = user;
    next();
  }

  function issueSession(res, userId) {
    const token = randomToken();
    const now = Date.now();
    const expiresAt = now + config.sessionTtlDays * 24 * 60 * 60 * 1000;
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND expires_at <= ?').run(userId, now);
    db.prepare(`
      INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(sha256(token), userId, now, expiresAt, now);
    res.append('Set-Cookie', secureCookie(SESSION_COOKIE, token, config.sessionTtlDays * 24 * 60 * 60));
    res.append('Set-Cookie', clearCookie(PENDING_COOKIE));
  }

  function storeCredential({ userId, response, registrationInfo, label }) {
    const credential = registrationInfo.credential;
    db.prepare(`
      INSERT INTO passkey_credentials
        (id, user_id, public_key, counter, transports, device_type, backed_up, label, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      credential.id, userId, Buffer.from(credential.publicKey), credential.counter,
      JSON.stringify(response.response.transports || credential.transports || []),
      registrationInfo.credentialDeviceType, registrationInfo.credentialBackedUp ? 1 : 0,
      label, Date.now(),
    );
  }

  const authenticationLimiter = createRateLimiter();
  app.use('/api/auth', authenticationLimiter);

  app.get('/api/health', (_req, res) => {
    const database = db.prepare('SELECT 1 AS ok').get();
    res.json({ ok: database.ok === 1, spotifyConfigured: Boolean(config.spotifyClientId) });
  });

  app.get('/api/config', (_req, res) => {
    res.json({
      appOrigin: config.origin,
      rpID: config.rpID,
      spotifyClientId: config.spotifyClientId,
      spotifyRedirectUri: `${config.origin}/spotify/callback`,
    });
  });

  app.get('/api/me', (req, res) => {
    const user = currentUser(req);
    if (!user) throw new HttpError(401, 'Sign in required');
    res.json({ user: userView(user) });
  });

  app.post('/api/auth/enroll/options', async (req, res) => {
    purgeExpired(db);
    const displayName = cleanText(req.body?.displayName, { field: 'Display name', maximum: 60 });
    const normalizedCode = normalizeInvitationCode(req.body?.invitationCode);
    if (normalizedCode.length < 16 || normalizedCode.length > 40) throw new HttpError(400, 'Invitation code is invalid');
    const invitationHash = sha256(normalizedCode);
    const invitation = db.prepare(`
      SELECT * FROM invitations
      WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?
    `).get(invitationHash, Date.now());
    if (!invitation) throw new HttpError(403, 'Invitation is invalid, expired, or already used');

    const userId = randomUUID();
    const options = await generateRegistrationOptions({
      rpName: config.rpName,
      rpID: config.rpID,
      userID: uuidToBytes(userId),
      userName: userId,
      userDisplayName: displayName,
      attestationType: 'none',
      authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
      timeout: CHALLENGE_TTL_MS,
    });
    setChallenge(res, {
      kind: 'invite_registration', challenge: options.challenge, userId,
      invitationHash, displayName, label: 'First passkey',
    });
    res.json({ options });
  });

  app.post('/api/auth/enroll/verify', async (req, res) => {
    const pending = challengeFromRequest(req, 'invite_registration');
    const verification = await verifyRegistrationResponse({
      response: req.body?.response,
      expectedChallenge: pending.challenge,
      expectedOrigin: config.origin,
      expectedRPID: config.rpID,
      requireUserVerification: true,
    });
    if (!verification.verified || !verification.registrationInfo) throw new HttpError(401, 'Passkey verification failed');

    db.exec('BEGIN IMMEDIATE');
    try {
      const invitation = db.prepare(`
        SELECT * FROM invitations WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?
      `).get(pending.invitation_hash, Date.now());
      if (!invitation) throw new HttpError(409, 'Invitation was already used or expired');
      db.prepare('INSERT INTO users (id, display_name, role, created_at) VALUES (?, ?, ?, ?)')
        .run(pending.user_id, pending.display_name, invitation.role, Date.now());
      storeCredential({
        userId: pending.user_id,
        response: req.body.response,
        registrationInfo: verification.registrationInfo,
        label: pending.label,
      });
      const result = db.prepare(`
        UPDATE invitations SET used_at = ?, used_by = ? WHERE code_hash = ? AND used_at IS NULL
      `).run(Date.now(), pending.user_id, pending.invitation_hash);
      if (result.changes !== 1) throw new HttpError(409, 'Invitation was already used');
      writeAuditEvent(db, pending.user_id, 'user.enrolled');
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    issueSession(res, pending.user_id);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(pending.user_id);
    res.status(201).json({ user: userView(user) });
  });

  app.post('/api/auth/sign-in/options', async (_req, res) => {
    purgeExpired(db);
    const options = await generateAuthenticationOptions({
      rpID: config.rpID,
      userVerification: 'required',
      timeout: CHALLENGE_TTL_MS,
    });
    setChallenge(res, { kind: 'authentication', challenge: options.challenge });
    res.json({ options });
  });

  app.post('/api/auth/sign-in/verify', async (req, res) => {
    const pending = challengeFromRequest(req, 'authentication');
    const credentialRow = db.prepare(`
      SELECT passkey_credentials.*, users.display_name, users.role
      FROM passkey_credentials JOIN users ON users.id = passkey_credentials.user_id
      WHERE passkey_credentials.id = ?
    `).get(req.body?.response?.id);
    if (!credentialRow) throw new HttpError(401, 'Passkey is not authorized');
    const verification = await verifyAuthenticationResponse({
      response: req.body.response,
      expectedChallenge: pending.challenge,
      expectedOrigin: config.origin,
      expectedRPID: config.rpID,
      credential: {
        id: credentialRow.id,
        publicKey: new Uint8Array(credentialRow.public_key),
        counter: credentialRow.counter,
        transports: JSON.parse(credentialRow.transports),
      },
      requireUserVerification: true,
    });
    if (!verification.verified) throw new HttpError(401, 'Passkey verification failed');
    db.prepare(`
      UPDATE passkey_credentials SET counter = ?, last_used_at = ? WHERE id = ?
    `).run(verification.authenticationInfo.newCounter, Date.now(), credentialRow.id);
    writeAuditEvent(db, credentialRow.user_id, 'session.signed_in', credentialRow.id);
    issueSession(res, credentialRow.user_id);
    res.json({ user: userView({
      id: credentialRow.user_id,
      display_name: credentialRow.display_name,
      role: credentialRow.role,
    }) });
  });

  app.post('/api/auth/sign-out', (req, res) => {
    const token = parseCookies(req.get('cookie'))[SESSION_COOKIE];
    if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
    res.append('Set-Cookie', clearCookie(SESSION_COOKIE));
    res.status(204).end();
  });

  app.get('/api/passkeys', requireUser, (req, res) => {
    const rows = db.prepare(`
      SELECT id, label, device_type, backed_up, created_at, last_used_at
      FROM passkey_credentials WHERE user_id = ? ORDER BY created_at ASC
    `).all(req.user.id);
    res.json({ passkeys: rows.map((row) => ({
      id: row.id,
      label: row.label,
      deviceType: row.device_type,
      backedUp: Boolean(row.backed_up),
      createdAt: new Date(row.created_at).toISOString(),
      lastUsedAt: row.last_used_at ? new Date(row.last_used_at).toISOString() : null,
    })) });
  });

  app.post('/api/auth/passkeys/options', requireUser, async (req, res) => {
    const label = cleanText(req.body?.label || 'Additional passkey', { field: 'Passkey label', maximum: 60 });
    const credentials = db.prepare('SELECT id, transports FROM passkey_credentials WHERE user_id = ?').all(req.user.id);
    const options = await generateRegistrationOptions({
      rpName: config.rpName,
      rpID: config.rpID,
      userID: uuidToBytes(req.user.id),
      userName: req.user.id,
      userDisplayName: req.user.display_name,
      attestationType: 'none',
      excludeCredentials: credentials.map((credential) => ({
        id: credential.id,
        transports: JSON.parse(credential.transports),
      })),
      authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
      timeout: CHALLENGE_TTL_MS,
    });
    setChallenge(res, { kind: 'add_passkey', challenge: options.challenge, userId: req.user.id, label });
    res.json({ options });
  });

  app.post('/api/auth/passkeys/verify', requireUser, async (req, res) => {
    const pending = challengeFromRequest(req, 'add_passkey');
    if (pending.user_id !== req.user.id) throw new HttpError(403, 'Passkey ceremony belongs to another user');
    const verification = await verifyRegistrationResponse({
      response: req.body?.response,
      expectedChallenge: pending.challenge,
      expectedOrigin: config.origin,
      expectedRPID: config.rpID,
      requireUserVerification: true,
    });
    if (!verification.verified || !verification.registrationInfo) throw new HttpError(401, 'Passkey verification failed');
    storeCredential({
      userId: req.user.id,
      response: req.body.response,
      registrationInfo: verification.registrationInfo,
      label: pending.label,
    });
    writeAuditEvent(db, req.user.id, 'passkey.added', verification.registrationInfo.credential.id);
    res.status(201).json({ ok: true });
  });

  app.delete('/api/passkeys/:credentialId', requireUser, (req, res) => {
    const count = db.prepare('SELECT COUNT(*) AS count FROM passkey_credentials WHERE user_id = ?').get(req.user.id).count;
    if (count <= 1) throw new HttpError(409, 'The last passkey cannot be removed');
    const result = db.prepare('DELETE FROM passkey_credentials WHERE id = ? AND user_id = ?')
      .run(req.params.credentialId, req.user.id);
    if (result.changes !== 1) throw new HttpError(404, 'Passkey not found');
    writeAuditEvent(db, req.user.id, 'passkey.removed', req.params.credentialId);
    res.status(204).end();
  });

  app.post('/api/host/prove', requireUser, (req, res) => {
    if (req.user.role !== 'host') throw new HttpError(403, 'Host role required');
    writeAuditEvent(db, req.user.id, 'host.proof');
    res.json({ ok: true, message: `Host authorization confirmed for ${req.user.display_name}.` });
  });

  app.get('/vendor/simplewebauthn.js', (_req, res) => {
    if (!existsSync(browserBundle)) throw new HttpError(500, 'WebAuthn browser bundle is unavailable');
    res.set('Cache-Control', 'public, max-age=86400');
    res.sendFile(browserBundle);
  });
  app.get('/sw.js', (_req, res) => {
    res.set({
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Service-Worker-Allowed': '/',
    });
    res.sendFile(resolve(publicDirectory, 'sw.js'));
  });
  app.use(express.static(publicDirectory, { index: false, maxAge: 0 }));
  app.get(['/', '/spotify/callback'], (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.sendFile(resolve(publicDirectory, 'index.html'));
  });

  app.use((error, req, res, _next) => {
    const status = error instanceof HttpError ? error.status : 500;
    if (status >= 500) console.error(req.method, req.path, error);
    res.status(status).json({ error: status >= 500 ? 'Unexpected server error' : error.message });
  });

  return { app, db, config };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = readConfig();
  const { app, db } = createApp({ config });
  const server = app.listen(config.port, '0.0.0.0', () => {
    console.log(`CannaBeats auth PoC listening on port ${config.port} for ${config.origin}`);
  });
  function shutdown(signal) {
    console.log(`Received ${signal}; shutting down`);
    server.close(() => {
      db.close();
      process.exit(0);
    });
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
