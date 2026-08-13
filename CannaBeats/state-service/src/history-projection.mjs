const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LOBBY = /^[A-Z0-9]{6}$/;
const enums = Object.freeze({
  phase: new Set(["lobby","ready","playing","placed","revealed","finished"]),
  terminal: new Set(["completed","abandoned"]),
  lifecycle: new Set(["recording","terminal_pending","sealed","purging","purged"]),
  event: new Set([
    "player_joined","player_removed","game_configured","game_started","track_requested",
    "placement_locked","placement_retracted","answer_revealed","round_advanced",
    "track_skipped","game_completed","game_abandoned","audio_source_selected",
    "audio_lease_acquired","audio_lease_released","audio_command_requested",
    "audio_command_delivered","audio_command_completed","audio_command_failed",
    "audio_command_interrupted","audio_command_cancelled","audio_command_outcome_unknown",
    "audio_lease_expired","audio_lease_renewed","audio_source_recovered",
  ]),
  outcome: new Set(["accepted","completed","failed","abandoned","interrupted","recovered","cancelled","unknown"]),
  actor: new Set(["host","player","source","system"]),
  detail: new Set(["host","phone","local","managed","play","pause","resume","correct","incorrect"]),
  reason: new Set([
    "authentication_required","browser_unavailable","device_unavailable","explicit_release",
    "game_abandoned","game_api_unavailable","game_completed","lease_expired",
    "managed_playback_failed","relay_unavailable","source_selected_local",
    "spotify_unavailable","unrecognized_reason",
  ]),
});

const integer = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
const timestamp = (value) => Number.isSafeInteger(value) && value >= 1 ? value : null;
const uuid = (value) => typeof value === "string" && UUID.test(value) ? value : null;
const enumeration = (value, category, fallback = null) =>
  typeof value === "string" && enums[category].has(value) ? value : fallback;

export function projectStateHistory({ run, stream, state, events, total }) {
  const revision = integer(run.revision);
  const baseline = integer(stream.baseline_revision);
  const last = integer(stream.last_recorded_revision);
  const lifecycle = enumeration(stream.lifecycle,"lifecycle");
  const retainedEventsConsistent = lifecycle !== "purged" || events.length === 0;
  const coverageConsistent = revision !== null && baseline !== null && last !== null
    && baseline <= last && last <= revision;
  return {
    runId: uuid(run.id),
    lobbyId: typeof run.lobby_code === "string" && LOBBY.test(run.lobby_code) ? run.lobby_code : null,
    current: {
      phase: enumeration(state?.phase,"phase"), round: integer(state?.round), revision,
      updatedAt: timestamp(run.updated_at),
      endedAt: run.ended_at === null ? null : timestamp(run.ended_at),
      terminalOutcome: run.terminal_outcome === null
        ? null : enumeration(run.terminal_outcome,"terminal"),
    },
    coverage: {
      complete: coverageConsistent && retainedEventsConsistent && last === revision,
      baselineRevision: baseline,lastRecordedRevision: last,currentRevision: revision,
    },
    retention: {
      purgedAt: stream.purged_at === null ? null : timestamp(stream.purged_at),lifecycle,
    },
    events: retainedEventsConsistent ? events.map((event) => ({
      sequence: integer(event.sequence),
      type: enumeration(event.event_type,"event","unrecognized_event_type"),
      outcome: enumeration(event.outcome,"outcome","unrecognized_outcome"),
      actorType: enumeration(event.actor_type,"actor","unrecognized_actor_type"),
      actorRef: uuid(event.actor_ref),actionId: uuid(event.action_id),commandRef: uuid(event.command_ref),
      round: event.round === null ? null : integer(event.round),
      detailCode: event.detail_code === null ? null
        : enumeration(event.detail_code,"detail","unrecognized_detail_code"),
      detailValue: event.detail_value === null ? null : integer(event.detail_value),
      reasonCode: event.reason_code === null ? null
        : enumeration(event.reason_code,"reason","unrecognized_reason"),
      occurredAt: timestamp(event.occurred_at),
    })) : [],
    truncated: Number.isSafeInteger(total) && total > events.length,
  };
}
