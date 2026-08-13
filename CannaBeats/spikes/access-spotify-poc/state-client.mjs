import { createHmac } from "node:crypto";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class StateClientError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

export function createAccessStateClient({
  origin, token, principalAssertionKey, fetchImpl = fetch, clock = Date.now,
}) {
  if (!origin || !token || !principalAssertionKey) {
    throw new Error("Access state-service origin and scoped credentials are required.");
  }
  const stateOrigin = new URL(origin).origin;
  async function request(pathname, { principalId, method = "GET", body } = {}) {
    if (typeof principalId !== "string" || !principalId) {
      throw new Error("A principal is required for an access state request.");
    }
    const now = clock();
    const expiresAt = now + 30_000;
    const claim = `access\ncannabeats-state\naccess\n${principalId}\n${expiresAt}`;
    const response = await fetchImpl(`${stateOrigin}${pathname}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-cannabeats-principal": principalId,
        "x-cannabeats-principal-issuer": "access",
        "x-cannabeats-principal-expires-at": String(expiresAt),
        "x-cannabeats-principal-signature": createHmac("sha256", principalAssertionKey)
          .update(claim).digest("hex"),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new StateClientError(502, "state_response_invalid");
    }
    if (!response.ok) {
      throw new StateClientError(response.status, typeof payload?.code === "string"
        ? payload.code : "state_request_failed");
    }
    return payload;
  }
  return Object.freeze({
    contract: () => fetchImpl(`${stateOrigin}/v1/contract`, { headers: { "cache-control": "no-store" } }),
    createLobby: ({ commandId, code, principalId }) => {
      if (!UUID_PATTERN.test(commandId ?? "")) throw new Error("Lobby command ID must be a canonical UUID.");
      return request("/v1/access/lobbies", {
        principalId, method: "POST", body: { commandId, code },
      });
    },
    addMembership: ({ commandId, code, principalId }) => {
      if (!UUID_PATTERN.test(commandId ?? "")) throw new Error("Membership command ID must be a canonical UUID.");
      return request(`/v1/access/lobbies/${encodeURIComponent(code)}/memberships`, {
        principalId, method: "POST", body: { commandId },
      });
    },
    admit: ({ actionId, code, principalId, name, expectedRunId,
      expectedRunGeneration, expectedRevision }) => {
      if (!UUID_PATTERN.test(actionId ?? "")) throw new Error("Admission action ID must be a canonical UUID.");
      return request(`/v1/lobbies/${encodeURIComponent(code)}/admissions`, {
        principalId, method: "POST", body: {
          actionId, name, expectedRunId, expectedRunGeneration, expectedRevision,
        },
      });
    },
    admissionContext: ({ code, principalId }) => request(
      `/v1/access/lobbies/${encodeURIComponent(code)}/admission-context`, { principalId },
    ),
    lobby: ({ code, principalId }) => request(
      `/v1/access/lobbies/${encodeURIComponent(code)}`, { principalId },
    ),
    lobbies: ({ principalId }) => request("/v1/access/lobbies", { principalId }),
  });
}
