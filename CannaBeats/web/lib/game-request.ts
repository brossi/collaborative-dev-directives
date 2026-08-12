import type { AudioControlView, Player, RoomView, Song } from "./game";
import {
  AUDIO_RESPONSE_ACTIONS,
  isRunBoundMutationAction,
  REVISION_ADVANCING_ACTIONS,
  RUN_BOUND_MUTATION_ACTIONS,
} from "./game-action-contract.ts";
import type { GameRules } from "./rules";

// Every run-bound mutation is receipt-backed by the server, so every dispatched
// intent can be retried only with its exact action identity and payload.
export const RETRYABLE_ACTIONS = new Set<string>(RUN_BOUND_MUTATION_ACTIONS);
const ROOM_RESPONSE_ACTIONS = new Set(["prepare", "join", ...RUN_BOUND_MUTATION_ACTIONS]);
const TRANSIENT_GATEWAY_STATUSES = new Set([502, 503, 504]);
const DEFAULT_TIMEOUT_MS = 8_000;
const ROOM_PHASES = new Set(["lobby", "ready", "playing", "placed", "revealed", "finished"]);
const PLAYER_CONTROLS = new Set(["phone", "host"]);
const AUDIO_SELECTIONS = new Set(["local", "managed"]);
const AUDIO_MODES = new Set(["local", "managed"]);
const AUDIO_STATUSES = new Set([
  "disconnected", "ready", "starting", "playing", "pausing", "paused", "resuming", "error",
]);
const RULE_PRESETS = new Set(["family", "all-eras", "modern", "younger", "broadway-tv-movies", "custom"]);
const CATALOG_SCOPES = new Set(["all", "broadway-tv-movies"]);
const ERA_IDS = ["early", "midcentury", "classics", "millennial", "current"] as const;
const UUID_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const PENDING_GAME_INTENT_KEY = "cannabeats-pending-game-intent";

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

export function loadPendingGameIntent(storage: Pick<Storage, "getItem" | "removeItem">) {
  const saved = storage.getItem(PENDING_GAME_INTENT_KEY);
  if (!saved) return null;
  try {
    const parsed = JSON.parse(saved) as unknown;
    if (!isRecord(parsed)
        || !isRunBoundMutationAction(String(parsed.action ?? ""))
        || !ACTION_ID.test(String(parsed.actionId ?? ""))
        || !/^[A-Z2-9]{6}$/.test(String(parsed.code ?? "").trim().toUpperCase())
        || !UUID_ID.test(String(parsed.expectedRunId ?? ""))
        || typeof parsed.expectedRunGeneration !== "number"
        || !Number.isSafeInteger(parsed.expectedRunGeneration)
        || parsed.expectedRunGeneration < 0
        || typeof parsed.expectedRevision !== "number"
        || !Number.isSafeInteger(parsed.expectedRevision)
        || parsed.expectedRevision < 0) {
      throw new Error("Invalid pending intent");
    }
    return Object.freeze({ ...parsed }) as Readonly<Record<string, unknown>>;
  } catch {
    storage.removeItem(PENDING_GAME_INTENT_KEY);
    return null;
  }
}

export function savePendingGameIntent(
  storage: Pick<Storage, "setItem">,
  request: Readonly<Record<string, unknown>>,
) {
  storage.setItem(PENDING_GAME_INTENT_KEY, JSON.stringify(request));
}

export function clearPendingGameIntent(storage: Pick<Storage, "removeItem">) {
  storage.removeItem(PENDING_GAME_INTENT_KEY);
}

function waitForPendingRetry(delayMs: number, signal?: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timeout = setTimeout(finish, delayMs);
    function finish() {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", finish);
      resolve();
    }
    signal?.addEventListener("abort", finish, { once: true });
  });
}

export async function reconcilePendingGameRequest(
  request: Readonly<Record<string, unknown>>,
  send: (request: Readonly<Record<string, unknown>>) => Promise<GameApiPayload>,
  options: {
    signal?: AbortSignal;
    onPending?: (request: Readonly<Record<string, unknown>>) => void;
    wait?: (attempt: number, signal?: AbortSignal) => Promise<void>;
  } = {},
) {
  let attempt = 0;
  while (!options.signal?.aborted) {
    try {
      const payload = await send(request);
      return { kind: "confirmed" as const, payload };
    } catch (error) {
      if (!(error instanceof GameApiError) || !error.pendingRequest) {
        return { kind: "rejected" as const, error };
      }
      options.onPending?.(error.pendingRequest);
      attempt += 1;
      const wait = options.wait ?? ((currentAttempt, signal) => (
        waitForPendingRetry(Math.min(5_000, 250 * (2 ** Math.min(currentAttempt - 1, 5))), signal)
      ));
      await wait(attempt, options.signal);
    }
  }
  return { kind: "aborted" as const };
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
    if (incoming.runGeneration > current.room.runGeneration) {
      return { room: incoming, sequence: nextSequence };
    }
    if (incoming.runGeneration < current.room.runGeneration) {
      return { room: current.room, sequence: nextSequence };
    }
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

export function commitGamePayload(
  current: RoomSnapshotCursor,
  payload: GameApiPayload,
  sequence: number,
  expectedCode: string,
  setRoom: (room: RoomView | null) => void,
  setAudio: (audio: AudioControlView) => void,
) {
  if (!validRoomViewShape(payload.room)
      || (payload.audio !== undefined && !validAudioControlViewShape(payload.audio))) {
    throw new GameApiError(
      "The game returned an incomplete room snapshot.",
      502,
      "invalid_response",
      payload.correlationId,
    );
  }
  const reconciled = commitRoomSnapshot(current, payload.room, sequence, expectedCode, setRoom);
  if (reconciled.room === payload.room && payload.audio) setAudio(payload.audio);
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
  return UUID_ID.test(String(value.id ?? ""))
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
    && value.minYear <= value.maxYear
    && typeof value.targetScore === "number" && Number.isSafeInteger(value.targetScore)
    && value.targetScore >= 3 && value.targetScore <= 20
    && typeof value.allowRetraction === "boolean"
    && CATALOG_SCOPES.has(String(value.catalogScope ?? ""))
    && ERA_IDS.every((era) => typeof eraWeights[era] === "number"
      && Number.isFinite(eraWeights[era])
      && Number(eraWeights[era]) >= 0
      && Number(eraWeights[era]) <= 100);
}

export function validAudioControlViewShape(value: unknown): value is AudioControlView {
  if (!isRecord(value)) return false;
  const selection = String(value.selection ?? "");
  const mode = String(value.mode ?? "");
  const status = String(value.status ?? "");
  const baseShape = AUDIO_SELECTIONS.has(selection)
    && AUDIO_MODES.has(String(value.mode ?? ""))
    && typeof value.sourceOnline === "boolean"
    && AUDIO_STATUSES.has(status)
    && (value.leaseId === undefined || typeof value.leaseId === "string")
    && (value.sourceName === undefined || typeof value.sourceName === "string")
    && (value.error === undefined || typeof value.error === "string");
  if (!baseShape) return false;
  if (mode === "local") {
    return value.sourceOnline === false
      && status === "disconnected"
      && value.leaseId === undefined
      && value.sourceName === undefined
      && value.error === undefined;
  }
  return selection === "managed"
    && typeof value.leaseId === "string"
    && UUID_ID.test(value.leaseId)
    && typeof value.sourceName === "string"
    && value.sourceName.length > 0
    && status !== "disconnected";
}

function validRoomPhaseRelations(
  value: Record<string, unknown>,
  players: Player[],
  activePlayer: Player | undefined,
) {
  const phase = String(value.phase);
  const round = Number(value.round);
  const currentSong = value.currentSong;
  const placement = value.placement;
  const result = value.result;
  const winnerId = value.winnerId;
  if (phase === "lobby") {
    return round === 0
      && value.activePlayerId === null
      && currentSong === null
      && placement === null
      && result === null
      && winnerId === null;
  }
  if (!players.length || !activePlayer || value.activePlayerId !== activePlayer.id || round < 1) return false;
  const songMayBeHidden = value.isHost === false && ["ready", "playing", "placed"].includes(phase);
  if (currentSong === null && !songMayBeHidden) return false;
  if (phase === "ready" || phase === "playing") {
    return placement === null && result === null && winnerId === null;
  }
  if (phase === "placed") return placement !== null && result === null && winnerId === null;
  if (phase === "revealed") return placement !== null && result !== null && currentSong !== null;
  return phase === "finished"
    && placement !== null
    && result !== null
    && currentSong !== null
    && winnerId !== null;
}

export function validRoomViewShape(value: unknown): value is RoomView {
  if (!isRecord(value)) return false;
  if (!Array.isArray(value.players) || !value.players.every(validPlayer)) return false;
  const players = value.players as Player[];
  const playerIds = new Set(players.map((player) => player.id));
  if (playerIds.size !== players.length) return false;
  const activePlayerIndex = Number(value.activePlayerIndex);
  const activePlayer = players[activePlayerIndex];
  const activePlayerId = value.activePlayerId;
  const placement = value.placement;
  const result = value.result;
  const baseShape = UUID_ID.test(String(value.runId ?? ""))
    && typeof value.runGeneration === "number"
    && Number.isSafeInteger(value.runGeneration)
    && Number(value.runGeneration) >= 0
    && typeof value.revision === "number"
    && Number.isSafeInteger(value.revision)
    && Number(value.revision) >= 0
    && /^[A-Z2-9]{6}$/.test(String(value.code ?? ""))
    && ROOM_PHASES.has(String(value.phase ?? ""))
    && (activePlayerId === null || (UUID_ID.test(String(activePlayerId)) && activePlayer?.id === activePlayerId))
    && typeof value.activePlayerIndex === "number"
    && Number.isSafeInteger(value.activePlayerIndex)
    && Number(value.activePlayerIndex) >= 0
    && (players.length === 0 ? activePlayerIndex === 0 : activePlayerIndex < players.length)
    && typeof value.round === "number"
    && Number.isSafeInteger(value.round)
    && Number(value.round) >= 0
    && (value.currentSong === null || validSong(value.currentSong))
    && (placement === null || (typeof placement === "number"
      && Number.isSafeInteger(placement)
      && placement >= 0
      && Boolean(activePlayer)
      && placement <= activePlayer.timeline.length))
    && typeof value.retractionUsed === "boolean"
    && (result === null || (isRecord(result)
      && typeof result.correct === "boolean"
      && typeof result.index === "number"
      && Number.isSafeInteger(result.index)
      && Number(result.index) >= 0
      && Boolean(activePlayer)
      && Number(result.index) <= activePlayer.timeline.length))
    && (value.winnerId === null || (UUID_ID.test(String(value.winnerId)) && playerIds.has(String(value.winnerId))))
    && validRules(value.rules)
    && typeof value.isHost === "boolean"
    && (value.isHost === true
      || value.phase === "revealed"
      || value.phase === "finished"
      || value.currentSong === null);
  return baseShape && validRoomPhaseRelations(value, players, activePlayer);
}

function validTransitionRoom(
  value: unknown,
  action: string,
  expectedCode: string,
  expectedRunId: string,
  expectedRunGeneration: number,
  expectedRevision: number,
): value is RoomView {
  if (!validRoomViewShape(value) || value.code !== expectedCode) return false;
  if (!isRunBoundMutationAction(action)) return true;
  if (!UUID_ID.test(expectedRunId)
      || !Number.isSafeInteger(expectedRunGeneration) || expectedRunGeneration < 0
      || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) return false;
  if (value.runId.toLowerCase() !== expectedRunId
      || value.runGeneration !== expectedRunGeneration) return false;
  return REVISION_ADVANCING_ACTIONS.has(action)
    ? value.revision > expectedRevision
    : value.revision >= expectedRevision;
}

export async function requestGame(
  endpoint: string,
  body: Record<string, unknown>,
  options: {
    fetchImpl?: FetchLike;
    cryptoSource?: CryptoSource;
    timeoutMs?: number;
    onRequestPrepared?: (request: Readonly<Record<string, unknown>>) => void;
  } = {},
) {
  const action = String(body.action ?? "");
  const retryable = RETRYABLE_ACTIONS.has(action);
  const requestBody = retryable && !body.actionId
    ? { ...body, actionId: actionUuid(options.cryptoSource) }
    : body;
  const retainedRequest = retryable ? Object.freeze({ ...requestBody }) : undefined;
  if (retainedRequest) options.onRequestPrepared?.(retainedRequest);
  const serializedBody = JSON.stringify(requestBody);
  const requestedActionId = retryable ? String(requestBody.actionId ?? "").toLowerCase() : "";
  const requestedRunId = String(requestBody.expectedRunId ?? "").toLowerCase();
  const requestedRunGeneration = Number(requestBody.expectedRunGeneration);
  const requestedRevision = Number(requestBody.expectedRevision);
  const requestedCode = String(requestBody.code ?? "").trim().toUpperCase();
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
      let parsedPayload: unknown;
      try {
        parsedPayload = await response.json() as unknown;
      } catch (error) {
        if (!response.ok || !ROOM_RESPONSE_ACTIONS.has(action)) throw error;
        if (retryable && attempt + 1 < attempts) continue;
        throw new GameApiError(
          retryable
            ? "The game returned an incomplete action result."
            : "The game returned an incomplete transition result.",
          502,
          "invalid_response",
          undefined,
          retryable ? requestedActionId : undefined,
          retryable ? retainedRequest : undefined,
        );
      }
      const payload = parsedPayload && typeof parsedPayload === "object" && !Array.isArray(parsedPayload)
        ? parsedPayload as GameApiPayload
        : {};
      if (response.ok) {
        if (retryable) {
          const responseActionId = String(payload.action?.id ?? "").toLowerCase();
          const validAudioOutcome = AUDIO_RESPONSE_ACTIONS.has(action)
            ? validAudioControlViewShape(payload.audio)
            : payload.audio === undefined;
          const validActionOutcome = Boolean(
            validTransitionRoom(
              payload.room,
              action,
              requestedCode,
              requestedRunId,
              requestedRunGeneration,
              requestedRevision,
            )
            && payload.action?.accepted === true
            && typeof payload.action.replayed === "boolean"
            && responseActionId === requestedActionId
            && validAudioOutcome,
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
            && (!validTransitionRoom(
              payload.room,
              action,
              requestedCode,
              requestedRunId,
              requestedRunGeneration,
              requestedRevision,
            ) || (payload.audio !== undefined && !validAudioControlViewShape(payload.audio)))) {
          throw new GameApiError(
            "The game returned an incomplete transition result.",
            502,
            "invalid_response",
            payload.correlationId,
          );
        }
        return payload;
      }
      if (retryable && response.status === 503 && payload.code === "database_busy") {
        if (attempt + 1 < attempts) continue;
        throw new GameApiError(
          payload.error ?? "The game is temporarily busy. Retry the same action.",
          response.status,
          "database_busy",
          payload.correlationId,
        );
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
