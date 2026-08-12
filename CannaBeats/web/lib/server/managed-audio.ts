import { randomUUID } from "node:crypto";
import { database, sha256 } from "./database.ts";
import { activeRunId, recordGameEvent, sealGameHistory } from "./game-events.ts";
import {
  transitionManagedCommand,
  type ManagedCommandState,
} from "./managed-audio-protocol.ts";

export type ManagedAudioCommandKind = "play" | "pause" | "resume";
export type ManagedPlaybackStatus = "ready" | "starting" | "playing" | "pausing" | "paused" | "resuming" | "error";

export type ManagedAudioView = {
  selection: "local" | "managed";
  mode: "local" | "managed";
  leaseId?: string;
  sourceName?: string;
  sourceOnline: boolean;
  status: ManagedPlaybackStatus | "disconnected";
  error?: string;
};

export type ManagedLeaseResult = {
  audio: ManagedAudioView;
  transition: "acquired" | "renewed" | "released" | "unchanged";
  interrupted: Array<{ id: string; kind: ManagedAudioCommandKind }>;
  commands: Array<{ id: string; kind: ManagedAudioCommandKind; status: "cancelled" | "outcome_unknown" }>;
};

type SourceRow = {
  id: string;
  display_name: string;
  last_seen_at: number | null;
};

type LeaseRow = {
  id: string;
  source_id: string;
  session_code: string;
  display_name: string;
  last_seen_at: number | null;
  playback_status: ManagedPlaybackStatus;
  last_error: string | null;
  expires_at: number;
};

export const MANAGED_SOURCE_ONLINE_MS = 15_000;
export const MANAGED_LEASE_TTL_MS = 90_000;

const MANAGED_ERROR_CATEGORIES = new Set([
  "authentication_required",
  "browser_unavailable",
  "device_unavailable",
  "game_api_unavailable",
  "managed_playback_failed",
  "relay_unavailable",
  "spotify_unavailable",
]);

function immediateTransaction<T>(work: () => T) {
  const db = database();
  const ownsTransaction = !db.isTransaction;
  if (ownsTransaction) db.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    if (ownsTransaction) db.exec("COMMIT");
    return result;
  } catch (error) {
    if (ownsTransaction && db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}

function managedErrorCategory(value: string | null) {
  const category = String(value ?? "").trim().toLowerCase();
  return MANAGED_ERROR_CATEGORIES.has(category) ? category : "managed_playback_failed";
}

function transitionLeaseCommands(leaseId: string) {
  database().prepare(`
    INSERT OR IGNORE INTO managed_audio_command_outcomes
      (command_id, source_id, run_id, completion_fingerprint, completed_at, command_state)
    SELECT managed_audio_commands.id, managed_audio_commands.source_id,
           game_sessions.active_run_id,
           json_object('pending', 1, 'kind', managed_audio_commands.kind), 0, 'queued'
    FROM managed_audio_commands
    JOIN game_sessions ON game_sessions.code = managed_audio_commands.session_code
    WHERE managed_audio_commands.lease_id = ? AND managed_audio_commands.completed_at IS NULL
  `).run(leaseId);
  const commands = database().prepare(`
    SELECT managed_audio_commands.id, managed_audio_commands.kind,
           managed_audio_command_outcomes.command_state AS status,
           managed_audio_command_outcomes.claim_generation AS claimGeneration
    FROM managed_audio_commands
    JOIN managed_audio_command_outcomes
      ON managed_audio_command_outcomes.command_id = managed_audio_commands.id
    WHERE managed_audio_commands.lease_id = ? AND managed_audio_commands.completed_at IS NULL
      AND managed_audio_command_outcomes.command_state IN ('queued', 'claimed', 'executing')
    ORDER BY managed_audio_commands.created_at
  `).all(leaseId) as Array<{
    id: string;
    kind: ManagedAudioCommandKind;
    status: "queued" | "claimed" | "executing";
    claimGeneration: string | null;
  }>;
  return commands.map((command) => {
    const action = command.status === "queued" ? "cancel" : "lose_authority";
    const next = transitionManagedCommand(
      { status: command.status, claimGeneration: command.claimGeneration },
      { action, claimGeneration: command.claimGeneration },
    ).command.status as "cancelled" | "outcome_unknown";
    database().prepare(`
      UPDATE managed_audio_command_outcomes SET command_state = ? WHERE command_id = ?
    `).run(next, command.id);
    return { id: command.id, kind: command.kind, status: next };
  });
}

function cleanupExpiredLeases(now = Date.now()) {
  return immediateTransaction(() => {
    const expired = database().prepare(`
      SELECT id, session_code FROM managed_audio_leases WHERE expires_at <= ?
    `).all(now) as Array<{ id: string; session_code: string }>;
    for (const lease of expired) {
      const runId = activeRunId(lease.session_code);
      const commands = transitionLeaseCommands(lease.id);
      if (runId) {
        for (const command of commands) {
          recordGameEvent({
            runId,
            type: command.status === "cancelled"
              ? "audio_command_cancelled"
              : "audio_command_outcome_unknown",
            outcome: command.status === "cancelled" ? "cancelled" : "unknown",
            actorType: "system",
            detailCode: command.kind,
            commandRef: command.id,
            reasonCode: "lease_expired",
            occurredAt: now,
          });
        }
        recordGameEvent({
          runId,
          type: "audio_lease_expired",
          outcome: "failed",
          actorType: "system",
          detailCode: "managed",
          occurredAt: now,
        });
      }
    }
    return database().prepare("DELETE FROM managed_audio_leases WHERE expires_at <= ?").run(now).changes;
  });
}

function leaseRow(sessionCode: string) {
  return database().prepare(`
    SELECT managed_audio_leases.*, managed_audio_sources.display_name,
           managed_audio_sources.last_seen_at
    FROM managed_audio_leases
    JOIN managed_audio_sources ON managed_audio_sources.id = managed_audio_leases.source_id
    WHERE managed_audio_leases.session_code = ?
  `).get(sessionCode) as LeaseRow | undefined;
}

function viewFor(row: LeaseRow | undefined, now = Date.now()): ManagedAudioView {
  if (!row || row.expires_at <= now) {
    return { selection: "local", mode: "local", sourceOnline: false, status: "disconnected" };
  }
  return {
    selection: "managed",
    mode: "managed",
    leaseId: row.id,
    sourceName: row.display_name,
    sourceOnline: Boolean(row.last_seen_at && row.last_seen_at > now - MANAGED_SOURCE_ONLINE_MS),
    status: row.playback_status,
    ...(row.last_error ? { error: row.last_error } : {}),
  };
}

export function managedAudioView(sessionCode: string) {
  return viewFor(leaseRow(sessionCode));
}

export function acquireManagedAudioLease(sessionCode: string, userId: string) {
  const now = Date.now();
  return immediateTransaction(() => {
    cleanupExpiredLeases(now);
    const existing = leaseRow(sessionCode);
    if (existing) {
      database().prepare(`
        UPDATE managed_audio_leases SET renewed_at = ?, expires_at = ? WHERE id = ?
      `).run(now, now + MANAGED_LEASE_TTL_MS, existing.id);
      return {
        audio: viewFor({ ...existing, expires_at: now + MANAGED_LEASE_TTL_MS }, now),
        transition: "renewed" as const,
        interrupted: [], commands: [],
      };
    }
    const source = database().prepare(`
      SELECT managed_audio_sources.id, managed_audio_sources.display_name,
             managed_audio_sources.last_seen_at
      FROM managed_audio_sources
      LEFT JOIN managed_audio_leases ON managed_audio_leases.source_id = managed_audio_sources.id
      WHERE managed_audio_sources.enabled = 1
        AND managed_audio_sources.last_seen_at > ?
        AND managed_audio_leases.id IS NULL
      ORDER BY managed_audio_sources.last_seen_at DESC
      LIMIT 1
    `).get(now - MANAGED_SOURCE_ONLINE_MS) as SourceRow | undefined;
    if (!source) throw new Error("No managed audio source is online and available.");
    const leaseId = randomUUID();
    database().prepare(`
      INSERT INTO managed_audio_leases
        (id, source_id, session_code, acquired_by, acquired_at, renewed_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(leaseId, source.id, sessionCode, userId, now, now, now + MANAGED_LEASE_TTL_MS);
    return {
      audio: {
        selection: "managed" as const,
        mode: "managed" as const,
        leaseId,
        sourceName: source.display_name,
        sourceOnline: true,
        status: "ready" as const,
      },
      transition: "acquired" as const,
      interrupted: [], commands: [],
    };
  });
}

export function renewManagedAudioLeaseIfNeeded(sessionCode: string, now = Date.now()) {
  const renewed = database().prepare(`
    UPDATE managed_audio_leases
    SET renewed_at = ?, expires_at = ?
    WHERE session_code = ? AND expires_at > ? AND expires_at <= ?
  `).run(now, now + MANAGED_LEASE_TTL_MS, sessionCode, now, now + Math.floor(MANAGED_LEASE_TTL_MS / 2));
  return Number(renewed.changes) === 1;
}

function audioSelection(sessionCode: string) {
  const row = database().prepare("SELECT audio_mode FROM game_sessions WHERE code = ?")
    .get(sessionCode) as { audio_mode: "local" | "managed" } | undefined;
  return row?.audio_mode ?? "managed";
}

/** Read-only projection of the saved source choice and current lease. */
export function selectedAudioView(sessionCode: string) {
  const selection = audioSelection(sessionCode);
  const view = managedAudioView(sessionCode);
  return { ...view, selection };
}

export function selectAudioSource(
  sessionCode: string,
  hostUserId: string,
  selection: "local" | "managed",
) {
  database().prepare("UPDATE game_sessions SET audio_mode = ?, updated_at = ? WHERE code = ?")
    .run(selection, Date.now(), sessionCode);
  if (selection === "local") {
    const result = releaseManagedAudioLease(sessionCode);
    return { ...result, audio: { ...result.audio, selection } };
  }
  const result = acquireManagedAudioLease(sessionCode, hostUserId);
  return { ...result, audio: { ...result.audio, selection } };
}

export function releaseManagedAudioLease(sessionCode: string): ManagedLeaseResult {
  const lease = database().prepare("SELECT id FROM managed_audio_leases WHERE session_code = ?")
    .get(sessionCode) as { id: string } | undefined;
  if (!lease) {
    return { audio: managedAudioView(sessionCode), transition: "unchanged", interrupted: [], commands: [] };
  }
  const transitioned = transitionLeaseCommands(lease.id);
  database().prepare("DELETE FROM managed_audio_leases WHERE id = ?").run(lease.id);
  // `interrupted` is retained in the return shape for exact Slice 1 callers,
  // but ADR 0002 derives terminal evidence from the protocol states below.
  // A delivered command is uncertain, not interrupted.
  return { audio: managedAudioView(sessionCode), transition: "released", interrupted: [], commands: transitioned };
}

export function enqueueManagedAudioCommand(
  sessionCode: string,
  userId: string,
  kind: ManagedAudioCommandKind,
  trackUri?: string,
) {
  const now = Date.now();
  cleanupExpiredLeases(now);
  const lease = leaseRow(sessionCode);
  if (!lease) throw new Error("This game does not own the managed audio source.");
  if (!lease.last_seen_at || lease.last_seen_at <= now - MANAGED_SOURCE_ONLINE_MS) {
    throw new Error("The managed audio source is offline.");
  }
  if (kind === "play" && !/^spotify:track:[A-Za-z0-9]+$/.test(trackUri ?? "")) {
    throw new Error("A valid Spotify track is required.");
  }
  const status: Record<ManagedAudioCommandKind, ManagedPlaybackStatus> = {
    play: "starting",
    pause: "pausing",
    resume: "resuming",
  };
  return immediateTransaction(() => {
    const commandId = randomUUID();
    database().prepare(`
      INSERT INTO managed_audio_commands
        (id, lease_id, source_id, session_code, kind, track_uri, requested_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(commandId, lease.id, lease.source_id, sessionCode, kind, trackUri ?? null, userId, now);
    const runId = activeRunId(sessionCode);
    database().prepare(`
      INSERT INTO managed_audio_command_outcomes
        (command_id, source_id, run_id, completion_fingerprint, completed_at, command_state)
      VALUES (?, ?, ?, ?, 0, 'queued')
    `).run(commandId, lease.source_id, runId, JSON.stringify({ pending: true, kind }));
    database().prepare(`
      UPDATE managed_audio_leases SET playback_status = ?, last_error = NULL WHERE id = ?
    `).run(status[kind], lease.id);
    return { audio: managedAudioView(sessionCode), commandId };
  });
}

export function authenticateManagedAudioSource(authorization: string | null) {
  const match = /^Bearer ([A-Za-z0-9_-]{32,128})$/.exec(authorization ?? "");
  if (!match) return null;
  return database().prepare(`
    SELECT id, display_name FROM managed_audio_sources
    WHERE token_hash = ? AND enabled = 1
  `).get(sha256(match[1])) as { id: string; display_name: string } | undefined ?? null;
}

export function pollManagedAudioSource(sourceId: string) {
  const now = Date.now();
  return immediateTransaction(() => {
    const priorSource = database().prepare("SELECT last_error FROM managed_audio_sources WHERE id = ?")
      .get(sourceId) as { last_error: string | null } | undefined;
    database().prepare(`
      UPDATE managed_audio_sources
      SET last_seen_at = ?, device_id = NULL, last_error = NULL
      WHERE id = ?
    `).run(now, sourceId);
    cleanupExpiredLeases(now);
    const lease = database().prepare(`
      SELECT id, session_code, playback_status FROM managed_audio_leases
      WHERE source_id = ? AND expires_at > ?
    `).get(sourceId, now) as { id: string; session_code: string; playback_status: ManagedPlaybackStatus } | undefined;
    if (!lease) return { lease: null, command: null };
    const runId = activeRunId(lease.session_code);
    if (priorSource?.last_error && runId) {
      recordGameEvent({
        runId,
        type: "audio_source_recovered",
        outcome: "recovered",
        actorType: "source",
        occurredAt: now,
      });
    }
    const command = database().prepare(`
      SELECT id, kind, track_uri AS trackUri, delivered_at AS deliveredAt
      FROM managed_audio_commands
      WHERE source_id = ? AND lease_id = ? AND completed_at IS NULL
      ORDER BY created_at ASC LIMIT 1
    `).get(sourceId, lease.id) as {
      id: string;
      kind: ManagedAudioCommandKind;
      trackUri: string | null;
      deliveredAt: number | null;
    } | undefined;
    if (command) {
      database().prepare(`
        UPDATE managed_audio_commands SET delivered_at = COALESCE(delivered_at, ?) WHERE id = ?
      `).run(now, command.id);
      if (!command.deliveredAt && runId) {
        recordGameEvent({
          runId,
          type: "audio_command_delivered",
          outcome: "accepted",
          actorType: "source",
          detailCode: command.kind,
          commandRef: command.id,
          occurredAt: now,
        });
      }
    }
    return {
      protocolVersion: 2,
      lease: { id: lease.id, sessionCode: lease.session_code, status: lease.playback_status },
      command: command ? { id: command.id, kind: command.kind, trackUri: command.trackUri } : null,
    };
  });
}

type CommandProtocolRow = {
  command_state: ManagedCommandState;
  claim_generation: string | null;
};

function commandProtocolRow(sourceId: string, commandId: string) {
  return database().prepare(`
    SELECT command_state, claim_generation
    FROM managed_audio_command_outcomes
    WHERE command_id = ? AND source_id = ?
  `).get(commandId, sourceId) as CommandProtocolRow | undefined;
}

function assertLiveCommandAuthority(sourceId: string, commandId: string, now = Date.now()) {
  const authority = database().prepare(`
    SELECT managed_audio_leases.expires_at
    FROM managed_audio_commands
    JOIN managed_audio_leases ON managed_audio_leases.id = managed_audio_commands.lease_id
    WHERE managed_audio_commands.id = ?
      AND managed_audio_commands.source_id = ?
      AND managed_audio_leases.source_id = ?
  `).get(commandId, sourceId, sourceId) as { expires_at: number } | undefined;
  if (!authority || authority.expires_at <= now) {
    throw new Error("Managed command lease authority is no longer live.");
  }
}

export function claimManagedAudioCommand(
  sourceId: string,
  commandId: string,
  claimGeneration: string,
) {
  return immediateTransaction(() => {
    assertLiveCommandAuthority(sourceId, commandId);
    const row = commandProtocolRow(sourceId, commandId);
    if (!row) return { status: "missing" as const, replayed: false };
    const transition = transitionManagedCommand(
      { status: row.command_state, claimGeneration: row.claim_generation },
      { action: "claim", claimGeneration },
    );
    if (!transition.replayed) {
      database().prepare(`
        UPDATE managed_audio_command_outcomes
        SET command_state = ?, claim_generation = ?
        WHERE command_id = ? AND source_id = ?
      `).run(transition.command.status, claimGeneration, commandId, sourceId);
    }
    return { status: "claimed" as const, replayed: transition.replayed };
  });
}

export function beginManagedAudioCommand(
  sourceId: string,
  commandId: string,
  claimGeneration: string,
) {
  return immediateTransaction(() => {
    assertLiveCommandAuthority(sourceId, commandId);
    const row = commandProtocolRow(sourceId, commandId);
    if (!row) return { status: "missing" as const, replayed: false };
    if (row.command_state === "executing" && row.claim_generation === claimGeneration) {
      return { status: "executing" as const, replayed: true };
    }
    const transition = transitionManagedCommand(
      { status: row.command_state, claimGeneration: row.claim_generation },
      { action: "begin_execution", claimGeneration },
    );
    database().prepare(`
      UPDATE managed_audio_command_outcomes SET command_state = ?
      WHERE command_id = ? AND source_id = ?
    `).run(transition.command.status, commandId, sourceId);
    return { status: "executing" as const, replayed: transition.replayed };
  });
}

export function markManagedAudioCommandOutcomeUnknown(
  sourceId: string,
  commandId: string,
  claimGeneration: string,
) {
  return immediateTransaction(() => {
    const row = commandProtocolRow(sourceId, commandId);
    if (!row) return { status: "missing" as const, replayed: false };
    if (row.command_state === "outcome_unknown" && row.claim_generation === claimGeneration) {
      return { status: "outcome_unknown" as const, replayed: true };
    }
    const transition = transitionManagedCommand(
      { status: row.command_state, claimGeneration: row.claim_generation },
      { action: "lose_authority", claimGeneration },
    );
    database().prepare(`
      UPDATE managed_audio_command_outcomes SET command_state = ?
      WHERE command_id = ? AND source_id = ?
    `).run(transition.command.status, commandId, sourceId);
    const outcome = database().prepare(`
      SELECT run_id, completion_fingerprint FROM managed_audio_command_outcomes
      WHERE command_id = ? AND source_id = ?
    `).get(commandId, sourceId) as { run_id: string | null; completion_fingerprint: string };
    let kind: ManagedAudioCommandKind | null = null;
    try {
      const pending = JSON.parse(outcome.completion_fingerprint) as { kind?: unknown };
      if (["play", "pause", "resume"].includes(String(pending.kind))) {
        kind = pending.kind as ManagedAudioCommandKind;
      }
    } catch {
      // The persisted protocol marker is verified by the schema migration probe.
    }
    if (outcome.run_id && kind) {
      recordGameEvent({
        runId: outcome.run_id,
        type: "audio_command_outcome_unknown",
        outcome: "unknown",
        actorType: "source",
        commandRef: commandId,
        detailCode: kind,
        reasonCode: "managed_playback_failed",
      });
    }
    return { status: "outcome_unknown" as const, replayed: transition.replayed };
  });
}

export function completeManagedAudioCommand(
  sourceId: string,
  commandId: string,
  ok: boolean,
  playbackStatus: "ready" | "playing" | "paused" | "error",
  error: string | null,
  claimGeneration?: string,
) {
  // The source may receive detailed browser/Spotify errors. Persist only a stable,
  // operator-safe category so tokens, URIs, or account details cannot reach SQLite.
  const message = ok ? null : managedErrorCategory(error);
  const status = ok ? playbackStatus : "error";
  const completionFingerprint = JSON.stringify({ ok, playbackStatus: status, error: message });
  const now = Date.now();
  return immediateTransaction(() => {
    const outcome = database().prepare(`
      SELECT run_id, completion_fingerprint, completed_at, command_state, claim_generation
      FROM managed_audio_command_outcomes
      WHERE command_id = ? AND source_id = ?
    `).get(commandId, sourceId) as {
      run_id: string | null;
      completion_fingerprint: string;
      completed_at: number;
      command_state: ManagedCommandState;
      claim_generation: string | null;
    } | undefined;
    if (outcome?.completed_at) {
      if (!claimGeneration || outcome.claim_generation !== claimGeneration) {
        throw new Error("managed command generation conflict");
      }
      return outcome.completion_fingerprint === completionFingerprint
        ? { status: "replayed" as const }
        : { status: "conflict" as const };
    }
    const command = database().prepare(`
      SELECT id, lease_id, session_code, kind, completed_at, error, completion_fingerprint
      FROM managed_audio_commands
      WHERE id = ? AND source_id = ?
    `).get(commandId, sourceId) as {
      id: string;
      lease_id: string;
      session_code: string;
      kind: ManagedAudioCommandKind;
      completed_at: number | null;
      error: string | null;
      completion_fingerprint: string | null;
    } | undefined;
    if (!command && !outcome) return { status: "missing" as const };
    if (command?.completed_at) {
      return command.completion_fingerprint === completionFingerprint
        ? { status: "replayed" as const }
        : { status: "conflict" as const };
    }
    let kind = command?.kind;
    if (!kind && outcome) {
      try {
        const pending = JSON.parse(outcome.completion_fingerprint) as { pending?: unknown; kind?: unknown };
        if (pending.pending === true && ["play", "pause", "resume"].includes(String(pending.kind))) {
          kind = pending.kind as ManagedAudioCommandKind;
        }
      } catch {
        // A malformed pending marker is not sufficient authority to accept an external outcome.
      }
    }
    if (!kind) return { status: "missing" as const };
    const requiredStatus = kind === "pause" ? "paused" : "playing";
    if (ok && playbackStatus !== requiredStatus) {
      throw new Error("Managed command completion state does not match its requested action.");
    }
    const transitionAction = outcome?.command_state === "outcome_unknown"
      ? (ok ? "reconcile_complete" : "reconcile_fail")
      : (ok ? "complete" : "fail");
    const transition = transitionManagedCommand(
      {
        status: outcome?.command_state ?? "queued",
        claimGeneration: outcome?.claim_generation ?? null,
        outcomeFingerprint: outcome?.completed_at ? outcome.completion_fingerprint : null,
      },
      {
        action: transitionAction,
        claimGeneration: claimGeneration ?? outcome?.claim_generation ?? null,
        outcomeFingerprint: completionFingerprint,
      },
    );
    const runId = outcome?.run_id ?? (command ? activeRunId(command.session_code) : null);
    if (outcome) {
      database().prepare(`
        UPDATE managed_audio_command_outcomes
        SET completion_fingerprint = ?, completed_at = ?, command_state = ?
        WHERE command_id = ? AND source_id = ? AND completed_at = 0
      `).run(completionFingerprint, now, transition.command.status, commandId, sourceId);
    } else {
      database().prepare(`
        INSERT INTO managed_audio_command_outcomes
          (command_id, source_id, run_id, completion_fingerprint, completed_at, command_state, claim_generation)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(commandId, sourceId, runId, completionFingerprint, now,
        transition.command.status, claimGeneration ?? null);
    }
    if (command) {
      database().prepare(`
        UPDATE managed_audio_commands
        SET completed_at = ?, error = ?, completion_fingerprint = ? WHERE id = ?
      `).run(now, message, completionFingerprint, command.id);
      database().prepare(`
        UPDATE managed_audio_leases SET playback_status = ?, last_error = ? WHERE id = ?
      `).run(status, message, command.lease_id);
    }
    database().prepare(`
      UPDATE managed_audio_sources
      SET last_seen_at = ?, device_id = NULL, last_error = ? WHERE id = ?
    `).run(now, message, sourceId);
    if (runId) {
      recordGameEvent({
        runId,
        type: ok ? "audio_command_completed" : "audio_command_failed",
        outcome: ok ? "completed" : "failed",
        actorType: "source",
        detailCode: kind,
        commandRef: commandId,
        reasonCode: message,
        occurredAt: now,
      });
      const lifecycle = database().prepare(`
        SELECT lifecycle_state FROM game_event_coverage WHERE run_id = ?
      `).get(runId) as { lifecycle_state: string } | undefined;
      if (lifecycle?.lifecycle_state === "terminal_pending") sealGameHistory(runId);
    }
    return { status: "completed" as const };
  });
}
