import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export const RELEASE_SCHEMA_GENERATION = 1;

export const RELEASE_SCHEMA_SQL = `
CREATE TABLE schema_generations (
  generation INTEGER PRIMARY KEY CHECK (generation = 1),
  contract_digest TEXT NOT NULL CHECK (length(contract_digest) = 64),
  applied_at INTEGER NOT NULL CHECK (applied_at > 0)
);
CREATE TRIGGER schema_generations_immutable_update BEFORE UPDATE ON schema_generations
BEGIN SELECT RAISE(ABORT, 'schema generations are immutable'); END;
CREATE TRIGGER schema_generations_immutable_delete BEFORE DELETE ON schema_generations
BEGIN SELECT RAISE(ABORT, 'schema generations are immutable'); END;

CREATE TABLE catalog_releases (
  catalog_version TEXT PRIMARY KEY CHECK (length(catalog_version) = 71),
  artifact_digest TEXT NOT NULL CHECK (length(artifact_digest) = 64),
  entries_digest TEXT NOT NULL CHECK (length(entries_digest) = 64),
  source_version TEXT NOT NULL CHECK (length(source_version) = 71),
  song_count INTEGER NOT NULL CHECK (song_count > 0),
  manifest TEXT NOT NULL CHECK (json_valid(manifest)),
  registered_at INTEGER NOT NULL CHECK (registered_at > 0)
);
CREATE TRIGGER catalog_releases_immutable_update BEFORE UPDATE ON catalog_releases
BEGIN SELECT RAISE(ABORT, 'catalog releases are immutable'); END;
CREATE TRIGGER catalog_releases_immutable_delete BEFORE DELETE ON catalog_releases
BEGIN SELECT RAISE(ABORT, 'catalog releases are immutable'); END;

CREATE TABLE catalog_entries (
  catalog_version TEXT NOT NULL REFERENCES catalog_releases(catalog_version) ON DELETE RESTRICT,
  uri TEXT NOT NULL,
  song TEXT NOT NULL CHECK (json_valid(song)),
  PRIMARY KEY (catalog_version,uri)
);
CREATE TRIGGER catalog_entries_immutable_update BEFORE UPDATE ON catalog_entries
BEGIN SELECT RAISE(ABORT, 'catalog entries are immutable'); END;
CREATE TRIGGER catalog_entries_immutable_delete BEFORE DELETE ON catalog_entries
BEGIN SELECT RAISE(ABORT, 'catalog entries are immutable'); END;

CREATE TABLE host_devices (
  device_id TEXT PRIMARY KEY CHECK (length(device_id) = 36),
  public_key TEXT NOT NULL UNIQUE CHECK (length(public_key) BETWEEN 32 AND 512),
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 80),
  authorized_at INTEGER NOT NULL CHECK (authorized_at > 0),
  revoked_at INTEGER CHECK (revoked_at IS NULL OR revoked_at >= authorized_at)
);
CREATE TRIGGER host_devices_identity_immutable BEFORE UPDATE ON host_devices
WHEN NEW.device_id <> OLD.device_id OR NEW.public_key <> OLD.public_key
  OR NEW.authorized_at <> OLD.authorized_at
BEGIN SELECT RAISE(ABORT, 'host device identity is immutable'); END;

CREATE TABLE host_enrollments (
  enrollment_hash TEXT PRIMARY KEY CHECK (length(enrollment_hash) = 64),
  issued_by_device_id TEXT REFERENCES host_devices(device_id) ON DELETE RESTRICT,
  issued_at INTEGER NOT NULL CHECK (issued_at > 0),
  expires_at INTEGER NOT NULL CHECK (expires_at > issued_at),
  redeemed_at INTEGER,
  redeemed_device_id TEXT UNIQUE REFERENCES host_devices(device_id) ON DELETE RESTRICT,
  CHECK ((redeemed_at IS NULL) = (redeemed_device_id IS NULL)),
  CHECK (redeemed_at IS NULL OR redeemed_at >= issued_at)
);

CREATE TABLE host_challenges (
  challenge_hash TEXT PRIMARY KEY CHECK (length(challenge_hash) = 64),
  device_id TEXT NOT NULL REFERENCES host_devices(device_id) ON DELETE RESTRICT,
  issued_at INTEGER NOT NULL CHECK (issued_at > 0),
  expires_at INTEGER NOT NULL CHECK (expires_at > issued_at),
  consumed_at INTEGER CHECK (consumed_at IS NULL OR consumed_at >= issued_at)
);

CREATE TABLE host_sessions (
  session_hash TEXT PRIMARY KEY CHECK (length(session_hash) = 64),
  device_id TEXT NOT NULL REFERENCES host_devices(device_id) ON DELETE RESTRICT,
  issued_at INTEGER NOT NULL CHECK (issued_at > 0),
  expires_at INTEGER NOT NULL CHECK (expires_at > issued_at),
  revoked_at INTEGER CHECK (revoked_at IS NULL OR revoked_at >= issued_at)
);

CREATE TABLE games (
  game_id TEXT PRIMARY KEY CHECK (length(game_id) = 36),
  host_device_id TEXT NOT NULL REFERENCES host_devices(device_id) ON DELETE RESTRICT,
  catalog_version TEXT NOT NULL REFERENCES catalog_releases(catalog_version) ON DELETE RESTRICT,
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('lobby','active','completed','abandoned')),
  state TEXT NOT NULL CHECK (json_valid(state)),
  revision INTEGER NOT NULL CHECK (revision >= 0),
  participant_capacity INTEGER NOT NULL DEFAULT 8 CHECK (participant_capacity = 8),
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  terminal_at INTEGER,
  CHECK ((lifecycle IN ('completed','abandoned')) = (terminal_at IS NOT NULL)),
  CHECK (terminal_at IS NULL OR terminal_at >= created_at)
);
CREATE UNIQUE INDEX games_one_active ON games((1))
WHERE lifecycle IN ('lobby','active');
CREATE TRIGGER games_identity_immutable BEFORE UPDATE ON games
WHEN NEW.game_id <> OLD.game_id OR NEW.host_device_id <> OLD.host_device_id
  OR NEW.catalog_version <> OLD.catalog_version OR NEW.created_at <> OLD.created_at
  OR NEW.participant_capacity <> OLD.participant_capacity
BEGIN SELECT RAISE(ABORT, 'game identity is immutable'); END;
CREATE TRIGGER games_lifecycle_guard BEFORE UPDATE OF lifecycle ON games
WHEN NOT (
  (OLD.lifecycle='lobby' AND NEW.lifecycle IN ('lobby','active','abandoned')) OR
  (OLD.lifecycle='active' AND NEW.lifecycle IN ('active','completed','abandoned')) OR
  (OLD.lifecycle=NEW.lifecycle AND OLD.lifecycle IN ('completed','abandoned'))
)
BEGIN SELECT RAISE(ABORT, 'game lifecycle transition is invalid'); END;

CREATE TABLE game_invites (
  invite_hash TEXT PRIMARY KEY CHECK (length(invite_hash) = 64),
  game_id TEXT NOT NULL REFERENCES games(game_id) ON DELETE RESTRICT,
  issued_by_device_id TEXT NOT NULL REFERENCES host_devices(device_id) ON DELETE RESTRICT,
  capacity INTEGER NOT NULL CHECK (capacity BETWEEN 1 AND 8),
  issued_at INTEGER NOT NULL CHECK (issued_at > 0),
  expires_at INTEGER NOT NULL CHECK (expires_at > issued_at),
  closed_at INTEGER CHECK (closed_at IS NULL OR closed_at >= issued_at),
  close_reason TEXT CHECK (close_reason IS NULL OR close_reason IN ('started','expired','revoked','capacity')),
  CHECK ((closed_at IS NULL) = (close_reason IS NULL))
);

CREATE TABLE participants (
  participant_id TEXT PRIMARY KEY CHECK (length(participant_id) = 36),
  game_id TEXT NOT NULL REFERENCES games(game_id) ON DELETE RESTRICT,
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 24),
  normalized_name TEXT NOT NULL CHECK (length(normalized_name) BETWEEN 1 AND 64),
  join_order INTEGER NOT NULL CHECK (join_order BETWEEN 1 AND 8),
  joined_at INTEGER NOT NULL CHECK (joined_at > 0),
  removed_at INTEGER CHECK (removed_at IS NULL OR removed_at >= joined_at),
  UNIQUE (game_id, participant_id)
);
CREATE UNIQUE INDEX participants_active_name ON participants(game_id,normalized_name)
WHERE removed_at IS NULL;
CREATE UNIQUE INDEX participants_active_order ON participants(game_id,join_order)
WHERE removed_at IS NULL;
CREATE TRIGGER participants_capacity_guard BEFORE INSERT ON participants
WHEN (SELECT COUNT(*) FROM participants WHERE game_id=NEW.game_id AND removed_at IS NULL)
  >= (SELECT participant_capacity FROM games WHERE game_id=NEW.game_id)
BEGIN SELECT RAISE(ABORT, 'participant capacity reached'); END;

CREATE TABLE participant_sessions (
  session_hash TEXT PRIMARY KEY CHECK (length(session_hash) = 64),
  game_id TEXT NOT NULL,
  participant_id TEXT NOT NULL,
  issued_at INTEGER NOT NULL CHECK (issued_at > 0),
  expires_at INTEGER NOT NULL CHECK (expires_at > issued_at),
  revoked_at INTEGER CHECK (revoked_at IS NULL OR revoked_at >= issued_at),
  FOREIGN KEY (game_id,participant_id) REFERENCES participants(game_id,participant_id) ON DELETE RESTRICT
);

CREATE TABLE action_receipts (
  game_id TEXT NOT NULL REFERENCES games(game_id) ON DELETE RESTRICT,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('host','participant','system')),
  actor_id TEXT NOT NULL CHECK (length(actor_id) = 36),
  request_id TEXT NOT NULL CHECK (length(request_id) = 36),
  operation TEXT NOT NULL CHECK (length(operation) BETWEEN 1 AND 64),
  request TEXT NOT NULL CHECK (json_valid(request)),
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  result TEXT NOT NULL CHECK (json_valid(result)),
  revision INTEGER NOT NULL CHECK (revision >= 0),
  accepted_at INTEGER NOT NULL CHECK (accepted_at > 0),
  PRIMARY KEY (game_id,actor_type,actor_id,request_id)
);
CREATE TRIGGER action_receipts_immutable_update BEFORE UPDATE ON action_receipts
BEGIN SELECT RAISE(ABORT, 'action receipts are immutable'); END;
CREATE TRIGGER action_receipts_immutable_delete BEFORE DELETE ON action_receipts
BEGIN SELECT RAISE(ABORT, 'action receipts are immutable'); END;

CREATE TABLE game_events (
  game_id TEXT NOT NULL REFERENCES games(game_id) ON DELETE RESTRICT,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  revision INTEGER NOT NULL CHECK (revision >= 0),
  event_type TEXT NOT NULL CHECK (event_type IN (
    'game_created','participant_joined','participant_removed','game_configured','game_started',
    'track_requested','placement_locked','placement_retracted','answer_revealed',
    'round_advanced','track_skipped','game_completed','game_abandoned',
    'playback_requested','playback_claimed','playback_completed','playback_failed',
    'playback_outcome_unknown','audio_started','audio_stopped','audio_interrupted','audio_recovered'
  )),
  outcome TEXT NOT NULL CHECK (outcome IN ('accepted','completed','failed','abandoned','interrupted','recovered','unknown')),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('host','participant','system')),
  actor_id TEXT NOT NULL CHECK (length(actor_id) = 36),
  request_id TEXT NOT NULL CHECK (length(request_id) = 36),
  detail TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(detail)),
  occurred_at INTEGER NOT NULL CHECK (occurred_at > 0),
  PRIMARY KEY (game_id,sequence),
  FOREIGN KEY (game_id,actor_type,actor_id,request_id)
    REFERENCES action_receipts(game_id,actor_type,actor_id,request_id)
    DEFERRABLE INITIALLY DEFERRED
);
CREATE TRIGGER game_events_immutable_update BEFORE UPDATE ON game_events
BEGIN SELECT RAISE(ABORT, 'game events are immutable'); END;
CREATE TRIGGER game_events_immutable_delete BEFORE DELETE ON game_events
BEGIN SELECT RAISE(ABORT, 'game events are immutable'); END;

CREATE TABLE playback_commands (
  command_id TEXT PRIMARY KEY CHECK (length(command_id) = 36),
  game_id TEXT NOT NULL REFERENCES games(game_id) ON DELETE RESTRICT,
  request_id TEXT NOT NULL CHECK (length(request_id) = 36),
  kind TEXT NOT NULL CHECK (kind IN ('play_track','play','pause')),
  track_uri TEXT,
  state TEXT NOT NULL CHECK (state IN ('queued','claimed','executing','completed','failed','outcome_unknown','cancelled')),
  claim_generation TEXT,
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  UNIQUE (game_id,request_id),
  CHECK ((kind='play_track') = (track_uri IS NOT NULL))
);

CREATE TABLE playback_command_transitions (
  command_id TEXT NOT NULL REFERENCES playback_commands(command_id) ON DELETE RESTRICT,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  from_state TEXT,
  to_state TEXT NOT NULL CHECK (to_state IN ('queued','claimed','executing','completed','failed','outcome_unknown','cancelled')),
  claim_generation TEXT,
  outcome_hash TEXT CHECK (outcome_hash IS NULL OR length(outcome_hash) = 64),
  reason_code TEXT CHECK (reason_code IS NULL OR reason_code IN (
    'spotify_missing','spotify_signed_out','automation_denied','command_timeout',
    'unexpected_track','response_lost','revoked','game_ended','unrecognized'
  )),
  occurred_at INTEGER NOT NULL CHECK (occurred_at > 0),
  PRIMARY KEY (command_id,sequence)
);
CREATE TRIGGER playback_transitions_immutable_update BEFORE UPDATE ON playback_command_transitions
BEGIN SELECT RAISE(ABORT, 'playback transitions are immutable'); END;
CREATE TRIGGER playback_transitions_immutable_delete BEFORE DELETE ON playback_command_transitions
BEGIN SELECT RAISE(ABORT, 'playback transitions are immutable'); END;

CREATE TABLE audio_sessions (
  audio_session_id TEXT PRIMARY KEY CHECK (length(audio_session_id) = 36),
  game_id TEXT NOT NULL REFERENCES games(game_id) ON DELETE RESTRICT,
  generation INTEGER NOT NULL CHECK (generation > 0),
  state TEXT NOT NULL CHECK (state IN ('starting','active','interrupted','ended')),
  started_at INTEGER NOT NULL CHECK (started_at > 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= started_at),
  ended_at INTEGER CHECK (ended_at IS NULL OR ended_at >= started_at),
  UNIQUE (game_id,generation),
  CHECK ((state='ended') = (ended_at IS NOT NULL))
);
CREATE UNIQUE INDEX audio_sessions_one_open_per_game ON audio_sessions(game_id)
WHERE state <> 'ended';

CREATE TABLE game_results (
  result_id TEXT PRIMARY KEY CHECK (length(result_id) = 36),
  game_id TEXT NOT NULL UNIQUE REFERENCES games(game_id) ON DELETE RESTRICT,
  final_revision INTEGER NOT NULL CHECK (final_revision > 0),
  projection TEXT NOT NULL CHECK (json_valid(projection)),
  created_at INTEGER NOT NULL CHECK (created_at > 0)
);
CREATE TRIGGER game_results_immutable_update BEFORE UPDATE ON game_results
BEGIN SELECT RAISE(ABORT, 'game results are immutable'); END;
CREATE TRIGGER game_results_immutable_delete BEFORE DELETE ON game_results
BEGIN SELECT RAISE(ABORT, 'game results are immutable'); END;

CREATE TABLE diagnostic_records (
  record_id TEXT PRIMARY KEY CHECK (length(record_id) = 36),
  game_id TEXT NOT NULL REFERENCES games(game_id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('host','listener','relay','game','audio')),
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  occurred_at INTEGER NOT NULL CHECK (occurred_at > 0),
  expires_at INTEGER NOT NULL CHECK (expires_at > occurred_at)
);
CREATE INDEX diagnostic_records_expiry ON diagnostic_records(expires_at,record_id);
`;

export function canonicalSchemaDigest(database) {
  const objects = database.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_schema
    WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name`).all().map((row) => ({ ...row }));
  return createHash('sha256').update(JSON.stringify(objects)).digest('hex');
}

function expectedSchemaDigest() {
  const database = new DatabaseSync(':memory:');
  try {
    database.exec('PRAGMA foreign_keys=ON');
    database.exec(RELEASE_SCHEMA_SQL);
    return canonicalSchemaDigest(database);
  } finally {
    database.close();
  }
}

export const RELEASE_SCHEMA_DIGEST = expectedSchemaDigest();
