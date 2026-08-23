import type { GameRules } from "./rules.ts";
import { cannabeatsPath } from "./paths.ts";

export const RELEASE_GAME_CONTRACT = "3";
export const RELEASE_GAME_CONTRACT_HEADER = "x-cannabeats-client-contract";
export const RELEASE_GAME_ROLE_HEADER = "x-cannabeats-game-role";
export const RELEASE_PENDING_ACTION_KEY = "cannabeats-release-pending-action";
export const RELEASE_SESSION_KEY = "cannabeats-release-session";

export type ReleaseRole = "host" | "participant";
export type ReleasePhase = "lobby" | "ready" | "playing" | "placed" | "revealed" | "finished";

export type ReleaseSong = {
  artist: string;
  title: string;
  uri: string;
  year: number;
  releaseYear?: number;
  themes?: string[];
};

export type ReleasePlayer = {
  control: "host" | "phone";
  id: string;
  name: string;
  timeline: ReleaseSong[];
};

export type ReleaseGameState = {
  activePlayerId: string | null;
  activePlayerIndex?: number;
  catalogVersion: string;
  currentSong?: ReleaseSong | null;
  gameId: string;
  phase: ReleasePhase;
  placement?: number | null;
  players: ReleasePlayer[];
  result?: { correct: boolean; index: number } | null;
  retractionUsed: boolean;
  revision: number;
  round: number;
  rules: GameRules;
  winnerId: string | null;
};

export type ReleaseSnapshot = {
  audio: {
    audioSessionId: string;
    generation: number;
    state: "active";
  } | null;
  playback?: ReleasePlaybackProjection;
  code: "snapshot";
  gameId: string;
  lifecycle: "lobby" | "active" | "completed" | "abandoned";
  participantId?: string;
  revision: number;
  state: ReleaseGameState;
};

export type ReleasePlaybackProjection = {
  state: "unknown" | "playing" | "paused";
  pending: "playing" | "paused" | null;
  failed: "playing" | "paused" | null;
};

export type ReleaseSession = {
  gameId: string;
  participantId?: string;
  role: ReleaseRole;
};

export type ReleaseActionIntent = {
  expectedRevision: number;
  gameId: string;
  operation: string;
  payload: Record<string, unknown>;
  requestId: string;
  role: ReleaseRole;
};

export class ReleaseClientError extends Error {
  readonly code: string;
  readonly status: number;
  readonly pending?: ReleaseActionIntent;

  constructor(code: string, status: number, pending?: ReleaseActionIntent) {
    super(code);
    this.name = "ReleaseClientError";
    this.code = code;
    this.status = status;
    this.pending = pending;
  }
}

function validRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validSong(value: unknown): value is ReleaseSong {
  return validRecord(value) && typeof value.artist === "string" && typeof value.title === "string"
    && typeof value.uri === "string" && Number.isSafeInteger(value.year);
}

function validRules(value: unknown): value is GameRules {
  return validRecord(value) && typeof value.preset === "string"
    && Number.isSafeInteger(value.minYear) && Number.isSafeInteger(value.maxYear)
    && Number.isSafeInteger(value.targetScore) && typeof value.allowRetraction === "boolean"
    && typeof value.catalogScope === "string" && validRecord(value.eraWeights);
}

function validPlayer(value: unknown): value is ReleasePlayer {
  return validRecord(value) && typeof value.id === "string" && typeof value.name === "string"
    && ["host", "phone"].includes(String(value.control)) && Array.isArray(value.timeline)
    && value.timeline.every(validSong);
}

function releaseState(value: unknown, role: ReleaseRole): ReleaseGameState {
  if (!validRecord(value) || typeof value.gameId !== "string"
      || typeof value.catalogVersion !== "string" || typeof value.phase !== "string"
      || !["lobby", "ready", "playing", "placed", "revealed", "finished"].includes(value.phase)
      || !Array.isArray(value.players) || !value.players.every(validPlayer)
      || !Number.isSafeInteger(value.revision) || !Number.isSafeInteger(value.round)
      || typeof value.retractionUsed !== "boolean" || !validRules(value.rules)
      || !(value.activePlayerId === null || typeof value.activePlayerId === "string")
      || !(value.winnerId === null || typeof value.winnerId === "string")) {
    throw new ReleaseClientError("invalid_response", 502);
  }
  const revealed = ["revealed", "finished"].includes(value.phase);
  if (role === "participant") {
    const answerKeys = ["currentSong", "placement", "result"];
    if (answerKeys.some((key) => (key in value) !== revealed)) {
      throw new ReleaseClientError("invalid_response", 502);
    }
  } else if (!("currentSong" in value) || !("placement" in value) || !("result" in value)) {
    throw new ReleaseClientError("invalid_response", 502);
  }
  if (revealed && (!validSong(value.currentSong) || !Number.isSafeInteger(value.placement)
      || !validRecord(value.result) || typeof value.result.correct !== "boolean"
      || !Number.isSafeInteger(value.result.index))) {
    throw new ReleaseClientError("invalid_response", 502);
  }
  return value as unknown as ReleaseGameState;
}

function releaseSnapshot(value: unknown, role: ReleaseRole): ReleaseSnapshot {
  if (!validRecord(value) || value.code !== "snapshot" || typeof value.gameId !== "string"
      || !["lobby", "active", "completed", "abandoned"].includes(String(value.lifecycle))
      || !Number.isSafeInteger(value.revision)) throw new ReleaseClientError("invalid_response", 502);
  const audio = value.audio;
  if (!(audio === null || (validRecord(audio)
      && Object.keys(audio).sort().join("\0") === "audioSessionId\0generation\0state"
      && typeof audio.audioSessionId === "string"
      && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
        .test(audio.audioSessionId)
      && Number.isSafeInteger(audio.generation) && Number(audio.generation) > 0
      && audio.state === "active"))) throw new ReleaseClientError("invalid_response", 502);
  const playback = value.playback;
  const validPlayback = validRecord(playback)
    && Object.keys(playback).sort().join("\0") === "failed\0pending\0state"
    && ["unknown", "playing", "paused"].includes(String(playback.state))
    && (playback.pending === null || ["playing", "paused"].includes(String(playback.pending)))
    && (playback.failed === null || ["playing", "paused"].includes(String(playback.failed)));
  if (role === "host" ? !validPlayback : playback !== undefined) {
    throw new ReleaseClientError("invalid_response", 502);
  }
  const state = releaseState(value.state, role);
  if (state.gameId !== value.gameId || state.revision !== value.revision
      || (role === "participant" && typeof value.participantId !== "string")) {
    throw new ReleaseClientError("invalid_response", 502);
  }
  return { ...value, state } as ReleaseSnapshot;
}

async function responseJson<T>(response: Response): Promise<T> {
  let value: unknown;
  try { value = await response.json(); } catch { throw new ReleaseClientError("invalid_response", 502); }
  if (!response.ok) {
    const code = validRecord(value) && typeof value.code === "string"
      ? value.code : "service_unavailable";
    throw new ReleaseClientError(code, response.status);
  }
  return value as T;
}

async function jsonRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(cannabeatsPath(path), {
    cache: "no-store",
    credentials: "same-origin",
    ...init,
    headers: {
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      ...init.headers,
    },
  });
  return responseJson<T>(response);
}

export function uuid(): string {
  return crypto.randomUUID();
}

export function randomBearer(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function saveReleaseSession(storage: Pick<Storage, "setItem">, session: ReleaseSession) {
  storage.setItem(RELEASE_SESSION_KEY, JSON.stringify(session));
}

export function loadReleaseSession(storage: Pick<Storage, "getItem" | "removeItem">) {
  const text = storage.getItem(RELEASE_SESSION_KEY);
  if (!text) return null;
  try {
    const value: unknown = JSON.parse(text);
    if (!validRecord(value) || !["host", "participant"].includes(String(value.role))
        || typeof value.gameId !== "string"
        || (value.participantId !== undefined && typeof value.participantId !== "string")) {
      throw new Error("invalid");
    }
    return value as ReleaseSession;
  } catch {
    storage.removeItem(RELEASE_SESSION_KEY);
    return null;
  }
}

export function savePendingReleaseAction(
  storage: Pick<Storage, "setItem">, intent: ReleaseActionIntent,
) {
  storage.setItem(RELEASE_PENDING_ACTION_KEY, JSON.stringify(intent));
}

export function clearPendingReleaseAction(storage: Pick<Storage, "removeItem">) {
  storage.removeItem(RELEASE_PENDING_ACTION_KEY);
}

export function acceptReleaseAction(
  storage: Pick<Storage, "removeItem">, state: ReleaseGameState,
) {
  clearPendingReleaseAction(storage);
  return {
    lifecycle: state.phase === "lobby" ? "lobby" as const
      : state.phase === "finished" ? "completed" as const : "active" as const,
    state,
  };
}

export function loadPendingReleaseAction(
  storage: Pick<Storage, "getItem" | "removeItem">,
): ReleaseActionIntent | null {
  const text = storage.getItem(RELEASE_PENDING_ACTION_KEY);
  if (!text) return null;
  try {
    const value: unknown = JSON.parse(text);
    if (!validRecord(value) || !Number.isSafeInteger(value.expectedRevision)
        || typeof value.gameId !== "string" || typeof value.operation !== "string"
        || !validRecord(value.payload) || typeof value.requestId !== "string"
        || !["host", "participant"].includes(String(value.role))) throw new Error("invalid");
    return value as ReleaseActionIntent;
  } catch {
    storage.removeItem(RELEASE_PENDING_ACTION_KEY);
    return null;
  }
}

export function loadPendingReleaseRecovery(
  storage: Pick<Storage, "getItem" | "removeItem">,
): { pending: ReleaseActionIntent; session: ReleaseSession } | null {
  const session = loadReleaseSession(storage);
  const pending = loadPendingReleaseAction(storage);
  return session && pending && pending.gameId === session.gameId && pending.role === session.role
    ? { pending, session } : null;
}

export async function exchangeHostTicket(ticket: string) {
  return jsonRequest<{ code: "ticket_exchanged" }>("/api/host/web-tickets/exchange", {
    method: "POST", body: JSON.stringify({ ticket }),
  });
}

export async function releaseReadiness() {
  return jsonRequest<{ ready: true; catalogVersion: string }>("/api/ready");
}

export async function recoverHostGame() {
  const result = await jsonRequest<{ game: unknown }>("/api/games/recovery");
  if (!validRecord(result) || !("game" in result)) throw new ReleaseClientError("invalid_response", 502);
  return { game: result.game === null ? null : releaseSnapshot(result.game, "host") };
}

export async function recoverParticipantGame() {
  return releaseSnapshot(await jsonRequest("/api/games/participant-recovery"), "participant");
}

export async function createReleaseGame(catalogVersion: string, rules: GameRules) {
  return jsonRequest<{
    code: "created" | "active_game_exists";
    gameId: string;
    revision?: number;
    state?: ReleaseGameState;
  }>("/api/games", {
    method: "POST",
    body: JSON.stringify({ catalogVersion, gameId: uuid(), requestId: uuid(), rules }),
  });
}

export async function hostSnapshot(gameId: string) {
  return releaseSnapshot(await jsonRequest(`/api/games/${gameId}/host-snapshot`), "host");
}

export async function participantSnapshot(gameId: string) {
  return releaseSnapshot(await jsonRequest(`/api/games/${gameId}/snapshot`), "participant");
}

export async function issueReleaseInvitation(gameId: string, expectedRevision: number) {
  const inviteToken = randomBearer();
  const result = await jsonRequest<{ revision: number; value: { expiresAt: number } }>(
    `/api/games/${gameId}/invitations`, {
      method: "POST",
      body: JSON.stringify({ expectedRevision, inviteToken, requestId: uuid() }),
    },
  );
  return { ...result, inviteToken };
}

export async function admitReleaseParticipant({
  displayName, gameId, inviteToken,
}: { displayName: string; gameId: string; inviteToken: string }) {
  const participantId = uuid();
  const sessionToken = randomBearer();
  const result = await jsonRequest<{ revision: number }>(`/api/games/${gameId}/participants`, {
    method: "POST",
    body: JSON.stringify({
      displayName, inviteToken, participantId, requestId: uuid(), sessionToken,
    }),
  });
  return { participantId, result };
}

export async function removeReleaseParticipant(
  gameId: string, participantId: string, expectedRevision: number,
) {
  return jsonRequest(`/api/games/${gameId}/participants/${participantId}/remove`, {
    method: "POST", body: JSON.stringify({ expectedRevision, requestId: uuid() }),
  });
}

export async function terminateReleaseGame(gameId: string, expectedRevision: number) {
  return jsonRequest(`/api/games/${gameId}/terminate`, {
    method: "POST", body: JSON.stringify({ expectedRevision, requestId: uuid() }),
  });
}

export function createActionIntent(
  session: ReleaseSession, expectedRevision: number,
  operation: string, payload: Record<string, unknown> = {},
): ReleaseActionIntent {
  return {
    expectedRevision, gameId: session.gameId, operation, payload,
    requestId: uuid(), role: session.role,
  };
}

async function sendActionAttempt(intent: ReleaseActionIntent, signal: AbortSignal) {
  const result = await jsonRequest<{
    code: "accepted";
    gameId: string;
    revision: number;
    state: ReleaseGameState;
  }>(`/api/games/${intent.gameId}/actions`, {
    method: "POST", signal,
    headers: {
      [RELEASE_GAME_CONTRACT_HEADER]: RELEASE_GAME_CONTRACT,
      [RELEASE_GAME_ROLE_HEADER]: intent.role,
    },
    body: JSON.stringify({
      expectedRevision: intent.expectedRevision, operation: intent.operation,
      payload: intent.payload, requestId: intent.requestId,
    }),
  });
  if (!validRecord(result) || result.code !== "accepted" || result.gameId !== intent.gameId
      || !Number.isSafeInteger(result.revision)) throw new ReleaseClientError("invalid_response", 502);
  const state = releaseState(result.state, intent.role);
  if (state.revision !== result.revision) throw new ReleaseClientError("invalid_response", 502);
  return { ...result, state };
}

export async function sendReleaseAction(intent: ReleaseActionIntent, attempts = 3) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 8_000);
    try {
      return await sendActionAttempt(intent, controller.signal);
    } catch (error) {
        const retryable = error instanceof DOMException && error.name === "AbortError"
          || error instanceof TypeError
          || error instanceof ReleaseClientError && (error.code === "invalid_response"
            || [502, 503, 504].includes(error.status));
      if (!retryable) throw error;
      if (attempt === attempts - 1) throw new ReleaseClientError("outcome_unknown", 0, intent);
      await new Promise((resolve) => window.setTimeout(resolve, 250 * (2 ** attempt)));
    } finally {
      window.clearTimeout(timeout);
    }
  }
  throw new ReleaseClientError("outcome_unknown", 0, intent);
}
