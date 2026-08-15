import { createAccessGatewayClient } from "./access-gateway.mjs";
import {
  createDiagnosticCollectorClient,DiagnosticCollectorGatewayError,
} from "./diagnostic-collector-client.mjs";
import {
  createDiagnosticMediation,DiagnosticMediationError,
} from "./diagnostic-mediation.mjs";
import { createGameStateClient,StateGatewayError } from "./state-client.mjs";

const MAX_BODY_BYTES = 8192;
const BODY_DEADLINE_MS = 2000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const decoder = new TextDecoder("utf-8",{ fatal: true });
const BROWSER_FAILURES = new Set([
  "authentication_required","not_authorized","request_invalid","request_timeout",
  "diagnostic_not_found","request_conflict","trace_busy","read_expired",
  "stale_correlation","trace_inactive","collector_busy","collector_degraded",
  "quota_exhausted","schema_incompatible","collector_response_invalid",
  "state_response_invalid","collector_unavailable","diagnostic_unavailable",
]);

class DiagnosticRouteError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

function fail(status, code) {
  throw new DiagnosticRouteError(status,code);
}

function exact(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).length !== keys.length
    || keys.some((key) => !Object.hasOwn(value,key))) fail(400,"request_invalid");
  return value;
}

function uuid(value) {
  if (typeof value !== "string" || !UUID.test(value)) fail(400,"request_invalid");
  return value;
}

async function readBody(request, { deadlineMs = BODY_DEADLINE_MS } = {}) {
  if (!request.body) fail(400,"request_invalid");
  const reader = request.body.getReader();
  let timer;
  try {
    const chunks = [];
    let size = 0;
    const timeout = new Promise((_,reject) => {
      timer = setTimeout(() => reject(new DiagnosticRouteError(408,"request_timeout")),deadlineMs);
    });
    while (true) {
      const next = reader.read();
      const { done,value } = await Promise.race([next,timeout]);
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) fail(400,"request_invalid");
      chunks.push(value);
    }
    const joined = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      joined.set(chunk,offset);
      offset += chunk.byteLength;
    }
    const parsed = JSON.parse(decoder.decode(joined));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
      || Object.getPrototypeOf(parsed) !== Object.prototype) fail(400,"request_invalid");
    return parsed;
  } catch (error) {
    if (error instanceof DiagnosticRouteError) throw error;
    fail(400,"request_invalid");
  } finally {
    clearTimeout(timer);
    try { void reader.cancel().catch(() => {}); } catch {}
    reader.releaseLock();
  }
}

function originAccepted(request) {
  if (request.headers.has("authorization")) return true;
  const expected = new URL(process.env.CANNABEATS_APP_ORIGIN ?? request.url).origin;
  return request.headers.get("origin") === expected;
}

function headers(request) {
  return {
    authorization: request.headers.get("authorization") ?? "",
    cookie: request.headers.get("cookie") ?? "",
  };
}

function responseError(error) {
  if (error instanceof DiagnosticMediationError || error instanceof DiagnosticRouteError
    || error instanceof DiagnosticCollectorGatewayError || error instanceof StateGatewayError) {
    const known = BROWSER_FAILURES.has(error.code);
    const status = known && [400,401,403,404,408,409,426,502,503].includes(error.status)
      ? error.status : 503;
    const code = known ? error.code : "diagnostic_unavailable";
    return Response.json({ error: code === "diagnostic_not_found"
      ? "Diagnostic trace not found."
      : code === "authentication_required" ? "Sign in required."
        : "Diagnostics are temporarily unavailable.",code },{
      status,headers: { "Cache-Control": "no-store" },
    });
  }
  return Response.json({
    error: "Diagnostics are temporarily unavailable.",code: "diagnostic_unavailable",
  },{ status: 503,headers: { "Cache-Control": "no-store" } });
}

export function createDiagnosticRouteHandlers({ mediation,bodyDeadlineMs } = {}) {
  const collector = () => createDiagnosticCollectorClient();
  const service = () => mediation ?? createDiagnosticMediation({
      access: {
        principal: (requestHeaders) => createAccessGatewayClient().principal(requestHeaders),
      },
      state: {
        runHost: (value) => createGameStateClient().diagnosticRunHost(value),
        managedStream: (value) => createGameStateClient().diagnosticManagedStream(value),
      },
      collector: {
        traceContext: (value) => collector().traceContext(value),
        startReceiptContext: (value) => collector().startReceiptContext(value),
        startTrace: (value) => collector().startTrace(value),
        endTrace: (value) => collector().endTrace(value),
        rotateSegment: (value) => collector().rotateSegment(value),
        readTrace: (value) => collector().readTrace(value),
      },
    });

  async function trace(request) {
    try {
      if (!originAccepted(request)) fail(403,"not_authorized");
      const body = await readBody(request,{ ...(bodyDeadlineMs ? { deadlineMs: bodyDeadlineMs } : {}) });
      if (body.action === "start") {
        exact(body,["action","requestId","runId"]);
        return Response.json(await service().start({
          headers: headers(request),requestId: uuid(body.requestId),runId: uuid(body.runId),
        }),{ headers: { "Cache-Control": "no-store" } });
      }
      if (body.action === "stop") {
        exact(body,["action","requestId","traceId"]);
        return Response.json(await service().stop({
          headers: headers(request),requestId: uuid(body.requestId),traceId: uuid(body.traceId),
        }),{ headers: { "Cache-Control": "no-store" } });
      }
      if (body.action === "status") {
        exact(body,["action","traceId"]);
        return Response.json(await service().status({
          headers: headers(request),traceId: uuid(body.traceId),
        }),{ headers: { "Cache-Control": "no-store" } });
      }
      fail(400,"request_invalid");
    } catch (error) {
      return responseError(error);
    }
  }

  async function report(request) {
    try {
      if (!originAccepted(request)) fail(403,"not_authorized");
      const body = exact(await readBody(request,{
        ...(bodyDeadlineMs ? { deadlineMs: bodyDeadlineMs } : {}),
      }),["traceId","cursor"]);
      return Response.json(await service().read({
        headers: headers(request),traceId: uuid(body.traceId),cursor: body.cursor,
      }),{ headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      return responseError(error);
    }
  }

  return Object.freeze({ trace,report });
}
