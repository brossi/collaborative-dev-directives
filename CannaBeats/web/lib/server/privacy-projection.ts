import contract from "../../contracts/privacy-projection.json" with { type: "json" };

type EnumCategory = Exclude<keyof typeof contract,
  "memberHistoryFields" | "memberCurrentFields" | "memberCoverageFields"
  | "memberRetentionFields" | "numericRules" | "fallbacks">;
const sets = Object.fromEntries(
  Object.entries(contract)
    .filter(([, values]) => Array.isArray(values))
    .map(([key, values]) => [key, new Set<string>(values as string[])]),
) as Record<EnumCategory, Set<string>>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export { contract as PRIVACY_PROJECTION_CONTRACT };

export function projectedEnum(
  value: unknown,
  category: EnumCategory,
  fallback: string | null = null,
) {
  return typeof value === "string" && sets[category].has(value) ? value : fallback;
}

export function projectedUuid(value: unknown) {
  return typeof value === "string" && UUID.test(value) ? value : null;
}

export function projectedNonnegativeInteger(value: unknown) {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

export function projectedTimestamp(value: unknown) {
  return Number.isSafeInteger(value) && Number(value) >= contract.numericRules.timestampMinimum
    ? Number(value)
    : null;
}

export function projectMemberHistory(input: {
  run: Record<string, unknown>;
  state: Record<string, unknown>;
  coverage?: Record<string, unknown>;
  events: Array<Record<string, unknown>>;
  total: unknown;
}) {
  const revision = projectedNonnegativeInteger(input.run.revision);
  const baseline = projectedNonnegativeInteger(input.coverage?.baseline_revision);
  const lastRecorded = projectedNonnegativeInteger(input.coverage?.last_recorded_revision);
  const lifecycle = input.coverage
    ? projectedEnum(input.coverage.lifecycle_state, "historyLifecycle") : null;
  const coverageConsistent = revision !== null && baseline !== null && lastRecorded !== null
    && baseline <= lastRecorded && lastRecorded <= revision;
  const retainedEventsConsistent = lifecycle !== "purged" || input.events.length === 0;
  return {
    runId: projectedUuid(input.run.id),
    lobbyId: typeof input.run.session_code === "string" && /^[A-Z0-9]{6}$/.test(input.run.session_code)
      ? input.run.session_code : null,
    current: {
      phase: projectedEnum(input.state.phase, "gamePhases"),
      round: projectedNonnegativeInteger(input.state.round),
      revision,
      updatedAt: projectedTimestamp(input.run.updated_at),
      endedAt: input.run.ended_at === null ? null : projectedTimestamp(input.run.ended_at),
      terminalOutcome: input.run.terminal_outcome === null
        ? null : projectedEnum(input.run.terminal_outcome, "terminalOutcomes"),
    },
    coverage: {
      complete: coverageConsistent && retainedEventsConsistent && lastRecorded === revision,
      baselineRevision: baseline,
      lastRecordedRevision: lastRecorded,
      currentRevision: revision,
    },
    retention: {
      purgedAt: input.coverage?.purged_at === null || input.coverage?.purged_at === undefined
        ? null : projectedTimestamp(input.coverage.purged_at),
      lifecycle,
    },
    events: retainedEventsConsistent ? input.events.map(projectHistoryEvent) : [],
    truncated: Number.isSafeInteger(input.total) && Number(input.total) > input.events.length,
  };
}

export function projectHistoryEvent(event: Record<string, unknown>) {
  return {
    sequence: projectedNonnegativeInteger(event.sequence),
    type: projectedEnum(event.event_type, "eventTypes", "unrecognized_event_type"),
    outcome: projectedEnum(event.outcome, "eventOutcomes", "unrecognized_outcome"),
    actorType: projectedEnum(event.actor_type, "eventActors", "unrecognized_actor_type"),
    actorRef: projectedUuid(event.actor_ref),
    actionId: projectedUuid(event.action_id),
    commandRef: projectedUuid(event.command_ref),
    round: event.round === null ? null : projectedNonnegativeInteger(event.round),
    detailCode: event.detail_code === null
      ? null
      : projectedEnum(event.detail_code, "eventDetails", "unrecognized_detail_code"),
    detailValue: event.detail_value === null
      ? null
      : projectedNonnegativeInteger(event.detail_value),
    reasonCode: event.reason_code === null
      ? null
      : projectedEnum(event.reason_code, "eventReasons", "unrecognized_reason"),
    occurredAt: projectedTimestamp(event.occurred_at),
  };
}
