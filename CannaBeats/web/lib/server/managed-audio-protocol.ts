export const MANAGED_COMMAND_STATES = [
  "queued",
  "claimed",
  "executing",
  "completed",
  "failed",
  "outcome_unknown",
  "cancelled",
] as const;

export type ManagedCommandState = (typeof MANAGED_COMMAND_STATES)[number];

export type ManagedCommand = {
  status: ManagedCommandState;
  claimGeneration: string | null;
  outcomeFingerprint?: string | null;
};

export type ManagedCommandEvent = {
  action:
    | "claim"
    | "cancel"
    | "begin_execution"
    | "lose_authority"
    | "complete"
    | "fail"
    | "reconcile_complete"
    | "reconcile_fail";
  claimGeneration?: string | null;
  outcomeFingerprint?: string | null;
};

type TransitionResult = {
  command: ManagedCommand;
  replayed: boolean;
};

const EDGES = new Map<string, ManagedCommandState>([
  ["queued:claim", "claimed"],
  ["queued:cancel", "cancelled"],
  ["claimed:begin_execution", "executing"],
  ["claimed:lose_authority", "outcome_unknown"],
  ["executing:complete", "completed"],
  ["executing:fail", "failed"],
  ["executing:lose_authority", "outcome_unknown"],
  ["outcome_unknown:reconcile_complete", "completed"],
  ["outcome_unknown:reconcile_fail", "failed"],
]);

function requiresGeneration(action: ManagedCommandEvent["action"]): boolean {
  return action !== "cancel";
}

function requiresOutcome(action: ManagedCommandEvent["action"]): boolean {
  return ["complete", "fail", "reconcile_complete", "reconcile_fail"].includes(action);
}

function assertGeneration(command: ManagedCommand, event: ManagedCommandEvent): void {
  if (!requiresGeneration(event.action)) return;
  if (!event.claimGeneration) throw new Error("managed command generation is required");
  if (command.status !== "queued" && command.claimGeneration !== event.claimGeneration) {
    throw new Error("managed command generation conflict");
  }
}

function isTerminalReplay(command: ManagedCommand, event: ManagedCommandEvent): boolean {
  const expectedAction = command.status === "completed" ? "complete" : command.status === "failed" ? "fail" : null;
  if (event.action !== expectedAction) return false;
  if (!command.outcomeFingerprint || command.outcomeFingerprint !== event.outcomeFingerprint) {
    throw new Error("managed command outcome conflict");
  }
  return true;
}

export function transitionManagedCommand(
  command: ManagedCommand,
  event: ManagedCommandEvent,
): TransitionResult {
  assertGeneration(command, event);

  if (command.status === "claimed" && event.action === "claim") {
    return { command: { ...command }, replayed: true };
  }
  if (isTerminalReplay(command, event)) {
    return { command: { ...command }, replayed: true };
  }

  const nextStatus = EDGES.get(`${command.status}:${event.action}`);
  if (!nextStatus) {
    throw new Error(`forbidden transition: ${command.status} -> ${event.action}`);
  }
  if (requiresOutcome(event.action) && !event.outcomeFingerprint) {
    throw new Error("managed command outcome fingerprint is required");
  }

  return {
    command: {
      status: nextStatus,
      claimGeneration:
        event.action === "claim" ? event.claimGeneration ?? null : command.claimGeneration,
      outcomeFingerprint: requiresOutcome(event.action)
        ? event.outcomeFingerprint ?? null
        : command.outcomeFingerprint ?? null,
    },
    replayed: false,
  };
}

export type SourceOutboxEntry = {
  generation: string;
  commandId: string;
  phase: string;
};

export function clearAcknowledgedOutbox<T extends SourceOutboxEntry>(
  current: T | null,
  acknowledged: SourceOutboxEntry,
): T | null {
  if (!current) return null;
  if (
    current.generation === acknowledged.generation
    && current.commandId === acknowledged.commandId
    && current.phase === acknowledged.phase
  ) {
    return null;
  }
  return current;
}
