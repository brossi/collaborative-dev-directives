import { randomUUID } from "node:crypto";
import { database, sha256 } from "./database";

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

function cleanupExpiredLeases(now = Date.now()) {
  database().prepare("DELETE FROM managed_audio_leases WHERE expires_at <= ?").run(now);
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
  cleanupExpiredLeases();
  return viewFor(leaseRow(sessionCode));
}

export function renewManagedAudioLease(sessionCode: string) {
  const now = Date.now();
  cleanupExpiredLeases(now);
  database().prepare(`
    UPDATE managed_audio_leases SET renewed_at = ?, expires_at = ? WHERE session_code = ?
  `).run(now, now + MANAGED_LEASE_TTL_MS, sessionCode);
  return viewFor(leaseRow(sessionCode), now);
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
      return viewFor({ ...existing, expires_at: now + MANAGED_LEASE_TTL_MS }, now);
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
      selection: "managed" as const,
      mode: "managed" as const,
      leaseId,
      sourceName: source.display_name,
      sourceOnline: true,
      status: "ready" as const,
    };
  });
}

function audioSelection(sessionCode: string) {
  const row = database().prepare("SELECT audio_mode FROM game_sessions WHERE code = ?")
    .get(sessionCode) as { audio_mode: "local" | "managed" } | undefined;
  return row?.audio_mode ?? "managed";
}

/** Returns the saved source choice and, for a host, opportunistically reserves the default source. */
export function selectedAudioView(sessionCode: string, hostUserId?: string) {
  const selection = audioSelection(sessionCode);
  let view = managedAudioView(sessionCode);
  if (selection === "managed" && hostUserId) {
    try {
      view = view.mode === "managed"
        ? renewManagedAudioLease(sessionCode)
        : acquireManagedAudioLease(sessionCode, hostUserId);
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "No managed audio source is online and available.") {
        throw error;
      }
      // Keep the managed choice visible while the source is temporarily unavailable.
    }
  }
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
    return { ...releaseManagedAudioLease(sessionCode), selection };
  }
  return { ...acquireManagedAudioLease(sessionCode, hostUserId), selection };
}

export function releaseManagedAudioLease(sessionCode: string) {
  database().prepare("DELETE FROM managed_audio_leases WHERE session_code = ?").run(sessionCode);
  return managedAudioView(sessionCode);
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
    database().prepare(`
      INSERT INTO managed_audio_commands
        (id, lease_id, source_id, session_code, kind, track_uri, requested_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), lease.id, lease.source_id, sessionCode, kind, trackUri ?? null, userId, now);
    database().prepare(`
      UPDATE managed_audio_leases SET playback_status = ?, last_error = NULL WHERE id = ?
    `).run(status[kind], lease.id);
    return managedAudioView(sessionCode);
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

export function pollManagedAudioSource(sourceId: string, deviceId: string | null) {
  const now = Date.now();
  database().prepare(`
    UPDATE managed_audio_sources
    SET last_seen_at = ?, device_id = COALESCE(?, device_id), last_error = NULL
    WHERE id = ?
  `).run(now, deviceId, sourceId);
  cleanupExpiredLeases(now);
  const lease = database().prepare(`
    SELECT id, session_code, playback_status FROM managed_audio_leases
    WHERE source_id = ? AND expires_at > ?
  `).get(sourceId, now) as { id: string; session_code: string; playback_status: ManagedPlaybackStatus } | undefined;
  if (!lease) return { lease: null, command: null };
  const command = database().prepare(`
    SELECT id, kind, track_uri AS trackUri FROM managed_audio_commands
    WHERE source_id = ? AND lease_id = ? AND completed_at IS NULL
    ORDER BY created_at ASC LIMIT 1
  `).get(sourceId, lease.id) as { id: string; kind: ManagedAudioCommandKind; trackUri: string | null } | undefined;
  if (command) {
    database().prepare(`
      UPDATE managed_audio_commands SET delivered_at = COALESCE(delivered_at, ?) WHERE id = ?
    `).run(now, command.id);
  }
  return {
    lease: { id: lease.id, sessionCode: lease.session_code, status: lease.playback_status },
    command: command ?? null,
  };
}

export function completeManagedAudioCommand(
  sourceId: string,
  commandId: string,
  ok: boolean,
  playbackStatus: "ready" | "playing" | "paused" | "error",
  error: string | null,
  deviceId: string | null,
) {
  const command = database().prepare(`
    SELECT id, lease_id FROM managed_audio_commands
    WHERE id = ? AND source_id = ? AND completed_at IS NULL
  `).get(commandId, sourceId) as { id: string; lease_id: string } | undefined;
  if (!command) return false;
  // The source may receive detailed browser/Spotify errors. Persist only a stable,
  // operator-safe category so tokens, URIs, or account details cannot reach SQLite.
  const message = ok ? null : managedErrorCategory(error);
  const status = ok ? playbackStatus : "error";
  const now = Date.now();
  database().exec("BEGIN IMMEDIATE");
  try {
    database().prepare(`
      UPDATE managed_audio_commands SET completed_at = ?, error = ? WHERE id = ?
    `).run(now, message, command.id);
    database().prepare(`
      UPDATE managed_audio_leases SET playback_status = ?, last_error = ? WHERE id = ?
    `).run(status, message, command.lease_id);
    database().prepare(`
      UPDATE managed_audio_sources
      SET last_seen_at = ?, device_id = COALESCE(?, device_id), last_error = ? WHERE id = ?
    `).run(now, deviceId, message, sourceId);
    database().exec("COMMIT");
    return true;
  } catch (caught) {
    database().exec("ROLLBACK");
    throw caught;
  }
}
