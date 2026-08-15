import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";

import { boundedJsonResponse } from "./bounded-json-response.mjs";

function secret(valueName, fileName) {
  const value = process.env[valueName]?.trim();
  if (value) return value;
  const path = process.env[fileName];
  return path ? readFileSync(path, "utf8").trim() : "";
}

export class StateGatewayError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

export function stateGatewayConfigured() {
  return Boolean(process.env.CANNABEATS_STATE_SERVICE_ORIGIN);
}

export function createGameStateClient({
  origin = process.env.CANNABEATS_STATE_SERVICE_ORIGIN,
  token = secret("CANNABEATS_STATE_GAME_TOKEN", "CANNABEATS_STATE_GAME_TOKEN_FILE"),
  principalAssertionKey = secret(
    "CANNABEATS_STATE_GAME_PRINCIPAL_ASSERTION_KEY",
    "CANNABEATS_STATE_GAME_PRINCIPAL_ASSERTION_KEY_FILE",
  ),
  fetchImpl = fetch,
  clock = Date.now,
  maxResponseBytes = 1024 * 1024,
} = {}) {
  if (!origin || !token || !principalAssertionKey) {
    throw new Error("Game state-service origin and scoped credentials are required.");
  }
  const stateOrigin = new URL(origin).origin;
  async function request(pathname, {
    principalId,method = "GET",body,signal,requirePrincipal = true,
  } = {}) {
    if (requirePrincipal && (typeof principalId !== "string" || !principalId)) {
      throw new Error("A principal is required for a game state request.");
    }
    const expiresAt = requirePrincipal ? clock() + 30_000 : null;
    const claim = requirePrincipal
      ? `game\ncannabeats-state\ngame\n${principalId}\n${expiresAt}` : null;
    const response = await fetchImpl(`${stateOrigin}${pathname}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...(requirePrincipal ? {
          "x-cannabeats-principal": principalId,
          "x-cannabeats-principal-issuer": "game",
          "x-cannabeats-principal-expires-at": String(expiresAt),
          "x-cannabeats-principal-signature": createHmac("sha256", principalAssertionKey)
            .update(claim).digest("hex"),
        } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(signal ? { signal } : {}),
      cache: "no-store",
    });
    let payload;
    try {
      payload = await boundedJsonResponse(response,maxResponseBytes);
    } catch {
      throw new StateGatewayError(502, "state_response_invalid");
    }
    if (!response.ok) throw new StateGatewayError(
      response.status,
      typeof payload?.code === "string" ? payload.code : "state_request_failed",
    );
    return payload;
  }
  return Object.freeze({
    recover: ({ principalId, preferredLobbyCode, pendingActionLobbyCode }) => {
      const query = new URLSearchParams();
      if (preferredLobbyCode) query.set("preferredLobbyCode",preferredLobbyCode);
      if (pendingActionLobbyCode) query.set("pendingActionLobbyCode",pendingActionLobbyCode);
      return request(`/v1/recovery${query.size ? `?${query}` : ""}`,{ principalId });
    },
    room: ({ code, principalId }) => request(`/v1/lobbies/${encodeURIComponent(code)}`, { principalId }),
    audio: ({ code, principalId }) => request(
      `/v1/lobbies/${encodeURIComponent(code)}/audio`, { principalId },
    ),
    history: ({ runId, principalId }) => request(
      `/v1/history/${encodeURIComponent(runId)}`, { principalId },
    ),
    createRun: ({ commandId, code, runId, rules, principalId }) => request(
      `/v1/lobbies/${encodeURIComponent(code)}/runs`, {
        principalId, method: "POST", body: { commandId, runId, rules },
      },
    ),
    action: ({ actionId, code, expectedRunId, expectedRunGeneration,
      expectedRevision, command, principalId }) => request(
      `/v1/lobbies/${encodeURIComponent(code)}/actions`, {
        principalId, method: "POST",
        body: { actionId, expectedRunId, expectedRunGeneration, expectedRevision, command },
      },
    ),
    diagnosticRunHost: ({ runId,principalId,signal }) => request(
      "/v1/diagnostics/run-host-authority",{
        principalId,method: "POST",body: { runId },signal,
      },
    ),
    diagnosticRunMember: ({ runId,principalId,signal }) => request(
      "/v1/diagnostics/run-member-authority",{
        method: "POST",principalId,body: { runId },signal,
      },
    ),
    diagnosticManagedStream: ({ signal } = {}) => request(
      "/v1/diagnostics/managed-stream-authority",{
        method: "POST",body: {},signal,requirePrincipal: false,
      },
    ),
  });
}
