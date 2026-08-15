import { createAccessGatewayClient } from "./access-gateway.mjs";
import {
  createDiagnosticCollectorClient,DiagnosticCollectorGatewayError,
} from "./diagnostic-collector-client.mjs";
import {
  createDiagnosticMediation,DiagnosticMediationError,
} from "./diagnostic-mediation.mjs";
import { createDiagnosticListenerMediation } from "./diagnostic-listener-mediation.mjs";
import { createGameStateClient,StateGatewayError } from "./state-client.mjs";

const MAX_BODY_BYTES = 8192;
const BODY_DEADLINE_MS = 2000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const decoder = new TextDecoder("utf-8",{ fatal: true });
const BROWSER_FAILURES = new Map([
  ["authentication_required",401],["not_authorized",403],["request_invalid",400],
  ["request_timeout",408],["diagnostic_not_found",404],["request_conflict",409],
  ["trace_busy",409],["read_expired",409],["stale_correlation",409],
  ["trace_inactive",409],["grant_lost",409],["sharing_disabled",409],
  ["source_session_lost",409],["relay_generation_unbound",409],
  ["report_conflict",409],["report_invalid",400],["rate_limited",429],
  ["collector_busy",503],["collector_degraded",503],
  ["quota_exhausted",503],["schema_incompatible",503],
  ["collector_response_invalid",502],["state_response_invalid",502],
  ["collector_unavailable",503],["diagnostic_unavailable",503],
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
    const status = known ? BROWSER_FAILURES.get(error.code) : 503;
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

let productionListenerService = null;

function createProductionListenerService() {
  const collector = () => createDiagnosticCollectorClient();
  const access = {
    principal: (requestHeaders) => createAccessGatewayClient().principal(requestHeaders),
  };
  const state = {
    runMember: (value) => createGameStateClient().diagnosticRunMember(value),
    managedStream: (value) => createGameStateClient().diagnosticManagedStream(value),
  };
  const collectorBoundary = {
    traceContext: (value) => collector().traceContext(value),
    consentReceiptContext: (requestId,operation) => (
      collector().consentReceiptContext(requestId,operation)
    ),
    reportIdentityContext: (value) => collector().reportIdentityContext(value),
    issuanceContext: (sampleId) => collector().issuanceContext(sampleId),
    putIssuance: (value) => collector().putIssuance(value),
    optIn: (value) => collector().optIn(value),
    stopSharing: (value) => collector().stopSharing(value),
    ingestReport: (value) => collector().ingestReport(value),
    endTrace: (value) => collector().endTrace(value),
    rotateSegment: (value) => collector().rotateSegment(value),
  };
  const reconciler = createDiagnosticMediation({
    access,state: {
      runHost: () => { throw new Error("listener_host_authority_forbidden"); },
      managedStream: state.managedStream,
    },collector: collectorBoundary,
  });
  return createDiagnosticListenerMediation({
    access,state,collector: collectorBoundary,reconcile: reconciler.reconcile,
  });
}

export function createDiagnosticListenerRouteHandlers({ mediation,bodyDeadlineMs } = {}) {
  const service = () => mediation ?? (productionListenerService ??= createProductionListenerService());
  const bodyOptions = bodyDeadlineMs ? { deadlineMs: bodyDeadlineMs } : {};

  async function listener(request) {
    try {
      if (!originAccepted(request)) fail(403,"not_authorized");
      const body = await readBody(request,bodyOptions);
      if (body.action === "opt_in") {
        exact(body,["action","requestId","runId","listenerInstanceId",
          "firstAllowedSequence","localConsentStartedMs"]);
        return Response.json(await service().optIn({
          headers: headers(request),requestId: uuid(body.requestId),runId: uuid(body.runId),
          listenerInstanceId: uuid(body.listenerInstanceId),
          firstAllowedSequence: body.firstAllowedSequence,
          localConsentStartedMs: body.localConsentStartedMs,
        }),{ headers: { "Cache-Control": "no-store" } });
      }
      if (body.action === "synchronize") {
        exact(body,["action","requestId","grantId"]);
        return Response.json(await service().synchronize({
          headers: headers(request),requestId: uuid(body.requestId),grantId: uuid(body.grantId),
        }),{ headers: { "Cache-Control": "no-store" } });
      }
      if (body.action === "stop") {
        exact(body,["action","requestId","grantId"]);
        return Response.json(await service().stop({
          headers: headers(request),requestId: uuid(body.requestId),grantId: uuid(body.grantId),
        }),{ headers: { "Cache-Control": "no-store" } });
      }
      fail(400,"request_invalid");
    } catch (error) { return responseError(error); }
  }

  async function listenerReport(request) {
    try {
      if (!originAccepted(request)) fail(403,"not_authorized");
      const body = exact(await readBody(request,bodyOptions),[
        "grantId","measurementCore","sampleObservation",
      ]);
      return Response.json(await service().report({
        headers: headers(request),grantId: uuid(body.grantId),
        measurementCore: body.measurementCore,sampleObservation: body.sampleObservation,
      }),{ headers: { "Cache-Control": "no-store" } });
    } catch (error) { return responseError(error); }
  }

  return Object.freeze({ listener,listenerReport });
}

export {
  exact as exactDiagnosticRequest,
  readBody as readDiagnosticRequestBody,
  responseError as diagnosticRouteErrorResponse,
  uuid as diagnosticRequestUuid,
};
