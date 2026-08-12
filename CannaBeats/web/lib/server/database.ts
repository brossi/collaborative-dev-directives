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
export const DATABASE_GAME_EVENT_REASON_CODES = [
  "authentication_required", "browser_unavailable", "device_unavailable",
  "explicit_release", "game_abandoned", "game_api_unavailable", "game_completed",
  "lease_expired", "managed_playback_failed", "relay_unavailable",
  "source_selected_local", "spotify_unavailable", "unrecognized_reason",
] as const;
const DATABASE_GAME_EVENT_TYPES = [
  "player_joined", "player_removed", "game_configured", "game_started",
  "track_requested", "placement_locked", "placement_retracted", "answer_revealed",
  "round_advanced", "track_skipped", "game_completed", "game_abandoned",
  "audio_source_selected", "audio_lease_acquired", "audio_lease_released",
  "audio_command_requested", "audio_command_delivered", "audio_command_completed",
  "audio_command_failed", "audio_command_interrupted", "audio_command_cancelled",
  "audio_command_outcome_unknown", "audio_lease_expired", "audio_lease_renewed",
  "audio_source_recovered",
] as const;
const DATABASE_GAME_EVENT_OUTCOMES = [
  "accepted", "completed", "failed", "abandoned", "interrupted", "recovered",
  "cancelled", "unknown",
] as const;

function sqlList(values: readonly string[]) {
  return values.map((value) => `'${value}'`).join(", ");
}

function canonicalGameEventsSql(ifNotExists = false) {
  return `CREATE TABLE ${ifNotExists ? "IF NOT EXISTS " : ""}game_events (
    run_id TEXT NOT NULL REFERENCES game_runs(id) ON DELETE CASCADE,
    sequence INTEGER NOT NULL,
    event_type TEXT NOT NULL CHECK (event_type IN (${sqlList(DATABASE_GAME_EVENT_TYPES)})),
    outcome TEXT NOT NULL CHECK (outcome IN (${sqlList(DATABASE_GAME_EVENT_OUTCOMES)})),
    actor_type TEXT NOT NULL CHECK (actor_type IN ('host', 'player', 'source', 'system')),
    actor_ref TEXT,
    action_id TEXT,
    command_ref TEXT,
    round INTEGER CHECK (round IS NULL OR round >= 0),
    detail_code TEXT CHECK (detail_code IS NULL OR detail_code IN (
      'host', 'phone', 'local', 'managed', 'play', 'pause', 'resume', 'correct', 'incorrect'
    )),
    detail_value INTEGER CHECK (detail_value IS NULL OR detail_value >= 0),
    reason_code TEXT CHECK (reason_code IS NULL OR reason_code IN (${sqlList(DATABASE_GAME_EVENT_REASON_CODES)})),
    occurred_at INTEGER NOT NULL,
    PRIMARY KEY (run_id, sequence)
  )`;
}

function canonicalCoverageSql(ifNotExists = false) {
  return `CREATE TABLE ${ifNotExists ? "IF NOT EXISTS " : ""}game_event_coverage (
    run_id TEXT PRIMARY KEY REFERENCES game_runs(id) ON DELETE CASCADE,
    baseline_revision INTEGER NOT NULL CHECK (baseline_revision >= 0),
    last_recorded_revision INTEGER NOT NULL CHECK (last_recorded_revision >= baseline_revision),
    started_at INTEGER NOT NULL CHECK (started_at > 0),
    purged_at INTEGER CHECK (purged_at IS NULL OR purged_at > 0),
    lifecycle_state TEXT NOT NULL DEFAULT 'recording'
      CHECK (lifecycle_state IN ('recording', 'terminal_pending', 'sealed', 'purging', 'purged'))
  )`;
}

function canonicalManagedOutcomesSql(ifNotExists = false) {
  return `CREATE TABLE ${ifNotExists ? "IF NOT EXISTS " : ""}managed_audio_command_outcomes (
    command_id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL REFERENCES managed_audio_sources(id) ON DELETE RESTRICT,
    run_id TEXT REFERENCES game_runs(id) ON DELETE CASCADE,
    completion_fingerprint TEXT NOT NULL CHECK (json_valid(completion_fingerprint)),
    completed_at INTEGER NOT NULL CHECK (completed_at >= 0),
    command_state TEXT NOT NULL DEFAULT 'queued'
      CHECK (command_state IN ('queued','claimed','executing','completed','failed','outcome_unknown','cancelled')),
    claim_generation TEXT,
    CHECK (
      (command_state IN ('queued','cancelled')
        AND claim_generation IS NULL AND completed_at = 0
        AND json_extract(completion_fingerprint, '$.pending') = 1)
      OR (command_state IN ('claimed','executing','outcome_unknown')
        AND claim_generation IS NOT NULL AND length(claim_generation) > 0
        AND completed_at = 0
        AND json_extract(completion_fingerprint, '$.pending') = 1)
      OR (command_state IN ('completed','failed')
        AND claim_generation IS NOT NULL AND length(claim_generation) > 0
        AND completed_at > 0
        AND json_type(completion_fingerprint, '$.ok') IN ('true','false'))
    )
  )`;
}

function canonicalManagedCommandsSql(ifNotExists = false) {
  return `CREATE TABLE ${ifNotExists ? "IF NOT EXISTS " : ""}managed_audio_commands (
    id TEXT PRIMARY KEY,
    lease_id TEXT REFERENCES managed_audio_leases(id) ON DELETE SET NULL,
    source_id TEXT NOT NULL REFERENCES managed_audio_sources(id) ON DELETE RESTRICT,
    session_code TEXT NOT NULL REFERENCES game_sessions(code) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('play', 'pause', 'resume')),
    track_uri TEXT,
    requested_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    delivered_at INTEGER,
    completed_at INTEGER,
    error TEXT,
    completion_fingerprint TEXT
  )`;
}

function normalizedSchemaSql(sql: string) {
  return sql.replace(/\bIF\s+NOT\s+EXISTS\b/gi, "").replace(/\s+/g, " ").trim().toLowerCase();
}

const GAME_EVENTS_SCHEMA_DIGEST = createHash("sha256")
  .update(normalizedSchemaSql(canonicalGameEventsSql()))
  .digest("hex");
const HISTORY_FEATURE_OBJECTS = [
  "game_event_coverage",
  "game_history_terminal_evidence",
  "game_events_history_write_guard",
  "game_event_coverage_lifecycle_guard",
  "game_event_coverage_initial_guard",
  "game_event_coverage_identity_guard",
  "game_events_immutable_update",
  "game_events_sealed_delete_guard",
] as const;
const MANAGED_AUDIO_FEATURE_OBJECTS = [
  "managed_audio_commands",
  "managed_audio_command_outcomes",
  "managed_audio_command_state_insert_guard",
  "managed_audio_command_state_update_guard",
  "managed_audio_command_identity_guard",
  "managed_audio_command_intent_guard",
  "managed_audio_lease_delete_transition",
  "managed_audio_source_delete_guard",
  "managed_audio_command_outcome_delete_guard",
] as const;
const HISTORY_PURGE_GUARD_OBJECTS = [
  "game_event_coverage_purged_immutable",
  "game_action_receipts_purged_write_guard",
  "game_runs_purged_delete_guard",
] as const;
const MANAGED_AUDIO_PURGE_GUARD_OBJECTS = [
  "managed_audio_outcomes_purged_insert_guard",
  "managed_audio_outcomes_purged_update_guard",
] as const;

function featureDigest(contract: string) {
  return createHash("sha256").update(contract).digest("hex");
}

function schemaObjectsDigest(candidate: DatabaseSync, names: readonly string[]) {
  const objects = candidate.prepare(`
    SELECT type, name, sql FROM sqlite_schema
    WHERE name IN (${names.map(() => "?").join(", ")})
    ORDER BY type, name
  `).all(...names) as Array<{ type: string; name: string; sql: string | null }>;
  if (objects.length !== names.length) {
    const present = new Set(objects.map((object) => object.name));
    throw new Error(`Canonical feature objects are missing (${names.filter((name) =>
      !present.has(name)).join(", ")}).`);
  }
  return featureDigest(objects.map((object) => [
    object.type,
    object.name,
    normalizedSchemaSql(object.sql ?? ""),
  ].join(":" )).join("\n"));
}

function verifyRecordedFeature(
  candidate: DatabaseSync,
  name: string,
  objectNames: readonly string[],
) {
  const recorded = candidate.prepare(`
    SELECT digest FROM cannabeats_feature_migrations WHERE name = ?
  `).get(name) as { digest: string } | undefined;
  if (!recorded) return false;
  if (recorded.digest !== schemaObjectsDigest(candidate, objectNames)) {
    throw new Error(`Recorded feature migration ${name} failed canonical schema verification.`);
  }
  return true;
}

function recordFeatureMigration(candidate: DatabaseSync, name: string, digest: string) {
  const recorded = candidate.prepare(`
    SELECT digest FROM cannabeats_feature_migrations WHERE name = ?
  `).get(name) as { digest: string } | undefined;
  if (recorded && recorded.digest !== digest) {
    throw new Error(`Recorded feature migration ${name} does not match this application build.`);
  }
  if (!recorded) {
    candidate.prepare(`
      INSERT INTO cannabeats_feature_migrations (name, digest, applied_at)
      VALUES (?, ?, ?)
    `).run(name, digest, Date.now());
  }
}

function verifyGameEventsBehavior(candidate: DatabaseSync) {
  const suffix = randomBytes(8).toString("hex");
  const userId = `00000000-0000-4000-8000-${suffix.padEnd(12, "0").slice(0, 12)}`;
  const runId = `10000000-0000-4000-8000-${suffix.padEnd(12, "0").slice(0, 12)}`;
  const code = `V${suffix.slice(0, 5).toUpperCase()}`;
  const now = Date.now();
  candidate.exec("SAVEPOINT verify_game_events_contract");
  try {
    candidate.prepare(`
      INSERT INTO users (id, display_name, role, created_at)
      VALUES (?, 'Schema verifier', 'host', ?)
    `).run(userId, now);
    candidate.prepare(`
      INSERT INTO game_sessions
        (code, host_user_id, status, active_run_id, created_at, updated_at)
      VALUES (?, ?, 'playing', ?, ?, ?)
    `).run(code, userId, runId, now, now);
    candidate.prepare(`
      INSERT INTO game_runs (id, session_code, state, created_at, updated_at)
      VALUES (?, ?, '{"phase":"playing"}', ?, ?)
    `).run(runId, code, now, now);
    candidate.prepare(`
      INSERT OR IGNORE INTO game_event_coverage
        (run_id, baseline_revision, last_recorded_revision, started_at)
      VALUES (?, 0, 0, ?)
    `).run(runId, now);
    candidate.prepare(`
      INSERT INTO game_events
        (run_id, sequence, event_type, outcome, actor_type, occurred_at)
      VALUES (?, 1, 'game_started', 'accepted', 'host', ?)
    `).run(runId, now);
    let rejected = false;
    try {
      candidate.prepare(`
        INSERT INTO game_events
          (run_id, sequence, event_type, outcome, actor_type, reason_code, occurred_at)
        VALUES (?, 2, 'audio_command_failed', 'failed', 'source', 'schema_probe_secret', ?)
      `).run(runId, now);
    } catch {
      rejected = true;
    }
    if (!rejected) throw new Error("Game-events schema accepted a non-taxonomy reason code.");
  } finally {
    candidate.exec("ROLLBACK TO verify_game_events_contract; RELEASE verify_game_events_contract");
  }
}

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
      PRAGMA recursive_triggers = ON;
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
      ended_at INTEGER,
      terminal_outcome TEXT CHECK (terminal_outcome IS NULL OR terminal_outcome IN ('completed', 'abandoned'))
    );
    CREATE INDEX IF NOT EXISTS game_runs_session_code ON game_runs(session_code);

    ${canonicalCoverageSql(true)};

    CREATE TABLE IF NOT EXISTS cannabeats_feature_migrations (
      name TEXT PRIMARY KEY,
      digest TEXT NOT NULL CHECK (length(digest) = 64),
      applied_at INTEGER NOT NULL
    );
    CREATE TRIGGER IF NOT EXISTS cannabeats_feature_migrations_immutable_update
    BEFORE UPDATE ON cannabeats_feature_migrations
    BEGIN
      SELECT RAISE(ABORT, 'feature migration records are immutable');
    END;
    CREATE TRIGGER IF NOT EXISTS cannabeats_feature_migrations_immutable_delete
    BEFORE DELETE ON cannabeats_feature_migrations
    BEGIN
      SELECT RAISE(ABORT, 'feature migration records are immutable');
    END;

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

    ${canonicalGameEventsSql(true)};
    CREATE INDEX IF NOT EXISTS game_events_occurred_at ON game_events(occurred_at);

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
      last_error TEXT,
      release_reason TEXT CHECK (release_reason IS NULL OR release_reason IN (
        'explicit_release','lease_expired','source_selected_local','game_completed','game_abandoned'
      ))
    );
    CREATE INDEX IF NOT EXISTS managed_audio_leases_expires_at
      ON managed_audio_leases(expires_at);

    ${canonicalManagedCommandsSql(true)};
    CREATE INDEX IF NOT EXISTS managed_audio_commands_pending
      ON managed_audio_commands(source_id, completed_at, created_at);

    CREATE TABLE IF NOT EXISTS managed_audio_command_outcomes (
      command_id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL REFERENCES managed_audio_sources(id) ON DELETE CASCADE,
      run_id TEXT REFERENCES game_runs(id) ON DELETE CASCADE,
      completion_fingerprint TEXT NOT NULL,
      completed_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS managed_audio_command_outcomes_completed_at
      ON managed_audio_command_outcomes(completed_at);
  `);
    const gameRunColumns = new Set(
      db.prepare("PRAGMA table_info(game_runs)").all().map((column) => (column as { name: string }).name),
    );
    if (!gameRunColumns.has("terminal_outcome")) {
      db.exec(`ALTER TABLE game_runs ADD COLUMN terminal_outcome TEXT
        CHECK (terminal_outcome IS NULL OR terminal_outcome IN ('completed', 'abandoned'))`);
      gameRunColumns.add("terminal_outcome");
    }
    const eventColumns = new Set(
      db.prepare("PRAGMA table_info(game_events)").all().map((column) => (column as { name: string }).name),
    );
    const eventTableSql = (db.prepare(`
      SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'game_events'
    `).get() as { sql: string }).sql;
    const recordedEventMigration = db.prepare(`
      SELECT digest FROM cannabeats_feature_migrations WHERE name = 'game_events_canonical_v2'
    `).get() as { digest: string } | undefined;
    if (recordedEventMigration && recordedEventMigration.digest !== GAME_EVENTS_SCHEMA_DIGEST) {
      throw new Error("Recorded game-events migration digest does not match this application build.");
    }
    if (
      recordedEventMigration
      && normalizedSchemaSql(eventTableSql) !== normalizedSchemaSql(canonicalGameEventsSql())
    ) {
      throw new Error("Recorded game-events migration failed canonical schema verification.");
    }
    if (normalizedSchemaSql(eventTableSql) !== normalizedSchemaSql(canonicalGameEventsSql())) {
      const commandRef = eventColumns.has("command_ref") ? "command_ref" : "NULL";
      db.exec(`
        ALTER TABLE game_events RENAME TO game_events_before_lifecycle;
        ${canonicalGameEventsSql()};
        INSERT INTO game_events
          (run_id, sequence, event_type, outcome, actor_type, actor_ref, action_id, command_ref,
           round, detail_code, detail_value, reason_code, occurred_at)
        SELECT run_id, sequence, event_type, outcome, actor_type, actor_ref, action_id, ${commandRef},
               round, detail_code, detail_value,
               CASE
                 WHEN reason_code IS NULL OR reason_code IN (
                   'authentication_required', 'browser_unavailable', 'device_unavailable',
                   'explicit_release', 'game_abandoned', 'game_api_unavailable', 'game_completed',
                   'lease_expired', 'managed_playback_failed', 'relay_unavailable',
                   'source_selected_local', 'spotify_unavailable', 'unrecognized_reason'
                 ) THEN reason_code
                 ELSE 'unrecognized_reason'
               END,
               occurred_at
        FROM game_events_before_lifecycle;
        DROP TABLE game_events_before_lifecycle;
        CREATE INDEX game_events_occurred_at ON game_events(occurred_at);
      `);
    }
    const verifiedEventTableSql = (db.prepare(`
      SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'game_events'
    `).get() as { sql: string }).sql;
    if (normalizedSchemaSql(verifiedEventTableSql) !== normalizedSchemaSql(canonicalGameEventsSql())) {
      throw new Error("Game-events schema failed canonical verification.");
    }
    const accessPrerequisitesExist = ["users", "game_sessions"].every((name) => Boolean(
      db!.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(name),
    ));
    if (accessPrerequisitesExist) verifyGameEventsBehavior(db);
    recordFeatureMigration(db, "game_events_canonical_v2", GAME_EVENTS_SCHEMA_DIGEST);
    const historyFeatureVerified = verifyRecordedFeature(
      db, "history_lifecycle_v4", HISTORY_FEATURE_OBJECTS,
    );
    if (!historyFeatureVerified) {
    const coverageColumns = new Set(
      db.prepare("PRAGMA table_info(game_event_coverage)").all()
        .map((column) => (column as { name: string }).name),
    );
    if (!coverageColumns.has("purged_at")) {
      db.exec("ALTER TABLE game_event_coverage ADD COLUMN purged_at INTEGER");
    }
    if (!coverageColumns.has("lifecycle_state")) {
      db.exec("ALTER TABLE game_event_coverage ADD COLUMN lifecycle_state TEXT NOT NULL DEFAULT 'recording'");
    }
    const coverageSql = (db.prepare(`
      SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'game_event_coverage'
    `).get() as { sql: string }).sql;
    if (normalizedSchemaSql(coverageSql) !== normalizedSchemaSql(canonicalCoverageSql())) {
      db.exec(`
        ALTER TABLE game_event_coverage RENAME TO game_event_coverage_before_canonical;
        ${canonicalCoverageSql()};
        INSERT INTO game_event_coverage
          (run_id, baseline_revision, last_recorded_revision, started_at, purged_at, lifecycle_state)
        SELECT run_id,
               MAX(0, baseline_revision),
               MAX(MAX(0, baseline_revision), last_recorded_revision),
               MAX(1, started_at),
               CASE WHEN purged_at > 0 THEN purged_at ELSE NULL END,
               CASE
                 WHEN purged_at > 0 THEN 'purged'
                 WHEN lifecycle_state IN ('recording','terminal_pending','sealed','purging')
                   THEN lifecycle_state
                 ELSE 'recording'
               END
        FROM game_event_coverage_before_canonical;
        DROP TABLE game_event_coverage_before_canonical;
      `);
    }
    db.exec(`
      DROP TRIGGER IF EXISTS game_event_coverage_lifecycle_guard;
      UPDATE game_event_coverage
      SET lifecycle_state = CASE
        WHEN purged_at IS NOT NULL THEN 'purged'
        ELSE 'recording'
      END
      WHERE lifecycle_state NOT IN ('recording','terminal_pending','sealed','purging','purged')
         OR (purged_at IS NOT NULL AND lifecycle_state <> 'purged');
      DROP VIEW IF EXISTS game_history_terminal_evidence;
      CREATE VIEW game_history_terminal_evidence AS
      SELECT c.run_id
      FROM game_event_coverage c
      JOIN game_runs r ON r.id = c.run_id
      JOIN game_sessions s ON s.code = r.session_code
      WHERE s.status = 'ended'
        AND s.active_run_id = r.id
        AND typeof(r.ended_at) = 'integer' AND r.ended_at > 0
        AND typeof(r.revision) = 'integer' AND r.revision >= 0
        AND r.revision = c.last_recorded_revision
        AND json_valid(r.state)
        AND (
          (r.terminal_outcome = 'completed' AND json_extract(r.state, '$.phase') = 'finished')
          OR (r.terminal_outcome = 'abandoned'
              AND json_extract(r.state, '$.phase') IN ('lobby','ready','playing','placed','revealed'))
        )
        AND 1 = (
          SELECT COUNT(*) FROM game_events e
          WHERE e.run_id = r.id AND e.event_type IN ('game_completed','game_abandoned')
        )
        AND 1 = (
          SELECT COUNT(*) FROM game_events e
          WHERE e.run_id = r.id
            AND ((r.terminal_outcome = 'completed'
                  AND e.event_type = 'game_completed' AND e.outcome = 'completed')
              OR (r.terminal_outcome = 'abandoned'
                  AND e.event_type = 'game_abandoned' AND e.outcome = 'abandoned'))
        )
        AND NOT EXISTS (
          SELECT 1 FROM managed_audio_command_outcomes o
          WHERE o.run_id = r.id AND o.command_state IN ('queued','claimed','executing')
        )
        AND NOT EXISTS (
          SELECT 1 FROM game_events requested
          WHERE requested.run_id = r.id
            AND requested.event_type = 'audio_command_requested'
            AND (requested.command_ref IS NULL OR NOT EXISTS (
              SELECT 1 FROM managed_audio_command_outcomes o
              WHERE o.command_id = requested.command_ref AND o.run_id = r.id
            ))
        );
      UPDATE game_event_coverage
      SET lifecycle_state='recording', purged_at=NULL
      WHERE lifecycle_state IN ('terminal_pending','sealed','purging')
        AND NOT EXISTS (
          SELECT 1 FROM game_runs r
          JOIN game_sessions s ON s.code=r.session_code
          WHERE r.id=game_event_coverage.run_id
            AND s.status='ended' AND s.active_run_id=r.id
            AND typeof(r.ended_at)='integer' AND r.ended_at>0
            AND json_valid(r.state)
            AND ((r.terminal_outcome='completed' AND json_extract(r.state,'$.phase')='finished')
              OR (r.terminal_outcome='abandoned'
                AND json_extract(r.state,'$.phase') IN ('lobby','ready','playing','placed','revealed')))
            AND 1=(SELECT COUNT(*) FROM game_events e WHERE e.run_id=r.id
              AND e.event_type IN ('game_completed','game_abandoned'))
            AND 1=(SELECT COUNT(*) FROM game_events e WHERE e.run_id=r.id
              AND ((r.terminal_outcome='completed' AND e.event_type='game_completed'
                    AND e.outcome='completed')
                OR (r.terminal_outcome='abandoned' AND e.event_type='game_abandoned'
                    AND e.outcome='abandoned')))
        );
      DROP TRIGGER IF EXISTS game_events_history_write_guard;
      CREATE TRIGGER game_events_history_write_guard
      BEFORE INSERT ON game_events
      WHEN NOT EXISTS (
        SELECT 1 FROM game_event_coverage
        WHERE run_id = NEW.run_id
          AND (
            lifecycle_state = 'recording'
            OR (
              lifecycle_state = 'terminal_pending'
              AND NEW.event_type IN (
                'audio_command_completed', 'audio_command_failed', 'audio_command_outcome_unknown'
              )
              AND NEW.command_ref IS NOT NULL
              AND EXISTS (
                SELECT 1 FROM managed_audio_command_outcomes
                WHERE command_id = NEW.command_ref AND run_id = NEW.run_id
              )
            )
          )
      )
      BEGIN
        SELECT RAISE(ABORT, 'game history is sealed or purged');
      END;
      CREATE TRIGGER game_event_coverage_lifecycle_guard
      BEFORE UPDATE OF lifecycle_state, purged_at ON game_event_coverage
      WHEN NOT (
        (NEW.lifecycle_state = OLD.lifecycle_state AND NEW.purged_at IS OLD.purged_at)
        OR (OLD.lifecycle_state = 'recording' AND NEW.lifecycle_state = 'terminal_pending'
            AND NEW.purged_at IS NULL
            AND EXISTS (SELECT 1 FROM game_history_terminal_evidence
                        WHERE run_id = NEW.run_id))
        OR (OLD.lifecycle_state = 'terminal_pending' AND NEW.lifecycle_state = 'sealed'
            AND NEW.purged_at IS NULL
            AND EXISTS (SELECT 1 FROM game_history_terminal_evidence
                        WHERE run_id = NEW.run_id))
        OR (OLD.lifecycle_state = 'sealed' AND NEW.lifecycle_state = 'purging'
            AND NEW.purged_at IS NULL
            AND EXISTS (SELECT 1 FROM game_history_terminal_evidence
                        WHERE run_id = NEW.run_id))
        OR (OLD.lifecycle_state = 'purging' AND NEW.lifecycle_state = 'purged'
            AND NEW.purged_at IS NOT NULL AND typeof(NEW.purged_at) = 'integer'
            AND NEW.purged_at > 0
            AND NOT EXISTS (SELECT 1 FROM game_events WHERE run_id = NEW.run_id)
            AND NOT EXISTS (SELECT 1 FROM game_action_receipts WHERE run_id = NEW.run_id)
            AND NOT EXISTS (SELECT 1 FROM managed_audio_command_outcomes WHERE run_id = NEW.run_id))
      )
      BEGIN
        SELECT RAISE(ABORT, 'game history lifecycle transition is invalid');
      END;
      DROP TRIGGER IF EXISTS game_event_coverage_initial_guard;
      CREATE TRIGGER game_event_coverage_initial_guard
      BEFORE INSERT ON game_event_coverage
      WHEN NEW.lifecycle_state <> 'recording' OR NEW.purged_at IS NOT NULL
      BEGIN
        SELECT RAISE(ABORT, 'game history coverage initial state is invalid');
      END;
      DROP TRIGGER IF EXISTS game_event_coverage_identity_guard;
      CREATE TRIGGER game_event_coverage_identity_guard
      BEFORE DELETE ON game_event_coverage
      WHEN EXISTS (SELECT 1 FROM game_runs WHERE id = OLD.run_id)
      BEGIN
        SELECT RAISE(ABORT, 'game history coverage identity is immutable');
      END;
      DROP TRIGGER IF EXISTS game_events_immutable_update;
      CREATE TRIGGER game_events_immutable_update
      BEFORE UPDATE ON game_events
      BEGIN
        SELECT RAISE(ABORT, 'game history events are immutable');
      END;
      DROP TRIGGER IF EXISTS game_events_sealed_delete_guard;
      CREATE TRIGGER game_events_sealed_delete_guard
      BEFORE DELETE ON game_events
      WHEN NOT EXISTS (
        SELECT 1 FROM game_event_coverage
        WHERE run_id = OLD.run_id AND lifecycle_state = 'purging'
      )
      BEGIN
        SELECT RAISE(ABORT, 'game history is sealed outside an authorized purge');
      END;
    `);
    recordFeatureMigration(db, "history_lifecycle_v4", schemaObjectsDigest(db, HISTORY_FEATURE_OBJECTS));
    }
    const managedAudioFeatureVerified = verifyRecordedFeature(
      db, "managed_audio_protocol_v4", MANAGED_AUDIO_FEATURE_OBJECTS,
    );
    if (!managedAudioFeatureVerified) {
    const commandColumns = new Set(
      db.prepare("PRAGMA table_info(managed_audio_commands)").all()
        .map((column) => (column as { name: string }).name),
    );
    if (!commandColumns.has("completion_fingerprint")) {
      db.exec("ALTER TABLE managed_audio_commands ADD COLUMN completion_fingerprint TEXT");
    }
    const leaseColumns = new Set(
      db.prepare("PRAGMA table_info(managed_audio_leases)").all()
        .map((column) => (column as { name: string }).name),
    );
    if (!leaseColumns.has("release_reason")) {
      db.exec("ALTER TABLE managed_audio_leases ADD COLUMN release_reason TEXT");
    }
    const commandOutcomeColumns = new Set(
      db.prepare("PRAGMA table_info(managed_audio_command_outcomes)").all()
        .map((column) => (column as { name: string }).name),
    );
    if (!commandOutcomeColumns.has("command_state")) {
      db.exec("ALTER TABLE managed_audio_command_outcomes ADD COLUMN command_state TEXT NOT NULL DEFAULT 'queued'");
    }
    if (!commandOutcomeColumns.has("claim_generation")) {
      db.exec("ALTER TABLE managed_audio_command_outcomes ADD COLUMN claim_generation TEXT");
    }
    db.exec(`
      INSERT OR IGNORE INTO managed_audio_command_outcomes
        (command_id, source_id, run_id, completion_fingerprint, completed_at,
         command_state, claim_generation)
      SELECT c.id, c.source_id, s.active_run_id,
             json_object('pending', 1, 'kind', c.kind), 0, 'queued', NULL
      FROM managed_audio_commands c
      JOIN game_sessions s ON s.code = c.session_code
      WHERE c.completed_at IS NULL;
    `);
    db.exec(`
      UPDATE managed_audio_command_outcomes
      SET command_state = CASE
            WHEN command_state IN ('completed','failed')
              AND typeof(completed_at) = 'integer' AND completed_at > 0
              AND json_valid(completion_fingerprint)
              AND json_type(completion_fingerprint, '$.ok') IN ('true','false')
              THEN command_state
            WHEN command_state IN ('queued','cancelled')
              AND claim_generation IS NULL AND completed_at = 0
              AND json_valid(completion_fingerprint)
              AND json_extract(completion_fingerprint, '$.pending') = 1
              THEN command_state
            WHEN command_state IN ('claimed','executing','outcome_unknown')
              AND claim_generation IS NOT NULL AND length(claim_generation) > 0
              AND completed_at = 0 AND json_valid(completion_fingerprint)
              AND json_extract(completion_fingerprint, '$.pending') = 1
              THEN command_state
            ELSE 'outcome_unknown'
          END,
          claim_generation = CASE
            WHEN command_state IN ('queued','cancelled')
              AND claim_generation IS NULL AND completed_at = 0
              AND json_valid(completion_fingerprint)
              AND json_extract(completion_fingerprint, '$.pending') = 1
              THEN NULL
            WHEN claim_generation IS NOT NULL AND length(claim_generation) > 0
              THEN claim_generation
            ELSE 'legacy-migration:' || command_id
          END,
          completed_at = CASE
            WHEN command_state IN ('completed','failed')
              AND typeof(completed_at) = 'integer' AND completed_at > 0
              AND json_valid(completion_fingerprint)
              AND json_type(completion_fingerprint, '$.ok') IN ('true','false')
              THEN completed_at
            ELSE 0
          END,
          completion_fingerprint = CASE
            WHEN command_state IN ('completed','failed')
              AND typeof(completed_at) = 'integer' AND completed_at > 0
              AND json_valid(completion_fingerprint)
              AND json_type(completion_fingerprint, '$.ok') IN ('true','false')
              THEN completion_fingerprint
            ELSE '{"pending":true}'
          END;
    `);
    const outcomesSql = (db.prepare(`
      SELECT sql FROM sqlite_schema WHERE type='table' AND name='managed_audio_command_outcomes'
    `).get() as { sql: string }).sql;
    if (normalizedSchemaSql(outcomesSql) !== normalizedSchemaSql(canonicalManagedOutcomesSql())) {
      db.exec(`
        PRAGMA legacy_alter_table = ON;
        ALTER TABLE managed_audio_command_outcomes RENAME TO managed_audio_command_outcomes_before_canonical;
        ${canonicalManagedOutcomesSql()};
        INSERT INTO managed_audio_command_outcomes
          (command_id, source_id, run_id, completion_fingerprint, completed_at, command_state, claim_generation)
        SELECT command_id, source_id, run_id,
               CASE WHEN json_valid(completion_fingerprint) THEN completion_fingerprint
                    ELSE '{"pending":true}' END,
               MAX(0, completed_at),
               CASE WHEN command_state IN ('queued','claimed','executing','completed','failed','outcome_unknown','cancelled')
                    THEN command_state ELSE 'outcome_unknown' END,
               claim_generation
        FROM managed_audio_command_outcomes_before_canonical;
        DROP TABLE managed_audio_command_outcomes_before_canonical;
        CREATE INDEX managed_audio_command_outcomes_completed_at
          ON managed_audio_command_outcomes(completed_at);
        PRAGMA legacy_alter_table = OFF;
      `);
    }
    const commandsSql = (db.prepare(`
      SELECT sql FROM sqlite_schema WHERE type='table' AND name='managed_audio_commands'
    `).get() as { sql: string }).sql;
    if (normalizedSchemaSql(commandsSql) !== normalizedSchemaSql(canonicalManagedCommandsSql())) {
      db.exec(`
        DROP TRIGGER IF EXISTS managed_audio_command_intent_guard;
        PRAGMA legacy_alter_table = ON;
        ALTER TABLE managed_audio_commands RENAME TO managed_audio_commands_before_canonical;
        ${canonicalManagedCommandsSql()};
        INSERT INTO managed_audio_commands
          (id, lease_id, source_id, session_code, kind, track_uri, requested_by,
           created_at, delivered_at, completed_at, error, completion_fingerprint)
        SELECT id, lease_id, source_id, session_code, kind, track_uri, requested_by,
               created_at, delivered_at, completed_at, error, completion_fingerprint
        FROM managed_audio_commands_before_canonical;
        DROP TABLE managed_audio_commands_before_canonical;
        CREATE INDEX managed_audio_commands_pending
          ON managed_audio_commands(source_id, completed_at, created_at);
        PRAGMA legacy_alter_table = OFF;
      `);
    }
    db.exec(`
      DROP TRIGGER IF EXISTS managed_audio_command_state_insert_guard;
      CREATE TRIGGER managed_audio_command_state_insert_guard
      BEFORE INSERT ON managed_audio_command_outcomes
      WHEN NOT (
        (NEW.command_state = 'queued' AND NEW.claim_generation IS NULL
          AND NEW.completed_at = 0 AND json_valid(NEW.completion_fingerprint)
          AND json_extract(NEW.completion_fingerprint, '$.pending') = 1)
        OR (NEW.command_state IN ('completed', 'failed')
          AND NEW.claim_generation IS NOT NULL AND NEW.completed_at > 0
          AND json_valid(NEW.completion_fingerprint))
      )
      BEGIN
        SELECT RAISE(ABORT, 'managed command initial state is invalid');
      END;
      DROP TRIGGER IF EXISTS managed_audio_command_state_update_guard;
      CREATE TRIGGER managed_audio_command_state_update_guard
      BEFORE UPDATE OF command_state, claim_generation, completion_fingerprint, completed_at
      ON managed_audio_command_outcomes
      WHEN NOT (
        (NEW.command_state = OLD.command_state
          AND NEW.claim_generation IS OLD.claim_generation
          AND NEW.completion_fingerprint IS OLD.completion_fingerprint
          AND NEW.completed_at = OLD.completed_at)
        OR (OLD.command_state = 'queued' AND NEW.command_state = 'claimed'
          AND OLD.claim_generation IS NULL AND NEW.claim_generation IS NOT NULL
          AND NEW.completed_at = 0)
        OR (OLD.command_state = 'queued' AND NEW.command_state = 'cancelled'
          AND NEW.claim_generation IS NULL AND NEW.completed_at = 0)
        OR (OLD.command_state = 'claimed' AND NEW.command_state = 'executing'
          AND NEW.claim_generation = OLD.claim_generation AND NEW.completed_at = 0)
        OR (OLD.command_state IN ('claimed', 'executing') AND NEW.command_state = 'outcome_unknown'
          AND NEW.claim_generation = OLD.claim_generation AND NEW.completed_at = 0)
        OR (OLD.command_state IN ('executing', 'outcome_unknown')
          AND NEW.command_state IN ('completed', 'failed')
          AND NEW.claim_generation = OLD.claim_generation
          AND NEW.claim_generation IS NOT NULL
          AND NEW.completed_at > 0
          AND json_valid(NEW.completion_fingerprint))
      )
      BEGIN
        SELECT RAISE(ABORT, 'managed command transition or claim generation is invalid');
      END;
      DROP TRIGGER IF EXISTS managed_audio_command_identity_guard;
      CREATE TRIGGER managed_audio_command_identity_guard
      BEFORE UPDATE OF command_id, source_id, run_id ON managed_audio_command_outcomes
      WHEN NEW.command_id IS NOT OLD.command_id OR NEW.source_id IS NOT OLD.source_id
        OR NEW.run_id IS NOT OLD.run_id
      BEGIN
        SELECT RAISE(ABORT, 'managed command outcome identity is immutable');
      END;
      DROP TRIGGER IF EXISTS managed_audio_command_intent_guard;
      CREATE TRIGGER managed_audio_command_intent_guard
      BEFORE UPDATE OF id, source_id, session_code, kind, track_uri, requested_by, created_at
      ON managed_audio_commands
      BEGIN
        SELECT RAISE(ABORT, 'managed command intent is immutable');
      END;
      DROP TRIGGER IF EXISTS managed_audio_lease_delete_transition;
      CREATE TRIGGER managed_audio_lease_delete_transition
      BEFORE DELETE ON managed_audio_leases
      BEGIN
        INSERT INTO game_events
          (run_id, sequence, event_type, outcome, actor_type, command_ref,
           detail_code, reason_code, occurred_at)
        SELECT o.run_id,
               (SELECT COALESCE(MAX(sequence), 0) FROM game_events WHERE run_id = o.run_id)
                 + ROW_NUMBER() OVER (PARTITION BY o.run_id ORDER BY c.created_at, c.id),
               CASE WHEN o.command_state = 'queued'
                    THEN 'audio_command_cancelled' ELSE 'audio_command_outcome_unknown' END,
               CASE WHEN o.command_state = 'queued' THEN 'cancelled' ELSE 'unknown' END,
               'system', c.id, c.kind,
               COALESCE(OLD.release_reason, 'explicit_release'),
               CAST(strftime('%s', 'now') AS INTEGER) * 1000
        FROM managed_audio_commands c
        JOIN managed_audio_command_outcomes o ON o.command_id = c.id
        WHERE c.lease_id = OLD.id AND o.run_id IS NOT NULL
          AND o.command_state IN ('queued','claimed','executing');
        UPDATE managed_audio_command_outcomes
        SET command_state = CASE
          WHEN command_state = 'queued' THEN 'cancelled'
          WHEN command_state IN ('claimed','executing') THEN 'outcome_unknown'
          ELSE command_state
        END
        WHERE command_id IN (SELECT id FROM managed_audio_commands WHERE lease_id = OLD.id)
          AND command_state IN ('queued','claimed','executing');
      END;
      DROP TRIGGER IF EXISTS managed_audio_source_delete_guard;
      CREATE TRIGGER managed_audio_source_delete_guard
      BEFORE DELETE ON managed_audio_sources
      WHEN EXISTS (SELECT 1 FROM managed_audio_command_outcomes WHERE source_id = OLD.id)
      BEGIN
        SELECT RAISE(ABORT, 'managed source has durable command outcomes');
      END;
      DROP TRIGGER IF EXISTS managed_audio_command_outcome_delete_guard;
      CREATE TRIGGER managed_audio_command_outcome_delete_guard
      BEFORE DELETE ON managed_audio_command_outcomes
      WHEN OLD.run_id IS NULL OR NOT EXISTS (
        SELECT 1 FROM game_event_coverage
        WHERE run_id = OLD.run_id AND lifecycle_state = 'purging'
      )
      BEGIN
        SELECT RAISE(ABORT, 'managed command outcomes are immutable outside an authorized purge');
      END;
    `);
    recordFeatureMigration(
      db, "managed_audio_protocol_v4", schemaObjectsDigest(db, MANAGED_AUDIO_FEATURE_OBJECTS),
    );
    }
    if (!verifyRecordedFeature(db, "history_purge_guards_v5", HISTORY_PURGE_GUARD_OBJECTS)) {
      db.exec(`
        DROP TRIGGER IF EXISTS game_event_coverage_purged_immutable;
        CREATE TRIGGER game_event_coverage_purged_immutable BEFORE UPDATE ON game_event_coverage
        WHEN OLD.lifecycle_state='purged'
        BEGIN SELECT RAISE(ABORT, 'game history purge boundary is immutable'); END;
        DROP TRIGGER IF EXISTS game_action_receipts_purged_write_guard;
        CREATE TRIGGER game_action_receipts_purged_write_guard BEFORE INSERT ON game_action_receipts
        WHEN EXISTS (SELECT 1 FROM game_event_coverage
          WHERE run_id=NEW.run_id AND lifecycle_state='purged')
        BEGIN SELECT RAISE(ABORT, 'game history is purged'); END;
        DROP TRIGGER IF EXISTS game_runs_purged_delete_guard;
        CREATE TRIGGER game_runs_purged_delete_guard BEFORE DELETE ON game_runs
        WHEN EXISTS (SELECT 1 FROM game_event_coverage
          WHERE run_id=OLD.id AND lifecycle_state='purged')
        BEGIN SELECT RAISE(ABORT, 'purged game snapshot is immutable'); END;
      `);
      recordFeatureMigration(
        db, "history_purge_guards_v5", schemaObjectsDigest(db, HISTORY_PURGE_GUARD_OBJECTS),
      );
    }
    if (!verifyRecordedFeature(
      db, "managed_audio_purge_guards_v5", MANAGED_AUDIO_PURGE_GUARD_OBJECTS,
    )) {
      db.exec(`
        DROP TRIGGER IF EXISTS managed_audio_outcomes_purged_insert_guard;
        CREATE TRIGGER managed_audio_outcomes_purged_insert_guard
        BEFORE INSERT ON managed_audio_command_outcomes
        WHEN NEW.run_id IS NOT NULL AND EXISTS (SELECT 1 FROM game_event_coverage
          WHERE run_id=NEW.run_id AND lifecycle_state='purged')
        BEGIN SELECT RAISE(ABORT, 'game history is purged'); END;
        DROP TRIGGER IF EXISTS managed_audio_outcomes_purged_update_guard;
        CREATE TRIGGER managed_audio_outcomes_purged_update_guard
        BEFORE UPDATE ON managed_audio_command_outcomes
        WHEN (NEW.run_id IS NOT NULL AND EXISTS (SELECT 1 FROM game_event_coverage
          WHERE run_id=NEW.run_id AND lifecycle_state='purged'))
          OR (OLD.run_id IS NOT NULL AND EXISTS (SELECT 1 FROM game_event_coverage
            WHERE run_id=OLD.run_id AND lifecycle_state='purged'))
        BEGIN SELECT RAISE(ABORT, 'game history is purged'); END;
      `);
      recordFeatureMigration(
        db, "managed_audio_purge_guards_v5",
        schemaObjectsDigest(db, MANAGED_AUDIO_PURGE_GUARD_OBJECTS),
      );
    }
    // Provider device identifiers are source-local capabilities/fingerprints. The
    // legacy column remains for exact Slice 1 compatibility but is never populated.
    db.exec("UPDATE managed_audio_sources SET device_id = NULL WHERE device_id IS NOT NULL");
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
    if (!gameRunColumns.has("terminal_outcome")) {
      db.exec(`
        ALTER TABLE game_runs ADD COLUMN terminal_outcome TEXT
          CHECK (terminal_outcome IS NULL OR terminal_outcome IN ('completed', 'abandoned'));
        UPDATE game_runs SET terminal_outcome = 'completed'
        WHERE ended_at IS NOT NULL AND json_valid(state)
          AND json_extract(state, '$.phase') = 'finished';
      `);
    }
    db.exec(`
      INSERT OR IGNORE INTO game_event_coverage
        (run_id, baseline_revision, last_recorded_revision, started_at)
      SELECT id, revision, revision, ${Date.now()} FROM game_runs;
      CREATE TRIGGER IF NOT EXISTS game_runs_initialize_event_coverage
      AFTER INSERT ON game_runs
      BEGIN
        INSERT OR IGNORE INTO game_event_coverage
          (run_id, baseline_revision, last_recorded_revision, started_at)
        VALUES (NEW.id, NEW.revision, NEW.revision, NEW.created_at);
      END;
    `);
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
      const lifecycleGuardSql = (db.prepare(`
        SELECT sql FROM sqlite_schema
        WHERE type = 'trigger' AND name = 'game_event_coverage_lifecycle_guard'
      `).get() as { sql: string } | undefined)?.sql;
      const receiptPurgeGuardSql = (db.prepare(`
        SELECT sql FROM sqlite_schema
        WHERE type = 'trigger' AND name = 'game_action_receipts_purged_write_guard'
      `).get() as { sql: string } | undefined)?.sql;
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
      `);
      if (lifecycleGuardSql) db.exec("DROP TRIGGER game_event_coverage_lifecycle_guard");
      db.exec(`
        DROP TABLE game_action_receipts;
        ALTER TABLE game_action_receipts_run_scoped RENAME TO game_action_receipts;
        CREATE INDEX game_action_receipts_accepted_at
          ON game_action_receipts(accepted_at);
      `);
      if (lifecycleGuardSql) db.exec(lifecycleGuardSql);
      if (receiptPurgeGuardSql) db.exec(receiptPurgeGuardSql);
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
