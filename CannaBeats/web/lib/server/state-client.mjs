import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";

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
} = {}) {
  if (!origin || !token || !principalAssertionKey) {
    throw new Error("Game state-service origin and scoped credentials are required.");
  }
  const stateOrigin = new URL(origin).origin;
  async function request(pathname, { principalId, method = "GET", body } = {}) {
    if (typeof principalId !== "string" || !principalId) {
      throw new Error("A principal is required for a game state request.");
    }
    const expiresAt = clock() + 30_000;
    const claim = `game\ncannabeats-state\ngame\n${principalId}\n${expiresAt}`;
    const response = await fetchImpl(`${stateOrigin}${pathname}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-cannabeats-principal": principalId,
        "x-cannabeats-principal-issuer": "game",
        "x-cannabeats-principal-expires-at": String(expiresAt),
        "x-cannabeats-principal-signature": createHmac("sha256", principalAssertionKey)
          .update(claim).digest("hex"),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      cache: "no-store",
    });
    let payload;
    try {
      payload = await response.json();
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
  });
}
