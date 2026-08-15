import { createHash } from "node:crypto";

import {
  canonicalE2OperationCommandBytes,
  canonicalTraceStateBytes,
  restoreE2OperationReceiptFromTrustedStore,
  restoreTraceStateFromTrustedStore,
  validateE2OperationCommandJson,
  validateOperationAuthorityJson,
} from "../s2e-e2-correlation.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const encoder = new TextEncoder();

export class DiagnosticMediationError extends Error {
  constructor(status, code) {
    super(code);
    this.name = "DiagnosticMediationError";
    this.status = status;
    this.code = code;
  }
}

function fail(status, code) {
  throw new DiagnosticMediationError(status,code);
}

function exactUuid(value) {
  if (typeof value !== "string" || !UUID.test(value)) fail(400,"request_invalid");
  return value;
}

function bytes(value) {
  return encoder.encode(JSON.stringify(value));
}

export function deriveDiagnosticUuid(label, ...parts) {
  if (!["trace","initial-segment","automatic-end","replacement-segment"].includes(label)
    || parts.length === 0 || parts.some((part) => typeof part !== "string" || !part)) {
    fail(400,"request_invalid");
  }
  const digest = Buffer.from(createHash("sha256")
    .update(`cannabeats:s2e:e8:v1:${label}:${parts.join(":")}`).digest()).subarray(0,16);
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = digest.toString("hex");
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

function command(value) {
  return validateE2OperationCommandJson(bytes(value));
}

function authority(value) {
  return validateOperationAuthorityJson(bytes(value));
}

function restoreTrace(value) {
  try {
    return restoreTraceStateFromTrustedStore(bytes(value));
  } catch {
    fail(502,"collector_response_invalid");
  }
}

function restoreReceipt(value) {
  try {
    return restoreE2OperationReceiptFromTrustedStore(bytes(value));
  } catch {
    fail(502,"collector_response_invalid");
  }
}

function sameBytes(left,right) {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function relatedReceipt(result,submittedCommand,state) {
  const receipt = restoreReceipt(result?.receipt);
  if (receipt.requestId !== submittedCommand.requestId
    || receipt.operation !== submittedCommand.operation
    || !sameBytes(canonicalE2OperationCommandBytes(receipt.canonicalCommand),
      canonicalE2OperationCommandBytes(submittedCommand))
    || !sameBytes(canonicalTraceStateBytes(receipt.result),canonicalTraceStateBytes(state))) {
    fail(502,"collector_response_invalid");
  }
  return receipt;
}

function traceProjection(state) {
  return Object.freeze({
    traceId: state.traceId,runId: state.runId,status: state.status,
    startedAtMs: state.startedAtMs,expiresAtMs: state.expiresAtMs,ended: state.ended,
  });
}

function relatedTrace(trace, expected) {
  for (const key of ["traceId","runId","runGeneration","status","startedAtMs","expiresAtMs"]) {
    if (Object.hasOwn(expected,key) && trace?.[key] !== expected[key]) {
      fail(502,"collector_response_invalid");
    }
  }
  if (Object.hasOwn(expected,"segmentId") && trace?.segment?.segmentId !== expected.segmentId) {
    fail(502,"collector_response_invalid");
  }
  if (Object.hasOwn(expected,"leaseId") && trace?.segment?.leaseId !== expected.leaseId) {
    fail(502,"collector_response_invalid");
  }
  if (Object.hasOwn(expected,"segmentStartedAtMs")
    && trace?.segment?.startedAtMs !== expected.segmentStartedAtMs) {
    fail(502,"collector_response_invalid");
  }
  if (Object.hasOwn(expected,"endReason")
    && trace?.ended?.reason !== expected.endReason) fail(502,"collector_response_invalid");
  if (Object.hasOwn(expected,"endedAtMs")
    && trace?.ended?.endedAtMs !== expected.endedAtMs) fail(502,"collector_response_invalid");
  return trace;
}

function relatedRead(result, trace) {
  const metadata = result?.metadata;
  const endedAtMs = trace.status === "ended" ? trace.ended.endedAtMs : null;
  const endReason = trace.status === "ended" ? trace.ended.reason : null;
  if (!metadata || metadata.traceId !== trace.traceId || metadata.status !== trace.status
    || metadata.startedAtMs !== trace.startedAtMs || metadata.endedAtMs !== endedAtMs
    || metadata.endReason !== endReason
    || result.reports.some((report) => report.serverContext.traceId !== trace.traceId
      || report.serverContext.runId !== trace.runId
      || report.serverContext.runGeneration !== trace.runGeneration)) {
    fail(502,"collector_response_invalid");
  }
  return result;
}

function exactHost(value, runId) {
  if (!value || value.authorityVersion !== 1 || value.runId !== runId
    || !["active","ended"].includes(value.status)
    || !Number.isSafeInteger(value.runGeneration) || value.runGeneration < 1
    || value.isHost !== true || Object.keys(value).length !== 5) {
    fail(502,"state_response_invalid");
  }
  return value;
}

function exactStream(value) {
  if (!value || value.authorityVersion !== 1 || !["active","absent"].includes(value.status)) {
    fail(502,"state_response_invalid");
  }
  if (value.status === "absent") {
    if (Object.keys(value).length !== 2) fail(502,"state_response_invalid");
    return value;
  }
  if (Object.keys(value).length !== 7 || !UUID.test(value.runId)
    || !UUID.test(value.leaseId) || !UUID.test(value.sourceId)
    || !Number.isSafeInteger(value.runGeneration) || value.runGeneration < 1
    || !Number.isSafeInteger(value.leaseExpiresAt) || value.leaseExpiresAt < 0) {
    fail(502,"state_response_invalid");
  }
  return value;
}

function collectorContext(value, payloadKey = "state") {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(502,"collector_response_invalid");
  }
  if (value.status === "trace_absent" && Object.keys(value).length === 1) return value;
  if (value.status === "found" && Object.keys(value).length === 2
    && Object.hasOwn(value,payloadKey)) return value;
  fail(502,"collector_response_invalid");
}

function exactPrincipal(value) {
  const principal = value?.principal;
  if (!principal || typeof principal.id !== "string" || !principal.id) {
    fail(503,"diagnostic_unavailable");
  }
  return principal;
}

export function createDiagnosticMediation({
  access,state,collector,clock = Date.now,deadlineMs = 2_000,
} = {}) {
  if (!access || !state || !collector || typeof clock !== "function"
    || !Number.isSafeInteger(deadlineMs) || deadlineMs < 1) {
    throw new Error("diagnostic_mediation_configuration_invalid");
  }

  async function bounded(operation) {
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(),deadlineMs);
    try {
      return await operation(controller.signal);
    } catch (error) {
      if (error instanceof DiagnosticMediationError) throw error;
      if (Number.isInteger(error?.status)) throw error;
      fail(503,"diagnostic_unavailable");
    } finally {
      clearTimeout(deadline);
    }
  }

  async function principal(headers) {
    let principal;
    try {
      principal = exactPrincipal(await bounded((signal) => access.principal({ ...headers,signal })));
    } catch (error) {
      if (error instanceof DiagnosticMediationError) throw error;
      if (error?.status === 401 || error?.status === 403) fail(401,"authentication_required");
      fail(503,"diagnostic_unavailable");
    }
    return principal;
  }

  async function principalHost(principalValue, runId) {
    try {
      return exactHost(await bounded((signal) => state.runHost({
        runId,principalId: principalValue.id,signal,
      })),runId);
    } catch (error) {
      if (error instanceof DiagnosticMediationError) throw error;
      if ([403,404].includes(error?.status)) fail(404,"diagnostic_not_found");
      fail(503,"diagnostic_unavailable");
    }
  }

  async function host(headers, runId) {
    return principalHost(await principal(headers),runId);
  }

  async function currentStream() {
    try {
      return exactStream(await bounded((signal) => state.managedStream({ signal })));
    } catch (error) {
      if (error instanceof DiagnosticMediationError) throw error;
      fail(503,"diagnostic_unavailable");
    }
  }

  async function automaticEnd(trace, reason) {
    const requestId = deriveDiagnosticUuid("automatic-end",trace.traceId,reason);
    const endCommand = command({ requestId,operation: "trace_end",parameters: {} });
    const nowMs = clock();
    const result = await collector.endTrace({
      command: endCommand,
      authority: authority({
        authorityVersion: 1,operation: "trace_end",nowMs,
        traceId: trace.traceId,reason,
      }),
    });
    const ended = relatedTrace(restoreTrace(result?.state),{
      traceId: trace.traceId,runId: trace.runId,runGeneration: trace.runGeneration,
      status: "ended",startedAtMs: trace.startedAtMs,expiresAtMs: trace.expiresAtMs,
      segmentId: trace.segment.segmentId,leaseId: trace.segment.leaseId,
      segmentStartedAtMs: trace.segment.startedAtMs,endReason: reason,
      ...(result?.status === "accepted" ? { endedAtMs: nowMs } : {}),
    });
    if (!["accepted","replayed"].includes(result?.status)) {
      fail(502,"collector_response_invalid");
    }
    relatedReceipt(result,endCommand,ended);
    return ended;
  }

  async function reconcile(activeTrace = null, stream = null) {
    let trace = activeTrace;
    if (trace === null) {
      const found = collectorContext(await collector.traceContext({ active: true }));
      if (found.status === "trace_absent") return null;
      trace = restoreTrace(found.state);
    }
    if (trace.status !== "active") return trace;
    const current = stream ?? await currentStream();
    if (current.status === "absent") {
      return automaticEnd(trace,"authority_lost");
    }
    if (current.runId !== trace.runId || current.runGeneration !== trace.runGeneration) {
      return automaticEnd(trace,"run_replaced");
    }
    if (current.leaseId === trace.segment.leaseId) return trace;
    const issuedSegmentId = deriveDiagnosticUuid(
      "replacement-segment",trace.traceId,trace.segment.leaseId,current.leaseId,
    );
    const nowMs = clock();
    const rotated = await collector.rotateSegment({ authority: authority({
      authorityVersion: 1,operation: "segment_rotate",nowMs,traceId: trace.traceId,
      priorLeaseId: trace.segment.leaseId,leaseId: current.leaseId,issuedSegmentId,
    }) });
    const state = relatedTrace(restoreTrace(rotated?.state),{
      traceId: trace.traceId,runId: trace.runId,runGeneration: trace.runGeneration,
      status: "active",startedAtMs: trace.startedAtMs,expiresAtMs: trace.expiresAtMs,
      leaseId: current.leaseId,segmentId: issuedSegmentId,segmentStartedAtMs: nowMs,
    });
    if (rotated?.status !== "accepted") fail(502,"collector_response_invalid");
    return state;
  }

  async function start({ headers,requestId,runId }) {
    exactUuid(requestId);
    exactUuid(runId);
    const hostAuthority = await host(headers,runId);
    const traceId = deriveDiagnosticUuid("trace",requestId);
    const initialSegmentId = deriveDiagnosticUuid("initial-segment",requestId);
    const retained = collectorContext(await collector.startReceiptContext(requestId),"receipt");
    if (retained.status === "found") {
      const receipt = restoreReceipt(retained.receipt);
      if (receipt.operation !== "trace_start" || receipt.requestId !== requestId
        || receipt.result.traceId !== traceId || receipt.result.runId !== runId
        || receipt.result.segment.segmentId !== initialSegmentId) {
        fail(409,"request_conflict");
      }
      const replayTrace = relatedTrace(receipt.result,{
        traceId,runId,runGeneration: hostAuthority.runGeneration,status: "active",
        segmentId: initialSegmentId,
      });
      return traceProjection(replayTrace);
    }
    if (retained.status !== "trace_absent") fail(502,"collector_response_invalid");
    if (hostAuthority.status !== "active") fail(404,"diagnostic_not_found");
    const stream = await currentStream();
    if (stream.status !== "active" || stream.runId !== runId
      || stream.runGeneration !== hostAuthority.runGeneration) {
      fail(404,"diagnostic_not_found");
    }
    await reconcile(null,stream);
    const startCommand = command({ requestId,operation: "trace_start",parameters: {} });
    const nowMs = clock();
    const result = await collector.startTrace({
      command: startCommand,
      authority: authority({
        authorityVersion: 1,operation: "trace_start",nowMs,isHost: true,
        runId,runGeneration: hostAuthority.runGeneration,leaseId: stream.leaseId,
        issuedTraceId: traceId,issuedSegmentId: initialSegmentId,
      }),
    });
    if (result.status === "trace_busy") fail(409,"trace_busy");
    if (!["accepted","replayed"].includes(result.status)) {
      fail(502,"collector_response_invalid");
    }
    const trace = relatedTrace(restoreTrace(result.state),{
      traceId,runId,runGeneration: hostAuthority.runGeneration,status: "active",
      leaseId: stream.leaseId,segmentId: initialSegmentId,
      ...(result.status === "accepted" ? {
        startedAtMs: nowMs,expiresAtMs: nowMs + 21_600_000,segmentStartedAtMs: nowMs,
      } : {}),
    });
    relatedReceipt(result,startCommand,trace);
    return traceProjection(trace);
  }

  async function traceForHost(headers, traceId, { reconcileActive = true } = {}) {
    exactUuid(traceId);
    const principalValue = await principal(headers);
    const found = collectorContext(await collector.traceContext({ traceId }));
    if (found.status === "trace_absent") fail(404,"diagnostic_not_found");
    if (found.status !== "found") fail(502,"collector_response_invalid");
    let trace = relatedTrace(restoreTrace(found.state),{ traceId });
    await principalHost(principalValue,trace.runId);
    if (reconcileActive && trace.status === "active") trace = await reconcile(trace);
    return trace;
  }

  async function stop({ headers,requestId,traceId }) {
    exactUuid(requestId);
    let trace = await traceForHost(headers,traceId,{ reconcileActive: false });
    const stopCommand = command({ requestId,operation: "trace_end",parameters: {} });
    try {
      const nowMs = clock();
      const result = await collector.endTrace({
        command: stopCommand,
        authority: authority({
          authorityVersion: 1,operation: "trace_end",nowMs,
          traceId,reason: "host_stopped",
        }),
      });
      trace = relatedTrace(restoreTrace(result.state),{
        traceId,runId: trace.runId,runGeneration: trace.runGeneration,status: "ended",
        startedAtMs: trace.startedAtMs,expiresAtMs: trace.expiresAtMs,
        segmentId: trace.segment.segmentId,leaseId: trace.segment.leaseId,
        segmentStartedAtMs: trace.segment.startedAtMs,endReason: "host_stopped",
        ...(result?.status === "accepted" ? { endedAtMs: nowMs } : {}),
      });
      if (!["accepted","replayed"].includes(result.status)) {
        fail(502,"collector_response_invalid");
      }
      relatedReceipt(result,stopCommand,trace);
    } catch (error) {
      if (!["stale_correlation","trace_inactive"].includes(error?.code)) {
        throw error;
      }
      const found = collectorContext(await collector.traceContext({ traceId }));
      if (found.status !== "found") throw error;
      const refreshed = relatedTrace(restoreTrace(found.state),{
        traceId,runId: trace.runId,runGeneration: trace.runGeneration,
        startedAtMs: trace.startedAtMs,expiresAtMs: trace.expiresAtMs,
        segmentId: trace.segment.segmentId,leaseId: trace.segment.leaseId,
        segmentStartedAtMs: trace.segment.startedAtMs,
      });
      if (refreshed.status !== "ended") throw error;
      trace = refreshed;
    }
    return traceProjection(trace);
  }

  async function status({ headers,traceId }) {
    return traceProjection(await traceForHost(headers,traceId));
  }

  async function read({ headers,traceId,cursor }) {
    const trace = await traceForHost(headers,traceId);
    const result = await collector.readTrace({ traceId,cursor });
    if (result.status === "trace_absent") fail(404,"diagnostic_not_found");
    if (result.status === "read_expired") fail(409,"read_expired");
    if (result.status === "collector_busy") fail(503,"collector_busy");
    if (result.status !== "found") fail(502,"collector_response_invalid");
    return Object.freeze({ trace: traceProjection(trace),...relatedRead(result,trace) });
  }

  return Object.freeze({ start,stop,status,read,reconcile });
}
