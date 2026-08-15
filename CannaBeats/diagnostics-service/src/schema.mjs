export const DIAGNOSTIC_SCHEMA_GENERATION = 1;

export const DIAGNOSTIC_SCHEMA_SQL = String.raw`
CREATE TABLE diagnostic_schema_generations (
  generation INTEGER PRIMARY KEY,
  contract_digest TEXT NOT NULL,
  applied_at INTEGER NOT NULL
) STRICT;

CREATE TABLE diagnostic_store (
  singleton TEXT PRIMARY KEY CHECK (singleton='diagnostics'),
  trace_count INTEGER NOT NULL DEFAULT 0 CHECK (trace_count BETWEEN 0 AND 32),
  report_count INTEGER NOT NULL DEFAULT 0 CHECK (report_count BETWEEN 0 AND 90000),
  request_count INTEGER NOT NULL DEFAULT 0 CHECK (request_count BETWEEN 0 AND 4096),
  canonical_bytes INTEGER NOT NULL DEFAULT 0 CHECK (canonical_bytes BETWEEN 0 AND 201326592),
  mode TEXT NOT NULL DEFAULT 'healthy' CHECK (mode IN ('healthy','data_degraded')),
  degraded_reason TEXT CHECK (degraded_reason IN ('retained_data_invalid','counter_mismatch')),
  CHECK ((mode='healthy' AND degraded_reason IS NULL)
    OR (mode='data_degraded' AND degraded_reason IS NOT NULL))
) STRICT;

CREATE TABLE diagnostic_traces (
  trace_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  run_generation INTEGER NOT NULL CHECK (run_generation > 0),
  status TEXT NOT NULL CHECK (status IN ('active','ended')),
  started_at REAL NOT NULL CHECK (started_at >= 0),
  active_expires_at REAL NOT NULL CHECK (active_expires_at = started_at + 21600000),
  ended_at REAL,
  end_reason TEXT CHECK (end_reason IN ('host_stopped','expired','run_replaced','authority_lost')),
  purge_after REAL,
  current_segment_id TEXT NOT NULL,
  report_revision INTEGER NOT NULL DEFAULT 0 CHECK (report_revision >= 0),
  periodic_count INTEGER NOT NULL DEFAULT 0 CHECK (periodic_count BETWEEN 0 AND 24000),
  transition_count INTEGER NOT NULL DEFAULT 0 CHECK (transition_count BETWEEN 0 AND 6000),
  canonical_bytes INTEGER NOT NULL DEFAULT 0 CHECK (canonical_bytes BETWEEN 0 AND 67108864),
  canonical_state BLOB NOT NULL,
  CHECK ((status='active' AND ended_at IS NULL AND end_reason IS NULL AND purge_after IS NULL)
    OR (status='ended' AND ended_at IS NOT NULL AND end_reason IS NOT NULL
      AND purge_after = ended_at + 172800000)),
  CHECK (end_reason IS NULL OR (end_reason='expired' AND ended_at=active_expires_at)
    OR (end_reason<>'expired' AND ended_at>=started_at AND ended_at<active_expires_at))
) STRICT;
CREATE UNIQUE INDEX diagnostic_one_active_trace ON diagnostic_traces(status) WHERE status='active';

CREATE TABLE diagnostic_segments (
  segment_id TEXT PRIMARY KEY,
  trace_id TEXT NOT NULL REFERENCES diagnostic_traces(trace_id) ON DELETE CASCADE,
  lease_id TEXT NOT NULL,
  started_at REAL NOT NULL CHECK (started_at >= 0),
  UNIQUE(trace_id,lease_id),
  UNIQUE(trace_id,segment_id)
) STRICT;

CREATE TABLE diagnostic_issuances (
  sample_id TEXT PRIMARY KEY,
  trace_id TEXT NOT NULL REFERENCES diagnostic_traces(trace_id) ON DELETE CASCADE,
  instance_id TEXT NOT NULL,
  timebase_id TEXT NOT NULL,
  server_receive_ms REAL NOT NULL CHECK (server_receive_ms >= 0),
  server_send_ms REAL NOT NULL CHECK (server_send_ms >= server_receive_ms),
  expires_at REAL NOT NULL CHECK (expires_at = server_send_ms + 120000),
  canonical_issuance BLOB NOT NULL
) STRICT;
CREATE INDEX diagnostic_issuance_expiry ON diagnostic_issuances(expires_at);

CREATE TABLE diagnostic_consents (
  trace_id TEXT NOT NULL REFERENCES diagnostic_traces(trace_id) ON DELETE CASCADE,
  listener_instance_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation > 0),
  status TEXT NOT NULL CHECK (status IN ('enabled','revoked')),
  first_allowed_sequence INTEGER NOT NULL CHECK (first_allowed_sequence >= 0),
  local_consent_started_ms REAL NOT NULL CHECK (local_consent_started_ms >= 0),
  changed_at REAL NOT NULL CHECK (changed_at >= 0),
  canonical_state BLOB NOT NULL,
  PRIMARY KEY(trace_id,listener_instance_id)
) STRICT;

CREATE TABLE diagnostic_relay_bindings (
  relay_generation_id TEXT PRIMARY KEY,
  trace_id TEXT NOT NULL REFERENCES diagnostic_traces(trace_id) ON DELETE CASCADE,
  segment_id TEXT NOT NULL REFERENCES diagnostic_segments(segment_id),
  lease_id TEXT NOT NULL,
  canonical_state BLOB NOT NULL
) STRICT;

CREATE TABLE diagnostic_reports (
  trace_id TEXT NOT NULL REFERENCES diagnostic_traces(trace_id) ON DELETE CASCADE,
  instance_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence >= 0),
  row_ordinal INTEGER NOT NULL CHECK (row_ordinal > 0),
  segment_id TEXT NOT NULL REFERENCES diagnostic_segments(segment_id),
  kind TEXT NOT NULL CHECK (kind IN ('listener_window','listener_transition','source_window','source_transition','relay_window','relay_transition')),
  bucket TEXT NOT NULL CHECK (bucket IN ('periodic','transition')),
  received_at REAL NOT NULL CHECK (received_at >= 0),
  mapped_start_earliest REAL NOT NULL CHECK (mapped_start_earliest >= 0),
  mapped_end_latest REAL NOT NULL CHECK (mapped_end_latest >= mapped_start_earliest),
  core_digest TEXT NOT NULL CHECK (length(core_digest)=64),
  envelope_digest TEXT NOT NULL CHECK (length(envelope_digest)=64),
  canonical_envelope BLOB NOT NULL CHECK (length(canonical_envelope)<=4096),
  PRIMARY KEY(trace_id,instance_id,sequence),
  UNIQUE(trace_id,row_ordinal),
  CHECK ((kind LIKE '%_window' AND bucket='periodic')
    OR (kind LIKE '%_transition' AND bucket='transition'))
) STRICT;
CREATE INDEX diagnostic_report_order ON diagnostic_reports
  (trace_id,mapped_start_earliest,mapped_end_latest,kind,instance_id,sequence);

CREATE TABLE diagnostic_requests (
  request_id TEXT PRIMARY KEY,
  trace_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('trace_start','trace_end','consent_opt_in','consent_stop','relay_bind','trace_purge')),
  fingerprint TEXT NOT NULL CHECK (length(fingerprint)=64),
  canonical_receipt BLOB NOT NULL CHECK (length(canonical_receipt)<=4096),
  accepted_at REAL NOT NULL CHECK (accepted_at >= 0),
  expires_at REAL NOT NULL CHECK (expires_at >= accepted_at)
) STRICT;
CREATE INDEX diagnostic_request_expiry ON diagnostic_requests(expires_at);

CREATE TABLE diagnostic_request_tombstones (
  request_id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL CHECK (length(fingerprint)=64),
  created_at REAL NOT NULL CHECK (created_at >= 0),
  expires_at REAL NOT NULL CHECK (expires_at = created_at + 172800000)
) STRICT;

CREATE TRIGGER diagnostic_request_identity_live BEFORE INSERT ON diagnostic_requests
WHEN EXISTS (SELECT 1 FROM diagnostic_request_tombstones WHERE request_id=NEW.request_id)
BEGIN SELECT RAISE(ABORT,'diagnostic request identity is retained'); END;
CREATE TRIGGER diagnostic_request_identity_tombstone BEFORE INSERT ON diagnostic_request_tombstones
WHEN EXISTS (SELECT 1 FROM diagnostic_requests WHERE request_id=NEW.request_id)
BEGIN SELECT RAISE(ABORT,'diagnostic request identity is retained'); END;
CREATE TRIGGER diagnostic_request_tombstones_immutable_update
BEFORE UPDATE ON diagnostic_request_tombstones
BEGIN SELECT RAISE(ABORT,'diagnostic request tombstone is immutable'); END;
CREATE TRIGGER diagnostic_requests_fixed_update BEFORE UPDATE ON diagnostic_requests
WHEN NEW.request_id<>OLD.request_id OR NEW.trace_id<>OLD.trace_id
  OR NEW.operation<>OLD.operation OR NEW.fingerprint<>OLD.fingerprint
  OR NEW.canonical_receipt<>OLD.canonical_receipt OR NEW.accepted_at<>OLD.accepted_at
BEGIN SELECT RAISE(ABORT,'diagnostic request receipt is immutable'); END;

CREATE TRIGGER diagnostic_traces_monotonic_update BEFORE UPDATE ON diagnostic_traces
WHEN NEW.trace_id<>OLD.trace_id OR NEW.run_id<>OLD.run_id
  OR NEW.run_generation<>OLD.run_generation OR NEW.started_at<>OLD.started_at
  OR NEW.active_expires_at<>OLD.active_expires_at
  OR NEW.report_revision<OLD.report_revision OR NEW.periodic_count<OLD.periodic_count
  OR NEW.transition_count<OLD.transition_count OR NEW.canonical_bytes<OLD.canonical_bytes
  OR (OLD.status='ended' AND (NEW.status<>OLD.status
    OR NEW.ended_at<>OLD.ended_at OR NEW.end_reason<>OLD.end_reason
    OR NEW.purge_after<>OLD.purge_after OR NEW.current_segment_id<>OLD.current_segment_id
    OR NEW.canonical_state<>OLD.canonical_state))
BEGIN SELECT RAISE(ABORT,'diagnostic trace authority is monotonic'); END;

CREATE TRIGGER diagnostic_segments_immutable_update BEFORE UPDATE ON diagnostic_segments BEGIN SELECT RAISE(ABORT,'diagnostic segment is immutable'); END;
CREATE TRIGGER diagnostic_issuances_immutable_update BEFORE UPDATE ON diagnostic_issuances BEGIN SELECT RAISE(ABORT,'diagnostic issuance is immutable'); END;
CREATE TRIGGER diagnostic_segments_immutable_delete BEFORE DELETE ON diagnostic_segments
WHEN EXISTS (SELECT 1 FROM diagnostic_traces WHERE trace_id=OLD.trace_id)
  AND (EXISTS (SELECT 1 FROM diagnostic_traces WHERE current_segment_id=OLD.segment_id)
    OR EXISTS (SELECT 1 FROM diagnostic_reports WHERE segment_id=OLD.segment_id)
    OR EXISTS (SELECT 1 FROM diagnostic_relay_bindings WHERE segment_id=OLD.segment_id))
BEGIN SELECT RAISE(ABORT,'diagnostic segment is retained'); END;
CREATE TRIGGER diagnostic_relay_bindings_immutable_update BEFORE UPDATE ON diagnostic_relay_bindings BEGIN SELECT RAISE(ABORT,'diagnostic relay binding is immutable'); END;
CREATE TRIGGER diagnostic_relay_bindings_immutable_delete BEFORE DELETE ON diagnostic_relay_bindings WHEN EXISTS (SELECT 1 FROM diagnostic_traces WHERE trace_id=OLD.trace_id) BEGIN SELECT RAISE(ABORT,'diagnostic relay binding is immutable'); END;
CREATE TRIGGER diagnostic_reports_immutable_update BEFORE UPDATE ON diagnostic_reports BEGIN SELECT RAISE(ABORT,'diagnostic report is immutable'); END;
CREATE TRIGGER diagnostic_reports_immutable_delete BEFORE DELETE ON diagnostic_reports WHEN EXISTS (SELECT 1 FROM diagnostic_traces WHERE trace_id=OLD.trace_id) BEGIN SELECT RAISE(ABORT,'diagnostic report is immutable'); END;
`;
