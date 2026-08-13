import { createHash } from "node:crypto";

export const STATE_SCHEMA_GENERATION = 3;

export const STATE_SCHEMA_SQL = `
CREATE TABLE state_schema_generations (
  generation INTEGER PRIMARY KEY CHECK (generation > 0),
  contract_digest TEXT NOT NULL CHECK (length(contract_digest) = 64),
  applied_at INTEGER NOT NULL CHECK (applied_at > 0)
);
CREATE TRIGGER state_schema_generations_immutable_update
BEFORE UPDATE ON state_schema_generations
BEGIN SELECT RAISE(ABORT, 'state schema generations are immutable'); END;
CREATE TRIGGER state_schema_generations_immutable_delete
BEFORE DELETE ON state_schema_generations
BEGIN SELECT RAISE(ABORT, 'state schema generations are immutable'); END;

CREATE TABLE state_authority (
  singleton TEXT PRIMARY KEY CHECK (singleton = 'state'),
  status TEXT NOT NULL CHECK (status IN ('candidate','active')),
  activated_at INTEGER CHECK (activated_at IS NULL OR activated_at > 0),
  first_admitted_at INTEGER CHECK (first_admitted_at IS NULL OR first_admitted_at > 0),
  source_digest TEXT CHECK (source_digest IS NULL OR length(source_digest)=64),
  candidate_digest TEXT CHECK (candidate_digest IS NULL OR length(candidate_digest)=64),
  schema_generation INTEGER,
  protocol_version INTEGER,
  release_epoch TEXT,
  CHECK ((status='active') = (source_digest IS NOT NULL AND candidate_digest IS NOT NULL
    AND schema_generation IS NOT NULL AND protocol_version IS NOT NULL
    AND release_epoch IS NOT NULL))
);
CREATE TRIGGER state_authority_update_guard BEFORE UPDATE ON state_authority
WHEN NOT (
  (OLD.status='candidate' AND NEW.status='active' AND OLD.activated_at IS NULL
    AND NEW.activated_at IS NOT NULL AND NEW.first_admitted_at IS OLD.first_admitted_at
    AND NEW.source_digest IS NOT NULL AND NEW.candidate_digest IS NOT NULL
    AND NEW.schema_generation=3 AND NEW.protocol_version=4
    AND length(NEW.release_epoch)>0) OR
  (OLD.status='active' AND NEW.status='active' AND NEW.activated_at=OLD.activated_at
    AND OLD.first_admitted_at IS NULL AND NEW.first_admitted_at IS NOT NULL
    AND NEW.source_digest=OLD.source_digest AND NEW.candidate_digest=OLD.candidate_digest
    AND NEW.schema_generation=OLD.schema_generation AND NEW.protocol_version=OLD.protocol_version
    AND NEW.release_epoch=OLD.release_epoch)
)
BEGIN SELECT RAISE(ABORT, 'state authority transition is invalid'); END;
CREATE TRIGGER state_authority_delete_guard BEFORE DELETE ON state_authority
BEGIN SELECT RAISE(ABORT, 'state authority is immutable'); END;

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
  terminal_outcome TEXT CHECK (terminal_outcome IS NULL OR terminal_outcome IN ('completed','abandoned')),
  CHECK ((ended_at IS NULL) = (terminal_outcome IS NULL))
);

CREATE TABLE action_receipts (
  run_id TEXT NOT NULL REFERENCES game_runs(id) ON DELETE RESTRICT,
  actor_principal_id TEXT NOT NULL,
  action_id TEXT NOT NULL,
  action TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint) = 64),
  result TEXT NOT NULL CHECK (json_valid(result)),
  revision INTEGER CHECK (revision IS NULL OR revision > 0),
  accepted_at INTEGER NOT NULL CHECK (accepted_at > 0),
  PRIMARY KEY (run_id, actor_principal_id, action_id)
);

CREATE TABLE history_streams (
  run_id TEXT PRIMARY KEY REFERENCES game_runs(id) ON DELETE RESTRICT,
  baseline_revision INTEGER NOT NULL CHECK (baseline_revision >= 0),
  last_recorded_revision INTEGER NOT NULL CHECK (last_recorded_revision >= baseline_revision),
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('recording','terminal_pending','sealed','purging','purged')),
  started_at INTEGER NOT NULL CHECK (started_at > 0),
  purged_at INTEGER CHECK (purged_at IS NULL OR purged_at > 0),
  CHECK ((lifecycle = 'purged') = (purged_at IS NOT NULL))
);

CREATE TABLE history_transitions (
  run_id TEXT NOT NULL REFERENCES game_runs(id) ON DELETE RESTRICT,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  from_state TEXT,
  to_state TEXT NOT NULL CHECK (to_state IN ('recording','terminal_pending','sealed','purging','purged')),
  reason TEXT NOT NULL,
  occurred_at INTEGER NOT NULL CHECK (occurred_at > 0),
  PRIMARY KEY (run_id, sequence)
);

CREATE TABLE game_events (
  run_id TEXT NOT NULL REFERENCES game_runs(id) ON DELETE RESTRICT,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  revision INTEGER CHECK (revision IS NULL OR revision >= 0),
  event_type TEXT NOT NULL CHECK (event_type IN (
    'player_joined','player_removed','game_configured','game_started','track_requested',
    'placement_locked','placement_retracted','answer_revealed','round_advanced',
    'track_skipped','game_completed','game_abandoned','audio_source_selected',
    'audio_lease_acquired','audio_lease_released','audio_command_requested',
    'audio_command_delivered','audio_command_completed','audio_command_failed',
    'audio_command_interrupted','audio_command_cancelled','audio_command_outcome_unknown',
    'audio_lease_expired','audio_lease_renewed','audio_source_recovered'
  )),
  outcome TEXT NOT NULL CHECK (outcome IN (
    'accepted','completed','failed','abandoned','interrupted','recovered','cancelled','unknown'
  )),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('host','player','source','system')),
  actor_ref TEXT,
  action_id TEXT,
  command_ref TEXT,
  round INTEGER CHECK (round IS NULL OR round >= 0),
  detail_code TEXT,
  detail_value INTEGER CHECK (detail_value IS NULL OR detail_value >= 0),
  reason_code TEXT CHECK (reason_code IS NULL OR reason_code IN (
    'authentication_required','browser_unavailable','device_unavailable','explicit_release',
    'game_abandoned','game_api_unavailable','game_completed','lease_expired',
    'managed_playback_failed','relay_unavailable','source_selected_local',
    'spotify_unavailable','unrecognized_reason'
  )),
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
  playback_status TEXT NOT NULL CHECK (playback_status IN ('ready','playing','paused','error')),
  last_error_category TEXT,
  CHECK ((playback_status='error') = (last_error_category IS NOT NULL))
);

CREATE TABLE managed_command_intents (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES managed_sources(id) ON DELETE RESTRICT,
  lobby_code TEXT NOT NULL REFERENCES lobbies(code) ON DELETE RESTRICT,
  run_id TEXT REFERENCES game_runs(id) ON DELETE RESTRICT,
  run_generation INTEGER NOT NULL CHECK (run_generation >= 0),
  protocol_version INTEGER NOT NULL CHECK (protocol_version = 4),
  kind TEXT NOT NULL CHECK (kind IN ('play','pause','resume')),
  action_id TEXT NOT NULL,
  dispatch_sequence INTEGER NOT NULL CHECK (dispatch_sequence > 0),
  created_at INTEGER NOT NULL CHECK (created_at > 0)
);

CREATE TABLE managed_command_payloads (
  command_id TEXT PRIMARY KEY REFERENCES managed_command_intents(id) ON DELETE RESTRICT,
  track_uri TEXT,
  requested_by_principal_id TEXT NOT NULL
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
  playback_status TEXT CHECK (playback_status IS NULL OR playback_status IN ('playing','paused','error')),
  error_category TEXT,
  reason_code TEXT CHECK (reason_code IS NULL OR reason_code IN (
    'authentication_required','browser_unavailable','device_unavailable','explicit_release',
    'game_abandoned','game_api_unavailable','game_completed','lease_expired',
    'managed_playback_failed','relay_unavailable','source_selected_local',
    'spotify_unavailable','unrecognized_reason'
  )),
  occurred_at INTEGER NOT NULL CHECK (occurred_at > 0),
  PRIMARY KEY (command_id, sequence)
);

CREATE TABLE managed_source_handoffs (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES managed_sources(id) ON DELETE RESTRICT,
  prior_lobby_code TEXT NOT NULL REFERENCES lobbies(code) ON DELETE RESTRICT,
  run_id TEXT NOT NULL REFERENCES game_runs(id) ON DELETE RESTRICT,
  run_generation INTEGER NOT NULL CHECK (run_generation >= 0),
  stop_command_id TEXT NOT NULL UNIQUE REFERENCES managed_command_intents(id) ON DELETE RESTRICT,
  reason_code TEXT NOT NULL CHECK (reason_code IN (
    'explicit_release','game_abandoned','game_completed','lease_expired','source_selected_local'
  )),
  created_at INTEGER NOT NULL CHECK (created_at > 0)
);

CREATE TABLE managed_source_handoff_transitions (
  handoff_id TEXT NOT NULL REFERENCES managed_source_handoffs(id) ON DELETE RESTRICT,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  from_state TEXT,
  to_state TEXT NOT NULL CHECK (to_state IN (
    'stop_required','stop_claimed','stop_executing','quarantined','safe'
  )),
  occurred_at INTEGER NOT NULL CHECK (occurred_at > 0),
  PRIMARY KEY (handoff_id,sequence)
);

CREATE VIEW managed_source_handoff_current AS
SELECT handoff.id,handoff.source_id,handoff.prior_lobby_code,handoff.run_id,
  handoff.run_generation,handoff.stop_command_id,handoff.reason_code,
  transition.to_state AS handoff_state,transition.occurred_at
FROM managed_source_handoffs handoff
JOIN managed_source_handoff_transitions transition ON transition.handoff_id=handoff.id
WHERE transition.sequence=(SELECT MAX(latest.sequence)
  FROM managed_source_handoff_transitions latest WHERE latest.handoff_id=handoff.id);

CREATE TABLE purge_tombstones (
  run_id TEXT PRIMARY KEY REFERENCES game_runs(id) ON DELETE RESTRICT,
  final_revision INTEGER NOT NULL CHECK (final_revision >= 0),
  terminal_outcome TEXT NOT NULL CHECK (terminal_outcome IN ('completed','abandoned')),
  purged_at INTEGER NOT NULL CHECK (purged_at > 0),
  manifest_digest TEXT NOT NULL CHECK (length(manifest_digest) = 64)
);
CREATE TABLE purge_sanitization (
  run_id TEXT PRIMARY KEY REFERENCES purge_tombstones(run_id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('pending','complete')),
  completed_at INTEGER CHECK (completed_at IS NULL OR completed_at > 0),
  CHECK ((status='complete') = (completed_at IS NOT NULL))
);

CREATE TABLE migration_manifests (
  source_database_digest TEXT PRIMARY KEY CHECK (length(source_database_digest) = 64),
  destination_generation INTEGER NOT NULL,
  content_digest TEXT NOT NULL CHECK (length(content_digest) = 64),
  private_digest TEXT NOT NULL CHECK (length(private_digest) = 64),
  candidate_digest TEXT NOT NULL CHECK (length(candidate_digest) = 64),
  row_counts TEXT NOT NULL CHECK (json_valid(row_counts)),
  created_at INTEGER NOT NULL CHECK (created_at > 0)
);

CREATE VIEW managed_command_current AS
SELECT i.*, t.to_state AS command_state, t.claim_generation,
       t.outcome_fingerprint, t.playback_status, t.error_category,
       t.reason_code, t.occurred_at AS transitioned_at
FROM managed_command_intents i
JOIN managed_command_transitions t ON t.command_id = i.id
WHERE t.sequence = (
  SELECT MAX(latest.sequence) FROM managed_command_transitions latest
  WHERE latest.command_id = i.id
);

CREATE UNIQUE INDEX action_receipts_revision
  ON action_receipts(run_id, revision) WHERE revision IS NOT NULL;
CREATE UNIQUE INDEX managed_command_dispatch_sequence
  ON managed_command_intents(source_id,lobby_code,dispatch_sequence);
CREATE INDEX purge_sanitization_status ON purge_sanitization(status);
CREATE UNIQUE INDEX lease_event_identity
  ON game_events(run_id,action_id,event_type)
  WHERE event_type IN ('audio_lease_acquired','audio_lease_released','audio_lease_expired',
    'audio_lease_renewed') AND action_id IS NOT NULL;

CREATE TRIGGER history_transitions_immutable_update BEFORE UPDATE ON history_transitions
BEGIN SELECT RAISE(ABORT, 'history transitions are immutable'); END;
CREATE TRIGGER history_transitions_immutable_delete BEFORE DELETE ON history_transitions
BEGIN SELECT RAISE(ABORT, 'history transitions are immutable'); END;
CREATE TRIGGER command_transitions_immutable_update BEFORE UPDATE ON managed_command_transitions
BEGIN SELECT RAISE(ABORT, 'command transitions are immutable'); END;
CREATE TRIGGER command_transitions_immutable_delete BEFORE DELETE ON managed_command_transitions
BEGIN SELECT RAISE(ABORT, 'command transitions are immutable'); END;
CREATE TRIGGER history_transition_chain BEFORE INSERT ON history_transitions
WHEN (NEW.sequence=1 AND NOT (NEW.from_state IS NULL AND NEW.to_state='recording'))
  OR (NEW.sequence=1 AND NEW.occurred_at < (
    SELECT run.created_at FROM game_runs run WHERE run.id=NEW.run_id
  ))
  OR (NEW.sequence>1 AND NOT EXISTS (
    SELECT 1 FROM history_transitions prior
    WHERE prior.run_id=NEW.run_id AND prior.sequence=NEW.sequence-1
      AND prior.to_state=NEW.from_state
  ))
  OR (NEW.sequence>1 AND NEW.occurred_at < (
    SELECT prior.occurred_at FROM history_transitions prior
    WHERE prior.run_id=NEW.run_id AND prior.sequence=NEW.sequence-1
  ))
  OR (NEW.sequence>1 AND NOT (
    (NEW.from_state='recording' AND NEW.to_state='terminal_pending') OR
    (NEW.from_state='terminal_pending' AND NEW.to_state='sealed') OR
    (NEW.from_state='sealed' AND NEW.to_state='purging') OR
    (NEW.from_state='purging' AND NEW.to_state='purged')
  ))
BEGIN SELECT RAISE(ABORT, 'history transition chain is invalid'); END;
CREATE TRIGGER command_transition_chain BEFORE INSERT ON managed_command_transitions
WHEN (NEW.claim_generation IS NOT NULL AND EXISTS (
    SELECT 1 FROM managed_command_transitions existing
    WHERE existing.claim_generation=NEW.claim_generation
      AND existing.command_id<>NEW.command_id
  ))
  OR (NEW.sequence=1 AND NOT (NEW.from_state IS NULL AND NEW.to_state='queued'))
  OR (NEW.sequence>1 AND NOT EXISTS (
    SELECT 1 FROM managed_command_transitions prior
    WHERE prior.command_id=NEW.command_id AND prior.sequence=NEW.sequence-1
      AND prior.to_state=NEW.from_state
  ))
  OR (NEW.sequence=1 AND NEW.occurred_at < (
    SELECT intent.created_at FROM managed_command_intents intent WHERE intent.id=NEW.command_id
  ))
  OR (NEW.sequence>1 AND NEW.occurred_at < (
    SELECT prior.occurred_at FROM managed_command_transitions prior
    WHERE prior.command_id=NEW.command_id AND prior.sequence=NEW.sequence-1
  ))
  OR (NEW.sequence>1 AND NEW.to_state<>'cancelled'
    AND (SELECT prior.claim_generation FROM managed_command_transitions prior
      WHERE prior.command_id=NEW.command_id AND prior.sequence=NEW.sequence-1) IS NOT NULL
    AND NEW.claim_generation IS NOT (
      SELECT prior.claim_generation FROM managed_command_transitions prior
      WHERE prior.command_id=NEW.command_id AND prior.sequence=NEW.sequence-1
    ))
  OR (NEW.sequence>1 AND NOT (
    (NEW.from_state='queued' AND NEW.to_state IN ('claimed','cancelled')) OR
    (NEW.from_state='claimed' AND NEW.to_state IN ('executing','outcome_unknown')) OR
    (NEW.from_state='executing' AND NEW.to_state IN ('completed','failed','outcome_unknown')) OR
    (NEW.from_state='outcome_unknown' AND NEW.to_state IN ('completed','failed'))
  ))
  OR NOT (
    (NEW.to_state='queued' AND NEW.claim_generation IS NULL
      AND NEW.outcome_fingerprint IS NULL AND NEW.playback_status IS NULL
      AND NEW.error_category IS NULL AND NEW.reason_code IS NULL) OR
    (NEW.to_state IN ('claimed','executing') AND NEW.claim_generation IS NOT NULL
      AND NEW.outcome_fingerprint IS NULL AND NEW.playback_status IS NULL
      AND NEW.error_category IS NULL AND NEW.reason_code IS NULL) OR
    (NEW.to_state='completed' AND NEW.claim_generation IS NOT NULL
      AND NEW.outcome_fingerprint IS NOT NULL
      AND NEW.playback_status=(SELECT CASE WHEN intent.kind='pause' THEN 'paused' ELSE 'playing' END
        FROM managed_command_intents intent WHERE intent.id=NEW.command_id)
      AND NEW.error_category IS NULL AND NEW.reason_code IS NULL) OR
    (NEW.to_state='failed' AND NEW.claim_generation IS NOT NULL
      AND NEW.outcome_fingerprint IS NOT NULL AND NEW.playback_status='error'
      AND NEW.error_category IS NOT NULL AND NEW.reason_code=NEW.error_category) OR
    (NEW.to_state='outcome_unknown' AND NEW.claim_generation IS NOT NULL
      AND NEW.outcome_fingerprint IS NULL AND NEW.playback_status IS NULL
      AND NEW.error_category IS NULL AND NEW.reason_code IS NOT NULL) OR
    (NEW.to_state='cancelled' AND NEW.claim_generation IS NULL
      AND NEW.outcome_fingerprint IS NULL AND NEW.playback_status IS NULL
      AND NEW.error_category IS NULL AND NEW.reason_code IS NOT NULL)
  )
BEGIN SELECT RAISE(ABORT, 'managed command transition chain is invalid'); END;
CREATE TRIGGER managed_command_intents_immutable_update BEFORE UPDATE ON managed_command_intents
BEGIN SELECT RAISE(ABORT, 'managed command intents are immutable'); END;
CREATE TRIGGER managed_command_intents_immutable_delete BEFORE DELETE ON managed_command_intents
BEGIN SELECT RAISE(ABORT, 'managed command intents are immutable'); END;
CREATE TRIGGER managed_source_handoff_chain BEFORE INSERT ON managed_source_handoff_transitions
WHEN (NEW.sequence=1 AND EXISTS (
    SELECT 1 FROM managed_source_handoff_current current
    JOIN managed_source_handoffs incoming ON incoming.id=NEW.handoff_id
    WHERE current.source_id=incoming.source_id AND current.handoff_state<>'safe'
      AND current.id<>NEW.handoff_id
  ))
  OR (NEW.sequence=1 AND NOT (NEW.from_state IS NULL
      AND NEW.to_state IN ('stop_required','quarantined')))
  OR (NEW.sequence>1 AND NOT EXISTS (
    SELECT 1 FROM managed_source_handoff_transitions prior
    WHERE prior.handoff_id=NEW.handoff_id AND prior.sequence=NEW.sequence-1
      AND prior.to_state=NEW.from_state
  ))
  OR (NEW.sequence>1 AND NEW.occurred_at < (
    SELECT prior.occurred_at FROM managed_source_handoff_transitions prior
    WHERE prior.handoff_id=NEW.handoff_id AND prior.sequence=NEW.sequence-1
  ))
  OR (NEW.sequence>1 AND NOT (
    (NEW.from_state='stop_required' AND NEW.to_state='stop_claimed') OR
    (NEW.from_state='stop_claimed' AND NEW.to_state IN ('stop_executing','quarantined')) OR
    (NEW.from_state='stop_executing' AND NEW.to_state IN ('safe','quarantined')) OR
    (NEW.from_state='quarantined' AND NEW.to_state='stop_required')
  ))
  OR NOT EXISTS (
    SELECT 1 FROM managed_source_handoffs handoff
    JOIN managed_command_current command ON command.id=handoff.stop_command_id
    WHERE handoff.id=NEW.handoff_id AND (
      (NEW.to_state='stop_required' AND command.command_state='queued') OR
      (NEW.to_state='stop_claimed' AND command.command_state='claimed') OR
      (NEW.to_state='stop_executing' AND command.command_state='executing') OR
      (NEW.to_state='quarantined'
        AND command.command_state IN ('queued','failed','outcome_unknown')) OR
      (NEW.to_state='safe' AND command.command_state='completed'
        AND command.playback_status='paused')
    )
  )
BEGIN SELECT RAISE(ABORT, 'managed source handoff transition is invalid'); END;
CREATE TRIGGER managed_source_handoffs_immutable_update BEFORE UPDATE ON managed_source_handoffs
BEGIN SELECT RAISE(ABORT, 'managed source handoff intents are immutable'); END;
CREATE TRIGGER managed_source_handoffs_immutable_delete BEFORE DELETE ON managed_source_handoffs
BEGIN SELECT RAISE(ABORT, 'managed source handoff intents are immutable'); END;
CREATE TRIGGER managed_source_handoff_transitions_immutable_update
BEFORE UPDATE ON managed_source_handoff_transitions
BEGIN SELECT RAISE(ABORT, 'managed source handoff transitions are immutable'); END;
CREATE TRIGGER managed_source_handoff_transitions_immutable_delete
BEFORE DELETE ON managed_source_handoff_transitions
BEGIN SELECT RAISE(ABORT, 'managed source handoff transitions are immutable'); END;
CREATE TRIGGER purge_tombstones_immutable_update BEFORE UPDATE ON purge_tombstones
BEGIN SELECT RAISE(ABORT, 'purge tombstones are immutable'); END;
CREATE TRIGGER purge_tombstones_immutable_delete BEFORE DELETE ON purge_tombstones
BEGIN SELECT RAISE(ABORT, 'purge tombstones are immutable'); END;
CREATE TRIGGER purge_sanitization_transition_guard BEFORE UPDATE ON purge_sanitization
WHEN NOT (OLD.status='pending' AND OLD.completed_at IS NULL
  AND NEW.status='complete' AND NEW.completed_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'purge sanitization transition is invalid'); END;
CREATE TRIGGER purge_sanitization_delete_guard BEFORE DELETE ON purge_sanitization
BEGIN SELECT RAISE(ABORT, 'purge sanitization evidence is immutable'); END;
CREATE TRIGGER migration_manifests_immutable_update BEFORE UPDATE ON migration_manifests
BEGIN SELECT RAISE(ABORT, 'migration manifests are immutable'); END;
CREATE TRIGGER migration_manifests_immutable_delete BEFORE DELETE ON migration_manifests
BEGIN SELECT RAISE(ABORT, 'migration manifests are immutable'); END;
CREATE TRIGGER migration_manifests_singleton BEFORE INSERT ON migration_manifests
WHEN EXISTS (SELECT 1 FROM migration_manifests)
BEGIN SELECT RAISE(ABORT, 'state authority accepts exactly one migration manifest'); END;

CREATE TRIGGER history_stream_lifecycle_guard BEFORE UPDATE OF lifecycle,purged_at ON history_streams
WHEN (SELECT status FROM state_authority WHERE singleton='state')='active' AND NOT (
  (OLD.lifecycle=NEW.lifecycle AND OLD.purged_at IS NEW.purged_at) OR
  (OLD.lifecycle='recording' AND NEW.lifecycle='terminal_pending' AND NEW.purged_at IS NULL) OR
  (OLD.lifecycle='terminal_pending' AND NEW.lifecycle='sealed' AND NEW.purged_at IS NULL) OR
  (OLD.lifecycle='sealed' AND NEW.lifecycle='purging' AND NEW.purged_at IS NULL) OR
  (OLD.lifecycle='purging' AND NEW.lifecycle='purged' AND NEW.purged_at IS NOT NULL)
)
BEGIN SELECT RAISE(ABORT, 'history lifecycle transition is invalid'); END;
CREATE TRIGGER history_stream_purged_immutable BEFORE UPDATE ON history_streams
WHEN (SELECT status FROM state_authority WHERE singleton='state')='active'
  AND OLD.lifecycle='purged'
BEGIN SELECT RAISE(ABORT, 'purged history is immutable'); END;
CREATE TRIGGER history_stream_delete_guard BEFORE DELETE ON history_streams
WHEN (SELECT status FROM state_authority WHERE singleton='state')='active'
BEGIN SELECT RAISE(ABORT, 'history streams cannot be deleted'); END;

CREATE TRIGGER game_events_insert_guard BEFORE INSERT ON game_events
WHEN (SELECT status FROM state_authority WHERE singleton='state')='active'
  AND (NEW.revision IS NULL OR NEW.revision>(SELECT revision FROM game_runs WHERE id=NEW.run_id)
    OR (NEW.event_type IN ('audio_lease_acquired','audio_lease_released','audio_lease_expired',
      'audio_lease_renewed') AND NEW.action_id IS NULL)
    OR COALESCE((SELECT lifecycle FROM history_streams WHERE run_id=NEW.run_id),'missing')
    NOT IN ('recording','terminal_pending') OR
    ((SELECT lifecycle FROM history_streams WHERE run_id=NEW.run_id)='terminal_pending'
      AND NOT (
        NEW.event_type='audio_lease_released' OR
        (NEW.event_type IN ('audio_command_delivered','audio_command_completed','audio_command_failed',
          'audio_command_outcome_unknown','audio_command_cancelled')
          AND NEW.command_ref IS NOT NULL
          AND EXISTS (SELECT 1 FROM managed_command_current command
            WHERE command.id=NEW.command_ref AND command.run_id=NEW.run_id
              AND ((NEW.event_type='audio_command_delivered'
                  AND command.command_state='claimed'
                  AND EXISTS (SELECT 1 FROM managed_source_handoffs handoff
                    WHERE handoff.stop_command_id=command.id))
                OR (NEW.event_type='audio_command_completed' AND command.command_state='completed')
                OR (NEW.event_type='audio_command_failed' AND command.command_state='failed')
                OR (NEW.event_type='audio_command_outcome_unknown'
                  AND command.command_state='outcome_unknown')
                OR (NEW.event_type='audio_command_cancelled'
                  AND command.command_state='cancelled')))
        )
      )))
BEGIN SELECT RAISE(ABORT, 'history is closed to new events'); END;
CREATE TRIGGER game_events_update_guard BEFORE UPDATE ON game_events
WHEN (SELECT status FROM state_authority WHERE singleton='state')='active'
BEGIN SELECT RAISE(ABORT, 'game events are immutable'); END;
CREATE TRIGGER game_events_delete_guard BEFORE DELETE ON game_events
WHEN (SELECT status FROM state_authority WHERE singleton='state')='active'
  AND COALESCE((SELECT lifecycle FROM history_streams WHERE run_id=OLD.run_id),'missing')<>'purging'
BEGIN SELECT RAISE(ABORT, 'game events may only be removed by purge'); END;

CREATE TRIGGER action_receipts_insert_guard BEFORE INSERT ON action_receipts
WHEN (SELECT status FROM state_authority WHERE singleton='state')='active'
  AND (COALESCE((SELECT lifecycle FROM history_streams WHERE run_id=NEW.run_id),'missing')
    <>'recording' OR NEW.revision IS NULL)
BEGIN SELECT RAISE(ABORT, 'history is closed to new receipts'); END;
CREATE TRIGGER action_receipts_update_guard BEFORE UPDATE ON action_receipts
WHEN (SELECT status FROM state_authority WHERE singleton='state')='active'
BEGIN SELECT RAISE(ABORT, 'action receipts are immutable'); END;
CREATE TRIGGER action_receipts_delete_guard BEFORE DELETE ON action_receipts
WHEN (SELECT status FROM state_authority WHERE singleton='state')='active'
  AND COALESCE((SELECT lifecycle FROM history_streams WHERE run_id=OLD.run_id),'missing')<>'purging'
BEGIN SELECT RAISE(ABORT, 'action receipts may only be removed by purge'); END;

CREATE TRIGGER command_payloads_update_guard BEFORE UPDATE ON managed_command_payloads
WHEN (SELECT status FROM state_authority WHERE singleton='state')='active'
BEGIN SELECT RAISE(ABORT, 'managed command payloads are immutable'); END;
CREATE TRIGGER command_payloads_insert_guard BEFORE INSERT ON managed_command_payloads
WHEN (SELECT status FROM state_authority WHERE singleton='state')='active'
  AND COALESCE((SELECT stream.lifecycle FROM managed_command_intents command
    JOIN history_streams stream ON stream.run_id=command.run_id
    WHERE command.id=NEW.command_id),'missing') NOT IN ('recording','terminal_pending')
BEGIN SELECT RAISE(ABORT, 'history is closed to command payloads'); END;
CREATE TRIGGER command_payloads_delete_guard BEFORE DELETE ON managed_command_payloads
WHEN (SELECT status FROM state_authority WHERE singleton='state')='active'
  AND COALESCE((SELECT stream.lifecycle FROM managed_command_intents command
    JOIN history_streams stream ON stream.run_id=command.run_id
    WHERE command.id=OLD.command_id),'missing')<>'purging'
BEGIN SELECT RAISE(ABORT, 'managed command payloads may only be removed by purge'); END;

CREATE TRIGGER command_transition_history_guard BEFORE INSERT ON managed_command_transitions
WHEN (SELECT status FROM state_authority WHERE singleton='state')='active'
  AND COALESCE((SELECT stream.lifecycle FROM managed_command_intents command
    JOIN history_streams stream ON stream.run_id=command.run_id
    WHERE command.id=NEW.command_id),'missing') IN ('sealed','purging','purged')
BEGIN SELECT RAISE(ABORT, 'managed command history is closed'); END;
CREATE TRIGGER game_runs_delete_guard BEFORE DELETE ON game_runs
WHEN (SELECT status FROM state_authority WHERE singleton='state')='active'
  AND EXISTS (SELECT 1 FROM history_streams WHERE run_id=OLD.id)
BEGIN SELECT RAISE(ABORT, 'run history boundary cannot be deleted'); END;
CREATE TRIGGER game_runs_purged_update_guard BEFORE UPDATE ON game_runs
WHEN (SELECT status FROM state_authority WHERE singleton='state')='active'
  AND EXISTS (SELECT 1 FROM history_streams
    WHERE run_id=OLD.id AND lifecycle='purged')
BEGIN SELECT RAISE(ABORT, 'purged run authority is immutable'); END;
`;

export const STATE_SCHEMA_DIGEST = createHash("sha256").update(STATE_SCHEMA_SQL).digest("hex");
