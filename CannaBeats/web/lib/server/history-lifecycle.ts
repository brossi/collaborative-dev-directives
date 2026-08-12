export const HISTORY_LIFECYCLE_STATES = [
  "recording",
  "terminal_pending",
  "sealed",
  "purging",
  "purged",
] as const;

export type HistoryLifecycleState = (typeof HISTORY_LIFECYCLE_STATES)[number];
export type HistoryLifecycleAction = "terminalize" | "seal" | "begin_purge" | "finish_purge";

const EDGES = new Map<string, HistoryLifecycleState>([
  ["recording:terminalize", "terminal_pending"],
  ["terminal_pending:seal", "sealed"],
  ["sealed:begin_purge", "purging"],
  ["purging:finish_purge", "purged"],
]);

export function transitionHistoryLifecycle(
  state: HistoryLifecycleState,
  action: HistoryLifecycleAction,
): HistoryLifecycleState {
  const next = EDGES.get(`${state}:${action}`);
  if (!next) throw new Error(`forbidden transition: ${state} -> ${action}`);
  return next;
}

const TERMINAL_RECONCILIATION_EVENTS = new Set([
  "audio_command_completed",
  "audio_command_failed",
  "audio_command_outcome_unknown",
]);

export function canAppendHistoryEvent(
  state: HistoryLifecycleState,
  eventType: string,
  commandIsBoundToRun: boolean,
): boolean {
  if (state === "recording") return true;
  return state === "terminal_pending"
    && commandIsBoundToRun
    && TERMINAL_RECONCILIATION_EVENTS.has(eventType);
}

type TerminalEvent = { type: string; outcome: string | null };

export type TerminalEvidence = {
  sessionStatus: string;
  activeRunMatches: boolean;
  phase: string;
  endedAt: number | null;
  terminalOutcome: string | null;
  terminalEvents: TerminalEvent[];
  coveragePresent: boolean;
  coverageComplete: boolean;
  commandStates: string[];
};

const RESOLVED_COMMAND_STATES = new Set([
  "completed",
  "failed",
  "cancelled",
  "outcome_unknown",
]);

export function terminalEvidence(evidence: TerminalEvidence): {
  consistent: boolean;
  reason: string | null;
} {
  const fail = (reason: string) => ({ consistent: false, reason });
  if (evidence.sessionStatus !== "ended") return fail("session_not_ended");
  if (!evidence.activeRunMatches) return fail("active_run_mismatch");
  if (!Number.isSafeInteger(evidence.endedAt) || Number(evidence.endedAt) <= 0) {
    return fail("missing_ended_at");
  }
  if (!evidence.coveragePresent) return fail("missing_coverage");
  if (!evidence.coverageComplete) return fail("incomplete_coverage");
  if (!evidence.commandStates.every((state) => RESOLVED_COMMAND_STATES.has(state))) {
    return fail("unresolved_command");
  }
  if (evidence.terminalOutcome !== "completed" && evidence.terminalOutcome !== "abandoned") {
    return fail("invalid_terminal_outcome");
  }
  const expectedType = evidence.terminalOutcome === "completed" ? "game_completed" : "game_abandoned";
  if (evidence.terminalOutcome === "completed" && evidence.phase !== "finished") {
    return fail("phase_outcome_mismatch");
  }
  if (evidence.terminalOutcome === "abandoned" && evidence.phase === "finished") {
    return fail("phase_outcome_mismatch");
  }
  if (
    evidence.terminalEvents.length !== 1
    || evidence.terminalEvents[0]?.type !== expectedType
    || evidence.terminalEvents[0]?.outcome !== evidence.terminalOutcome
  ) {
    return fail("terminal_event_mismatch");
  }
  return { consistent: true, reason: null };
}
