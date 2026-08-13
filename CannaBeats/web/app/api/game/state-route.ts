import { createHash } from "node:crypto";
import type { AudioControlView, RoomView } from "../../../lib/game";
import { createAccessGatewayClient, AccessGatewayError } from "../../../lib/server/access-gateway.mjs";
import { createGameStateClient, StateGatewayError } from "../../../lib/server/state-client.mjs";
import {
  GAME_CLIENT_CONTRACT_HEADER,
  GAME_CLIENT_CONTRACT_VERSION,
} from "../../../lib/game-client-contract.ts";

type Principal = {
  id: string;
  displayName: string;
  role: "host" | "player";
  kind: "account" | "guest";
  sessionCode?: string;
};

const ACTION_MAP = {
  abandon: "abandon_game",
  addPlayer: "add_host_player",
  removePlayer: "remove_player",
  rules: "configure_rules",
  start: "start_game",
  begin: "begin_round",
  place: "place_song",
  retract: "retract_placement",
  reveal: "reveal_answer",
  advance: "advance_round",
  skip: "skip_track",
  audioAcquire: "select_audio",
  audioSelect: "select_audio",
  audioRelease: "release_audio",
  audioControl: "control_audio",
} as const;

function safeFailure(error: unknown) {
  if (error instanceof StateGatewayError || error instanceof AccessGatewayError) {
    const message = error.status === 401 ? "Sign in required."
      : error.status === 403 ? "This action is not permitted."
        : error.status === 404 ? "Game session not found."
          : error.status === 503 ? "The game is temporarily busy."
            : "The game request was not accepted.";
    return Response.json({ error: message, code: error.code }, {
      status: error.status, headers: { "Cache-Control": "no-store" },
    });
  }
  return Response.json({ error: "Unexpected server error", code: "gateway_internal_error" }, {
    status: 500, headers: { "Cache-Control": "no-store" },
  });
}

async function principal(request: Request): Promise<Principal> {
  const result = await createAccessGatewayClient().principal({
    authorization: request.headers.get("authorization") ?? "",
    cookie: request.headers.get("cookie") ?? "",
  });
  return result.principal as Principal;
}

function commandFor(action: keyof typeof ACTION_MAP, payload: Record<string, unknown>) {
  switch (action) {
    case "addPlayer": return { type: ACTION_MAP[action], name: payload.name };
    case "removePlayer": return { type: ACTION_MAP[action], playerId: payload.playerId };
    case "rules": return { type: ACTION_MAP[action], rules: payload.rules };
    case "place": return { type: ACTION_MAP[action], playerId: payload.playerId, index: payload.index };
    case "retract": return { type: ACTION_MAP[action], playerId: payload.playerId };
    case "audioAcquire": return { type: ACTION_MAP[action], mode: "managed" };
    case "audioSelect": return { type: ACTION_MAP[action], mode: payload.mode };
    case "audioControl": return { type: ACTION_MAP[action], kind: payload.command };
    default: return { type: ACTION_MAP[action] };
  }
}

function mutationOriginAccepted(request: Request) {
  if (request.headers.has("authorization")) return true;
  const expected = new URL(process.env.CANNABEATS_APP_ORIGIN ?? request.url).origin;
  const supplied = request.headers.get("origin") ?? "";
  return supplied === expected;
}

function clientContractAccepted(request: Request) {
  return request.headers.get(GAME_CLIENT_CONTRACT_HEADER) === GAME_CLIENT_CONTRACT_VERSION;
}

function clientUpgradeRequired() {
  return Response.json({
    recovery: { outcome: "client_upgrade_required", lobbies: [] },
    error: "Reload after updating CannaBeats to continue.",
    code: "client_upgrade_required",
  }, { status: 426, headers: { "Cache-Control": "no-store" } });
}

function runIdForPrepare(actionId: string) {
  const bytes = Buffer.from(createHash("sha256").update(`prepare:${actionId}`).digest("hex").slice(0, 32), "hex");
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

export async function getStateGame(request: Request) {
  try {
    if (!clientContractAccepted(request)) return clientUpgradeRequired();
    const url = new URL(request.url);
    if (url.searchParams.get("recover") === "1") {
      const access = await createAccessGatewayClient().recoverPrincipal({
        authorization: request.headers.get("authorization") ?? "",
        cookie: request.headers.get("cookie") ?? "",
      });
      if (access.outcome !== "authenticated" || !access.principal) {
        return Response.json({ recovery: { outcome: access.outcome,lobbies: [] } }, {
          headers: { "Cache-Control": "no-store" },
        });
      }
      const actor = access.principal as Principal;
      const responseHeaders = new Headers({ "Cache-Control": "no-store" });
      if (typeof access.sessionCookie === "string" && access.sessionCookie) {
        responseHeaders.set("Set-Cookie",access.sessionCookie);
      }
      const state = createGameStateClient();
      const preferredLobbyCode = url.searchParams.get("preferredLobbyCode")?.trim().toUpperCase();
      const pendingActionLobbyCode = url.searchParams.get("pendingActionLobbyCode")?.trim().toUpperCase();
      const recovery = await state.recover({
        principalId: actor.id,preferredLobbyCode: preferredLobbyCode || undefined,
        pendingActionLobbyCode: pendingActionLobbyCode || undefined,
      });
      if (!["resume","action_reconciliation_required"].includes(recovery.outcome)
          || recovery.lobbies.length !== 1) {
        return Response.json({ recovery }, { headers: responseHeaders });
      }
      const recovered = recovery.lobbies[0];
      const [room,audio] = await Promise.all([
        state.room({ code: recovered.code,principalId: actor.id }),
        state.audio({ code: recovered.code,principalId: actor.id }),
      ]);
      return Response.json({
        recovery,
        session: {
          code: recovered.code,
          ...(recovered.seatPlayerId ? { playerId: recovered.seatPlayerId } : {}),
        },
        room: room.state,
        audio,
      }, { headers: responseHeaders });
    }
    const actor = await principal(request);
    const runId = url.searchParams.get("runId");
    if (runId) {
      const result = await createGameStateClient().history({ runId,principalId: actor.id });
      return Response.json(result, { headers: { "Cache-Control": "no-store" } });
    }
    const code = url.searchParams.get("code")?.trim().toUpperCase() ?? "";
    if (!/^[A-Z2-9]{6}$/.test(code)) {
      return Response.json({ error: "Room code is required.", code: "invalid_request" }, { status: 400 });
    }
    const state = createGameStateClient();
    const [room, audio] = await Promise.all([
      state.room({ code, principalId: actor.id }),
      state.audio({ code, principalId: actor.id }),
    ]);
    if (!room.state) return Response.json({
      error: "The host has not prepared a game for this lobby yet.", code: "state_conflict",
    }, { status: 409 });
    return Response.json({ room: room.state as RoomView, audio: audio as AudioControlView }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return safeFailure(error);
  }
}

export async function postStateGame(request: Request) {
  try {
    if (!clientContractAccepted(request)) return clientUpgradeRequired();
    if (!mutationOriginAccepted(request)) return Response.json({
      error: "Request origin was not accepted.", code: "forbidden",
    }, { status: 403 });
    const payload = await request.json() as Record<string, unknown>;
    const code = String(payload.code ?? "").trim().toUpperCase();
    if (!/^[A-Z2-9]{6}$/.test(code)) return Response.json({
      error: "Game code is invalid.", code: "invalid_request",
    }, { status: 400 });
    const state = createGameStateClient();
    const access = createAccessGatewayClient();
    const action = String(payload.action ?? "");
    const actionId = String(payload.actionId ?? "").toLowerCase();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(actionId)) {
      return Response.json({ error: "Action identity is required.", code: "invalid_request" }, { status: 400 });
    }
    if (action === "guestInvite") {
      const invited = await access.guestInvite({
        authorization: request.headers.get("authorization") ?? "",
        cookie: request.headers.get("cookie") ?? "", actionId, code,
      });
      return Response.json({
        ...invited,
        action: { id: actionId, accepted: true, replayed: Boolean(invited.replayed) },
      });
    }
    if (action === "join" || action === "joinGuest") {
      const joined = await access.admit({
        authorization: request.headers.get("authorization") ?? "",
        cookie: request.headers.get("cookie") ?? "",
        actionId, code, name: payload.name,
        requireInvitation: action === "joinGuest", invite: payload.invite,
      });
      return Response.json({
        room: joined.admission.state,
        playerId: joined.principal.id,
        action: { id: actionId, accepted: true, replayed: Boolean(joined.admission.replayed) },
      }, {
        status: joined.admission.replayed ? 200 : 201,
        headers: {
          "Cache-Control": "no-store",
          ...(joined.sessionCookie ? { "Set-Cookie": joined.sessionCookie } : {}),
        },
      });
    }
    const actor = await principal(request);
    if (action === "prepare") {
      let current = await state.room({ code, principalId: actor.id });
      let created = false;
      let replayed = false;
      const runId = runIdForPrepare(actionId);
      if (!current.state) {
        const createdRun = await state.createRun({
          commandId: actionId, code, runId, rules: payload.rules,
          principalId: actor.id,
        });
        replayed = Boolean(createdRun.replayed);
        current = await state.room({ code, principalId: actor.id });
        created = true;
      } else if (current.runId === runId) {
        const replay = await state.createRun({
          commandId: actionId, code, runId, rules: payload.rules,
          principalId: actor.id,
        });
        replayed = Boolean(replay.replayed);
      }
      const audio = await state.audio({ code, principalId: actor.id });
      const joinOrigin = process.env.CANNABEATS_PUBLIC_GAME_ORIGIN
        ?? `${new URL(request.url).origin}${process.env.NEXT_PUBLIC_CANNABEATS_BASE_PATH ?? ""}`;
      return Response.json({
        room: current.state,
        audio,
        created,
        ...(created ? { joinOrigin } : {}),
        action: { id: actionId, accepted: true, replayed },
      }, { status: created ? 201 : 200 });
    }
    if (action in ACTION_MAP) {
      const result = await state.action({
        actionId,
        code,
        expectedRunId: payload.expectedRunId,
        expectedRunGeneration: payload.expectedRunGeneration,
        expectedRevision: payload.expectedRevision,
        command: commandFor(action as keyof typeof ACTION_MAP, payload),
        principalId: actor.id,
      });
      const returnsAudio = [
        "abandon", "begin", "advance", "skip", "audioAcquire", "audioSelect",
        "audioRelease", "audioControl",
      ].includes(action);
      const audio = returnsAudio ? await state.audio({ code, principalId: actor.id }) : undefined;
      return Response.json({
        room: result.state,
        ...(audio ? { audio } : {}),
        action: { id: actionId, accepted: true, replayed: Boolean(result.replayed) },
      });
    }
    return Response.json({ error: "Unknown action.", code: "invalid_request" }, { status: 400 });
  } catch (error) {
    return safeFailure(error);
  }
}
