import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const INVITATION_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';

function randomAlphabetText(length) {
  const result = [];
  const limit = 256 - (256 % INVITATION_ALPHABET.length);
  while (result.length < length) {
    for (const byte of randomBytes(length - result.length)) {
      if (byte >= limit) continue;
      result.push(INVITATION_ALPHABET[byte % INVITATION_ALPHABET.length]);
    }
  }
  return result.join('');
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function normalizeInvitationCode(value) {
  return String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function generateInvitationCode() {
  const raw = randomAlphabetText(20);
  return raw.match(/.{1,5}/g).join('-');
}

export function generatePairingCode() {
  const raw = randomAlphabetText(8);
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

export function uuidToBytes(uuid) {
  return Buffer.from(uuid.replaceAll('-', ''), 'hex');
}

export function openDatabase(databasePath) {
  mkdirSync(dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('host', 'player')),
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS passkey_credentials (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      public_key BLOB NOT NULL,
      counter INTEGER NOT NULL DEFAULT 0,
      transports TEXT NOT NULL DEFAULT '[]',
      device_type TEXT NOT NULL,
      backed_up INTEGER NOT NULL DEFAULT 0,
      label TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS passkey_credentials_user_id
      ON passkey_credentials(user_id);

    CREATE TABLE IF NOT EXISTS invitations (
      code_hash TEXT PRIMARY KEY,
      role TEXT NOT NULL CHECK (role IN ('host', 'player')),
      note TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      used_at INTEGER,
      used_by TEXT REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS webauthn_challenges (
      token_hash TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('invite_registration', 'add_passkey', 'authentication')),
      challenge TEXT NOT NULL,
      user_id TEXT,
      invitation_hash TEXT,
      display_name TEXT,
      label TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_user_id ON sessions(user_id);

    CREATE TABLE IF NOT EXISTS audit_events (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      event TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS host_agents (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      public_key_der TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER,
      revoked_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS host_agents_user_id ON host_agents(user_id);

    CREATE TABLE IF NOT EXISTS host_agent_pairings (
      pairing_secret_hash TEXT PRIMARY KEY,
      code_hash TEXT NOT NULL UNIQUE,
      public_key_der TEXT NOT NULL,
      display_name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      approved_at INTEGER,
      approved_by TEXT REFERENCES users(id),
      agent_id TEXT REFERENCES host_agents(id)
    );

    CREATE TABLE IF NOT EXISTS host_agent_challenges (
      token_hash TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES host_agents(id) ON DELETE CASCADE,
      challenge TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
  `);
}

export function purgeExpired(db, now = Date.now()) {
  db.prepare('DELETE FROM webauthn_challenges WHERE expires_at <= ?').run(now);
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
  db.prepare('DELETE FROM host_agent_challenges WHERE expires_at <= ?').run(now);
  db.prepare('DELETE FROM host_agent_pairings WHERE expires_at <= ?').run(now);
}

export function createInvitation(db, { role = 'host', note = '', ttlHours = 168 } = {}) {
  if (!['host', 'player'].includes(role)) throw new Error('Role must be host or player');
  if (!Number.isFinite(ttlHours) || ttlHours <= 0 || ttlHours > 24 * 365) {
    throw new Error('Invitation lifetime must be between 0 and 8,760 hours');
  }
  const code = generateInvitationCode();
  const now = Date.now();
  const expiresAt = now + ttlHours * 60 * 60 * 1000;
  db.prepare(`
    INSERT INTO invitations (code_hash, role, note, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(sha256(normalizeInvitationCode(code)), role, String(note).slice(0, 200), now, expiresAt);
  return { code, role, note, expiresAt };
}

export function writeAuditEvent(db, userId, event, detail = '') {
  db.prepare(`
    INSERT INTO audit_events (id, user_id, event, detail, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(randomUUID(), userId ?? null, event, String(detail).slice(0, 500), Date.now());
}
