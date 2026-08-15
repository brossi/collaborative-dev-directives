import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach,test } from "node:test";

import { DiagnosticCollector } from "../../diagnostics-service/src/collector.mjs";
import {
  createDiagnosticMediation,DiagnosticMediationError,deriveDiagnosticUuid,
} from "../lib/server/diagnostic-mediation.mjs";

const roots = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop(),{ recursive: true,force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(),"cannabeats-e83a-"));
  roots.push(root);
  let now = 1000;
  const collector = new DiagnosticCollector(join(root,"diagnostics.sqlite"),{ clock: () => now });
  const adapter = {
    traceContext: (locator) => collector.traceContext(locator),
    startReceiptContext: (requestId) => collector.traceStartReceiptContext(requestId),
    startTrace: ({ command,authority }) => collector.startTrace(command,authority),
    endTrace: ({ command,authority }) => collector.endTrace(command,authority),
    rotateSegment: ({ authority }) => collector.rotateSegment(authority),
    readTrace: ({ traceId,cursor }) => collector.readTrace(Buffer.from(JSON.stringify({ traceId,cursor }))),
  };
  const runId = randomUUID();
  const leaseId = randomUUID();
  const nextLeaseId = randomUUID();
  const principalId = randomUUID();
  const hostRuns = new Set([runId]);
  const authority = {
    hostStatus: "active",streamStatus: "active",runId,runGeneration: 1,leaseId,
  };
  const access = { principal: async () => ({ principal: { id: principalId } }) };
  const state = {
      runHost: async ({ runId: requested,principalId: requestedPrincipal }) => {
        if (!hostRuns.has(requested) || requestedPrincipal !== principalId) {
          throw Object.assign(new Error("missing"),{ status: 404,code: "not_found" });
        }
        return {
          authorityVersion: 1,status: authority.hostStatus,runId: requested,
          runGeneration: authority.runGeneration,isHost: true,
        };
      },
      managedStream: async () => authority.streamStatus === "absent"
        ? { authorityVersion: 1,status: "absent" }
        : {
          authorityVersion: 1,status: "active",runId: authority.runId,
          runGeneration: authority.runGeneration,leaseId: authority.leaseId,
          sourceId: randomUUID(),leaseExpiresAt: now + 120_000,
        },
    };
  const mediation = createDiagnosticMediation({
    access,state,collector: adapter,clock: () => now,
  });
  return {
    access,adapter,collector,mediation,state,authority,hostRuns,
    runId,leaseId,nextLeaseId,principalId,
    headers: { authorization: "",cookie: "cb_session=test" },
    setNow: (value) => { now = value; },
  };
}

test("deterministic diagnostic identities are versioned canonical UUIDs", () => {
  const requestId = randomUUID();
  const trace = deriveDiagnosticUuid("trace",requestId);
  assert.match(trace,/^[0-9a-f-]{36}$/);
  assert.equal(trace,deriveDiagnosticUuid("trace",requestId));
  assert.notEqual(trace,deriveDiagnosticUuid("initial-segment",requestId));
});

test("host start and response-loss replay retain the original active result after trace end", async () => {
  const f = fixture();
  const requestId = randomUUID();
  const started = await f.mediation.start({ headers: f.headers,requestId,runId: f.runId });
  assert.equal(started.status,"active");
  assert.equal(started.traceId,deriveDiagnosticUuid("trace",requestId));
  const stopId = randomUUID();
  const stopped = await f.mediation.stop({ headers: f.headers,requestId: stopId,traceId: started.traceId });
  assert.equal(stopped.status,"ended");
  const replay = await f.mediation.start({ headers: f.headers,requestId,runId: f.runId });
  assert.deepEqual(replay,started);
  const otherRunId = randomUUID();
  f.hostRuns.add(otherRunId);
  await assert.rejects(() => f.mediation.start({
    headers: f.headers,requestId,runId: otherRunId,
  }),(error) => error instanceof DiagnosticMediationError
    && error.status === 409 && error.code === "request_conflict");
  f.collector.close();
});

test("active reconciliation rotates an exact lease edge and ends authority loss", async () => {
  const f = fixture();
  const started = await f.mediation.start({
    headers: f.headers,requestId: randomUUID(),runId: f.runId,
  });
  f.authority.leaseId = f.nextLeaseId;
  const rotated = await f.mediation.status({ headers: f.headers,traceId: started.traceId });
  assert.equal(rotated.status,"active");
  assert.equal(f.collector.traceContext({ traceId: started.traceId }).state.segment.leaseId,
    f.nextLeaseId);
  f.authority.streamStatus = "absent";
  const ended = await f.mediation.status({ headers: f.headers,traceId: started.traceId });
  assert.equal(ended.ended.status,"ended");
  assert.equal(ended.ended.endedAtMs,1000);
  assert.equal(ended.ended.reason,"authority_lost");
  f.collector.close();
});

test("host read returns one validated collector page and non-host lookup is concealed", async () => {
  const f = fixture();
  const started = await f.mediation.start({
    headers: f.headers,requestId: randomUUID(),runId: f.runId,
  });
  const page = await f.mediation.read({ headers: f.headers,traceId: started.traceId,cursor: null });
  assert.equal(page.status,"found");
  assert.equal(page.complete,true);
  assert.deepEqual(page.reports,[]);
  f.hostRuns.delete(f.runId);
  await assert.rejects(() => f.mediation.status({ headers: f.headers,traceId: started.traceId }),
    (error) => error instanceof DiagnosticMediationError
      && error.status === 404 && error.code === "diagnostic_not_found");
  f.collector.close();
});

test("host stop does not depend on current stream authority", async () => {
  const f = fixture();
  const started = await f.mediation.start({
    headers: f.headers,requestId: randomUUID(),runId: f.runId,
  });
  f.authority.streamStatus = "absent";
  const stopped = await f.mediation.stop({
    headers: f.headers,requestId: randomUUID(),traceId: started.traceId,
  });
  assert.equal(stopped.ended.reason,"host_stopped");
  f.collector.close();
});

test("simultaneous host starts admit one trace and return one finite busy result", async () => {
  const f = fixture();
  const settled = await Promise.allSettled([
    f.mediation.start({ headers: f.headers,requestId: randomUUID(),runId: f.runId }),
    f.mediation.start({ headers: f.headers,requestId: randomUUID(),runId: f.runId }),
  ]);
  assert.equal(settled.filter((entry) => entry.status === "fulfilled").length,1);
  const rejected = settled.find((entry) => entry.status === "rejected");
  assert.equal(rejected.reason.code,"trace_busy");
  f.collector.close();
});

test("authentication completes before any retained trace lookup", async () => {
  let collectorCalls = 0;
  const mediation = createDiagnosticMediation({
    access: { principal: async () => { throw Object.assign(new Error("denied"),{ status: 401 }); } },
    state: { runHost: async () => {},managedStream: async () => {} },
    collector: {
      traceContext: async () => { collectorCalls += 1; return { status: "trace_absent" }; },
    },
  });
  await assert.rejects(() => mediation.status({
    headers: { authorization: "",cookie: "" },traceId: randomUUID(),
  }),(error) => error.code === "authentication_required");
  assert.equal(collectorCalls,0);

  const malformedAccess = createDiagnosticMediation({
    access: { principal: async () => ({}) },
    state: { runHost: async () => {},managedStream: async () => {} },
    collector: {
      traceContext: async () => { collectorCalls += 1; return { status: "trace_absent" }; },
    },
  });
  await assert.rejects(() => malformedAccess.status({
    headers: { authorization: "",cookie: "" },traceId: randomUUID(),
  }),(error) => error.code === "diagnostic_unavailable");
  assert.equal(collectorCalls,0);
});

test("every collector projection is bound back to the requested trace", async () => {
  const f = fixture();
  const started = await f.mediation.start({
    headers: f.headers,requestId: randomUUID(),runId: f.runId,
  });
  const otherTraceId = randomUUID();
  const substitutedContext = createDiagnosticMediation({
    access: f.access,state: f.state,clock: () => 1000,
    collector: {
      ...f.adapter,
      traceContext: () => f.adapter.traceContext({ traceId: started.traceId }),
    },
  });
  await assert.rejects(() => substitutedContext.status({
    headers: f.headers,traceId: otherTraceId,
  }),(error) => error.code === "collector_response_invalid");

  const page = await f.adapter.readTrace({ traceId: started.traceId,cursor: null });
  const substitutedRead = createDiagnosticMediation({
    access: f.access,state: f.state,clock: () => 1000,
    collector: {
      ...f.adapter,
      readTrace: async () => ({
        ...page,metadata: { ...page.metadata,traceId: otherTraceId },
      }),
    },
  });
  await assert.rejects(() => substitutedRead.read({
    headers: f.headers,traceId: started.traceId,cursor: null,
  }),(error) => error.code === "collector_response_invalid");
  f.collector.close();

  const changedStart = fixture();
  const substitutedStart = createDiagnosticMediation({
    access: changedStart.access,state: changedStart.state,clock: () => 1000,
    collector: {
      ...changedStart.adapter,
      startTrace: (value) => {
        const result = changedStart.adapter.startTrace(value);
        return { ...result,state: { ...result.state,runGeneration: 2 } };
      },
    },
  });
  await assert.rejects(() => substitutedStart.start({
    headers: changedStart.headers,requestId: randomUUID(),runId: changedStart.runId,
  }),(error) => error.code === "collector_response_invalid");
  changedStart.collector.close();
});

test("operation results retain the exact submitted timing and receipt projection", async () => {
  const shiftedStart = fixture();
  const startMediation = createDiagnosticMediation({
    access: shiftedStart.access,state: shiftedStart.state,clock: () => 1000,
    collector: {
      ...shiftedStart.adapter,
      startTrace: (value) => {
        const result = shiftedStart.adapter.startTrace(value);
        const state = {
          ...result.state,startedAtMs: 1001,expiresAtMs: 21_601_001,
          segment: { ...result.state.segment,startedAtMs: 1001 },
        };
        return { ...result,state,receipt: { ...result.receipt,result: state } };
      },
    },
  });
  await assert.rejects(() => startMediation.start({
    headers: shiftedStart.headers,requestId: randomUUID(),runId: shiftedStart.runId,
  }),(error) => error.code === "collector_response_invalid");
  shiftedStart.collector.close();

  const shiftedEnd = fixture();
  const started = await shiftedEnd.mediation.start({
    headers: shiftedEnd.headers,requestId: randomUUID(),runId: shiftedEnd.runId,
  });
  shiftedEnd.setNow(2000);
  const endMediation = createDiagnosticMediation({
    access: shiftedEnd.access,state: shiftedEnd.state,clock: () => 2000,
    collector: {
      ...shiftedEnd.adapter,
      endTrace: (value) => {
        const result = shiftedEnd.adapter.endTrace(value);
        const state = {
          ...result.state,ended: { ...result.state.ended,endedAtMs: 2001 },
        };
        return { ...result,state,receipt: { ...result.receipt,result: state } };
      },
    },
  });
  await assert.rejects(() => endMediation.stop({
    headers: shiftedEnd.headers,requestId: randomUUID(),traceId: started.traceId,
  }),(error) => error.code === "collector_response_invalid");
  shiftedEnd.collector.close();

  const shiftedRotate = fixture();
  const rotating = await shiftedRotate.mediation.start({
    headers: shiftedRotate.headers,requestId: randomUUID(),runId: shiftedRotate.runId,
  });
  shiftedRotate.setNow(2000);
  shiftedRotate.authority.leaseId = shiftedRotate.nextLeaseId;
  const rotateMediation = createDiagnosticMediation({
    access: shiftedRotate.access,state: shiftedRotate.state,clock: () => 2000,
    collector: {
      ...shiftedRotate.adapter,
      rotateSegment: (value) => {
        const result = shiftedRotate.adapter.rotateSegment(value);
        return {
          ...result,state: {
            ...result.state,segment: { ...result.state.segment,startedAtMs: 2001 },
          },
        };
      },
    },
  });
  await assert.rejects(() => rotateMediation.status({
    headers: shiftedRotate.headers,traceId: rotating.traceId,
  }),(error) => error.code === "collector_response_invalid");
  shiftedRotate.collector.close();
});

test("replayed lifecycle results preserve their originally retained timestamps", async () => {
  const rotation = fixture();
  const started = await rotation.mediation.start({
    headers: rotation.headers,requestId: randomUUID(),runId: rotation.runId,
  });
  const prior = rotation.adapter.traceContext({ traceId: started.traceId }).state;
  rotation.setNow(2000);
  rotation.authority.leaseId = rotation.nextLeaseId;
  const first = await rotation.mediation.status({
    headers: rotation.headers,traceId: started.traceId,
  });
  assert.equal(first.status,"active");
  const replayingRotation = createDiagnosticMediation({
    access: rotation.access,state: rotation.state,clock: () => 2001,
    collector: {
      ...rotation.adapter,
      traceContext: () => ({ status: "found",state: prior }),
    },
  });
  const replayed = await replayingRotation.status({
    headers: rotation.headers,traceId: started.traceId,
  });
  assert.equal(replayed.status,"active");
  assert.equal(rotation.collector.traceContext({ traceId: started.traceId })
    .state.segment.startedAtMs,2000);
  rotation.collector.close();

  const stop = fixture();
  const active = await stop.mediation.start({
    headers: stop.headers,requestId: randomUUID(),runId: stop.runId,
  });
  stop.setNow(2000);
  const stopRequestId = randomUUID();
  const original = await stop.mediation.stop({
    headers: stop.headers,requestId: stopRequestId,traceId: active.traceId,
  });
  const replayingStop = createDiagnosticMediation({
    access: stop.access,state: stop.state,clock: () => 3000,
    collector: {
      ...stop.adapter,
      endTrace: (value) => {
        const result = stop.adapter.endTrace(value);
        const state = {
          ...result.state,ended: { ...result.state.ended,endedAtMs: 2001 },
        };
        return { ...result,state,receipt: { ...result.receipt,result: state } };
      },
    },
  });
  await assert.rejects(() => replayingStop.stop({
    headers: stop.headers,requestId: stopRequestId,traceId: original.traceId,
  }),(error) => error.code === "collector_response_invalid");
  stop.collector.close();
});

test("a stop racing exact trace expiry returns the retained expired projection", async () => {
  const f = fixture();
  const started = await f.mediation.start({
    headers: f.headers,requestId: randomUUID(),runId: f.runId,
  });
  f.setNow(started.expiresAtMs - 1);
  let advanceAfterLookup = true;
  const racing = createDiagnosticMediation({
    access: f.access,state: f.state,clock: () => started.expiresAtMs,
    collector: {
      ...f.adapter,
      traceContext: (locator) => {
        const found = f.adapter.traceContext(locator);
        if (advanceAfterLookup) {
          advanceAfterLookup = false;
          f.setNow(started.expiresAtMs);
        }
        return found;
      },
    },
  });
  const stopped = await racing.stop({
    headers: f.headers,requestId: randomUUID(),traceId: started.traceId,
  });
  assert.equal(stopped.ended.reason,"expired");
  assert.equal(stopped.ended.endedAtMs,started.expiresAtMs);
  f.collector.close();
});

test("a stale stop refresh cannot replace immutable trace identity", async () => {
  const f = fixture();
  const started = await f.mediation.start({
    headers: f.headers,requestId: randomUUID(),runId: f.runId,
  });
  const active = f.adapter.traceContext({ traceId: started.traceId }).state;
  let lookups = 0;
  const mediation = createDiagnosticMediation({
    access: f.access,state: f.state,clock: () => 2000,
    collector: {
      ...f.adapter,
      traceContext: () => {
        lookups += 1;
        if (lookups === 1) return { status: "found",state: active };
        return { status: "found",state: {
          ...active,status: "ended",startedAtMs: 1001,expiresAtMs: 21_601_001,
          segment: { ...active.segment,startedAtMs: 1001 },
          ended: { status: "ended",endedAtMs: 2000,reason: "host_stopped" },
        } };
      },
      endTrace: async () => {
        throw Object.assign(new Error("inactive"),{ status: 409,code: "trace_inactive" });
      },
    },
  });
  await assert.rejects(() => mediation.stop({
    headers: f.headers,requestId: randomUUID(),traceId: started.traceId,
  }),(error) => error.code === "collector_response_invalid");
  f.collector.close();
});

test("start refuses absent or wrong-run stream authority before collector mutation", async () => {
  for (const configure of [
    (f) => { f.authority.streamStatus = "absent"; },
    (f) => { f.authority.runId = randomUUID(); },
  ]) {
    const f = fixture();
    configure(f);
    await assert.rejects(() => f.mediation.start({
      headers: f.headers,requestId: randomUUID(),runId: f.runId,
    }),(error) => error.code === "diagnostic_not_found");
    assert.deepEqual(f.collector.traceContext({ active: true }),{ status: "trace_absent" });
    f.collector.close();
  }
});

test("status preserves an unchanged lease and ends a replaced run", async () => {
  const unchanged = fixture();
  const active = await unchanged.mediation.start({
    headers: unchanged.headers,requestId: randomUUID(),runId: unchanged.runId,
  });
  assert.deepEqual(await unchanged.mediation.status({
    headers: unchanged.headers,traceId: active.traceId,
  }),active);
  unchanged.collector.close();

  const replaced = fixture();
  const started = await replaced.mediation.start({
    headers: replaced.headers,requestId: randomUUID(),runId: replaced.runId,
  });
  replaced.authority.runId = randomUUID();
  const ended = await replaced.mediation.status({
    headers: replaced.headers,traceId: started.traceId,
  });
  assert.equal(ended.ended.reason,"run_replaced");
  replaced.collector.close();
});

test("host stop replays exactly and fresh ended stop/read remain effect-free", async () => {
  const f = fixture();
  const started = await f.mediation.start({
    headers: f.headers,requestId: randomUUID(),runId: f.runId,
  });
  const requestId = randomUUID();
  const stopped = await f.mediation.stop({ headers: f.headers,requestId,traceId: started.traceId });
  assert.deepEqual(await f.mediation.stop({
    headers: f.headers,requestId,traceId: started.traceId,
  }),stopped);
  assert.deepEqual(await f.mediation.stop({
    headers: f.headers,requestId: randomUUID(),traceId: started.traceId,
  }),stopped);
  const page = await f.mediation.read({
    headers: f.headers,traceId: started.traceId,cursor: null,
  });
  assert.equal(page.trace.status,"ended");
  assert.equal(page.metadata.endReason,"host_stopped");
  f.collector.close();
});
