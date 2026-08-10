import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

let db: DatabaseSync | undefined;
let dbPath = "";

export function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function randomToken() {
  return randomBytes(32).toString("base64url");
}

export function database() {
  const configuredPath = process.env.CANNABEATS_DATABASE_PATH
    ?? resolve(process.cwd(), ".data/cannabeats.sqlite");
  if (db && dbPath === configuredPath) return db;
  db?.close();
  mkdirSync(dirname(configuredPath), { recursive: true });
  db = new DatabaseSync(configuredPath);
  dbPath = configuredPath;
  db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS game_runs (
      id TEXT PRIMARY KEY,
      session_code TEXT NOT NULL REFERENCES game_sessions(code) ON DELETE CASCADE,
      state TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      ended_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS game_runs_session_code ON game_runs(session_code);

    CREATE TABLE IF NOT EXISTS game_run_player_identities (
      run_id TEXT NOT NULL REFERENCES game_runs(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      player_id TEXT NOT NULL,
      joined_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      PRIMARY KEY (run_id, user_id),
      UNIQUE (run_id, player_id)
    );
    CREATE INDEX IF NOT EXISTS game_run_player_identities_user_id
      ON game_run_player_identities(user_id);

    CREATE TABLE IF NOT EXISTS game_guest_invites (
      token_hash TEXT PRIMARY KEY,
      session_code TEXT NOT NULL REFERENCES game_sessions(code) ON DELETE CASCADE,
      created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      revoked_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS game_guest_invites_session_code
      ON game_guest_invites(session_code);

    CREATE TABLE IF NOT EXISTS game_guest_users (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      session_code TEXT NOT NULL REFERENCES game_sessions(code) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS game_guest_sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      session_code TEXT NOT NULL REFERENCES game_sessions(code) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      revoked_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS game_guest_sessions_user_id
      ON game_guest_sessions(user_id);

    /* Legacy engine-room tables remain readable during migration, but are no longer canonical. */
    CREATE TABLE IF NOT EXISTS rooms (
      code TEXT PRIMARY KEY,
      host_user_id TEXT NOT NULL REFERENCES users(id),
      state TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS rooms_host_user_id ON rooms(host_user_id);

    CREATE TABLE IF NOT EXISTS room_player_identities (
      room_code TEXT NOT NULL REFERENCES rooms(code) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      player_id TEXT NOT NULL,
      joined_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      PRIMARY KEY (room_code, user_id),
      UNIQUE (room_code, player_id)
    );
    CREATE INDEX IF NOT EXISTS room_player_identities_user_id
      ON room_player_identities(user_id);

    CREATE TABLE IF NOT EXISTS desktop_web_tickets (
      token_hash TEXT PRIMARY KEY,
      desktop_session_hash TEXT NOT NULL REFERENCES desktop_sessions(token_hash) ON DELETE CASCADE,
      room_code TEXT,
      session_code TEXT REFERENCES game_sessions(code),
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS desktop_web_sessions (
      token_hash TEXT PRIMARY KEY,
      desktop_session_hash TEXT NOT NULL REFERENCES desktop_sessions(token_hash) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS desktop_web_sessions_desktop_session
      ON desktop_web_sessions(desktop_session_hash);

    CREATE TABLE IF NOT EXISTS managed_audio_sources (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER,
      device_id TEXT,
      last_error TEXT
    );

    CREATE TABLE IF NOT EXISTS managed_audio_leases (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL UNIQUE REFERENCES managed_audio_sources(id) ON DELETE CASCADE,
      session_code TEXT NOT NULL UNIQUE REFERENCES game_sessions(code) ON DELETE CASCADE,
      acquired_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      acquired_at INTEGER NOT NULL,
      renewed_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      playback_status TEXT NOT NULL DEFAULT 'ready',
      last_error TEXT
    );
    CREATE INDEX IF NOT EXISTS managed_audio_leases_expires_at
      ON managed_audio_leases(expires_at);

    CREATE TABLE IF NOT EXISTS managed_audio_commands (
      id TEXT PRIMARY KEY,
      lease_id TEXT NOT NULL REFERENCES managed_audio_leases(id) ON DELETE CASCADE,
      source_id TEXT NOT NULL REFERENCES managed_audio_sources(id) ON DELETE CASCADE,
      session_code TEXT NOT NULL REFERENCES game_sessions(code) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('play', 'pause', 'resume')),
      track_uri TEXT,
      requested_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      delivered_at INTEGER,
      completed_at INTEGER,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS managed_audio_commands_pending
      ON managed_audio_commands(source_id, completed_at, created_at);
  `);
  const gameSessionColumns = new Set(
    db.prepare("PRAGMA table_info(game_sessions)").all().map((column) => (column as { name: string }).name),
  );
  if (!gameSessionColumns.has("active_run_id")) {
    db.exec("ALTER TABLE game_sessions ADD COLUMN active_run_id TEXT");
  }
  const ticketColumns = new Set(
    db.prepare("PRAGMA table_info(desktop_web_tickets)").all().map((column) => (column as { name: string }).name),
  );
  if (!ticketColumns.has("session_code")) {
    db.exec("ALTER TABLE desktop_web_tickets ADD COLUMN session_code TEXT REFERENCES game_sessions(code)");
  }
  return db;
}
