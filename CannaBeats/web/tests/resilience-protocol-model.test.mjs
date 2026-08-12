import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MANAGED_COMMAND_STATES,
  clearAcknowledgedOutbox,
  transitionManagedCommand,
} from "../lib/server/managed-audio-protocol.ts";
import {
  HISTORY_LIFECYCLE_STATES,
  canAppendHistoryEvent,
  terminalEvidence,
  transitionHistoryLifecycle,
} from "../lib/server/history-lifecycle.ts";

const generationA = "00000000-0000-4000-8000-000000000001";
const generationB = "00000000-0000-4000-8000-000000000002";

test("managed command states permit only the declared lifecycle edges", () => {
  assert.deepEqual(MANAGED_COMMAND_STATES, [
    "queued", "claimed", "executing", "completed", "failed", "outcome_unknown", "cancelled",
  ]);
  const permitted = new Map([
    ["queued:claim", "claimed"],
    ["claimed:claim", "claimed"],
    ["queued:cancel", "cancelled"],
    ["claimed:begin_execution", "executing"],
    ["claimed:lose_authority", "outcome_unknown"],
    ["executing:complete", "completed"],
    ["executing:fail", "failed"],
    ["executing:lose_authority", "outcome_unknown"],
    ["outcome_unknown:reconcile_complete", "completed"],
    ["outcome_unknown:reconcile_fail", "failed"],
    ["completed:complete", "completed"],
    ["failed:fail", "failed"],
  ]);
  const actions = [
    "claim", "cancel", "begin_execution", "lose_authority",
    "complete", "fail", "reconcile_complete", "reconcile_fail",
  ];
  for (const state of MANAGED_COMMAND_STATES) {
    for (const action of actions) {
      const expected = permitted.get(`${state}:${action}`);
      const input = {
        status: state,
        claimGeneration: state === "queued" ? null : generationA,
        outcomeFingerprint:
          state === "completed" ? "complete-result" : state === "failed" ? "fail-result" : null,
      };
      const event = { action, claimGeneration: generationA, outcomeFingerprint: `${action}-result` };
      if (expected) {
        assert.equal(transitionManagedCommand(input, event).command.status, expected, `${state}:${action}`);
      } else {
        assert.throws(() => transitionManagedCommand(input, event), /forbidden transition/i, `${state}:${action}`);
      }
    }
  }
});

test("same-generation retries replay while cross-generation requests conflict", () => {
  const claimed = transitionManagedCommand(
    { status: "queued", claimGeneration: null },
    { action: "claim", claimGeneration: generationA },
  );
  assert.equal(claimed.replayed, false);
  assert.equal(transitionManagedCommand(
    claimed.command,
    { action: "claim", claimGeneration: generationA },
  ).replayed, true);
  assert.throws(() => transitionManagedCommand(
    claimed.command,
    { action: "claim", claimGeneration: generationB },
  ), /generation conflict/i);

  const executing = transitionManagedCommand(
    claimed.command,
    { action: "begin_execution", claimGeneration: generationA },
  ).command;
  const completed = transitionManagedCommand(executing, {
    action: "complete",
    claimGeneration: generationA,
    outcomeFingerprint: "playing",
  });
  assert.equal(completed.command.status, "completed");
  assert.equal(transitionManagedCommand(completed.command, {
    action: "complete",
    claimGeneration: generationA,
    outcomeFingerprint: "playing",
  }).replayed, true);
  assert.throws(() => transitionManagedCommand(completed.command, {
    action: "complete",
    claimGeneration: generationA,
    outcomeFingerprint: "paused",
  }), /outcome conflict/i);
});

test("an old acknowledgement cannot clear a newer source outbox generation", () => {
  const oldSnapshot = { generation: generationA, commandId: "command-a", phase: "outcome_pending" };
  const current = { generation: generationB, commandId: "command-b", phase: "executing" };
  assert.deepEqual(clearAcknowledgedOutbox(current, oldSnapshot), current);
  assert.equal(clearAcknowledgedOutbox(current, { ...current }), null);
});

test("history lifecycle permits only terminalize, seal, and atomic purge ordering", () => {
  assert.deepEqual(HISTORY_LIFECYCLE_STATES, [
    "recording", "terminal_pending", "sealed", "purging", "purged",
  ]);
  const permitted = new Map([
    ["recording:terminalize", "terminal_pending"],
    ["terminal_pending:seal", "sealed"],
    ["sealed:begin_purge", "purging"],
    ["purging:finish_purge", "purged"],
  ]);
  const actions = ["terminalize", "seal", "begin_purge", "finish_purge"];
  for (const state of HISTORY_LIFECYCLE_STATES) {
    for (const action of actions) {
      const expected = permitted.get(`${state}:${action}`);
      if (expected) {
        assert.equal(transitionHistoryLifecycle(state, action), expected, `${state}:${action}`);
      } else {
        assert.throws(() => transitionHistoryLifecycle(state, action), /forbidden transition/i);
      }
    }
  }
});

test("terminal-pending history accepts only reconciliation for already-bound audio commands", () => {
  assert.equal(canAppendHistoryEvent("recording", "game_started", false), true);
  assert.equal(canAppendHistoryEvent("terminal_pending", "audio_command_completed", true), true);
  assert.equal(canAppendHistoryEvent("terminal_pending", "audio_command_failed", true), true);
  assert.equal(canAppendHistoryEvent("terminal_pending", "audio_command_outcome_unknown", true), true);
  assert.equal(canAppendHistoryEvent("terminal_pending", "audio_command_completed", false), false);
  assert.equal(canAppendHistoryEvent("terminal_pending", "round_advanced", true), false);
  for (const state of ["sealed", "purging", "purged"]) {
    assert.equal(canAppendHistoryEvent(state, "audio_command_completed", true), false);
  }
});

test("history sealing requires one consistent terminal event and resolved command states", () => {
  const completed = {
    sessionStatus: "ended",
    activeRunMatches: true,
    phase: "finished",
    endedAt: 1,
    terminalOutcome: "completed",
    terminalEvents: [{ type: "game_completed", outcome: "completed" }],
    coveragePresent: true,
    coverageComplete: true,
    commandStates: ["completed", "failed", "cancelled", "outcome_unknown"],
  };
  assert.deepEqual(terminalEvidence(completed), { consistent: true, reason: null });
  for (const mutation of [
    { terminalEvents: [] },
    { terminalEvents: [{ type: "game_abandoned", outcome: "abandoned" }] },
    { terminalEvents: [...completed.terminalEvents, ...completed.terminalEvents] },
    { coveragePresent: false },
    { coverageComplete: false },
    { sessionStatus: "playing" },
    { activeRunMatches: false },
    { phase: "playing" },
    { endedAt: null },
    { commandStates: ["executing"] },
  ]) {
    assert.equal(terminalEvidence({ ...completed, ...mutation }).consistent, false);
  }
  assert.deepEqual(terminalEvidence({
    ...completed,
    phase: "playing",
    terminalOutcome: "abandoned",
    terminalEvents: [{ type: "game_abandoned", outcome: "abandoned" }],
  }), { consistent: true, reason: null });
});
