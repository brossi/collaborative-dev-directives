import { database } from "./database.ts";
import {
  canAppendHistoryEvent,
  terminalEvidence,
  transitionHistoryLifecycle,
  type HistoryLifecycleState,
} from "./history-lifecycle.ts";
import { projectMemberHistory } from "./privacy-projection.ts";

export const GAME_EVENT_TYPES = [
  "player_joined",
  "player_removed",
  "game_configured",
  "game_started",
  "track_requested",
  "placement_locked",
  "placement_retracted",
  "answer_revealed",
  "round_advanced",
  "track_skipped",
  "game_completed",
  "game_abandoned",
  "audio_source_selected",
  "audio_lease_acquired",
  "audio_lease_released",
  "audio_command_requested",
  "audio_command_delivered",
  "audio_command_completed",
  "audio_command_failed",
  "audio_command_interrupted",
  "audio_command_cancelled",
  "audio_command_outcome_unknown",
  "audio_lease_expired",
  "audio_lease_renewed",
  "audio_source_recovered",
] as const;

export type GameEventType = typeof GAME_EVENT_TYPES[number];
export type GameEventOutcome = "accepted" | "completed" | "failed" | "abandoned" | "interrupted" | "recovered" | "cancelled" | "unknown";
export type GameEventActorType = "host" | "player" | "source" | "system";

const EVENT_TYPE_SET = new Set<string>(GAME_EVENT_TYPES);
const OUTCOME_SET = new Set<string>([
  "accepted", "completed", "failed", "abandoned", "interrupted", "recovered", "cancelled", "unknown",
]);
const ACTOR_TYPE_SET = new Set<string>(["host", "player", "source", "system"]);
const DETAIL_CODE_SET = new Set<string>([
  "host",
  "phone",
  "local",
  "managed",
  "play",
  "pause",
  "resume",
  "correct",
  "incorrect",
]);
export const GAME_EVENT_REASON_CODES = [
  "authentication_required",
  "browser_unavailable",
  "device_unavailable",
  "explicit_release",
  "game_abandoned",
  "game_api_unavailable",
  "game_completed",
  "lease_expired",
  "managed_playback_failed",
  "relay_unavailable",
  "source_selected_local",
  "spotify_unavailable",
  "unrecognized_reason",
] as const;
const REASON_CODE_SET = new Set<string>(GAME_EVENT_REASON_CODES);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type EventInput = {
  runId: string;
  type: GameEventType;
  outcome: GameEventOutcome;
  actorType: GameEventActorType;
  actorRef?: string | null;
  actionId?: string | null;
  commandRef?: string | null;
  round?: number | null;
  detailCode?: string | null;
  detailValue?: number | null;
  reasonCode?: string | null;
  occurredAt?: number;
};

function safeInteger(value: number | null | undefined, label: string) {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a nonnegative safe integer.`);
  return value;
}

export function recordGameEvent(input: EventInput) {
  if (!EVENT_TYPE_SET.has(input.type)) throw new Error("Game event type is invalid.");
  if (!OUTCOME_SET.has(input.outcome)) throw new Error("Game event outcome is invalid.");
  if (!ACTOR_TYPE_SET.has(input.actorType)) throw new Error("Game event actor type is invalid.");
  if (input.actorRef && !UUID.test(input.actorRef)) throw new Error("Game event actor reference is invalid.");
  if (input.actionId && !UUID.test(input.actionId)) throw new Error("Game event action ID is invalid.");
  if (input.commandRef && !UUID.test(input.commandRef)) throw new Error("Game event command reference is invalid.");
  if (input.detailCode && !DETAIL_CODE_SET.has(input.detailCode)) throw new Error("Game event detail code is invalid.");
  if (input.reasonCode && !REASON_CODE_SET.has(input.reasonCode)) {
    throw new Error("Game event reason code is invalid.");
  }
  const occurredAt = input.occurredAt ?? Date.now();
  if (!Number.isSafeInteger(occurredAt) || occurredAt <= 0) throw new Error("Game event time is invalid.");
  const db = database();
  const ownsTransaction = !db.isTransaction;
  if (ownsTransaction) db.exec("BEGIN IMMEDIATE");
  try {
    const coverage = db.prepare(`
      SELECT purged_at, lifecycle_state FROM game_event_coverage WHERE run_id = ?
    `).get(input.runId) as {
      purged_at: number | null;
      lifecycle_state: HistoryLifecycleState;
    } | undefined;
    if (!coverage) throw new Error("Game event coverage boundary is unavailable.");
    if (coverage.purged_at || coverage.lifecycle_state === "purged") {
      throw new Error("Game event history was purged.");
    }
    const commandIsBound = Boolean(input.commandRef && db.prepare(`
      SELECT 1 FROM managed_audio_command_outcomes WHERE command_id = ? AND run_id = ?
    `).get(input.commandRef, input.runId));
    if (!canAppendHistoryEvent(coverage.lifecycle_state, input.type, commandIsBound)) {
      throw new Error("Game event history is sealed.");
    }
    const sequence = (db.prepare(`
      SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM game_events WHERE run_id = ?
    `).get(input.runId) as { sequence: number }).sequence;
    db.prepare(`
      INSERT INTO game_events
        (run_id, sequence, event_type, outcome, actor_type, actor_ref, action_id, command_ref,
         round, detail_code, detail_value, reason_code, occurred_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.runId,
      sequence,
      input.type,
      input.outcome,
      input.actorType,
      input.actorRef ?? null,
      input.actionId ?? null,
      input.commandRef ?? null,
      safeInteger(input.round, "Game event round"),
      input.detailCode ?? null,
      safeInteger(input.detailValue, "Game event detail value"),
      input.reasonCode ?? null,
      occurredAt,
    );
    if (ownsTransaction) db.exec("COMMIT");
    return sequence;
  } catch (error) {
    if (ownsTransaction && db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}

export function activeRunId(sessionCode: string) {
  return (database().prepare("SELECT active_run_id FROM game_sessions WHERE code = ?")
    .get(sessionCode) as { active_run_id: string | null } | undefined)?.active_run_id ?? null;
}

export function advanceGameEventCoverage(runId: string, expectedRevision: number, resultingRevision: number) {
  if (!Number.isSafeInteger(expectedRevision) || !Number.isSafeInteger(resultingRevision)
      || expectedRevision < 0 || resultingRevision !== expectedRevision + 1) {
    throw new Error("Game event coverage revision transition is invalid.");
  }
  return Number(database().prepare(`
    UPDATE game_event_coverage SET last_recorded_revision = ?
    WHERE run_id = ? AND last_recorded_revision = ?
  `).run(resultingRevision, runId, expectedRevision).changes) === 1;
}

export function gameHistory(runId: string, limit = 1_000) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new Error("Game history limit must be between 1 and 1000.");
  }
  const db = database();
  const run = db.prepare(`
    SELECT id, session_code, state, revision, created_at, updated_at, ended_at, terminal_outcome
    FROM game_runs WHERE id = ?
  `).get(runId) as {
    id: string;
    session_code: string;
    state: string;
    revision: number;
    created_at: number;
    updated_at: number;
    ended_at: number | null;
    terminal_outcome: "completed" | "abandoned" | null;
  } | undefined;
  if (!run) throw new Error("Game run was not found.");
  let state: { phase?: unknown; round?: unknown } = {};
  try {
    const parsed = JSON.parse(run.state) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) state = parsed;
  } catch {
    // The event trail remains readable even if the authoritative snapshot needs repair.
  }
  const events = db.prepare(`
    SELECT sequence, event_type, outcome, actor_type, actor_ref, action_id, command_ref,
           round, detail_code, detail_value, reason_code, occurred_at
    FROM game_events WHERE run_id = ? ORDER BY sequence ASC LIMIT ?
  `).all(runId, limit) as Array<Record<string, unknown>>;
  const total = (db.prepare("SELECT COUNT(*) AS count FROM game_events WHERE run_id = ?")
    .get(runId) as { count: number }).count;
  const coverage = db.prepare(`
    SELECT baseline_revision, last_recorded_revision, purged_at, lifecycle_state
    FROM game_event_coverage WHERE run_id = ?
  `).get(runId) as {
    baseline_revision: number;
    last_recorded_revision: number;
    purged_at: number | null;
    lifecycle_state: HistoryLifecycleState;
  } | undefined;
  return projectMemberHistory({
    run: run as unknown as Record<string, unknown>,
    state,
    coverage: coverage as unknown as Record<string, unknown> | undefined,
    events,
    total,
  });
}

function terminalRunEvidence(runId: string) {
  const row = database().prepare(`
    SELECT game_runs.ended_at, game_runs.terminal_outcome, game_runs.state, game_runs.revision,
           game_sessions.status, game_sessions.active_run_id
    FROM game_runs
    JOIN game_sessions ON game_sessions.code = game_runs.session_code
    WHERE game_runs.id = ?
  `).get(runId) as {
    ended_at: number | null;
    terminal_outcome: "completed" | "abandoned" | null;
    state: string;
    status: string;
    active_run_id: string | null;
    revision: number;
  } | undefined;
  if (!row) throw new Error("Game run was not found.");
  let phase: unknown;
  try {
    phase = (JSON.parse(row.state) as { phase?: unknown })?.phase;
  } catch {
    phase = null;
  }
  const terminalEvents = database().prepare(`
    SELECT event_type AS type, outcome FROM game_events
    WHERE run_id = ? AND event_type IN ('game_completed', 'game_abandoned')
    ORDER BY sequence
  `).all(runId) as Array<{ type: string; outcome: string | null }>;
  const coverage = database().prepare(`
    SELECT last_recorded_revision FROM game_event_coverage WHERE run_id = ?
  `).get(runId) as { last_recorded_revision: number } | undefined;
  const commandStates = database().prepare(`
    SELECT command_state FROM managed_audio_command_outcomes WHERE run_id = ?
  `).all(runId).map((entry) => (entry as { command_state: string }).command_state);
  return terminalEvidence({
    sessionStatus: row.status,
    activeRunMatches: row.active_run_id === runId,
    phase: String(phase ?? ""),
    endedAt: row.ended_at,
    terminalOutcome: row.terminal_outcome,
    terminalEvents,
    coveragePresent: Boolean(coverage),
    coverageComplete: Boolean(coverage && coverage.last_recorded_revision === row.revision),
    commandStates,
  });
}

export function sealGameHistory(
  runId: string,
  { allowOutcomeUnknown = false }: { allowOutcomeUnknown?: boolean } = {},
) {
  const db = database();
  const ownsTransaction = !db.isTransaction;
  if (ownsTransaction) db.exec("BEGIN IMMEDIATE");
  try {
    const coverage = db.prepare(`
      SELECT lifecycle_state FROM game_event_coverage WHERE run_id = ?
    `).get(runId) as { lifecycle_state: HistoryLifecycleState } | undefined;
    if (!coverage) throw new Error("Game history coverage boundary is unavailable.");
    if (["purging", "purged"].includes(coverage.lifecycle_state)) {
      throw new Error("Game history is already purging or purged.");
    }
    const evidence = terminalRunEvidence(runId);
    if (!evidence.consistent) {
      throw new Error(`Game history cannot be sealed without consistent terminal evidence (${evidence.reason}).`);
    }
    if (coverage.lifecycle_state === "sealed") {
      if (ownsTransaction) db.exec("COMMIT");
      return { sealed: true, replayed: true };
    }
    let state = coverage.lifecycle_state;
    if (state === "recording") {
      state = transitionHistoryLifecycle(state, "terminalize") as "terminal_pending";
      db.prepare(`UPDATE game_event_coverage SET lifecycle_state = ? WHERE run_id = ?`)
        .run(state, runId);
    }
    const unknownOutcomes = (db.prepare(`
      SELECT COUNT(*) AS count FROM managed_audio_command_outcomes
      WHERE run_id = ? AND command_state = 'outcome_unknown'
    `).get(runId) as { count: number }).count;
    if (unknownOutcomes > 0 && !allowOutcomeUnknown) {
      if (ownsTransaction) db.exec("COMMIT");
      return { sealed: false, replayed: false, pending: true };
    }
    const sealed = transitionHistoryLifecycle(state, "seal");
    db.prepare(`UPDATE game_event_coverage SET lifecycle_state = ? WHERE run_id = ?`)
      .run(sealed, runId);
    if (ownsTransaction) db.exec("COMMIT");
    return { sealed: true, replayed: false };
  } catch (error) {
    if (ownsTransaction && db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}

export function deleteGameHistory(runId: string) {
  const db = database();
  db.exec("BEGIN IMMEDIATE");
  try {
    const prior = db.prepare("SELECT purged_at FROM game_event_coverage WHERE run_id = ?")
      .get(runId) as { purged_at: number | null } | undefined;
    if (!prior) throw new Error("Game history coverage boundary is unavailable.");
    if (prior?.purged_at) {
      db.exec("COMMIT");
      return { events: 0, receipts: 0 };
    }
    sealGameHistory(runId, { allowOutcomeUnknown: true });
    db.prepare(`UPDATE game_event_coverage SET lifecycle_state = 'purging' WHERE run_id = ?`)
      .run(runId);
    const events = Number(db.prepare("DELETE FROM game_events WHERE run_id = ?").run(runId).changes);
    const receipts = Number(db.prepare("DELETE FROM game_action_receipts WHERE run_id = ?").run(runId).changes);
    db.prepare(`
      UPDATE game_event_coverage
      SET baseline_revision = (SELECT revision FROM game_runs WHERE id = ?),
          last_recorded_revision = (SELECT revision FROM game_runs WHERE id = ?),
          purged_at = ?, lifecycle_state = 'purged'
      WHERE run_id = ?
    `).run(runId, runId, Date.now(), runId);
    db.prepare("DELETE FROM managed_audio_command_outcomes WHERE run_id = ?").run(runId);
    db.exec("COMMIT");
    return { events, receipts };
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}

export function purgeExpiredGameHistory({
  now = Date.now(),
  retentionDays = 90,
}: { now?: number; retentionDays?: number } = {}) {
  if (!Number.isSafeInteger(retentionDays) || retentionDays < 1 || retentionDays > 365) {
    throw new Error("Game history retention must be between 1 and 365 days.");
  }
  const cutoff = now - retentionDays * 86_400_000;
  const db = database();
  db.exec("BEGIN IMMEDIATE");
  try {
    const missingCoverage = db.prepare(`
      SELECT game_runs.id FROM game_runs
      JOIN game_sessions ON game_sessions.code = game_runs.session_code
      LEFT JOIN game_event_coverage ON game_event_coverage.run_id = game_runs.id
      WHERE game_runs.ended_at IS NOT NULL AND game_runs.ended_at <= ?
        AND game_sessions.status = 'ended'
        AND game_sessions.active_run_id = game_runs.id
        AND game_runs.terminal_outcome IN ('completed', 'abandoned')
        AND game_event_coverage.run_id IS NULL
      LIMIT 1
    `).get(cutoff) as { id: string } | undefined;
    if (missingCoverage) throw new Error("Game history coverage boundary is unavailable.");
    const runs = db.prepare(`
      SELECT game_runs.id FROM game_runs
      JOIN game_sessions ON game_sessions.code = game_runs.session_code
      JOIN game_event_coverage ON game_event_coverage.run_id = game_runs.id
      WHERE game_runs.ended_at IS NOT NULL AND game_runs.ended_at <= ?
        AND game_sessions.status = 'ended'
        AND game_sessions.active_run_id = game_runs.id
        AND json_valid(game_runs.state)
        AND (
          (game_runs.terminal_outcome = 'completed' AND json_extract(game_runs.state, '$.phase') = 'finished')
          OR (game_runs.terminal_outcome = 'abandoned'
              AND json_extract(game_runs.state, '$.phase') IN ('lobby', 'ready', 'playing', 'placed', 'revealed'))
        )
        AND game_event_coverage.purged_at IS NULL
    `)
      .all(cutoff) as Array<{ id: string }>;
    let events = 0;
    let receipts = 0;
    for (const run of runs) {
      sealGameHistory(run.id, { allowOutcomeUnknown: true });
      db.prepare(`UPDATE game_event_coverage SET lifecycle_state = 'purging' WHERE run_id = ?`)
        .run(run.id);
      events += Number(db.prepare("DELETE FROM game_events WHERE run_id = ?").run(run.id).changes);
      receipts += Number(db.prepare("DELETE FROM game_action_receipts WHERE run_id = ?").run(run.id).changes);
      db.prepare(`
        UPDATE game_event_coverage
        SET baseline_revision = (SELECT revision FROM game_runs WHERE id = ?),
            last_recorded_revision = (SELECT revision FROM game_runs WHERE id = ?),
            purged_at = ?, lifecycle_state = 'purged'
        WHERE run_id = ?
      `).run(run.id, run.id, now, run.id);
      db.prepare("DELETE FROM managed_audio_command_outcomes WHERE run_id = ?").run(run.id);
    }
    db.exec("COMMIT");
    return { runs: runs.length, events, receipts };
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}
