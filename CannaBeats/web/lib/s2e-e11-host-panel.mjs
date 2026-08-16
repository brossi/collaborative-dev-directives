const STORAGE_KEY = "cannabeats:s2e:e11:host-trace:v1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_RESPONSE_BYTES = 16_384;
const RESULTS = new Set([
  "source_suspected","relay_suspected","listener_delivery_suspected",
  "listener_buffer_suspected","browser_output_suspected","insufficient_evidence",
]);
const CONFIDENCE = new Set(["high","medium","insufficient"]);
const MISSING = new Set([
  "source","relay","listener","trace_mismatch","segment_mismatch",
  "timebase_mismatch","duplicate_listener","invalid_pair","ordering_overlap",
  "unknown_state","contradictory_evidence","no_anomaly",
]);
const END_REASONS = new Set(["host_stopped","expired","run_replaced","authority_lost"]);
const FINITE_CODES = new Set([
  "authentication_required","not_authorized","request_invalid","request_timeout",
  "diagnostic_not_found","request_conflict","trace_busy","read_expired",
  "stale_correlation","trace_inactive","grant_lost","sharing_disabled",
  "source_session_lost","relay_generation_unbound","report_conflict",
  "report_invalid","rate_limited",
  "collector_busy","collector_degraded","quota_exhausted","schema_incompatible",
  "collector_response_invalid","state_response_invalid","collector_unavailable",
  "diagnostic_unavailable",
]);
const CODE_STATUS = new Map([
  ["authentication_required",401],["not_authorized",403],["request_invalid",400],
  ["request_timeout",408],["diagnostic_not_found",404],["request_conflict",409],
  ["trace_busy",409],["read_expired",409],["stale_correlation",409],
  ["trace_inactive",409],["grant_lost",409],["sharing_disabled",409],
  ["source_session_lost",409],["relay_generation_unbound",409],
  ["report_conflict",409],["report_invalid",400],["rate_limited",429],
  ["collector_busy",503],
  ["collector_degraded",503],["quota_exhausted",503],["schema_incompatible",503],
  ["collector_response_invalid",502],["state_response_invalid",502],
  ["collector_unavailable",503],["diagnostic_unavailable",503],
]);
const decoder = new TextDecoder("utf-8",{ fatal: true });

export class E11HostPanelError extends Error {
  constructor(code) {
    super(FINITE_CODES.has(code) ? code : "diagnostic_unavailable");
    this.name = "E11HostPanelError";
    this.code = this.message;
  }
}

function fail(code) {
  throw new E11HostPanelError(code);
}

function exact(value, keys, code = "collector_response_invalid") {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== keys.length
    || keys.some((key) => !Object.hasOwn(value,key))) fail(code);
  return value;
}

function uuid(value, code = "collector_response_invalid") {
  if (typeof value !== "string" || !UUID.test(value)) fail(code);
  return value;
}

function safe(value, { nullable = false } = {}) {
  if (nullable && value === null) return value;
  if (!Number.isSafeInteger(value) || value < 0) fail("collector_response_invalid");
  return value;
}

function freeze(value) {
  for (const nested of Object.values(value)) {
    if (nested && typeof nested === "object" && !Object.isFrozen(nested)) freeze(nested);
  }
  return Object.freeze(value);
}

function trace(value, expectedRunId) {
  exact(value,["traceId","runId","status","startedAtMs","expiresAtMs","ended"]);
  uuid(value.traceId);
  if (value.runId !== expectedRunId || !["active","ended"].includes(value.status)) {
    fail("collector_response_invalid");
  }
  safe(value.startedAtMs);
  safe(value.expiresAtMs);
  if (value.status === "active") {
    if (value.ended !== null) fail("collector_response_invalid");
  } else {
    exact(value.ended,["status","endedAtMs","reason"]);
    if (value.ended.status !== "ended" || !END_REASONS.has(value.ended.reason)) {
      fail("collector_response_invalid");
    }
    safe(value.ended.endedAtMs);
    if (value.ended.endedAtMs < value.startedAtMs
      || value.ended.endedAtMs > value.expiresAtMs) fail("collector_response_invalid");
  }
  return freeze({ ...value,ended: value.ended && { ...value.ended } });
}

function comparison(value, expectedTraceId) {
  exact(value,["comparisonVersion","trace","reportCount","diagnosis"]);
  if (value.comparisonVersion !== 1) fail("collector_response_invalid");
  exact(value.trace,["traceId","status","startedAtMs","endedAtMs"]);
  if (value.trace.traceId !== expectedTraceId
    || !["active","ended"].includes(value.trace.status)) fail("collector_response_invalid");
  safe(value.trace.startedAtMs);
  safe(value.trace.endedAtMs,{ nullable: true });
  if ((value.trace.status === "active") !== (value.trace.endedAtMs === null)) {
    fail("collector_response_invalid");
  }
  if (value.trace.endedAtMs !== null
    && value.trace.endedAtMs < value.trace.startedAtMs) fail("collector_response_invalid");
  if (safe(value.reportCount) > 4_096) fail("collector_response_invalid");
  exact(value.diagnosis,["result","confidence","missing","evidenceCount","interval"]);
  if (!RESULTS.has(value.diagnosis.result) || !CONFIDENCE.has(value.diagnosis.confidence)
    || !Array.isArray(value.diagnosis.missing)
    || value.diagnosis.missing.some((item) => !MISSING.has(item))
    || new Set(value.diagnosis.missing).size !== value.diagnosis.missing.length
    || [...value.diagnosis.missing].sort().some(
      (item,index) => item !== value.diagnosis.missing[index])) {
    fail("collector_response_invalid");
  }
  if (safe(value.diagnosis.evidenceCount) > 12) fail("collector_response_invalid");
  const insufficient = value.diagnosis.result === "insufficient_evidence";
  if (insufficient !== (value.diagnosis.confidence === "insufficient")
    || insufficient !== (value.diagnosis.missing.length > 0)) {
    fail("collector_response_invalid");
  }
  if (["source_suspected","relay_suspected"].includes(value.diagnosis.result)
      !== (value.diagnosis.confidence === "high")) fail("collector_response_invalid");
  if (value.diagnosis.interval !== null) {
    exact(value.diagnosis.interval,["startEarliestMs","endLatestMs"]);
    if (!Number.isFinite(value.diagnosis.interval.startEarliestMs)
      || !Number.isFinite(value.diagnosis.interval.endLatestMs)
      || value.diagnosis.interval.endLatestMs < value.diagnosis.interval.startEarliestMs) {
      fail("collector_response_invalid");
    }
  }
  if ((value.diagnosis.interval === null) !== (value.diagnosis.evidenceCount === 0)) {
    fail("collector_response_invalid");
  }
  return freeze({
    comparisonVersion: 1,trace: { ...value.trace },reportCount: value.reportCount,
    diagnosis: { ...value.diagnosis,missing: [...value.diagnosis.missing],
      interval: value.diagnosis.interval && { ...value.diagnosis.interval } },
  });
}

async function responseBytes(response) {
  if (!response.body) fail("diagnostic_unavailable");
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
        fail("diagnostic_unavailable");
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

async function parsedResponse(response) {
  let value;
  try {
    value = JSON.parse(decoder.decode(await responseBytes(response)));
  } catch (error) {
    if (error instanceof E11HostPanelError) throw error;
    fail("diagnostic_unavailable");
  }
  if (!response.ok) {
    exact(value,["error","code"],"diagnostic_unavailable");
    if (!FINITE_CODES.has(value.code) || CODE_STATUS.get(value.code) !== response.status) {
      fail("diagnostic_unavailable");
    }
    fail(value.code);
  }
  return value;
}

export function createE11HostTransport({
  fetchImpl = fetch,traceUrl = "/api/diagnostics/trace",
  comparisonUrl = "/api/diagnostics/comparison",deadlineMs = 5_000,
} = {}) {
  if (typeof fetchImpl !== "function" || !Number.isSafeInteger(deadlineMs)
    || deadlineMs < 1) throw new Error("e11_transport_configuration_invalid");
  async function post(url,body,{ signal } = {}) {
    let response;
    let timedOut = false;
    const controller = new AbortController();
    const relayAbort = () => controller.abort();
    signal?.addEventListener("abort",relayAbort,{ once: true });
    const deadline = setTimeout(() => { timedOut = true; controller.abort(); },deadlineMs);
    try {
      response = await fetchImpl(url,{ method: "POST",headers: {
        "Content-Type": "application/json",
      },body: JSON.stringify(body),signal: controller.signal });
    } catch {
      fail(timedOut ? "request_timeout" : "diagnostic_unavailable");
    } finally {
      clearTimeout(deadline);
      signal?.removeEventListener("abort",relayAbort);
    }
    return parsedResponse(response);
  }
  return Object.freeze({
    start: (runId,requestId) => post(traceUrl,{ action: "start",runId,requestId }),
    stop: (traceId,requestId) => post(traceUrl,{ action: "stop",traceId,requestId }),
    compare: (traceId,signal) => post(comparisonUrl,{ traceId },{ signal }),
  });
}

function stored(value) {
  exact(value,["version","runId","startRequestId","trace","stopRequestId"],"request_invalid");
  if (value.version !== 1) fail("request_invalid");
  uuid(value.runId,"request_invalid");
  uuid(value.startRequestId,"request_invalid");
  if (value.trace !== null) trace(value.trace,value.runId);
  if (value.stopRequestId !== null) uuid(value.stopRequestId,"request_invalid");
  return value;
}

function initial() {
  return freeze({
    enabled: false,open: false,runId: null,busy: false,trace: null,
    comparison: null,notice: null,
  });
}

export function createE11HostPanelController({ transport,storage,randomUuid } = {}) {
  if (!transport || typeof transport.start !== "function"
    || typeof transport.stop !== "function" || typeof transport.compare !== "function"
    || !storage || typeof randomUuid !== "function") {
    throw new Error("e11_panel_configuration_invalid");
  }
  let state = initial();
  let epoch = 0;
  let readAbort = null;
  const listeners = new Set();
  const publish = (next) => {
    state = freeze(next);
    for (const listener of listeners) listener(state);
  };
  const save = (record) => {
    try { storage.setItem(STORAGE_KEY,JSON.stringify(record)); }
    catch { fail("diagnostic_unavailable"); }
  };
  const load = (runId) => {
    let raw;
    try { raw = storage.getItem(STORAGE_KEY); } catch { return null; }
    if (raw === null) return null;
    try {
      const value = stored(JSON.parse(raw));
      return value.runId === runId ? value : null;
    } catch {
      try { storage.removeItem(STORAGE_KEY); } catch {}
      return null;
    }
  };
  const current = (token,runId) => token === epoch && state.enabled && state.runId === runId;
  const saveIfSameIntent = (record, expected) => {
    const retained = load(record.runId);
    if (!retained || retained.startRequestId !== expected.startRequestId
      || retained.stopRequestId !== expected.stopRequestId) return false;
    save(record);
    return true;
  };

  async function start() {
    if (!state.enabled || state.busy || !state.runId) return false;
    const runId = state.runId;
    const token = epoch;
    let record = load(runId);
    if (record?.trace) {
      if (current(token,runId)) publish({ ...state,trace: record.trace,notice: null });
      return true;
    }
    if (!record) {
      const startRequestId = randomUuid();
      uuid(startRequestId,"request_invalid");
      record = { version: 1,runId,startRequestId,trace: null,stopRequestId: null };
      save(record);
    }
    publish({ ...state,busy: true,notice: null });
    try {
      const retainedTrace = trace(await transport.start(runId,record.startRequestId),runId);
      saveIfSameIntent({ ...record,trace: retainedTrace },record);
      if (current(token,runId)) publish({
        ...state,busy: false,trace: retainedTrace,comparison: null,notice: "started",
      });
      return true;
    } catch (error) {
      if (current(token,runId)) publish({
        ...state,busy: false,notice: error instanceof E11HostPanelError
          ? error.code : "diagnostic_unavailable",
      });
      return false;
    }
  }

  async function refresh() {
    if (!state.enabled || state.busy || !state.trace) return false;
    const runId = state.runId;
    const traceId = state.trace.traceId;
    const token = epoch;
    readAbort?.abort();
    readAbort = new AbortController();
    publish({ ...state,busy: true,notice: null });
    try {
      const result = comparison(await transport.compare(traceId,readAbort.signal),traceId);
      if (current(token,runId)) publish({
        ...state,busy: false,comparison: result,notice: "refreshed",
      });
      return true;
    } catch (error) {
      if (current(token,runId)) publish({
        ...state,busy: false,notice: error instanceof E11HostPanelError
          ? error.code : "diagnostic_unavailable",
      });
      return false;
    } finally {
      readAbort = null;
    }
  }

  async function stop() {
    if (!state.enabled || state.busy || state.trace?.status !== "active") return false;
    const runId = state.runId;
    const token = epoch;
    const record = load(runId);
    if (!record?.trace || record.trace.traceId !== state.trace.traceId) return false;
    const stopRequestId = record.stopRequestId ?? randomUuid();
    uuid(stopRequestId,"request_invalid");
    const pending = { ...record,stopRequestId };
    save(pending);
    publish({ ...state,busy: true,notice: null });
    try {
      const ended = trace(await transport.stop(state.trace.traceId,stopRequestId),runId);
      saveIfSameIntent({ ...pending,trace: ended,stopRequestId: null },pending);
      if (current(token,runId)) publish({
        ...state,busy: false,trace: ended,notice: "stopped",
      });
      return true;
    } catch (error) {
      if (current(token,runId)) publish({
        ...state,busy: false,notice: error instanceof E11HostPanelError
          ? error.code : "diagnostic_unavailable",
      });
      return false;
    }
  }

  return Object.freeze({
    snapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      listener(state);
      return () => { listeners.delete(listener); };
    },
    sync({ enabled,runId }) {
      epoch += 1;
      readAbort?.abort();
      readAbort = null;
      if (!enabled || !UUID.test(runId ?? "")) {
        publish(initial());
        return;
      }
      const record = load(runId);
      publish(freeze({
        enabled: true,open: false,runId,busy: false,trace: record?.trace ?? null,
        comparison: null,notice: record && !record.trace ? "resume_available" : null,
      }));
    },
    setOpen(open) {
      if (!state.enabled) return;
      if (!open) {
        readAbort?.abort();
        publish({ ...state,open: false,comparison: null });
      } else publish({ ...state,open: true });
    },
    start,refresh,stop,
    dispose() {
      epoch += 1;
      readAbort?.abort();
      readAbort = null;
      listeners.clear();
      state = initial();
    },
  });
}

export { STORAGE_KEY as E11_HOST_STORAGE_KEY };
