import { readFileSync } from "node:fs";

function gameServiceToken() {
  const direct = process.env.CANNABEATS_GAME_SERVICE_TOKEN?.trim();
  if (direct) return direct;
  const path = process.env.CANNABEATS_GAME_SERVICE_TOKEN_FILE;
  return path ? readFileSync(path, "utf8").trim() : "";
}

export class AccessGatewayError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

export function accessGatewayConfigured() {
  return Boolean(process.env.CANNABEATS_ACCESS_SERVICE_INTERNAL_ORIGIN);
}

export function createAccessGatewayClient({
  origin = process.env.CANNABEATS_ACCESS_SERVICE_INTERNAL_ORIGIN,
  token = gameServiceToken(),
  fetchImpl = fetch,
} = {}) {
  if (!origin || !token) throw new Error("Access gateway origin and game credential are required.");
  const accessOrigin = new URL(origin).origin;
  async function request(pathname, body) {
    const response = await fetchImpl(`${accessOrigin}${pathname}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-cannabeats-internal-token": token,
      },
      body: JSON.stringify(body),
      cache: "no-store",
    });
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new AccessGatewayError(502, "access_response_invalid");
    }
    if (!response.ok) throw new AccessGatewayError(
      response.status,
      typeof payload?.code === "string" ? payload.code : "access_request_failed",
    );
    return payload;
  }
  return Object.freeze({
    principal: ({ authorization, cookie }) => request("/api/internal/game/principal", {
      authorization: authorization ?? "", cookie: cookie ?? "",
    }),
    recoverPrincipal: ({ authorization, cookie, pendingActionLobbyCode }) => request(
      "/api/internal/game/recover-principal", {
        authorization: authorization ?? "",cookie: cookie ?? "",
        ...(pendingActionLobbyCode ? { pendingActionLobbyCode } : {}),
      }),
    guestInvite: ({ authorization, cookie, actionId, code }) => request("/api/internal/game/guest-invite", {
      authorization: authorization ?? "", cookie: cookie ?? "", actionId, code,
    }),
    admit: ({ authorization, cookie, ...admission }) => request("/api/internal/game/admit", {
      authorization: authorization ?? "", cookie: cookie ?? "", ...admission,
    }),
    desktopHandoff: ({ ticket }) => request("/api/internal/game/desktop-handoff", { ticket }),
  });
}
