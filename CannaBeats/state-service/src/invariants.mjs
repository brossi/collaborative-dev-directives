import { redactRoomStateForRetention, validateRoomState } from "./game-domain.mjs";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PLAYBACK_ERROR_CATEGORIES = new Set([
  "authentication_required", "browser_unavailable", "device_unavailable",
  "managed_playback_failed", "relay_unavailable", "spotify_unavailable",
  "unrecognized_reason",
]);

export function validateStateDatabase(db, { requireCandidate = false } = {}) {
  const violations = [];
  const authority = db.prepare(`SELECT status,activated_at,first_admitted_at
    FROM state_authority WHERE singleton='state'`).get();
  const authorityCount = db.prepare("SELECT COUNT(*) AS count FROM state_authority").get().count;
  if (!authority || authorityCount !== 1) violations.push("state authority record is missing or duplicated");
  if (requireCandidate && authority?.status !== "candidate") {
    violations.push("state authority is not a candidate");
  }
  if (db.prepare("PRAGMA integrity_check").get().integrity_check !== "ok") {
    violations.push("SQLite integrity check failed");
  }
  if (db.prepare("PRAGMA foreign_key_check").all().length) {
    violations.push("foreign-key validation failed");
  }
  const streams = db.prepare(`SELECT stream.run_id,stream.baseline_revision,
      stream.last_recorded_revision,stream.lifecycle,stream.purged_at,
      run.revision,run.state,run.ended_at,run.terminal_outcome,run.lobby_code,
      lobby.status,lobby.active_run_id,lobby.run_generation
    FROM history_streams stream
    JOIN game_runs run ON run.id=stream.run_id
    JOIN lobbies lobby ON lobby.code=run.lobby_code`).all();
  const runCount = db.prepare("SELECT COUNT(*) AS count FROM game_runs").get().count;
  if (streams.length !== runCount) violations.push("every run must own one history stream");
  for (const stream of streams) {
    let roomState = null;
    try {
      roomState = validateRoomState(JSON.parse(stream.state));
      if (roomState.runId !== stream.run_id || roomState.code !== stream.lobby_code
          || roomState.revision !== stream.revision
          || (stream.active_run_id === stream.run_id
            && roomState.runGeneration !== stream.run_generation)) {
        violations.push(`run ${stream.run_id} snapshot identity is inconsistent`);
      }
    } catch {
      violations.push(`run ${stream.run_id} snapshot shape is invalid`);
    }
    if (stream.last_recorded_revision > stream.revision) {
      violations.push(`run ${stream.run_id} history exceeds its revision`);
    }
    const terminal = ["terminal_pending", "sealed", "purged"].includes(stream.lifecycle);
    if (terminal && (!stream.ended_at || !["completed", "abandoned"].includes(stream.terminal_outcome)
        || stream.status !== "ended" || stream.active_run_id !== stream.run_id)) {
      violations.push(`run ${stream.run_id} terminal evidence is inconsistent`);
    }
    if (terminal && ((stream.terminal_outcome === "completed" && roomState?.phase !== "finished")
        || (stream.terminal_outcome === "abandoned" && roomState?.phase === "finished"))) {
      violations.push(`run ${stream.run_id} terminal snapshot phase is inconsistent`);
    }
    if (stream.lifecycle === "purging") {
      violations.push(`run ${stream.run_id} is interrupted during purge`);
    }
    if (stream.lifecycle === "recording" && (stream.ended_at !== null || stream.terminal_outcome !== null)) {
      violations.push(`run ${stream.run_id} ended while history is recording`);
    }
    if (["terminal_pending", "sealed"].includes(stream.lifecycle)
        && stream.last_recorded_revision !== stream.revision) {
      violations.push(`run ${stream.run_id} terminal history coverage is incomplete`);
    }
    if (["terminal_pending", "sealed"].includes(stream.lifecycle)) {
      const expectedType = stream.terminal_outcome === "completed" ? "game_completed" : "game_abandoned";
      const terminalEvents = db.prepare(`SELECT
          SUM(CASE WHEN event_type=? AND outcome=? THEN 1 ELSE 0 END) AS matching,
          SUM(CASE WHEN event_type IN ('game_completed','game_abandoned')
            AND NOT (event_type=? AND outcome=?) THEN 1 ELSE 0 END) AS conflicting
        FROM game_events WHERE run_id=?`).get(
        expectedType,stream.terminal_outcome,expectedType,stream.terminal_outcome,stream.run_id,
      );
      if (terminalEvents.matching !== 1 || terminalEvents.conflicting) {
        violations.push(`run ${stream.run_id} terminal event evidence is inconsistent`);
      }
    }
    if (stream.lifecycle !== "purged" && stream.purged_at !== null) {
      violations.push(`run ${stream.run_id} has a purge timestamp before purge`);
    }
    if (stream.lifecycle === "purged") {
      if (roomState && JSON.stringify(roomState)
          !== JSON.stringify(redactRoomStateForRetention(roomState))) {
        violations.push(`run ${stream.run_id} retained snapshot is not privacy canonical`);
      }
      const payload = db.prepare(`SELECT
          (SELECT COUNT(*) FROM game_events WHERE run_id=?) AS events,
          (SELECT COUNT(*) FROM action_receipts WHERE run_id=?) AS receipts,
          (SELECT COUNT(*) FROM managed_command_payloads payload
            JOIN managed_command_intents command ON command.id=payload.command_id
            WHERE command.run_id=?) AS command_payloads,
          (SELECT COUNT(*) FROM purge_tombstones WHERE run_id=?) AS tombstones`).get(
        stream.run_id,stream.run_id,stream.run_id,stream.run_id,
      );
      if (!stream.purged_at || payload.events || payload.receipts || payload.command_payloads
          || payload.tombstones !== 1) {
        violations.push(`run ${stream.run_id} purge boundary is incomplete`);
      }
      const sanitization = db.prepare(`SELECT status,completed_at FROM purge_sanitization
        WHERE run_id=?`).get(stream.run_id);
      if (!sanitization || !["pending", "complete"].includes(sanitization.status)
          || (sanitization.status === "complete" && !sanitization.completed_at)) {
        violations.push(`run ${stream.run_id} purge sanitization evidence is incomplete`);
      }
    }
    if (["sealed", "purged"].includes(stream.lifecycle)) {
      const unresolved = db.prepare(`SELECT COUNT(*) AS count FROM managed_command_current
        WHERE run_id=? AND command_state IN ('queued','claimed','executing','outcome_unknown')`)
        .get(stream.run_id).count;
      if (unresolved) violations.push(`run ${stream.run_id} closed with executable commands`);
    }
  }
  const malformedTransitions = db.prepare(`SELECT COUNT(*) AS count
    FROM managed_command_transitions transition
    WHERE transition.sequence>1 AND transition.from_state<>(
      SELECT prior.to_state FROM managed_command_transitions prior
      WHERE prior.command_id=transition.command_id AND prior.sequence=transition.sequence-1
    )`).get().count;
  if (malformedTransitions) violations.push("managed-command transition chain is discontinuous");
  const nonMonotonicCommandEvidence = db.prepare(`SELECT COUNT(*) AS count
    FROM managed_command_transitions transition
    JOIN managed_command_intents command ON command.id=transition.command_id
    LEFT JOIN managed_command_transitions prior ON prior.command_id=transition.command_id
      AND prior.sequence=transition.sequence-1
    WHERE (transition.sequence=1 AND transition.occurred_at<command.created_at)
      OR (transition.sequence>1 AND transition.occurred_at<prior.occurred_at)`).get().count;
  if (nonMonotonicCommandEvidence) violations.push("managed-command chronology is invalid");
  const invalidCommandEventRevisions = db.prepare(`SELECT COUNT(*) AS count
    FROM game_events event JOIN game_runs run ON run.id=event.run_id
    WHERE event.command_ref IS NOT NULL
      AND (event.revision IS NULL OR event.revision<0 OR event.revision>run.revision)`).get().count;
  if (invalidCommandEventRevisions) violations.push("managed-command event revision is invalid");
  const invalidGeneralEventEvidence = db.prepare(`SELECT COUNT(*) AS count
    FROM game_events event
    JOIN game_runs run ON run.id=event.run_id
    LEFT JOIN game_events prior ON prior.run_id=event.run_id AND prior.sequence=event.sequence-1
    WHERE (event.revision IS NOT NULL AND (event.revision<0 OR event.revision>run.revision))
      OR (event.sequence>1 AND (prior.sequence IS NULL OR event.occurred_at<prior.occurred_at))`).get().count;
  if (invalidGeneralEventEvidence) violations.push("game-event chronology or revision is invalid");
  const invalidReceiptEvidence = db.prepare(`SELECT COUNT(*) AS count
    FROM action_receipts receipt
    JOIN game_runs run ON run.id=receipt.run_id
    WHERE (receipt.revision IS NULL
        AND COALESCE(json_extract(receipt.result,'$.legacy'),0)<>1)
      OR receipt.revision>run.revision
      OR (receipt.revision IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM game_events event WHERE event.run_id=receipt.run_id
          AND event.revision=receipt.revision AND event.action_id=receipt.action_id))`).get().count;
  if (invalidReceiptEvidence) violations.push("action-receipt revision evidence is invalid");
  const invalidLeaseEvents = db.prepare(`SELECT COUNT(*) AS count
    FROM game_events event
    WHERE event.event_type IN ('audio_lease_acquired','audio_lease_released',
        'audio_lease_expired','audio_lease_renewed')
      AND (event.action_id IS NULL OR NOT (
        (event.event_type='audio_lease_acquired' AND EXISTS (
          SELECT 1 FROM state_commands command WHERE command.command_id=event.action_id
            AND command.command_type='acquire_managed_lease')) OR
        (event.event_type='audio_lease_acquired' AND EXISTS (
          SELECT 1 FROM action_receipts receipt WHERE receipt.run_id=event.run_id
            AND receipt.action_id=event.action_id AND receipt.action='select_audio')) OR
        (event.event_type='audio_lease_renewed' AND EXISTS (
          SELECT 1 FROM state_commands command WHERE command.command_id=event.action_id
            AND command.command_type='renew_managed_lease')) OR
        (event.event_type='audio_lease_renewed' AND EXISTS (
          SELECT 1 FROM action_receipts receipt WHERE receipt.run_id=event.run_id
            AND receipt.action_id=event.action_id AND receipt.action='select_audio')) OR
        (event.event_type='audio_lease_expired' AND EXISTS (
          SELECT 1 FROM state_commands command WHERE command.command_id=event.action_id
            AND command.command_type IN ('expire_managed_leases','acquire_managed_lease'))) OR
        (event.event_type='audio_lease_expired' AND EXISTS (
          SELECT 1 FROM action_receipts receipt
          WHERE receipt.action_id=event.action_id AND receipt.action='select_audio')) OR
        (event.event_type='audio_lease_released' AND (
          EXISTS (SELECT 1 FROM state_commands command WHERE command.command_id=event.action_id
            AND command.command_type='release_managed_lease') OR
          EXISTS (SELECT 1 FROM action_receipts receipt WHERE receipt.run_id=event.run_id
            AND receipt.action_id=event.action_id)))
      ))`).get().count;
  if (invalidLeaseEvents) violations.push("managed-lease event authority is invalid");
  const illegalCommandEdges = db.prepare(`SELECT COUNT(*) AS count
    FROM managed_command_transitions
    WHERE (sequence=1 AND NOT (from_state IS NULL AND to_state='queued'))
       OR (sequence>1 AND NOT (
         (from_state='queued' AND to_state IN ('claimed','cancelled')) OR
         (from_state='claimed' AND to_state IN ('executing','outcome_unknown')) OR
         (from_state='executing' AND to_state IN ('completed','failed','outcome_unknown')) OR
         (from_state='outcome_unknown' AND to_state IN ('completed','failed'))
       ))`).get().count;
  if (illegalCommandEdges) violations.push("managed-command transition edge is invalid");
  const illegalCommandEvidence = db.prepare(`SELECT COUNT(*) AS count
    FROM managed_command_transitions transition
    JOIN managed_command_intents command ON command.id=transition.command_id
    LEFT JOIN managed_command_transitions prior ON prior.command_id=transition.command_id
      AND prior.sequence=transition.sequence-1
    WHERE NOT (
      (transition.to_state='queued' AND transition.claim_generation IS NULL
        AND transition.outcome_fingerprint IS NULL AND transition.playback_status IS NULL
        AND transition.error_category IS NULL AND transition.reason_code IS NULL) OR
      (transition.to_state IN ('claimed','executing') AND transition.claim_generation IS NOT NULL
        AND transition.outcome_fingerprint IS NULL AND transition.playback_status IS NULL
        AND transition.error_category IS NULL AND transition.reason_code IS NULL
        AND (prior.claim_generation IS NULL OR prior.claim_generation=transition.claim_generation)) OR
      (transition.to_state='completed' AND transition.claim_generation IS NOT NULL
        AND transition.claim_generation=prior.claim_generation
        AND transition.outcome_fingerprint IS NOT NULL
        AND transition.playback_status=CASE WHEN command.kind='pause' THEN 'paused' ELSE 'playing' END
        AND transition.error_category IS NULL AND transition.reason_code IS NULL) OR
      (transition.to_state='failed' AND transition.claim_generation IS NOT NULL
        AND transition.claim_generation=prior.claim_generation
        AND transition.outcome_fingerprint IS NOT NULL AND transition.playback_status='error'
        AND transition.error_category IS NOT NULL
        AND transition.reason_code=transition.error_category) OR
      (transition.to_state='outcome_unknown' AND transition.claim_generation IS NOT NULL
        AND transition.claim_generation=prior.claim_generation
        AND transition.outcome_fingerprint IS NULL AND transition.playback_status IS NULL
        AND transition.error_category IS NULL AND transition.reason_code IS NOT NULL) OR
      (transition.to_state='cancelled' AND transition.claim_generation IS NULL
        AND transition.outcome_fingerprint IS NULL AND transition.playback_status IS NULL
        AND transition.error_category IS NULL AND transition.reason_code IS NOT NULL)
    )`).get().count;
  if (illegalCommandEvidence) violations.push("managed-command transition evidence is invalid");
  const reusedClaimGenerations = db.prepare(`SELECT COUNT(*) AS count FROM (
    SELECT claim_generation FROM managed_command_transitions
    WHERE claim_generation IS NOT NULL GROUP BY claim_generation
    HAVING COUNT(DISTINCT command_id)<>1)`).get().count;
  if (reusedClaimGenerations) violations.push("managed-command claim generation is reused");
  const commandEventRows = db.prepare(`SELECT transition.command_id,transition.to_state,
      transition.claim_generation,transition.outcome_fingerprint,transition.error_category,
      transition.reason_code,transition.occurred_at,command.run_id,command.source_id,
      command.kind,command.action_id,payload.requested_by_principal_id,
      lobby.host_principal_id,stream.lifecycle
    FROM managed_command_transitions transition
    JOIN managed_command_intents command ON command.id=transition.command_id
    LEFT JOIN managed_command_payloads payload ON payload.command_id=command.id
    JOIN lobbies lobby ON lobby.code=command.lobby_code
    JOIN history_streams stream ON stream.run_id=command.run_id
    WHERE transition.to_state<>'executing' ORDER BY transition.command_id,transition.sequence`).all();
  const eventMatrix = {
    queued: ["audio_command_requested", "accepted", "host"],
    claimed: ["audio_command_delivered", "accepted", "source"],
    completed: ["audio_command_completed", "completed", "source"],
    failed: ["audio_command_failed", "failed", "source"],
    outcome_unknown: ["audio_command_outcome_unknown", "unknown", "system"],
    cancelled: ["audio_command_cancelled", "cancelled", "system"],
  };
  for (const transition of commandEventRows) {
    if (transition.claim_generation !== null && !UUID_PATTERN.test(transition.claim_generation)) {
      violations.push(`managed command ${transition.command_id} claim generation is invalid`);
    }
    if (["completed", "failed"].includes(transition.to_state)
        && !/^[0-9a-f]{64}$/i.test(transition.outcome_fingerprint ?? "")) {
      violations.push(`managed command ${transition.command_id} outcome fingerprint is invalid`);
    }
    if (transition.to_state === "failed"
        && !PLAYBACK_ERROR_CATEGORIES.has(transition.error_category)) {
      violations.push(`managed command ${transition.command_id} failure category is invalid`);
    }
    if (transition.lifecycle === "purged") continue;
    const [eventType,outcome,mappedActorType] = eventMatrix[transition.to_state];
    const reviewedCompletion = transition.to_state === "completed" && db.prepare(`SELECT 1
      FROM managed_source_handoffs handoff
      JOIN managed_source_handoff_resolutions resolution ON resolution.handoff_id=handoff.id
      WHERE handoff.stop_command_id=?`).get(transition.command_id);
    const actorType = reviewedCompletion ? "system"
      : transition.to_state === "queued"
        && transition.requested_by_principal_id !== transition.host_principal_id
        ? "player" : mappedActorType;
    const actorRef = ["host","player"].includes(actorType) ? transition.requested_by_principal_id
      : actorType === "source" ? transition.source_id : null;
    const reasonCode = ["failed", "outcome_unknown", "cancelled"].includes(transition.to_state)
      ? transition.reason_code : null;
    const exact = db.prepare(`SELECT COUNT(*) AS count FROM game_events
      WHERE run_id=? AND command_ref=? AND event_type=? AND outcome=? AND actor_type=?
        AND actor_ref IS ? AND action_id=? AND revision IS NOT NULL
        AND round IS NULL AND detail_code=? AND detail_value IS NULL
        AND reason_code IS ? AND occurred_at=?`).get(
      transition.run_id,transition.command_id,eventType,outcome,actorType,
      actorRef,transition.action_id,transition.kind,reasonCode,transition.occurred_at,
    ).count;
    if (exact !== 1) {
      violations.push(`managed command ${transition.command_id} event projection is inconsistent`);
    }
  }
  const projectedCount = commandEventRows.filter((row) => row.lifecycle !== "purged").length;
  const actualCommandEvents = db.prepare(`SELECT COUNT(*) AS count FROM game_events event
    JOIN history_streams stream ON stream.run_id=event.run_id
    WHERE stream.lifecycle<>'purged' AND event.command_ref IS NOT NULL`).get().count;
  if (actualCommandEvents !== projectedCount) {
    violations.push("managed-command event projection contains orphan or duplicate evidence");
  }
  const malformedHistoryTransitions = db.prepare(`SELECT COUNT(*) AS count
    FROM history_transitions transition
    WHERE transition.sequence>1 AND transition.from_state<>(
      SELECT prior.to_state FROM history_transitions prior
      WHERE prior.run_id=transition.run_id AND prior.sequence=transition.sequence-1
    )`).get().count;
  if (malformedHistoryTransitions) violations.push("history transition chain is discontinuous");
  const nonMonotonicHistoryTransitions = db.prepare(`SELECT COUNT(*) AS count
    FROM history_transitions transition
    JOIN game_runs run ON run.id=transition.run_id
    LEFT JOIN history_transitions prior ON prior.run_id=transition.run_id
      AND prior.sequence=transition.sequence-1
    WHERE (transition.sequence=1 AND transition.occurred_at<run.created_at)
      OR (transition.sequence>1 AND transition.occurred_at<prior.occurred_at)`).get().count;
  if (nonMonotonicHistoryTransitions) violations.push("history transition chronology is invalid");
  const illegalHistoryEdges = db.prepare(`SELECT COUNT(*) AS count
    FROM history_transitions
    WHERE (sequence=1 AND NOT (from_state IS NULL AND to_state='recording'))
       OR (sequence>1 AND NOT (
         (from_state='recording' AND to_state='terminal_pending') OR
         (from_state='terminal_pending' AND to_state='sealed') OR
         (from_state='sealed' AND to_state='purging') OR
         (from_state='purging' AND to_state='purged')
       ))`).get().count;
  if (illegalHistoryEdges) violations.push("history transition edge is invalid");
  const staleHistoryProjection = db.prepare(`SELECT COUNT(*) AS count
    FROM history_streams stream
    WHERE NOT EXISTS (SELECT 1 FROM history_transitions transition
      WHERE transition.run_id=stream.run_id)
      OR stream.lifecycle IS NOT (SELECT transition.to_state FROM history_transitions transition
        WHERE transition.run_id=stream.run_id ORDER BY transition.sequence DESC LIMIT 1)`).get().count;
  if (staleHistoryProjection) violations.push("history lifecycle projection is stale");
  const forbiddenTerminalEvents = db.prepare(`SELECT COUNT(*) AS count
    FROM history_streams stream JOIN game_events event ON event.run_id=stream.run_id
    WHERE stream.lifecycle IN ('terminal_pending','sealed')
      AND event.sequence>(SELECT MIN(terminal.sequence) FROM game_events terminal
        WHERE terminal.run_id=stream.run_id
          AND terminal.event_type IN ('game_completed','game_abandoned'))
      AND event.event_type NOT IN ('audio_command_requested','audio_command_delivered',
        'audio_command_completed','audio_command_failed',
        'audio_command_outcome_unknown','audio_command_cancelled','audio_lease_released')`).get().count;
  if (forbiddenTerminalEvents) violations.push("terminal history contains a non-reconciliation event");
  const strayTombstones = db.prepare(`SELECT COUNT(*) AS count FROM purge_tombstones tombstone
    JOIN history_streams stream ON stream.run_id=tombstone.run_id
    WHERE stream.lifecycle<>'purged'`).get().count;
  if (strayTombstones) violations.push("purge tombstone exists before the purge boundary");
  const straySanitization = db.prepare(`SELECT COUNT(*) AS count FROM purge_sanitization evidence
    JOIN history_streams stream ON stream.run_id=evidence.run_id
    WHERE stream.lifecycle<>'purged'`).get().count;
  if (straySanitization) violations.push("purge sanitization exists before the purge boundary");
  const orphanCommandIntents = db.prepare(`SELECT COUNT(*) AS count
    FROM managed_command_intents intent
    WHERE NOT EXISTS (SELECT 1 FROM managed_command_transitions transition
      WHERE transition.command_id=intent.id AND transition.sequence=1
        AND transition.from_state IS NULL AND transition.to_state='queued')`).get().count;
  if (orphanCommandIntents) violations.push("managed-command intent lacks its initial transition");
  const malformedHandoffs = db.prepare(`SELECT COUNT(*) AS count
    FROM managed_source_handoffs handoff
    JOIN managed_command_current command ON command.id=handoff.stop_command_id
    JOIN game_runs run ON run.id=handoff.run_id
    WHERE command.kind<>'pause' OR command.source_id<>handoff.source_id
      OR command.lobby_code<>handoff.prior_lobby_code OR command.run_id<>handoff.run_id
      OR command.run_generation<>handoff.run_generation
      OR run.lobby_code<>handoff.prior_lobby_code
      OR json_extract(run.state,'$.runGeneration')<>handoff.run_generation`).get().count;
  if (malformedHandoffs) violations.push("managed-source handoff authority is inconsistent");
  const orphanHandoffs = db.prepare(`SELECT COUNT(*) AS count FROM managed_source_handoffs handoff
    WHERE NOT EXISTS (SELECT 1 FROM managed_source_handoff_transitions transition
      WHERE transition.handoff_id=handoff.id AND transition.sequence=1
        AND transition.from_state IS NULL
        AND transition.to_state='stop_required')`).get().count;
  if (orphanHandoffs) violations.push("managed-source handoff lacks its initial transition");
  const discontinuousHandoffs = db.prepare(`SELECT COUNT(*) AS count
    FROM managed_source_handoff_transitions transition
    WHERE transition.sequence>1 AND transition.from_state<>(
      SELECT prior.to_state FROM managed_source_handoff_transitions prior
      WHERE prior.handoff_id=transition.handoff_id AND prior.sequence=transition.sequence-1
    )`).get().count;
  if (discontinuousHandoffs) violations.push("managed-source handoff chain is discontinuous");
  const duplicateActiveHandoffs = db.prepare(`SELECT COUNT(*) AS count FROM (
    SELECT source_id FROM managed_source_handoff_current WHERE handoff_state<>'safe'
    GROUP BY source_id HAVING COUNT(*)>1)`).get().count;
  if (duplicateActiveHandoffs) violations.push("managed source has competing handoff authority");
  const staleHandoffProjection = db.prepare(`SELECT COUNT(*) AS count
    FROM managed_source_handoff_current handoff
    JOIN managed_command_current command ON command.id=handoff.stop_command_id
    WHERE NOT (
      (handoff.handoff_state='stop_required' AND command.command_state='queued') OR
      (handoff.handoff_state='stop_claimed' AND command.command_state='claimed') OR
      (handoff.handoff_state='stop_executing' AND command.command_state='executing') OR
      (handoff.handoff_state='quarantined'
        AND command.command_state IN ('failed','outcome_unknown')) OR
      (handoff.handoff_state='safe' AND (
        (command.command_state='completed' AND command.playback_status='paused') OR
        (command.command_state IN ('failed','outcome_unknown')
          AND EXISTS (SELECT 1 FROM managed_source_handoff_resolutions resolution
            WHERE resolution.handoff_id=handoff.id
              AND resolution.resolution='confirmed_paused'))
      ))
    )`).get().count;
  if (staleHandoffProjection) violations.push("managed-source handoff projection is stale");
  const contradictoryCommandRunAuthority = db.prepare(`SELECT COUNT(*) AS count
    FROM managed_command_intents command
    JOIN game_runs run ON run.id=command.run_id
    WHERE command.lobby_code<>run.lobby_code
      OR command.run_generation<>json_extract(run.state,'$.runGeneration')
      OR command.lobby_code<>json_extract(run.state,'$.code')`).get().count;
  if (contradictoryCommandRunAuthority) {
    violations.push("managed-command run authority is inconsistent");
  }
  if (violations.length) {
    throw new Error(`State invariant validation failed: ${violations.join("; ")}.`);
  }
  return { authority, runs: runCount, historyStreams: streams.length };
}
