import { classifyDiagnosticEvidence } from "../s2e-e3-comparison.mjs";
import { uploadedEnvelopeIdentity } from "../s2e-e2-correlation.mjs";

const MAX_PAGES = 16;
const MAX_REPORTS = 4_096;
const MAX_LISTENERS = 8;
const COHORT_HORIZON_MS = 60_000;
const WINDOW_KINDS = new Set(["listener_window","source_window","relay_window"]);
const ALL_KINDS = new Set([
  "listener_window","listener_transition","source_window","source_transition",
  "relay_window","relay_transition",
]);

export class DiagnosticComparisonError extends Error {
  constructor(status, code) {
    super(code);
    this.name = "DiagnosticComparisonError";
    this.status = status;
    this.code = code;
  }
}

function fail(status, code) {
  throw new DiagnosticComparisonError(status,code);
}

function exact(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== keys.length
    || keys.some((key) => !Object.hasOwn(value,key))) {
    fail(502,"collector_response_invalid");
  }
  return value;
}

function deepFreeze(value) {
  for (const nested of Object.values(value)) {
    if (nested && typeof nested === "object" && !Object.isFrozen(nested)) deepFreeze(nested);
  }
  return Object.freeze(value);
}

function stable(value) {
  return JSON.stringify(value);
}

function intervalEnd(envelope) {
  const value = envelope?.alignment?.mappedEndLatestMs;
  if (!Number.isFinite(value)) fail(502,"collector_response_invalid");
  return value;
}

function partitionKey(envelope) {
  return [
    envelope.serverContext.traceId,envelope.serverContext.correlationSegmentId,
    envelope.serverContext.leaseId,envelope.alignment.sample.timebaseId,
  ].join(":");
}

function newest(left, right) {
  return intervalEnd(left) - intervalEnd(right)
    || left.measurementCore.instanceId.localeCompare(right.measurementCore.instanceId)
    || left.measurementCore.sequence - right.measurementCore.sequence;
}

function selectPair(group, kind) {
  const byInstance = new Map();
  for (const envelope of group.filter((value) => value.measurementCore.kind === kind)) {
    const instanceId = envelope.measurementCore.instanceId;
    const values = byInstance.get(instanceId) ?? [];
    values.push(envelope);
    byInstance.set(instanceId,values);
  }
  const instances = [...byInstance.entries()].map(([instanceId,values]) => ({
    instanceId,values,newest: [...values].sort(newest).at(-1),
  })).sort((left,right) => newest(left.newest,right.newest)
    || left.instanceId.localeCompare(right.instanceId));
  const selected = instances.at(-1);
  if (!selected || selected.values.length < 2) return null;
  const ordered = [...selected.values].sort((left,right) => (
    left.measurementCore.sequence - right.measurementCore.sequence
      || newest(left,right)
  ));
  return Object.freeze({ prior: ordered.at(-2),current: ordered.at(-1) });
}

function selectListeners(group) {
  const latest = new Map();
  for (const envelope of group.filter(
    (value) => value.measurementCore.kind === "listener_window",
  )) {
    const instanceId = envelope.measurementCore.instanceId;
    const retained = latest.get(instanceId);
    if (!retained || newest(retained,envelope) < 0) latest.set(instanceId,envelope);
  }
  const newestEnd = Math.max(...[...latest.values()].map(intervalEnd));
  if (!Number.isFinite(newestEnd)) return [];
  const selected = [...latest.values()].filter(
    (value) => newestEnd - intervalEnd(value) <= COHORT_HORIZON_MS,
  ).sort((left,right) => left.measurementCore.instanceId.localeCompare(
    right.measurementCore.instanceId,
  ));
  return selected.length > MAX_LISTENERS ? selected.slice(0,MAX_LISTENERS + 1) : selected;
}

export function selectDiagnosticEvidence(reports) {
  if (!Array.isArray(reports) || reports.length > MAX_REPORTS) {
    fail(502,"collector_response_invalid");
  }
  const groups = new Map();
  const identities = new Set();
  for (const report of reports) {
    let identity;
    try {
      identity = uploadedEnvelopeIdentity(report);
    } catch {
      fail(502,"collector_response_invalid");
    }
    if (identities.has(identity)) fail(502,"collector_response_invalid");
    identities.add(identity);
    if (!ALL_KINDS.has(report.measurementCore.kind)) fail(502,"collector_response_invalid");
    if (!WINDOW_KINDS.has(report.measurementCore.kind)) continue;
    const key = partitionKey(report);
    const values = groups.get(key) ?? [];
    values.push(report);
    groups.set(key,values);
  }
  if (groups.size === 0) return Object.freeze({ source: null,relay: null,listeners: [] });
  const candidates = [...groups.entries()].map(([key,values]) => {
    const listeners = values.filter(
      (value) => value.measurementCore.kind === "listener_window",
    );
    const newestListener = listeners.length
      ? Math.max(...listeners.map(intervalEnd)) : Number.NEGATIVE_INFINITY;
    const newestWindow = Math.max(...values.map(intervalEnd));
    return { key,values,newestListener,newestWindow };
  }).sort((left,right) => {
    const listenerOrder = left.newestListener - right.newestListener;
    if (listenerOrder) return listenerOrder;
    if (left.newestListener === Number.NEGATIVE_INFINITY) {
      const windowOrder = left.newestWindow - right.newestWindow;
      if (windowOrder) return windowOrder;
    }
    return left.key.localeCompare(right.key);
  });
  const group = candidates.at(-1).values;
  return Object.freeze({
    source: selectPair(group,"source_window"),
    relay: selectPair(group,"relay_window"),
    listeners: Object.freeze(selectListeners(group)),
  });
}

function diagnosisProjection(value) {
  exact(value,["diagnosisVersion","result","confidence","contributing","missing"]);
  const contributing = value.contributing;
  if (!Array.isArray(contributing) || !Array.isArray(value.missing)) {
    fail(502,"collector_response_invalid");
  }
  const interval = contributing.length === 0 ? null : {
    startEarliestMs: Math.min(...contributing.map(
      (item) => item.interval.startEarliestMs,
    )),
    endLatestMs: Math.max(...contributing.map((item) => item.interval.endLatestMs)),
  };
  return deepFreeze({
    result: value.result,confidence: value.confidence,missing: [...value.missing],
    evidenceCount: contributing.length,interval,
  });
}

function traceProjection(trace) {
  exact(trace,["traceId","runId","status","startedAtMs","expiresAtMs","ended"]);
  return deepFreeze({
    traceId: trace.traceId,status: trace.status,startedAtMs: trace.startedAtMs,
    endedAtMs: trace.status === "ended" ? trace.ended?.endedAtMs : null,
  });
}

async function completeSnapshot(readPage, headers, traceId, cancelled) {
  const reports = [];
  const seenCursors = new Set();
  let cursor = null;
  let firstTrace = null;
  let firstMetadata = null;
  for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber += 1) {
    if (cancelled()) fail(408,"request_timeout");
    const page = exact(await readPage({ headers,traceId,cursor }),[
      "trace","status","complete","metadata","reports","cursor",
    ]);
    if (page.status !== "found" || !Array.isArray(page.reports)
      || page.reports.length > 256 || typeof page.complete !== "boolean") {
      fail(502,"collector_response_invalid");
    }
    const pageTrace = stable(page.trace);
    const pageMetadata = stable(page.metadata);
    firstTrace ??= pageTrace;
    firstMetadata ??= pageMetadata;
    if (pageTrace !== firstTrace || pageMetadata !== firstMetadata) {
      fail(502,"collector_response_invalid");
    }
    reports.push(...page.reports);
    if (reports.length > MAX_REPORTS) fail(502,"collector_response_invalid");
    if (page.complete) {
      if (page.cursor !== null || reports.length !== page.metadata.reportCount) {
        fail(502,"collector_response_invalid");
      }
      return { trace: page.trace,metadata: page.metadata,reports };
    }
    if (page.cursor === null) fail(502,"collector_response_invalid");
    const cursorKey = stable(page.cursor);
    if (seenCursors.has(cursorKey)) fail(502,"collector_response_invalid");
    seenCursors.add(cursorKey);
    cursor = page.cursor;
  }
  fail(502,"collector_response_invalid");
}

export function createDiagnosticComparisonService({
  readPage,classify = classifyDiagnosticEvidence,deadlineMs = 2_000,
} = {}) {
  if (typeof readPage !== "function" || typeof classify !== "function"
    || !Number.isSafeInteger(deadlineMs) || deadlineMs < 1) {
    throw new Error("diagnostic_comparison_configuration_invalid");
  }
  async function compare({ headers,traceId }) {
    let timedOut = false;
    let timer;
    const work = (async () => {
      const snapshot = await completeSnapshot(readPage,headers,traceId,() => timedOut);
      if (timedOut) fail(408,"request_timeout");
      const evidence = selectDiagnosticEvidence(snapshot.reports);
      const diagnosis = diagnosisProjection(classify(evidence));
      return deepFreeze({
        comparisonVersion: 1,trace: traceProjection(snapshot.trace),
        reportCount: snapshot.metadata.reportCount,diagnosis,
      });
    })();
    work.catch(() => {});
    const timeout = new Promise((_,reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        reject(new DiagnosticComparisonError(408,"request_timeout"));
      },deadlineMs);
    });
    try {
      return await Promise.race([work,timeout]);
    } finally {
      clearTimeout(timer);
    }
  }
  return Object.freeze({ compare });
}

export const E11_LIMITS = Object.freeze({
  maxPages: MAX_PAGES,maxReports: MAX_REPORTS,maxListeners: MAX_LISTENERS,
  cohortHorizonMs: COHORT_HORIZON_MS,
});
