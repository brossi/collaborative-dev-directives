import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  createE11HostPanelController,createE11HostTransport,
  E11HostPanelError,E11_HOST_STORAGE_KEY,
} from "../lib/s2e-e11-host-panel.mjs";

const RUN = "10000000-0000-4000-8000-000000000001";
const RUN_2 = "10000000-0000-4000-8000-000000000002";
const TRACE = "10000000-0000-4000-8000-000000000003";
const ids = Array.from({ length: 8 },(_,index) => (
  `20000000-0000-4000-8000-${String(index + 1).padStart(12,"0")}`
));

class MemoryStorage {
  values = new Map();
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key,value) { this.values.set(key,value); }
  removeItem(key) { this.values.delete(key); }
}

function active(runId = RUN,traceId = TRACE) {
  return { traceId,runId,status: "active",startedAtMs: 1,
    expiresAtMs: 21_600_001,ended: null };
}

function ended(runId = RUN,traceId = TRACE) {
  return { ...active(runId,traceId),status: "ended",
    ended: { status: "ended",endedAtMs: 2,reason: "host_stopped" } };
}

function comparison(traceId = TRACE) {
  return { comparisonVersion: 1,trace: {
    traceId,status: "active",startedAtMs: 1,endedAtMs: null,
  },reportCount: 7,diagnosis: {
    result: "listener_buffer_suspected",confidence: "medium",missing: [],
    evidenceCount: 6,interval: { startEarliestMs: 10,endLatestMs: 20 },
  } };
}

function fixture(overrides = {}) {
  const storage = new MemoryStorage();
  let uuidIndex = 0;
  const calls = [];
  const transport = {
    start: async (runId,requestId) => { calls.push(["start",runId,requestId]); return active(runId); },
    stop: async (traceId,requestId) => { calls.push(["stop",traceId,requestId]); return ended(); },
    compare: async (traceId) => { calls.push(["compare",traceId]); return comparison(traceId); },
    ...overrides,
  };
  const controller = createE11HostPanelController({
    storage,transport,randomUuid: () => ids[uuidIndex++],
  });
  controller.sync({ enabled: true,runId: RUN });
  return { controller,storage,calls,transport };
}

test("start response loss retains and replays the exact session intent", async () => {
  let attempts = 0;
  const seen = [];
  const f = fixture({ start: async (runId,requestId) => {
    seen.push([runId,requestId]);
    attempts += 1;
    if (attempts === 1) throw new E11HostPanelError("diagnostic_unavailable");
    return active(runId);
  } });
  assert.equal(await f.controller.start(),false);
  assert.equal(f.controller.snapshot().notice,"diagnostic_unavailable");
  const retained = JSON.parse(f.storage.getItem(E11_HOST_STORAGE_KEY));
  assert.equal(retained.trace,null);
  assert.equal(await f.controller.start(),true);
  assert.deepEqual(seen,[[RUN,ids[0]],[RUN,ids[0]]]);
  assert.equal(f.controller.snapshot().trace.traceId,TRACE);
});

test("stop response loss retains exact intent and ended trace remains comparable", async () => {
  let attempts = 0;
  const seen = [];
  const f = fixture({ stop: async (traceId,requestId) => {
    seen.push([traceId,requestId]);
    attempts += 1;
    if (attempts === 1) throw new E11HostPanelError("diagnostic_unavailable");
    return ended();
  } });
  await f.controller.start();
  assert.equal(await f.controller.stop(),false);
  assert.equal(await f.controller.stop(),true);
  assert.deepEqual(seen,[[TRACE,ids[1]],[TRACE,ids[1]]]);
  assert.equal(f.controller.snapshot().trace.status,"ended");
  assert.equal(await f.controller.refresh(),true);
  assert.equal(f.controller.snapshot().comparison.diagnosis.result,
    "listener_buffer_suspected");
});

test("one pending action fences duplicate controls and close aborts only the read", async () => {
  let releaseStart;
  const heldStart = new Promise((resolve) => { releaseStart = resolve; });
  const f = fixture({ start: async (runId,requestId) => {
    f.calls.push(["start",runId,requestId]);
    await heldStart;
    return active(runId);
  } });
  const pending = f.controller.start();
  assert.equal(f.controller.snapshot().busy,true);
  assert.equal(await f.controller.start(),false);
  assert.equal(await f.controller.refresh(),false);
  releaseStart();
  await pending;

  let aborted = false;
  f.transport.compare = async (_traceId,signal) => new Promise((_,reject) => {
    signal.addEventListener("abort",() => {
      aborted = true;
      reject(new E11HostPanelError("diagnostic_unavailable"));
    });
  });
  f.controller.setOpen(true);
  const reading = f.controller.refresh();
  f.controller.setOpen(false);
  assert.equal(await reading,false);
  assert.equal(aborted,true);
  assert.equal(f.controller.snapshot().comparison,null);
});

test("disabled/member state admits no action and malformed storage is discarded", async () => {
  const f = fixture();
  f.storage.setItem(E11_HOST_STORAGE_KEY,"{bad");
  f.controller.sync({ enabled: false,runId: RUN });
  assert.equal(await f.controller.start(),false);
  assert.equal(f.calls.length,0);
  f.controller.sync({ enabled: true,runId: RUN });
  assert.equal(f.storage.getItem(E11_HOST_STORAGE_KEY),null);
  assert.equal(f.controller.snapshot().trace,null);
  assert.equal(f.controller.snapshot().notice,"request_invalid");
  assert.equal(await f.controller.start(),false);
  assert.equal(f.calls.length,0);
});

test("late prior-run completion cannot overwrite a newer run intent", async () => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const f = fixture({ start: async (runId) => {
    if (runId === RUN) { await held; return active(RUN); }
    return active(RUN_2,"10000000-0000-4000-8000-000000000004");
  } });
  const prior = f.controller.start();
  f.controller.sync({ enabled: true,runId: RUN_2 });
  await f.controller.start();
  release();
  await prior;
  const retained = JSON.parse(f.storage.getItem(E11_HOST_STORAGE_KEY));
  assert.equal(retained.runId,RUN_2);
  assert.equal(f.controller.snapshot().runId,RUN_2);
});

test("production attachment is host-only and does not enter gameplay audio or readiness", () => {
  const page = readFileSync(new URL("../app/page.tsx",import.meta.url),"utf8");
  assert.match(page,/room\.isHost && audio\.selection === "managed"/);
  assert.equal((page.match(/<HostDiagnosticsPanel runId=\{room\.runId\} \/>/g) ?? []).length,2);
  for (const relative of [
    "../lib/use-managed-audio-stream.ts",
    "../app/api/game/state-route.ts",
    "../app/api/audio-stream/route.ts",
    "../app/api/ready/route.ts",
  ]) {
    const source = readFileSync(new URL(relative,import.meta.url),"utf8");
    assert.doesNotMatch(source,/s2e-e11|diagnostic-comparison|HostDiagnosticsPanel/);
  }
});

test("browser transport bounds deadlines and rejects noncanonical dependency output", async () => {
  const held = createE11HostTransport({ deadlineMs: 5,fetchImpl: async (_url,options) => (
    new Promise((_,reject) => options.signal.addEventListener("abort",() => reject(
      new Error("aborted"),
    ),{ once: true }))
  ) });
  await assert.rejects(() => held.start(RUN,ids[0]),
    (error) => error.code === "request_timeout");

  let cancelled = false;
  const stalledBody = createE11HostTransport({ deadlineMs: 5,fetchImpl: async (
    _url,options,
  ) => {
    assert.equal(options.redirect,"error");
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode("{")); },
      cancel() { cancelled = true; },
    }),{ status: 200,headers: { "content-type": "application/json" } });
  } });
  await assert.rejects(() => stalledBody.compare(TRACE),
    (error) => error.code === "request_timeout");
  assert.equal(cancelled,true);

  const mismatched = createE11HostTransport({ fetchImpl: async () => Response.json({
    error: "Diagnostics are temporarily unavailable.",code: "collector_degraded",
  },{ status: 401 }) });
  await assert.rejects(() => mismatched.compare(TRACE),
    (error) => error.code === "diagnostic_unavailable");

  for (const response of [
    Response.json({ error: "private detail",code: "collector_degraded" },{ status: 503 }),
    Response.json(comparison(),{ status: 201 }),
    new Response(JSON.stringify(comparison()),{ status: 200,
      headers: { "content-type": "text/plain" } }),
  ]) {
    const noncanonical = createE11HostTransport({ fetchImpl: async () => response });
    await assert.rejects(() => noncanonical.compare(TRACE),
      (error) => error.code === "diagnostic_unavailable");
  }

  const hostile = createE11HostTransport({ fetchImpl: async () => Response.json({
    ...comparison(),diagnosis: { ...comparison().diagnosis,missing: ["private_detail"] },
  }) });
  const controller = createE11HostPanelController({ storage: new MemoryStorage(),
    randomUuid: () => ids[0],transport: {
      start: async () => active(),stop: async () => ended(),
      compare: (traceId,signal) => hostile.compare(traceId,signal),
    } });
  controller.sync({ enabled: true,runId: RUN });
  await controller.start();
  assert.equal(await controller.refresh(),false);
  assert.equal(controller.snapshot().notice,"collector_response_invalid");

  const impossible = createE11HostPanelController({ storage: new MemoryStorage(),
    randomUuid: () => ids[0],transport: {
      start: async () => active(),stop: async () => ended(),compare: async () => ({
        ...comparison(),reportCount: 0,
      }),
    } });
  impossible.sync({ enabled: true,runId: RUN });
  await impossible.start();
  assert.equal(await impossible.refresh(),false);
  assert.equal(impossible.snapshot().notice,"collector_response_invalid");
});

test("operation results remain bound to their requested lifecycle", async () => {
  const otherTrace = "10000000-0000-4000-8000-000000000099";
  const f = fixture({ stop: async () => ended(RUN,otherTrace) });
  await f.controller.start();
  assert.equal(await f.controller.stop(),false);
  assert.equal(f.controller.snapshot().notice,"collector_response_invalid");
  assert.equal(f.controller.snapshot().trace.traceId,TRACE);
  assert.equal(JSON.parse(f.storage.getItem(E11_HOST_STORAGE_KEY)).stopRequestId,ids[1]);

  const activeStop = fixture({ stop: async () => active() });
  await activeStop.controller.start();
  assert.equal(await activeStop.controller.stop(),false);
  assert.equal(activeStop.controller.snapshot().trace.status,"active");

  const endedStart = fixture({ start: async () => ended() });
  assert.equal(await endedStart.controller.start(),false);
  assert.equal(endedStart.controller.snapshot().notice,"collector_response_invalid");
});

test("a stale refresh cannot clear or publish through a newer read owner", async () => {
  const f = fixture();
  await f.controller.start();
  let rejectOld;
  let resolveNew;
  let newAborted = false;
  f.transport.compare = (traceId,signal) => new Promise((resolve,reject) => {
    if (traceId === TRACE) rejectOld = reject;
    else {
      resolveNew = resolve;
      signal.addEventListener("abort",() => { newAborted = true; reject(
        new E11HostPanelError("diagnostic_unavailable"),
      ); },{ once: true });
    }
  });
  const old = f.controller.refresh();
  f.controller.sync({ enabled: true,runId: RUN_2 });
  f.storage.setItem(E11_HOST_STORAGE_KEY,JSON.stringify({
    version: 1,runId: RUN_2,startRequestId: ids[2],trace: active(
      RUN_2,"10000000-0000-4000-8000-000000000004",
    ),stopRequestId: null,
  }));
  f.controller.sync({ enabled: true,runId: RUN_2 });
  const current = f.controller.refresh();
  rejectOld(new E11HostPanelError("diagnostic_unavailable"));
  await old;
  f.controller.setOpen(false);
  assert.equal(await current,false);
  assert.equal(newAborted,true);
  assert.equal(f.controller.snapshot().comparison,null);
  assert.equal(resolveNew instanceof Function,true);
});
