const response = (body, status = 200) => Response.json(body, {
  status,headers: { "Cache-Control": "no-store" },
});

export const stateAudioSourceConfigured = () =>
  Boolean(process.env.CANNABEATS_STATE_SERVICE_ORIGIN);

export async function postStateAudioSource(request, { fetchImpl = fetch } = {}) {
  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) {
    return response({ error: "Managed source authentication required." },401);
  }
  let payload;
  try { payload = await request.json(); } catch {
    return response({ error: "A JSON request body is required." },400);
  }
  const origin = new URL(process.env.CANNABEATS_STATE_SERVICE_ORIGIN).origin;
  const action = String(payload.action ?? "");
  const stateResponse = action === "poll"
    ? await fetchImpl(`${origin}/v1/source/work`, {
      headers: { authorization,"cache-control": "no-store" },cache: "no-store",
    })
    : await fetchImpl(`${origin}/v1/managed-commands/${encodeURIComponent(String(payload.commandId ?? ""))}/transitions`, {
      method: "POST",headers: { authorization,"content-type": "application/json" },
      body: JSON.stringify({
        requestId: payload.requestId,claimGeneration: payload.claimGeneration,
        action: action === "outcome_unknown" ? "lose_authority"
          : action === "complete" ? (payload.ok === true ? "complete" : "fail") : action,
        outcomeFingerprint: action === "complete" ? {
          ok: payload.ok,playbackStatus: payload.playbackStatus,
          errorCategory: payload.ok === true ? null : payload.error,
        } : null,
        reasonCode: action === "outcome_unknown" ? "game_api_unavailable"
          : action === "complete" && payload.ok !== true ? payload.error : null,
      }),cache: "no-store",
    });
  let statePayload;
  try { statePayload = await stateResponse.json(); } catch {
    return response({ error: "State service returned an invalid response." },502);
  }
  if (!stateResponse.ok) return response({
    error: "Managed source request was not accepted.",
    code: statePayload.code ?? "state_request_failed",
  },stateResponse.status);
  if (action === "poll") return response(statePayload);
  if (action === "complete") return response({
    completed: true,replayed: Boolean(statePayload.replayed),
  });
  return response({
    accepted: true,
    status: action === "outcome_unknown" ? "outcome_unknown" : statePayload.state,
    replayed: Boolean(statePayload.replayed),
  });
}
