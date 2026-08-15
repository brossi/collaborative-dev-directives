import { boundedJsonResponse } from "./bounded-json-response.mjs";

export class DiagnosticSourceStateError extends Error {
  constructor(status,code) {
    super(code);
    this.name = "DiagnosticSourceStateError";
    this.status = status;
    this.code = code;
  }
}

export function createDiagnosticSourceStateClient({
  origin = process.env.CANNABEATS_STATE_SERVICE_ORIGIN,
  fetchImpl = fetch,
} = {}) {
  if (!origin) throw new Error("diagnostic_source_state_configuration_invalid");
  const base = new URL(origin).origin;
  return Object.freeze({
    async authority({ authorization,signal }) {
      let response;
      try {
        response = await fetchImpl(`${base}/v1/diagnostics/managed-stream-authority`,{
          method: "POST",signal,cache: "no-store",
          headers: { authorization,"content-type": "application/json" },body: "{}",
        });
        const value = await boundedJsonResponse(response);
        if (!response.ok) throw new DiagnosticSourceStateError(
          response.status,response.status === 403 ? "authentication_required" : "state_unavailable",
        );
        return value;
      } catch (error) {
        if (error instanceof DiagnosticSourceStateError) throw error;
        throw new DiagnosticSourceStateError(503,"state_unavailable");
      }
    },
  });
}
