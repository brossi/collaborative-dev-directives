import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

let db: DatabaseSync | undefined;
let dbPath = "";
export const DATABASE_SCHEMA_MIN_VERSION = 0;
export const DATABASE_SCHEMA_MAX_VERSION = 2;
export const DATABASE_SCHEMA_TARGET_VERSION = 1;
const DEFAULT_DATABASE_BUSY_TIMEOUT_MS = 5_000;

function assertSchemaEnvironment() {
  const contract = {
    CANNABEATS_SCHEMA_MIN_VERSION: DATABASE_SCHEMA_MIN_VERSION,
    CANNABEATS_SCHEMA_MAX_VERSION: DATABASE_SCHEMA_MAX_VERSION,
    CANNABEATS_SCHEMA_TARGET_VERSION: DATABASE_SCHEMA_TARGET_VERSION,
  };
  for (const [name, compiled] of Object.entries(contract)) {
    const configured = process.env[name];
    if (configured !== undefined && configured !== String(compiled)) {
      throw new Error(`${name}=${configured} does not match compiled schema contract ${compiled}`);
    }
  }
}

function databaseBusyTimeoutMs() {
  const configured = process.env.CANNABEATS_DATABASE_BUSY_TIMEOUT_MS;
  if (configured === undefined) return DEFAULT_DATABASE_BUSY_TIMEOUT_MS;
  const parsed = Number(configured);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 60_000) {
    throw new Error("CANNABEATS_DATABASE_BUSY_TIMEOUT_MS must be an integer from 1 through 60000.");
  }
  return parsed;
}

export function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function randomToken() {
  return randomBytes(32).toString("base64url");
}

export function database() {
  assertSchemaEnvironment();
  const configuredPath = process.env.CANNABEATS_DATABASE_PATH
    ?? resolve(process.cwd(), ".data/cannabeats.sqlite");
  if (db && dbPath === configuredPath) return db;
  db?.close();
  db = undefined;
  dbPath = "";
  mkdirSync(dirname(configuredPath), { recursive: true });
  db = new DatabaseSync(configuredPath);
  dbPath = configuredPath;
  try {
    db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = ${databaseBusyTimeoutMs()};
    `);
    db.exec("BEGIN IMMEDIATE");
    const startingVersion = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    if (startingVersion > DATABASE_SCHEMA_MAX_VERSION) {
      throw new Error(
        `Database schema version ${startingVersion} is newer than supported version ${DATABASE_SCHEMA_MAX_VERSION}`,
      );
    }
    if (startingVersion < DATABASE_SCHEMA_MIN_VERSION) {
      throw new Error(
        `Database schema version ${startingVersion} is older than supported version ${DATABASE_SCHEMA_MIN_VERSION}`,
      );
    }
    db.exec(`
    CREATE TABLE IF NOT EXISTS game_runs (
      id TEXT PRIMARY KEY,
      session_code TEXT NOT NULL REFERENCES game_sessions(code) ON DELETE CASCADE,
      state TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      ended_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS game_runs_session_code ON game_runs(session_code);

    CREATE TABLE IF NOT EXISTS game_action_receipts (
      run_id TEXT NOT NULL REFERENCES game_runs(id) ON DELETE CASCADE,
      actor_id TEXT NOT NULL,
      action_id TEXT NOT NULL,
      action TEXT NOT NULL,
      request_fingerprint TEXT NOT NULL,
      accepted_at INTEGER NOT NULL,
      PRIMARY KEY (run_id, actor_id, action_id)
    );
    CREATE INDEX IF NOT EXISTS game_action_receipts_accepted_at
      ON game_action_receipts(accepted_at);

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
    const gameRunColumns = new Set(
      db.prepare("PRAGMA table_info(game_runs)").all().map((column) => (column as { name: string }).name),
    );
    if (!gameRunColumns.has("revision")) {
      db.exec(`
        ALTER TABLE game_runs ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
        UPDATE game_runs
        SET revision = CAST(json_extract(state, '$.revision') AS INTEGER)
        WHERE json_valid(state)
          AND json_type(state, '$.revision') = 'integer'
          AND json_extract(state, '$.revision') >= 0;
      `);
    }
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS game_runs_advance_revision
      AFTER UPDATE OF state ON game_runs
      FOR EACH ROW
      BEGIN
        UPDATE game_runs SET revision = OLD.revision + 1 WHERE id = OLD.id;
      END;
    `);
    const gameSessionColumns = new Set(
      db.prepare("PRAGMA table_info(game_sessions)").all().map((column) => (column as { name: string }).name),
    );
    if (!gameSessionColumns.has("active_run_id")) {
      db.exec("ALTER TABLE game_sessions ADD COLUMN active_run_id TEXT");
    }
    if (!gameSessionColumns.has("audio_mode")) {
      db.exec("ALTER TABLE game_sessions ADD COLUMN audio_mode TEXT NOT NULL DEFAULT 'managed' CHECK (audio_mode IN ('local', 'managed'))");
    }
    if (!gameSessionColumns.has("run_generation")) {
      db.exec(`
        ALTER TABLE game_sessions ADD COLUMN run_generation INTEGER NOT NULL DEFAULT 0;
        UPDATE game_sessions SET run_generation = 1 WHERE active_run_id IS NOT NULL;
      `);
    }
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS game_sessions_advance_run_generation
      AFTER UPDATE OF active_run_id ON game_sessions
      FOR EACH ROW
      WHEN NEW.active_run_id IS NOT OLD.active_run_id
      BEGIN
        UPDATE game_sessions SET run_generation = OLD.run_generation + 1 WHERE code = OLD.code;
      END;
    `);
    const ticketColumns = new Set(
      db.prepare("PRAGMA table_info(desktop_web_tickets)").all().map((column) => (column as { name: string }).name),
    );
    if (!ticketColumns.has("session_code")) {
      db.exec("ALTER TABLE desktop_web_tickets ADD COLUMN session_code TEXT REFERENCES game_sessions(code)");
    }
    const receiptForeignKeys = db.prepare("PRAGMA foreign_key_list(game_action_receipts)").all() as Array<{
      from: string;
      table: string;
    }>;
    if (receiptForeignKeys.some((foreignKey) => foreignKey.from === "actor_id" && foreignKey.table === "users")) {
      db.exec(`
        CREATE TABLE game_action_receipts_run_scoped (
          run_id TEXT NOT NULL REFERENCES game_runs(id) ON DELETE CASCADE,
          actor_id TEXT NOT NULL,
          action_id TEXT NOT NULL,
          action TEXT NOT NULL,
          request_fingerprint TEXT NOT NULL,
          accepted_at INTEGER NOT NULL,
          PRIMARY KEY (run_id, actor_id, action_id)
        );
        INSERT INTO game_action_receipts_run_scoped
          (run_id, actor_id, action_id, action, request_fingerprint, accepted_at)
        SELECT run_id, actor_id, action_id, action, request_fingerprint, accepted_at
        FROM game_action_receipts;
        DROP TABLE game_action_receipts;
        ALTER TABLE game_action_receipts_run_scoped RENAME TO game_action_receipts;
        CREATE INDEX game_action_receipts_accepted_at
          ON game_action_receipts(accepted_at);
      `);
    }
    const resultingVersion = Math.max(startingVersion, DATABASE_SCHEMA_TARGET_VERSION);
    db.exec(`PRAGMA user_version = ${resultingVersion}; COMMIT`);
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Preserve the migration error if SQLite already rolled the transaction back.
    }
    db.close();
    db = undefined;
    dbPath = "";
    throw error;
  }
  return db;
}
