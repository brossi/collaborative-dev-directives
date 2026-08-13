import { readFileSync } from "node:fs";

const secret = (valueName,fileName) => process.env[valueName]?.trim()
  || (process.env[fileName] ? readFileSync(process.env[fileName],"utf8").trim() : "");

export function stateOperatorConfigured() {
  return Boolean(process.env.CANNABEATS_STATE_SERVICE_ORIGIN);
}

export function createStateOperatorClient({
  origin = process.env.CANNABEATS_STATE_SERVICE_ORIGIN,
  token = secret("CANNABEATS_STATE_OPERATOR_TOKEN","CANNABEATS_STATE_OPERATOR_TOKEN_FILE"),
  fetchImpl = fetch,
} = {}) {
  if (!origin || !token) throw new Error("State operator origin and credential are required.");
  const stateOrigin = new URL(origin).origin;
  async function request(pathname,{ method = "GET",body } = {}) {
    const response = await fetchImpl(`${stateOrigin}${pathname}`,{
      method,headers: { authorization: `Bearer ${token}`,"content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(`State operator request failed with ${payload.code ?? response.status}.`);
    return payload;
  }
  return Object.freeze({
    sources: () => request("/v1/admin/managed-sources"),
    registerSource: (body) => request("/v1/admin/managed-sources",{ method: "POST",body }),
    rotateSource: ({ sourceId,...body }) => request(
      `/v1/admin/managed-sources/${encodeURIComponent(sourceId)}/rotate`,{ method: "POST",body },
    ),
    disableSource: ({ sourceId,...body }) => request(
      `/v1/admin/managed-sources/${encodeURIComponent(sourceId)}/disable`,{ method: "POST",body },
    ),
    validate: () => request("/v1/admin/validate"),
    report: ({ sinceHours = 24 } = {}) => request(
      `/v1/admin/report?sinceHours=${encodeURIComponent(sinceHours)}`,
    ),
  });
}
