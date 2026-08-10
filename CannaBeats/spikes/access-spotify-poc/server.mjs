import { createPublicKey, randomBytes, randomUUID, timingSafeEqual, verify as verifySignature } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
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
  generatePairingCode,
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
const PAIRING_TTL_MS = 10 * 60 * 1000;
const AGENT_CHALLENGE_TTL_MS = 2 * 60 * 1000;
const HOST_AGENT_PAIRING_LABEL = 'host_agent_pair:';
const DESKTOP_PAIRING_LABEL = 'desktop_pair:';
const GAME_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

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

function secretEnvironment(overrides, overrideName, valueName, fileName) {
  if (Object.hasOwn(overrides, overrideName)) return String(overrides[overrideName] ?? '').trim();
  if (process.env[valueName]) return process.env[valueName].trim();
  const path = process.env[fileName];
  return path ? readFileSync(path, 'utf8').trim() : '';
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
  const relayOriginText = overrides.audioRelayOrigin ?? process.env.AUDIO_RELAY_ORIGIN ?? '';
  const audioRelayOrigin = relayOriginText ? new URL(relayOriginText).origin : '';
  const audioRelayIngestToken = secretEnvironment(
    overrides, 'audioRelayIngestToken', 'AUDIO_RELAY_INGEST_TOKEN', 'AUDIO_RELAY_INGEST_TOKEN_FILE',
  );
  const audioRelayListenToken = secretEnvironment(
    overrides, 'audioRelayListenToken', 'AUDIO_RELAY_LISTEN_TOKEN', 'AUDIO_RELAY_LISTEN_TOKEN_FILE',
  );
  const relayParts = [audioRelayOrigin, audioRelayIngestToken, audioRelayListenToken];
  if (relayParts.some(Boolean) && !relayParts.every(Boolean)) {
    throw new Error('Audio relay origin, ingest token, and listen token must be configured together');
  }
  if (audioRelayIngestToken && audioRelayIngestToken === audioRelayListenToken) {
    throw new Error('Audio relay ingest and listen tokens must differ');
  }
  if (process.env.NODE_ENV === 'production' && audioRelayOrigin && !audioRelayOrigin.startsWith('https://')) {
    throw new Error('AUDIO_RELAY_ORIGIN must use HTTPS in production');
  }
  return {
    origin: origin.origin,
    rpID,
    rpName: overrides.rpName || process.env.RP_NAME || 'CannaBeats PoC',
    port: overrides.port ?? integerEnvironment('PORT', 3002, 1, 65535),
    databasePath: overrides.databasePath || process.env.DATABASE_PATH || resolve(moduleDirectory, 'data/cannabeats-poc.sqlite'),
    spotifyClientId: overrides.spotifyClientId ?? process.env.SPOTIFY_CLIENT_ID ?? '',
    audioRelayOrigin,
    audioRelayIngestToken,
    audioRelayListenToken,
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

function normalizePairingCode(value) {
  return normalizeInvitationCode(value);
}

function makeGameCode() {
  const bytes = randomBytes(6);
  return Array.from(bytes, (byte) => GAME_CODE_ALPHABET[byte % GAME_CODE_ALPHABET.length]).join('');
}

function normalizeGameCode(value) {
  return normalizeInvitationCode(value);
}

function validateAgentPublicKey(value) {
  const encoded = String(value ?? '').trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length > 512) {
    throw new HttpError(400, 'Host application public key is invalid');
  }
  let key;
  try {
    key = createPublicKey({ key: Buffer.from(encoded, 'base64'), format: 'der', type: 'spki' });
  } catch {
    throw new HttpError(400, 'Host application public key is invalid');
  }
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new HttpError(400, 'Host application must use a P-256 signing key');
  }
  return key.export({ format: 'der', type: 'spki' }).toString('base64');
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
      const nativeDesktopRequest = !origin && req.path.startsWith('/desktop/');
      if (!nativeDesktopRequest && (!origin || !constantTimeTextEqual(origin, config.origin))) {
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

  function currentDesktopUser(req) {
    const authorization = req.get('authorization') ?? '';
    const match = /^Bearer ([A-Za-z0-9_-]{32,128})$/.exec(authorization);
    if (!match) return null;
    const tokenHash = sha256(match[1]);
    const session = db.prepare(`
      SELECT desktop_sessions.token_hash, desktop_sessions.display_name AS application_name,
             desktop_sessions.expires_at, users.*
      FROM desktop_sessions JOIN users ON users.id = desktop_sessions.user_id
      WHERE desktop_sessions.token_hash = ? AND desktop_sessions.revoked_at IS NULL
    `).get(tokenHash);
    if (!session || session.expires_at <= Date.now()) return null;
    db.prepare('UPDATE desktop_sessions SET last_seen_at = ? WHERE token_hash = ?')
      .run(Date.now(), tokenHash);
    return session;
  }

  function requireDesktopUser(req, _res, next) {
    const user = currentDesktopUser(req);
    if (!user) return next(new HttpError(401, 'Desktop application authorization required'));
    req.user = user;
    next();
  }

  function gameSessionView(code) {
    const session = db.prepare(`
      SELECT game_sessions.*, users.display_name AS host_display_name
      FROM game_sessions JOIN users ON users.id = game_sessions.host_user_id
      WHERE game_sessions.code = ?
    `).get(code);
    if (!session) return null;
    const members = db.prepare(`
      SELECT users.id, users.display_name, users.role, game_session_members.joined_at,
             game_session_members.last_seen_at
      FROM game_session_members JOIN users ON users.id = game_session_members.user_id
      WHERE game_session_members.session_code = ? ORDER BY game_session_members.joined_at ASC
    `).all(code);
    return {
      code: session.code,
      status: session.status,
      host: { id: session.host_user_id, displayName: session.host_display_name },
      members: members.map((member) => ({
        id: member.id,
        displayName: member.display_name,
        role: member.role,
        joinedAt: new Date(member.joined_at).toISOString(),
      })),
      createdAt: new Date(session.created_at).toISOString(),
      updatedAt: new Date(session.updated_at).toISOString(),
    };
  }

  function createGameSessionForHost(hostUserId) {
    let code = makeGameCode();
    while (db.prepare('SELECT 1 FROM game_sessions WHERE code = ?').get(code)) code = makeGameCode();
    const now = Date.now();
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(`
        INSERT INTO game_sessions (code, host_user_id, status, created_at, updated_at)
        VALUES (?, ?, 'lobby', ?, ?)
      `).run(code, hostUserId, now, now);
      db.prepare(`
        INSERT INTO game_session_members (session_code, user_id, joined_at, last_seen_at)
        VALUES (?, ?, ?, ?)
      `).run(code, hostUserId, now, now);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    writeAuditEvent(db, hostUserId, 'game_session.created', code);
    return gameSessionView(code);
  }

  function existingGameSessionForHost(hostUserId, rawCode) {
    const code = normalizeGameCode(rawCode);
    if (code.length !== 6) throw new HttpError(400, 'Game code is invalid');
    const session = db.prepare(`
      SELECT code, status FROM game_sessions
      WHERE code = ? AND host_user_id = ?
    `).get(code, hostUserId);
    if (!session) throw new HttpError(404, 'Game session was not found for this host account');
    if (session.status === 'ended') throw new HttpError(409, 'This game session has ended');
    db.prepare(`
      UPDATE game_session_members SET last_seen_at = ?
      WHERE session_code = ? AND user_id = ?
    `).run(Date.now(), code, hostUserId);
    return gameSessionView(code);
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

  function verifyHostAgentProof(body) {
    const agentId = cleanText(body?.agentId, { field: 'Host application ID', maximum: 80 });
    const challengeToken = String(body?.challengeToken ?? '');
    const signature = String(body?.signature ?? '');
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(challengeToken)) {
      throw new HttpError(400, 'Host application challenge is invalid');
    }
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(signature) || signature.length > 256) {
      throw new HttpError(400, 'Host application signature is invalid');
    }
    const challengeHash = sha256(challengeToken);
    const pending = db.prepare(`
      SELECT * FROM host_agent_challenges WHERE token_hash = ?
    `).get(challengeHash);
    db.prepare('DELETE FROM host_agent_challenges WHERE token_hash = ?').run(challengeHash);
    if (!pending || pending.agent_id !== agentId || pending.expires_at <= Date.now()) {
      throw new HttpError(400, 'Host application challenge expired or was already used');
    }
    const agent = db.prepare(`
      SELECT host_agents.*, users.display_name AS user_display_name, users.role
      FROM host_agents JOIN users ON users.id = host_agents.user_id
      WHERE host_agents.id = ? AND host_agents.revoked_at IS NULL
    `).get(agentId);
    if (!agent) throw new HttpError(401, 'Host application is not authorized');
    const publicKey = createPublicKey({
      key: Buffer.from(agent.public_key_der, 'base64'), format: 'der', type: 'spki',
    });
    const verified = verifySignature(
      'sha256', Buffer.from(pending.challenge), publicKey, Buffer.from(signature, 'base64'),
    );
    if (!verified) throw new HttpError(401, 'Host application signature was not accepted');
    db.prepare('UPDATE host_agents SET last_seen_at = ? WHERE id = ?').run(Date.now(), agentId);
    writeAuditEvent(db, agent.user_id, 'host_agent.proved', agentId);
    return agent;
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
  const agentPairingLimiter = createRateLimiter({ limit: 30 });
  const desktopPairingLimiter = createRateLimiter({ limit: 20 });

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
    if (pending.label?.startsWith(HOST_AGENT_PAIRING_LABEL)
      || pending.label?.startsWith(DESKTOP_PAIRING_LABEL)) {
      throw new HttpError(400, 'This passkey ceremony belongs to application approval');
    }
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

  app.post('/api/desktop/authorizations/start', desktopPairingLimiter, (req, res) => {
    purgeExpired(db);
    const displayName = cleanText(req.body?.displayName, {
      field: 'Desktop application name', maximum: 80,
    });
    let code = generatePairingCode();
    while (db.prepare('SELECT 1 FROM desktop_authorizations WHERE code_hash = ?').get(
      sha256(normalizePairingCode(code)),
    )) code = generatePairingCode();
    const authorizationToken = randomToken();
    const now = Date.now();
    const expiresAt = now + PAIRING_TTL_MS;
    db.prepare(`
      INSERT INTO desktop_authorizations
        (token_hash, code_hash, display_name, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      sha256(authorizationToken), sha256(normalizePairingCode(code)), displayName, now, expiresAt,
    );
    res.status(201).json({
      status: 'pending',
      code,
      authorizationToken,
      expiresAt: new Date(expiresAt).toISOString(),
      verificationUrl: `${config.origin}/desktop/approve?code=${encodeURIComponent(code)}`,
    });
  });

  app.post('/api/desktop/authorizations/status', desktopPairingLimiter, (req, res) => {
    purgeExpired(db);
    const authorizationToken = String(req.body?.authorizationToken ?? '');
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(authorizationToken)) {
      throw new HttpError(400, 'Desktop authorization token is invalid');
    }
    const tokenHash = sha256(authorizationToken);
    const authorization = db.prepare(`
      SELECT desktop_authorizations.*, users.display_name AS user_display_name, users.role
      FROM desktop_authorizations LEFT JOIN users ON users.id = desktop_authorizations.approved_by
      WHERE desktop_authorizations.token_hash = ?
    `).get(tokenHash);
    if (!authorization) throw new HttpError(404, 'Desktop authorization expired or was not found');
    if (!authorization.approved_by) return res.json({ status: 'pending' });

    const now = Date.now();
    const expiresAt = now + config.sessionTtlDays * 24 * 60 * 60 * 1000;
    db.prepare(`
      INSERT INTO desktop_sessions
        (token_hash, user_id, display_name, created_at, expires_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(token_hash) DO UPDATE SET last_seen_at = excluded.last_seen_at
    `).run(
      tokenHash, authorization.approved_by, authorization.display_name, now, expiresAt, now,
    );
    db.prepare('UPDATE desktop_authorizations SET claimed_at = ? WHERE token_hash = ?')
      .run(now, tokenHash);
    res.json({
      status: 'authorized',
      user: {
        id: authorization.approved_by,
        displayName: authorization.user_display_name,
        role: authorization.role,
      },
      application: { displayName: authorization.display_name },
      expiresAt: new Date(expiresAt).toISOString(),
    });
  });

  app.get('/api/desktop/authorizations/pending', requireUser, (req, res) => {
    purgeExpired(db);
    const normalizedCode = normalizePairingCode(req.query?.code);
    if (normalizedCode.length !== 8) throw new HttpError(400, 'Desktop pairing code is invalid');
    const authorization = db.prepare(`
      SELECT display_name, expires_at, approved_by
      FROM desktop_authorizations WHERE code_hash = ? AND expires_at > ?
    `).get(sha256(normalizedCode), Date.now());
    if (!authorization) throw new HttpError(404, 'Desktop pairing code expired or was not found');
    if (authorization.approved_by && authorization.approved_by !== req.user.id) {
      throw new HttpError(409, 'Desktop pairing request was already approved');
    }
    res.json({
      application: { displayName: authorization.display_name },
      code: `${normalizedCode.slice(0, 4)}-${normalizedCode.slice(4)}`,
      expiresAt: new Date(authorization.expires_at).toISOString(),
      approved: authorization.approved_by === req.user.id,
    });
  });

  app.post('/api/desktop/authorizations/approve/options', requireUser, async (req, res) => {
    purgeExpired(db);
    const normalizedCode = normalizePairingCode(req.body?.code);
    if (normalizedCode.length !== 8) throw new HttpError(400, 'Desktop pairing code is invalid');
    const authorization = db.prepare(`
      SELECT * FROM desktop_authorizations WHERE code_hash = ? AND expires_at > ?
    `).get(sha256(normalizedCode), Date.now());
    if (!authorization) throw new HttpError(404, 'Desktop pairing code expired or was not found');
    if (authorization.approved_by && authorization.approved_by !== req.user.id) {
      throw new HttpError(409, 'Desktop pairing request was already approved');
    }
    const credentials = db.prepare(`
      SELECT id, transports FROM passkey_credentials WHERE user_id = ?
    `).all(req.user.id);
    const options = await generateAuthenticationOptions({
      rpID: config.rpID,
      allowCredentials: credentials.map((credential) => ({
        id: credential.id,
        transports: JSON.parse(credential.transports),
      })),
      userVerification: 'required',
      timeout: CHALLENGE_TTL_MS,
    });
    setChallenge(res, {
      kind: 'authentication',
      challenge: options.challenge,
      userId: req.user.id,
      label: `${DESKTOP_PAIRING_LABEL}${authorization.code_hash}`,
    });
    res.json({ options, application: { displayName: authorization.display_name } });
  });

  app.post('/api/desktop/authorizations/approve/verify', requireUser, async (req, res) => {
    const pending = challengeFromRequest(req, 'authentication');
    if (!pending.label?.startsWith(DESKTOP_PAIRING_LABEL) || pending.user_id !== req.user.id) {
      throw new HttpError(403, 'Desktop pairing ceremony belongs to another request');
    }
    const credentialRow = db.prepare(`
      SELECT * FROM passkey_credentials WHERE id = ? AND user_id = ?
    `).get(req.body?.response?.id, req.user.id);
    if (!credentialRow) throw new HttpError(401, 'Passkey is not authorized for this account');
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
    db.prepare('UPDATE passkey_credentials SET counter = ?, last_used_at = ? WHERE id = ?')
      .run(verification.authenticationInfo.newCounter, Date.now(), credentialRow.id);

    const codeHash = pending.label.slice(DESKTOP_PAIRING_LABEL.length);
    const authorization = db.prepare(`
      SELECT * FROM desktop_authorizations WHERE code_hash = ? AND expires_at > ?
    `).get(codeHash, Date.now());
    if (!authorization) throw new HttpError(404, 'Desktop pairing request expired or was not found');
    if (authorization.approved_by && authorization.approved_by !== req.user.id) {
      throw new HttpError(409, 'Desktop pairing request was already approved');
    }
    db.prepare(`
      UPDATE desktop_authorizations SET approved_at = ?, approved_by = ? WHERE code_hash = ?
    `).run(Date.now(), req.user.id, codeHash);
    writeAuditEvent(db, req.user.id, 'desktop_application.approved', authorization.display_name);
    res.json({
      ok: true,
      message: `${authorization.display_name} is authorized for ${req.user.display_name}.`,
    });
  });

  app.get('/api/desktop-applications', requireUser, (req, res) => {
    purgeExpired(db);
    const applications = db.prepare(`
      SELECT token_hash, display_name, created_at, expires_at, last_seen_at, revoked_at
      FROM desktop_sessions WHERE user_id = ? ORDER BY created_at DESC
    `).all(req.user.id);
    res.json({ applications: applications.map((application) => ({
      id: application.token_hash,
      displayName: application.display_name,
      createdAt: new Date(application.created_at).toISOString(),
      expiresAt: new Date(application.expires_at).toISOString(),
      lastSeenAt: new Date(application.last_seen_at).toISOString(),
      revokedAt: application.revoked_at ? new Date(application.revoked_at).toISOString() : null,
    })) });
  });

  app.delete('/api/desktop-applications/:applicationId', requireUser, (req, res) => {
    if (!/^[a-f0-9]{64}$/.test(req.params.applicationId)) {
      throw new HttpError(400, 'Desktop application ID is invalid');
    }
    const result = db.prepare(`
      UPDATE desktop_sessions SET revoked_at = ?
      WHERE token_hash = ? AND user_id = ? AND revoked_at IS NULL
    `).run(Date.now(), req.params.applicationId, req.user.id);
    if (result.changes !== 1) throw new HttpError(404, 'Desktop application not found');
    writeAuditEvent(db, req.user.id, 'desktop_application.revoked', req.params.applicationId);
    res.status(204).end();
  });

  app.get('/api/desktop/me', requireDesktopUser, (req, res) => {
    res.json({
      user: userView(req.user),
      application: { displayName: req.user.application_name },
    });
  });

  app.delete('/api/desktop/session', requireDesktopUser, (req, res) => {
    const result = db.prepare(`
      UPDATE desktop_sessions SET revoked_at = ?
      WHERE token_hash = ? AND revoked_at IS NULL
    `).run(Date.now(), req.user.token_hash);
    if (result.changes !== 1) throw new HttpError(404, 'Desktop session not found');
    writeAuditEvent(db, req.user.id, 'desktop_application.disconnected', req.user.application_name);
    res.status(204).end();
  });

  app.post('/api/game-sessions', requireUser, (req, res) => {
    if (req.user.role !== 'host') throw new HttpError(403, 'Host role required');
    res.status(201).json({ session: createGameSessionForHost(req.user.id) });
  });

  app.get('/api/game-sessions/current', requireUser, (req, res) => {
    const sessions = db.prepare(`
      SELECT game_sessions.code FROM game_sessions
      JOIN game_session_members ON game_session_members.session_code = game_sessions.code
      WHERE game_session_members.user_id = ? AND game_sessions.status != 'ended'
      ORDER BY game_session_members.last_seen_at DESC
    `).all(req.user.id);
    res.json({ sessions: sessions.map((session) => gameSessionView(session.code)) });
  });

  app.get('/api/game-sessions/:code', requireUser, (req, res) => {
    const code = normalizeGameCode(req.params.code);
    if (code.length !== 6) throw new HttpError(400, 'Game code is invalid');
    const member = db.prepare(`
      SELECT 1 FROM game_session_members WHERE session_code = ? AND user_id = ?
    `).get(code, req.user.id);
    if (!member) throw new HttpError(404, 'Game session not found');
    res.json({ session: gameSessionView(code) });
  });

  app.post('/api/desktop/game-sessions/join', requireDesktopUser, (req, res) => {
    const code = normalizeGameCode(req.body?.code);
    if (code.length !== 6) throw new HttpError(400, 'Game code is invalid');
    const session = db.prepare('SELECT status FROM game_sessions WHERE code = ?').get(code);
    if (!session) throw new HttpError(404, 'Game session not found');
    if (session.status !== 'lobby') throw new HttpError(409, 'This game has already started');
    const now = Date.now();
    db.prepare(`
      INSERT INTO game_session_members (session_code, user_id, joined_at, last_seen_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(session_code, user_id) DO UPDATE SET last_seen_at = excluded.last_seen_at
    `).run(code, req.user.id, now, now);
    db.prepare('UPDATE game_sessions SET updated_at = ? WHERE code = ?').run(now, code);
    writeAuditEvent(db, req.user.id, 'game_session.joined', code);
    res.json({ session: gameSessionView(code) });
  });

  app.get('/api/desktop/game-sessions/current', requireDesktopUser, (req, res) => {
    const sessions = db.prepare(`
      SELECT game_sessions.code FROM game_sessions
      JOIN game_session_members ON game_session_members.session_code = game_sessions.code
      WHERE game_session_members.user_id = ? AND game_sessions.status != 'ended'
      ORDER BY game_session_members.last_seen_at DESC
    `).all(req.user.id);
    res.json({ sessions: sessions.map((session) => gameSessionView(session.code)) });
  });

  app.get('/api/desktop/game-sessions/:code', requireDesktopUser, (req, res) => {
    const code = normalizeGameCode(req.params.code);
    if (code.length !== 6) throw new HttpError(400, 'Game code is invalid');
    const member = db.prepare(`
      SELECT 1 FROM game_session_members WHERE session_code = ? AND user_id = ?
    `).get(code, req.user.id);
    if (!member) throw new HttpError(404, 'Game session not found');
    db.prepare(`
      UPDATE game_session_members SET last_seen_at = ? WHERE session_code = ? AND user_id = ?
    `).run(Date.now(), code, req.user.id);
    res.json({ session: gameSessionView(code) });
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

  app.post('/api/host-agents/pair/start', agentPairingLimiter, (req, res) => {
    purgeExpired(db);
    const displayName = cleanText(req.body?.displayName, {
      field: 'Host application name', maximum: 80,
    });
    const publicKeyDer = validateAgentPublicKey(req.body?.publicKeyDer);
    const code = generatePairingCode();
    const pairingSecret = randomToken();
    const now = Date.now();
    const expiresAt = now + PAIRING_TTL_MS;
    db.prepare(`
      INSERT INTO host_agent_pairings
        (pairing_secret_hash, code_hash, public_key_der, display_name, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      sha256(pairingSecret), sha256(normalizePairingCode(code)), publicKeyDer,
      displayName, now, expiresAt,
    );
    res.status(201).json({
      code,
      pairingSecret,
      expiresAt: new Date(expiresAt).toISOString(),
      verificationUrl: `${config.origin}/?pair=${encodeURIComponent(code)}`,
    });
  });

  app.post('/api/host-agents/pair/status', (req, res) => {
    purgeExpired(db);
    const pairingSecret = String(req.body?.pairingSecret ?? '');
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(pairingSecret)) {
      throw new HttpError(400, 'Pairing secret is invalid');
    }
    let pairing = db.prepare(`
      SELECT * FROM host_agent_pairings WHERE pairing_secret_hash = ?
    `).get(sha256(pairingSecret));
    if (!pairing) throw new HttpError(404, 'Pairing request expired or was not found');
    if (!pairing.approved_at) return res.json({ status: 'pending' });

    if (!pairing.agent_id) {
      db.exec('BEGIN IMMEDIATE');
      try {
        pairing = db.prepare(`
          SELECT * FROM host_agent_pairings WHERE pairing_secret_hash = ?
        `).get(sha256(pairingSecret));
        if (!pairing || !pairing.approved_by) throw new HttpError(409, 'Pairing approval was lost');
        let agent = db.prepare('SELECT * FROM host_agents WHERE public_key_der = ?')
          .get(pairing.public_key_der);
        if (agent && (agent.user_id !== pairing.approved_by || agent.revoked_at)) {
          throw new HttpError(409, 'This application key cannot be paired');
        }
        if (!agent) {
          const agentId = randomUUID();
          db.prepare(`
            INSERT INTO host_agents (id, user_id, public_key_der, display_name, created_at)
            VALUES (?, ?, ?, ?, ?)
          `).run(agentId, pairing.approved_by, pairing.public_key_der, pairing.display_name, Date.now());
          agent = db.prepare('SELECT * FROM host_agents WHERE id = ?').get(agentId);
          writeAuditEvent(db, pairing.approved_by, 'host_agent.paired', agentId);
        }
        db.prepare(`
          UPDATE host_agent_pairings SET agent_id = ? WHERE pairing_secret_hash = ?
        `).run(agent.id, sha256(pairingSecret));
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    }

    const agent = db.prepare(`
      SELECT host_agents.id, host_agents.display_name, users.id AS user_id,
             users.display_name AS user_display_name
      FROM host_agents JOIN users ON users.id = host_agents.user_id
      WHERE host_agents.id = (
        SELECT agent_id FROM host_agent_pairings WHERE pairing_secret_hash = ?
      )
    `).get(sha256(pairingSecret));
    res.json({
      status: 'authorized',
      agent: {
        id: agent.id,
        displayName: agent.display_name,
        userId: agent.user_id,
        userDisplayName: agent.user_display_name,
      },
    });
  });

  app.post('/api/host-agents/pair/approve/options', requireUser, async (req, res) => {
    purgeExpired(db);
    if (req.user.role !== 'host') throw new HttpError(403, 'Host role required');
    const normalizedCode = normalizePairingCode(req.body?.code);
    if (normalizedCode.length !== 8) throw new HttpError(400, 'Pairing code is invalid');
    const pairing = db.prepare(`
      SELECT * FROM host_agent_pairings WHERE code_hash = ? AND expires_at > ?
    `).get(sha256(normalizedCode), Date.now());
    if (!pairing) throw new HttpError(404, 'Pairing code expired or was not found');
    if (pairing.approved_by && pairing.approved_by !== req.user.id) {
      throw new HttpError(409, 'Pairing request was already approved');
    }
    const credentials = db.prepare(`
      SELECT id, transports FROM passkey_credentials WHERE user_id = ?
    `).all(req.user.id);
    const options = await generateAuthenticationOptions({
      rpID: config.rpID,
      allowCredentials: credentials.map((credential) => ({
        id: credential.id,
        transports: JSON.parse(credential.transports),
      })),
      userVerification: 'required',
      timeout: CHALLENGE_TTL_MS,
    });
    setChallenge(res, {
      kind: 'authentication',
      challenge: options.challenge,
      userId: req.user.id,
      label: `${HOST_AGENT_PAIRING_LABEL}${pairing.code_hash}`,
    });
    res.json({ options, application: { displayName: pairing.display_name } });
  });

  app.post('/api/host-agents/pair/approve/verify', requireUser, async (req, res) => {
    const pending = challengeFromRequest(req, 'authentication');
    if (!pending.label?.startsWith(HOST_AGENT_PAIRING_LABEL) || pending.user_id !== req.user.id) {
      throw new HttpError(403, 'Pairing ceremony belongs to another request');
    }
    const credentialRow = db.prepare(`
      SELECT * FROM passkey_credentials WHERE id = ? AND user_id = ?
    `).get(req.body?.response?.id, req.user.id);
    if (!credentialRow) throw new HttpError(401, 'Passkey is not authorized for this account');
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

    const pairingHash = pending.label.slice(HOST_AGENT_PAIRING_LABEL.length);
    const pairing = db.prepare(`
      SELECT * FROM host_agent_pairings WHERE code_hash = ? AND expires_at > ?
    `).get(pairingHash, Date.now());
    if (!pairing) throw new HttpError(404, 'Pairing request expired or was not found');
    if (pairing.approved_by && pairing.approved_by !== req.user.id) {
      throw new HttpError(409, 'Pairing request was already approved');
    }
    db.prepare(`
      UPDATE host_agent_pairings SET approved_at = ?, approved_by = ? WHERE code_hash = ?
    `).run(Date.now(), req.user.id, pairingHash);
    writeAuditEvent(db, req.user.id, 'host_agent.approved', pairing.display_name);
    res.json({ ok: true, message: `${pairing.display_name} is authorized for this host account.` });
  });

  app.post('/api/host-agents/challenge', (req, res) => {
    purgeExpired(db);
    const agentId = cleanText(req.body?.agentId, { field: 'Host application ID', maximum: 80 });
    const agent = db.prepare('SELECT id FROM host_agents WHERE id = ? AND revoked_at IS NULL').get(agentId);
    if (!agent) throw new HttpError(404, 'Host application is not authorized');
    const challengeToken = randomToken();
    const challenge = randomToken();
    const now = Date.now();
    const expiresAt = now + AGENT_CHALLENGE_TTL_MS;
    db.prepare(`
      INSERT INTO host_agent_challenges (token_hash, agent_id, challenge, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(sha256(challengeToken), agentId, challenge, now, expiresAt);
    res.json({ challengeToken, challenge, expiresAt: new Date(expiresAt).toISOString() });
  });

  app.post('/api/host-agents/verify', (req, res) => {
    const agent = verifyHostAgentProof(req.body);
    res.json({
      ok: true,
      agent: { id: agent.id, displayName: agent.display_name },
      user: { id: agent.user_id, displayName: agent.user_display_name, role: agent.role },
      message: `Host application authorization confirmed for ${agent.user_display_name}.`,
    });
  });

  app.post('/api/host-agents/relay-grant', (req, res) => {
    if (!config.audioRelayOrigin || !config.audioRelayIngestToken || !config.audioRelayListenToken) {
      throw new HttpError(503, 'The audio relay is not configured');
    }
    const agent = verifyHostAgentProof(req.body);
    if (agent.role !== 'host') throw new HttpError(403, 'Host role required');
    writeAuditEvent(db, agent.user_id, 'host_agent.relay_grant', agent.id);
    res.json({
      relay: {
        origin: config.audioRelayOrigin,
        ingestToken: config.audioRelayIngestToken,
        listenToken: config.audioRelayListenToken,
        mode: 'poc-shared-static',
      },
    });
  });

  app.post('/api/host-agents/game-sessions/prepare', (req, res) => {
    const agent = verifyHostAgentProof(req.body);
    if (agent.role !== 'host') throw new HttpError(403, 'Host role required');
    const hasExistingCode = typeof req.body?.code === 'string'
      && req.body.code.trim().length > 0;
    const session = hasExistingCode
      ? existingGameSessionForHost(agent.user_id, req.body.code)
      : createGameSessionForHost(agent.user_id);
    writeAuditEvent(
      db,
      agent.user_id,
      hasExistingCode ? 'host_agent.game_session_selected' : 'host_agent.game_session_created',
      session.code,
    );
    res.status(hasExistingCode ? 200 : 201).json({ session, created: !hasExistingCode });
  });

  app.get('/api/host-agents', requireUser, (req, res) => {
    const agents = db.prepare(`
      SELECT id, display_name, created_at, last_seen_at, revoked_at
      FROM host_agents WHERE user_id = ? ORDER BY created_at DESC
    `).all(req.user.id);
    res.json({ agents: agents.map((agent) => ({
      id: agent.id,
      displayName: agent.display_name,
      createdAt: new Date(agent.created_at).toISOString(),
      lastSeenAt: agent.last_seen_at ? new Date(agent.last_seen_at).toISOString() : null,
      revokedAt: agent.revoked_at ? new Date(agent.revoked_at).toISOString() : null,
    })) });
  });

  app.delete('/api/host-agents/:agentId', requireUser, (req, res) => {
    const result = db.prepare(`
      UPDATE host_agents SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL
    `).run(Date.now(), req.params.agentId, req.user.id);
    if (result.changes !== 1) throw new HttpError(404, 'Host application not found');
    db.prepare('DELETE FROM host_agent_challenges WHERE agent_id = ?').run(req.params.agentId);
    writeAuditEvent(db, req.user.id, 'host_agent.revoked', req.params.agentId);
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
  app.get(['/', '/spotify/callback', '/desktop/approve'], (_req, res) => {
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
