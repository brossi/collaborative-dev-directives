import { readFileSync } from "node:fs";

import { restoreUploadedEnvelopeFromTrustedStore } from "../s2e-e2-correlation.mjs";

const TOKEN = /^[!-~]{32,256}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const decoder = new TextDecoder("utf-8",{ fatal: true });
const FAILURE_CODES = new Set([
  "authentication_required","not_authorized","request_timeout","request_invalid",
  "authority_invalid","sample_invalid","alignment_invalid","report_invalid",
  "report_too_large","request_conflict","report_conflict","stale_correlation",
  "sample_expired","read_expired","trace_inactive","sharing_disabled",
  "collector_busy","collector_degraded","quota_exhausted","schema_incompatible",
]);
const REPORT_KINDS = new Set([
  "listener_window","listener_transition","source_window","source_transition",
  "relay_window","relay_transition",
]);
const END_REASONS = new Set([
  "host_stopped","expired","run_replaced","authority_lost",
]);

export class DiagnosticCollectorGatewayError extends Error {
  constructor(status, code) {
    super(code);
    this.name = "DiagnosticCollectorGatewayError";
    this.status = status;
    this.code = code;
  }
}

function fail(status, code) {
  throw new DiagnosticCollectorGatewayError(status,code);
}

function secret() {
  const direct = process.env.CANNABEATS_DIAGNOSTICS_GAME_TOKEN?.trim();
  if (direct) return direct;
  const path = process.env.CANNABEATS_DIAGNOSTICS_GAME_TOKEN_FILE;
  return path ? readFileSync(path,"utf8").trim() : "";
}

function exact(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== keys.length
    || keys.some((key) => !Object.hasOwn(value,key))) fail(502,"collector_response_invalid");
  return value;
}

async function responseBytes(response) {
  if (!response.body) fail(502,"collector_response_invalid");
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done,value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        fail(502,"collector_response_invalid");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk,offset);
    offset += chunk.byteLength;
  }
  return joined;
}

function parsed(bytes) {
  try {
    const value = JSON.parse(decoder.decode(bytes));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      fail(502,"collector_response_invalid");
    }
    return value;
  } catch (error) {
    if (error instanceof DiagnosticCollectorGatewayError) throw error;
    fail(502,"collector_response_invalid");
  }
}

function cursor(value) {
  if (value === null) return null;
  exact(value,["readSessionId","last"]);
  if (!UUID.test(value.readSessionId)) fail(502,"collector_response_invalid");
  exact(value.last,[
    "mappedStartEarliestMs","mappedEndLatestMs","kind","instanceId","sequence",
  ]);
  if (!UUID.test(value.last.instanceId)
    || !REPORT_KINDS.has(value.last.kind)
    || !Number.isSafeInteger(value.last.sequence) || value.last.sequence < 0
    || !Number.isFinite(value.last.mappedStartEarliestMs)
    || !Number.isFinite(value.last.mappedEndLatestMs)) fail(502,"collector_response_invalid");
  return value;
}

function readResult(value) {
  if (["trace_absent","read_expired","collector_busy"].includes(value.status)) {
    exact(value,["status"]);
    return Object.freeze({ status: value.status });
  }
  exact(value,["status","complete","metadata","reports","cursor"]);
  if (value.status !== "found" || typeof value.complete !== "boolean"
    || !Array.isArray(value.reports) || value.reports.length > 256) {
    fail(502,"collector_response_invalid");
  }
  exact(value.metadata,["traceId","status","startedAtMs","endedAtMs","endReason","reportCount"]);
  if (!UUID.test(value.metadata.traceId) || !["active","ended"].includes(value.metadata.status)
    || !Number.isSafeInteger(value.metadata.startedAtMs) || value.metadata.startedAtMs < 0
    || !(value.metadata.endedAtMs === null
      || (Number.isSafeInteger(value.metadata.endedAtMs) && value.metadata.endedAtMs >= 0))
    || !(value.metadata.endReason === null || END_REASONS.has(value.metadata.endReason))
    || (value.metadata.status === "active"
      ? value.metadata.endedAtMs !== null || value.metadata.endReason !== null
      : value.metadata.endedAtMs === null || value.metadata.endReason === null)
    || !Number.isSafeInteger(value.metadata.reportCount) || value.metadata.reportCount < 0) {
    fail(502,"collector_response_invalid");
  }
  if (value.metadata.reportCount > 32_768
    || (value.metadata.status === "ended"
      && value.metadata.endedAtMs < value.metadata.startedAtMs)
    || value.complete !== (value.cursor === null)) fail(502,"collector_response_invalid");
  const reports = value.reports.map((report) => restoreUploadedEnvelopeFromTrustedStore(
    new TextEncoder().encode(JSON.stringify(report)),
  ));
  return Object.freeze({
    status: "found",complete: value.complete,metadata: Object.freeze({ ...value.metadata }),
    reports: Object.freeze(reports),cursor: cursor(value.cursor),
  });
}

export function createDiagnosticCollectorClient({
  origin = process.env.CANNABEATS_DIAGNOSTICS_SERVICE_ORIGIN,
  token = secret(),
  fetchImpl = fetch,
  deadlineMs = 2_000,
} = {}) {
  if (!origin || !TOKEN.test(token) || !Number.isSafeInteger(deadlineMs) || deadlineMs < 1) {
    throw new Error("diagnostic_collector_configuration_invalid");
  }
  const base = new URL(origin).origin;
  async function request(path, body) {
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(),deadlineMs);
    let response;
    try {
      response = await fetchImpl(`${base}${path}`,{
        method: "POST",signal: controller.signal,cache: "no-store",
        headers: { authorization: `Bearer ${token}`,"content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const value = parsed(await responseBytes(response));
      if (!response.ok) {
        const code = FAILURE_CODES.has(value.code) ? value.code : "collector_unavailable";
        throw new DiagnosticCollectorGatewayError(response.status,code);
      }
      return value;
    } catch (error) {
      if (error instanceof DiagnosticCollectorGatewayError) throw error;
      fail(503,"collector_unavailable");
    } finally {
      clearTimeout(deadline);
    }
  }
  return Object.freeze({
    traceContext: (locator) => request("/v1/game/trace/context",locator),
    startReceiptContext: (requestId) => request(
      "/v1/game/trace/start-context",{ requestId },
    ),
    consentReceiptContext: (requestId,operation) => request(
      "/v1/game/consent/receipt-context",{ requestId,operation },
    ),
    relayReceiptContext: (requestId) => request(
      "/v1/game/relay/receipt-context",{ requestId },
    ),
    relayBindingContext: (relayGenerationId) => request(
      "/v1/game/relay/context",{ relayGenerationId },
    ),
    reportIdentityContext: ({ traceId,instanceId,sequence }) => request(
      "/v1/game/report/context",{ traceId,instanceId,sequence },
    ),
    issuanceContext: (sampleId) => request(
      "/v1/game/synchronization/context",{ sampleId },
    ),
    putIssuance: ({ traceId,issuance }) => request(
      "/v1/game/synchronization/issue",{ traceId,issuance },
    ),
    optIn: ({ command,authority }) => request(
      "/v1/game/consent/opt-in",{ command,authority },
    ),
    stopSharing: ({ command,authority }) => request(
      "/v1/game/consent/stop",{ command,authority },
    ),
    bindRelay: ({ command,authority }) => request(
      "/v1/game/relay/bind",{ command,authority },
    ),
    ingestReport: ({ envelope,grantGeneration }) => request(
      "/v1/game/report/ingest",{ envelope,grantGeneration },
    ),
    startTrace: ({ command,authority }) => request(
      "/v1/game/trace/start",{ command,authority },
    ),
    endTrace: ({ command,authority }) => request(
      "/v1/game/trace/end",{ command,authority },
    ),
    rotateSegment: ({ authority }) => request("/v1/game/segment/rotate",{ authority }),
    readTrace: async ({ traceId,cursor: next }) => {
      const value = await request("/v1/game/trace/read",{ traceId,cursor: next });
      try {
        const result = readResult(value);
        if (next === null && result.status === "found" && result.complete
          && result.reports.length !== result.metadata.reportCount) {
          fail(502,"collector_response_invalid");
        }
        return result;
      } catch (error) {
        if (error instanceof DiagnosticCollectorGatewayError) throw error;
        fail(502,"collector_response_invalid");
      }
    },
  });
}
