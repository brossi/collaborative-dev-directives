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
  `);
  return db;
}
