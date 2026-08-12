import { createHash } from "node:crypto";

export const STATE_SCHEMA_GENERATION = 1;

export const STATE_SCHEMA_SQL = `
CREATE TABLE state_schema_generations (
  generation INTEGER PRIMARY KEY CHECK (generation > 0),
  contract_digest TEXT NOT NULL CHECK (length(contract_digest) = 64),
  applied_at INTEGER NOT NULL CHECK (applied_at > 0)
);

CREATE TABLE state_authority (
  singleton TEXT PRIMARY KEY CHECK (singleton = 'state'),
  status TEXT NOT NULL CHECK (status IN ('candidate','active')),
  activated_at INTEGER CHECK (activated_at IS NULL OR activated_at > 0),
  first_admitted_at INTEGER CHECK (first_admitted_at IS NULL OR first_admitted_at > 0)
);

CREATE TABLE state_commands (
  command_id TEXT PRIMARY KEY,
  command_type TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint) = 64),
  result TEXT NOT NULL CHECK (json_valid(result)),
  accepted_at INTEGER NOT NULL CHECK (accepted_at > 0)
);

CREATE TABLE lobbies (
  code TEXT PRIMARY KEY CHECK (length(code) = 6),
  host_principal_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('lobby','playing','ended')),
  active_run_id TEXT,
  run_generation INTEGER NOT NULL DEFAULT 0 CHECK (run_generation >= 0),
  audio_mode TEXT NOT NULL DEFAULT 'managed' CHECK (audio_mode IN ('local','managed')),
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  updated_at INTEGER NOT NULL CHECK (updated_at > 0)
);

CREATE TABLE lobby_members (
  lobby_code TEXT NOT NULL REFERENCES lobbies(code) ON DELETE CASCADE,
  principal_id TEXT NOT NULL,
  joined_at INTEGER NOT NULL CHECK (joined_at > 0),
  last_seen_at INTEGER NOT NULL CHECK (last_seen_at > 0),
  PRIMARY KEY (lobby_code, principal_id)
);

CREATE TABLE game_runs (
  id TEXT PRIMARY KEY,
  lobby_code TEXT NOT NULL REFERENCES lobbies(code) ON DELETE RESTRICT,
  state TEXT NOT NULL CHECK (json_valid(state)),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  updated_at INTEGER NOT NULL CHECK (updated_at > 0),
  ended_at INTEGER CHECK (ended_at IS NULL OR ended_at > 0),
  terminal_outcome TEXT CHECK (terminal_outcome IS NULL OR terminal_outcome IN ('completed','abandoned'))
);

CREATE TABLE action_receipts (
  run_id TEXT NOT NULL REFERENCES game_runs(id) ON DELETE RESTRICT,
  actor_principal_id TEXT NOT NULL,
  action_id TEXT NOT NULL,
  action TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  accepted_at INTEGER NOT NULL CHECK (accepted_at > 0),
  PRIMARY KEY (run_id, actor_principal_id, action_id)
);

CREATE TABLE history_streams (
  run_id TEXT PRIMARY KEY REFERENCES game_runs(id) ON DELETE RESTRICT,
  baseline_revision INTEGER NOT NULL CHECK (baseline_revision >= 0),
  last_recorded_revision INTEGER NOT NULL CHECK (last_recorded_revision >= baseline_revision),
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('recording','terminal_pending','sealed','purged')),
  started_at INTEGER NOT NULL CHECK (started_at > 0),
  purged_at INTEGER CHECK (purged_at IS NULL OR purged_at > 0)
);

CREATE TABLE history_transitions (
  run_id TEXT NOT NULL REFERENCES game_runs(id) ON DELETE RESTRICT,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  from_state TEXT,
  to_state TEXT NOT NULL CHECK (to_state IN ('recording','terminal_pending','sealed','purged')),
  reason TEXT NOT NULL,
  occurred_at INTEGER NOT NULL CHECK (occurred_at > 0),
  PRIMARY KEY (run_id, sequence)
);

CREATE TABLE game_events (
  run_id TEXT NOT NULL REFERENCES game_runs(id) ON DELETE RESTRICT,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  event_type TEXT NOT NULL,
  outcome TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_ref TEXT,
  action_id TEXT,
  command_ref TEXT,
  round INTEGER CHECK (round IS NULL OR round >= 0),
  detail_code TEXT,
  detail_value INTEGER CHECK (detail_value IS NULL OR detail_value >= 0),
  reason_code TEXT,
  occurred_at INTEGER NOT NULL CHECK (occurred_at > 0),
  PRIMARY KEY (run_id, sequence)
);

CREATE TABLE managed_sources (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL CHECK (enabled IN (0,1)),
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  last_seen_at INTEGER,
  last_error_category TEXT
);

CREATE TABLE managed_leases (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL UNIQUE REFERENCES managed_sources(id) ON DELETE RESTRICT,
  lobby_code TEXT NOT NULL UNIQUE REFERENCES lobbies(code) ON DELETE RESTRICT,
  acquired_by_principal_id TEXT NOT NULL,
  acquired_at INTEGER NOT NULL CHECK (acquired_at > 0),
  renewed_at INTEGER NOT NULL CHECK (renewed_at >= acquired_at),
  expires_at INTEGER NOT NULL CHECK (expires_at > renewed_at),
  playback_status TEXT NOT NULL,
  last_error_category TEXT
);

CREATE TABLE managed_command_intents (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES managed_sources(id) ON DELETE RESTRICT,
  lobby_code TEXT NOT NULL REFERENCES lobbies(code) ON DELETE RESTRICT,
  run_id TEXT REFERENCES game_runs(id) ON DELETE RESTRICT,
  run_generation INTEGER NOT NULL CHECK (run_generation >= 0),
  protocol_version INTEGER NOT NULL CHECK (protocol_version = 2),
  kind TEXT NOT NULL CHECK (kind IN ('play','pause','resume')),
  track_uri TEXT,
  requested_by_principal_id TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK (created_at > 0)
);

CREATE TABLE managed_command_transitions (
  command_id TEXT NOT NULL REFERENCES managed_command_intents(id) ON DELETE RESTRICT,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  from_state TEXT,
  to_state TEXT NOT NULL CHECK (to_state IN (
    'queued','claimed','executing','completed','failed','outcome_unknown','cancelled'
  )),
  claim_generation TEXT,
  outcome_fingerprint TEXT,
  reason_code TEXT,
  occurred_at INTEGER NOT NULL CHECK (occurred_at > 0),
  PRIMARY KEY (command_id, sequence)
);

CREATE TABLE purge_tombstones (
  run_id TEXT PRIMARY KEY REFERENCES game_runs(id) ON DELETE RESTRICT,
  final_revision INTEGER NOT NULL CHECK (final_revision >= 0),
  terminal_outcome TEXT NOT NULL CHECK (terminal_outcome IN ('completed','abandoned')),
  purged_at INTEGER NOT NULL CHECK (purged_at > 0),
  manifest_digest TEXT NOT NULL CHECK (length(manifest_digest) = 64)
);

CREATE TABLE migration_manifests (
  source_database_digest TEXT PRIMARY KEY CHECK (length(source_database_digest) = 64),
  destination_generation INTEGER NOT NULL,
  content_digest TEXT NOT NULL CHECK (length(content_digest) = 64),
  row_counts TEXT NOT NULL CHECK (json_valid(row_counts)),
  created_at INTEGER NOT NULL CHECK (created_at > 0)
);

CREATE VIEW managed_command_current AS
SELECT i.*, t.to_state AS command_state, t.claim_generation,
       t.outcome_fingerprint, t.reason_code, t.occurred_at AS transitioned_at
FROM managed_command_intents i
JOIN managed_command_transitions t ON t.command_id = i.id
WHERE t.sequence = (
  SELECT MAX(latest.sequence) FROM managed_command_transitions latest
  WHERE latest.command_id = i.id
);

CREATE TRIGGER history_transitions_immutable_update BEFORE UPDATE ON history_transitions
BEGIN SELECT RAISE(ABORT, 'history transitions are immutable'); END;
CREATE TRIGGER history_transitions_immutable_delete BEFORE DELETE ON history_transitions
BEGIN SELECT RAISE(ABORT, 'history transitions are immutable'); END;
CREATE TRIGGER command_transitions_immutable_update BEFORE UPDATE ON managed_command_transitions
BEGIN SELECT RAISE(ABORT, 'command transitions are immutable'); END;
CREATE TRIGGER command_transitions_immutable_delete BEFORE DELETE ON managed_command_transitions
BEGIN SELECT RAISE(ABORT, 'command transitions are immutable'); END;
CREATE TRIGGER purge_tombstones_immutable_update BEFORE UPDATE ON purge_tombstones
BEGIN SELECT RAISE(ABORT, 'purge tombstones are immutable'); END;
CREATE TRIGGER purge_tombstones_immutable_delete BEFORE DELETE ON purge_tombstones
BEGIN SELECT RAISE(ABORT, 'purge tombstones are immutable'); END;
`;

export const STATE_SCHEMA_DIGEST = createHash("sha256").update(STATE_SCHEMA_SQL).digest("hex");
