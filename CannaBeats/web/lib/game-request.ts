import type { AudioControlView, Player, RoomView, Song } from "./game";
import type { GameRules } from "./rules";

export const RETRYABLE_ACTIONS = new Set(["place", "retract", "reveal"]);
const ROOM_RESPONSE_ACTIONS = new Set([
  "prepare", "join", "audioAcquire", "audioSelect", "audioRelease", "audioControl",
  "addPlayer", "removePlayer", "rules", "start", "begin", "place", "retract",
  "reveal", "advance", "skip",
]);

const TRANSIENT_GATEWAY_STATUSES = new Set([502, 503, 504]);
const DEFAULT_TIMEOUT_MS = 8_000;
const ROOM_PHASES = new Set(["lobby", "ready", "playing", "placed", "revealed", "finished"]);
const PLAYER_CONTROLS = new Set(["phone", "host"]);
const RULE_PRESETS = new Set(["family", "all-eras", "modern", "younger", "broadway-tv-movies", "custom"]);
const CATALOG_SCOPES = new Set(["all", "broadway-tv-movies"]);
const ERA_IDS = ["early", "midcentury", "classics", "millennial", "current"] as const;
const UUID_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type CryptoSource = {
  randomUUID?: () => string;
  getRandomValues: <T extends ArrayBufferView>(array: T) => T;
};

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type RoomSnapshotCursor = {
  room: RoomView | null;
  sequence: number;
};

export type GameApiPayload = {
  room?: RoomView;
  audio?: AudioControlView;
  action?: { id: string; accepted: boolean; replayed: boolean };
  error?: string;
  code?: string;
  correlationId?: string;
  hostToken?: string;
  playerId?: string;
  joinOrigin?: string;
  guestInvite?: string;
  expiresAt?: number;
};

export class GameApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly correlationId?: string;
  readonly actionId?: string;
  readonly pendingRequest?: Readonly<Record<string, unknown>>;

  constructor(
    message: string,
    status: number,
    code: string,
    correlationId?: string,
    actionId?: string,
    pendingRequest?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "GameApiError";
    this.status = status;
    this.code = code;
    this.correlationId = correlationId;
    this.actionId = actionId;
    this.pendingRequest = pendingRequest;
  }
}

export function actionUuid(cryptoSource: CryptoSource = globalThis.crypto) {
  if (typeof cryptoSource.randomUUID === "function") return cryptoSource.randomUUID();
  const bytes = cryptoSource.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}

export function reconcileRoomSnapshot(
  current: RoomSnapshotCursor,
  incoming: RoomView,
  sequence: number,
): RoomSnapshotCursor {
  const nextSequence = Math.max(current.sequence, sequence);
  if (!current.room) {
    return sequence >= current.sequence
      ? { room: incoming, sequence: nextSequence }
      : { room: null, sequence: nextSequence };
  }
  if (current.room.runId === incoming.runId) {
    if (incoming.revision > current.room.revision) {
      return { room: incoming, sequence: nextSequence };
    }
    if (incoming.revision < current.room.revision || sequence < current.sequence) {
      return { room: current.room, sequence: nextSequence };
    }
    return { room: incoming, sequence: nextSequence };
  }
  if (incoming.code === current.room.code) {
    if (incoming.runGeneration > current.room.runGeneration) {
      return { room: incoming, sequence: nextSequence };
    }
    if (incoming.runGeneration < current.room.runGeneration) {
      return { room: current.room, sequence: nextSequence };
    }
  }
  return sequence >= current.sequence
    ? { room: incoming, sequence: nextSequence }
    : { room: current.room, sequence: nextSequence };
}

export function commitRoomSnapshot(
  current: RoomSnapshotCursor,
  incoming: RoomView,
  sequence: number,
  expectedCode: string,
  setRoom: (room: RoomView | null) => void,
) {
  if (!validRoomViewShape(incoming) || incoming.code !== expectedCode.trim().toUpperCase()) {
    throw new GameApiError(
      "The game returned an incomplete room snapshot.",
      502,
      "invalid_response",
    );
  }
  const reconciled = reconcileRoomSnapshot(current, incoming, sequence);
  setRoom(reconciled.room);
  return reconciled;
}

export function commitJoinResult(
  payload: GameApiPayload,
  applyRoom: (room: RoomView) => RoomView | null,
  persistSession: (playerId: string) => void,
) {
  if (typeof payload.playerId !== "string"
      || !UUID_ID.test(payload.playerId)
      || !validRoomViewShape(payload.room)
      || !payload.room.players.some((player) => player.id === payload.playerId)) {
    throw new GameApiError(
      "The game returned an incomplete join result.",
      502,
      "invalid_response",
      payload.correlationId,
    );
  }
  const acceptedRoom = applyRoom(payload.room);
  if (acceptedRoom !== payload.room) {
    throw new GameApiError(
      "The join result was superseded by newer game state.",
      409,
      "stale_response",
      payload.correlationId,
    );
  }
  persistSession(payload.playerId);
  return { playerId: payload.playerId, room: acceptedRoom };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function validSong(value: unknown): value is Song {
  if (!isRecord(value)) return false;
  return typeof value.title === "string"
    && typeof value.artist === "string"
    && typeof value.year === "number"
    && Number.isSafeInteger(value.year)
    && (value.releaseYear === undefined || (typeof value.releaseYear === "number" && Number.isSafeInteger(value.releaseYear)))
    && (value.themes === undefined || (Array.isArray(value.themes) && value.themes.every((theme) => typeof theme === "string")))
    && (value.uri === undefined || typeof value.uri === "string");
}

function validPlayer(value: unknown): value is Player {
  if (!isRecord(value)) return false;
  return typeof value.id === "string"
    && typeof value.name === "string"
    && PLAYER_CONTROLS.has(String(value.control ?? ""))
    && Array.isArray(value.timeline)
    && value.timeline.every(validSong);
}

function validRules(value: unknown): value is GameRules {
  if (!isRecord(value) || !isRecord(value.eraWeights)) return false;
  const eraWeights = value.eraWeights;
  return RULE_PRESETS.has(String(value.preset ?? ""))
    && typeof value.minYear === "number" && Number.isSafeInteger(value.minYear)
    && typeof value.maxYear === "number" && Number.isSafeInteger(value.maxYear)
    && typeof value.targetScore === "number" && Number.isSafeInteger(value.targetScore)
    && typeof value.allowRetraction === "boolean"
    && CATALOG_SCOPES.has(String(value.catalogScope ?? ""))
    && ERA_IDS.every((era) => typeof eraWeights[era] === "number" && Number.isFinite(eraWeights[era]));
}

export function validRoomViewShape(value: unknown): value is RoomView {
  if (!isRecord(value)) return false;
  return UUID_ID.test(String(value.runId ?? ""))
    && typeof value.runGeneration === "number"
    && Number.isSafeInteger(value.runGeneration)
    && Number(value.runGeneration) >= 0
    && typeof value.revision === "number"
    && Number.isSafeInteger(value.revision)
    && Number(value.revision) >= 0
    && /^[A-Z2-9]{6}$/.test(String(value.code ?? ""))
    && ROOM_PHASES.has(String(value.phase ?? ""))
    && Array.isArray(value.players)
    && value.players.every(validPlayer)
    && (value.activePlayerId === null || typeof value.activePlayerId === "string")
    && typeof value.activePlayerIndex === "number"
    && Number.isSafeInteger(value.activePlayerIndex)
    && Number(value.activePlayerIndex) >= 0
    && typeof value.round === "number"
    && Number.isSafeInteger(value.round)
    && Number(value.round) >= 0
    && (value.currentSong === null || validSong(value.currentSong))
    && (value.placement === null || (typeof value.placement === "number" && Number.isSafeInteger(value.placement) && value.placement >= 0))
    && typeof value.retractionUsed === "boolean"
    && (value.result === null || (isRecord(value.result)
      && typeof value.result.correct === "boolean"
      && typeof value.result.index === "number"
      && Number.isSafeInteger(value.result.index)
      && Number(value.result.index) >= 0))
    && (value.winnerId === null || typeof value.winnerId === "string")
    && validRules(value.rules)
    && typeof value.isHost === "boolean";
}

function validRoomView(
  value: unknown,
  expectedRunId: string,
  expectedRevision: number,
  expectedCode: string,
): value is RoomView {
  if (!validRoomViewShape(value)) return false;
  return value.runId.toLowerCase() === expectedRunId
    && value.revision > expectedRevision
    && value.code === expectedCode;
}

export async function requestGame(
  endpoint: string,
  body: Record<string, unknown>,
  options: {
    fetchImpl?: FetchLike;
    cryptoSource?: CryptoSource;
    timeoutMs?: number;
  } = {},
) {
  const action = String(body.action ?? "");
  const retryable = RETRYABLE_ACTIONS.has(action);
  const requestBody = retryable && !body.actionId
    ? { ...body, actionId: actionUuid(options.cryptoSource) }
    : body;
  const retainedRequest = retryable ? Object.freeze({ ...requestBody }) : undefined;
  const serializedBody = JSON.stringify(requestBody);
  const requestedActionId = retryable ? String(requestBody.actionId ?? "").toLowerCase() : "";
  const requestedRunId = retryable ? String(requestBody.expectedRunId ?? "").toLowerCase() : "";
  const requestedRevision = retryable ? Number(requestBody.expectedRevision) : -1;
  const requestedCode = retryable ? String(requestBody.code ?? "").trim().toUpperCase() : "";
  const fetchImpl = options.fetchImpl ?? fetch;
  const attempts = retryable ? 2 : 1;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort(new DOMException("Game request timed out.", "TimeoutError"));
    }, timeoutMs);
    try {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: serializedBody,
        signal: controller.signal,
      });
      const parsedPayload = await response.json() as unknown;
      const payload = parsedPayload && typeof parsedPayload === "object" && !Array.isArray(parsedPayload)
        ? parsedPayload as GameApiPayload
        : {};
      if (response.ok) {
        if (retryable) {
          const responseActionId = String(payload.action?.id ?? "").toLowerCase();
          const validActionOutcome = Boolean(
            validRoomView(payload.room, requestedRunId, requestedRevision, requestedCode)
            && payload.action?.accepted === true
            && typeof payload.action.replayed === "boolean"
            && responseActionId === requestedActionId,
          );
          if (!validActionOutcome) {
            if (attempt + 1 < attempts) continue;
            throw new GameApiError(
              "The game returned an incomplete action result.",
              502,
              "invalid_response",
              payload.correlationId,
              requestedActionId,
              retainedRequest,
            );
          }
        } else if (ROOM_RESPONSE_ACTIONS.has(action)
            && (!validRoomViewShape(payload.room) || payload.room.code !== String(body.code ?? "").trim().toUpperCase())) {
          throw new GameApiError(
            "The game returned an incomplete transition result.",
            502,
            "invalid_response",
            payload.correlationId,
          );
        }
        return payload;
      }
      if (retryable && TRANSIENT_GATEWAY_STATUSES.has(response.status)) {
        if (attempt + 1 < attempts) continue;
        throw new GameApiError(
          "The action result could not be confirmed. Refresh the game before retrying.",
          response.status,
          "action_outcome_unknown",
          payload.correlationId,
          requestedActionId,
          retainedRequest,
        );
      }
      throw new GameApiError(
        payload.error ?? "Something went wrong.",
        response.status,
        payload.code ?? "request_failed",
        payload.correlationId,
      );
    } catch (error) {
      if (error instanceof GameApiError || !retryable) throw error;
      if (attempt + 1 >= attempts) {
        throw new GameApiError(
          "The action result could not be confirmed. Refresh the game before retrying.",
          502,
          "action_outcome_unknown",
          undefined,
          requestedActionId,
          retainedRequest,
        );
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error("The game request did not complete.");
}
