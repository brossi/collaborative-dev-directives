import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname,resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  createDiagnosticListenerRouteHandlers,createDiagnosticRouteHandlers,
} from "../lib/server/diagnostic-routes.mjs";
import { DiagnosticCollectorGatewayError } from "../lib/server/diagnostic-collector-client.mjs";
import {
  createDiagnosticMediation,DiagnosticMediationError,
} from "../lib/server/diagnostic-mediation.mjs";
import { StateGatewayError } from "../lib/server/state-client.mjs";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)),"..");

function request(body,{ origin = "https://poc.example" } = {}) {
  return new Request("https://poc.example/game/api/diagnostics/trace",{
    method: "POST",headers: { origin,"content-type": "application/json",cookie: "cb_session=x" },
    body: JSON.stringify(body),
  });
}

test("diagnostic routes accept only the exact host trace and read families", async () => {
  const calls = [];
  const handlers = createDiagnosticRouteHandlers({ mediation: {
    start: async (value) => { calls.push(["start",value]); return { status: "active" }; },
    stop: async (value) => { calls.push(["stop",value]); return { status: "ended" }; },
    status: async (value) => { calls.push(["status",value]); return { status: "active" }; },
    read: async (value) => { calls.push(["read",value]); return { status: "found" }; },
  } });
  const runId = randomUUID();
  const requestId = randomUUID();
  const traceId = randomUUID();
  for (const [body,expected] of [
    [{ action: "start",requestId,runId },"start"],
    [{ action: "stop",requestId,traceId },"stop"],
    [{ action: "status",traceId },"status"],
  ]) assert.equal((await handlers.trace(request(body))).status,200,expected);
  const report = new Request("https://poc.example/game/api/diagnostics/report",{
    method: "POST",headers: { origin: "https://poc.example","content-type": "application/json" },
    body: JSON.stringify({ traceId,cursor: null }),
  });
  assert.equal((await handlers.report(report)).status,200);
  assert.deepEqual(calls.map(([name]) => name),["start","stop","status","read"]);
});

test("host comparison route uses the authorized complete read and returns no raw evidence", async () => {
  const traceId = randomUUID();
  const runId = randomUUID();
  let reads = 0;
  const handlers = createDiagnosticRouteHandlers({ mediation: {
    start: async () => {},stop: async () => {},status: async () => {},
    read: async ({ headers,traceId: requested,cursor }) => {
      reads += 1;
      assert.equal(headers.cookie,"cb_session=x");
      assert.equal(requested,traceId);
      assert.equal(cursor,null);
      return {
        trace: { traceId,runId,status: "active",startedAtMs: 1,
          expiresAtMs: 21_600_001,ended: null },
        status: "found",complete: true,metadata: {
          traceId,status: "active",startedAtMs: 1,endedAtMs: null,
          endReason: null,reportCount: 0,
        },reports: [],cursor: null,
      };
    },
  } });
  const response = await handlers.comparison(request({ traceId }));
  assert.equal(response.status,200);
  assert.equal(response.headers.get("cache-control"),"no-store");
  const body = await response.json();
  assert.equal(body.comparisonVersion,1);
  assert.equal(body.diagnosis.result,"insufficient_evidence");
  assert.equal(body.diagnosis.evidenceCount,0);
  assert.equal("reports" in body,false);
  assert.equal(JSON.stringify(body).includes(runId),false);
  assert.equal(reads,1);
});

test("comparison route conceals a member read and preserves finite collector failure", async () => {
  const traceId = randomUUID();
  for (const [error,status,code] of [
    [new DiagnosticMediationError(404,"diagnostic_not_found"),404,"diagnostic_not_found"],
    [new DiagnosticMediationError(503,"collector_degraded"),503,"collector_degraded"],
  ]) {
    const handlers = createDiagnosticRouteHandlers({ mediation: {
      start: async () => {},stop: async () => {},status: async () => {},
      read: async () => { throw error; },
    } });
    const response = await handlers.comparison(request({ traceId }));
    assert.equal(response.status,status);
    assert.equal((await response.json()).code,code);
  }
});

test("comparison authenticates before any State or collector lookup", async () => {
  let lowerCalls = 0;
  const mediation = createDiagnosticMediation({
    access: { principal: async () => {
      throw new DiagnosticMediationError(401,"authentication_required");
    } },
    state: { runHost: async () => { lowerCalls += 1; },
      managedStream: async () => { lowerCalls += 1; } },
    collector: { traceContext: async () => { lowerCalls += 1; } },
  });
  const handlers = createDiagnosticRouteHandlers({ mediation });
  const response = await handlers.comparison(request({ traceId: randomUUID() }));
  assert.equal(response.status,401);
  assert.equal((await response.json()).code,"authentication_required");
  assert.equal(lowerCalls,0);
});

test("diagnostic routes conceal authority and normalize malformed or failed requests", async () => {
  const handlers = createDiagnosticRouteHandlers({ mediation: {
    start: async () => { throw new DiagnosticMediationError(404,"diagnostic_not_found"); },
    stop: async () => {},status: async () => {},read: async () => {},
  } });
  const denied = await handlers.trace(request({
    action: "start",requestId: randomUUID(),runId: randomUUID(),
  },{ origin: "https://other.example" }));
  assert.equal(denied.status,403);
  assert.equal((await denied.json()).code,"not_authorized");
  const malformed = await handlers.trace(request({
    action: "start",requestId: randomUUID(),runId: randomUUID(),leaseId: randomUUID(),
  }));
  assert.equal(malformed.status,400);
  assert.equal((await malformed.json()).code,"request_invalid");
  const missing = await handlers.trace(request({
    action: "start",requestId: randomUUID(),runId: randomUUID(),
  }));
  assert.equal(missing.status,404);
  assert.deepEqual(await missing.json(),{
    error: "Diagnostic trace not found.",code: "diagnostic_not_found",
  });
});

test("diagnostic routes bound oversized and stalled browser bodies before mediation", async () => {
  let called = false;
  const handlers = createDiagnosticRouteHandlers({ mediation: {
    start: async () => { called = true; },stop: async () => {},
    status: async () => {},read: async () => {},
  },bodyDeadlineMs: 5 });
  const oversized = await handlers.trace(request({ padding: "x".repeat(8192) }));
  assert.equal(oversized.status,400);
  assert.equal((await oversized.json()).code,"request_invalid");

  const stalled = new Request("https://poc.example/game/api/diagnostics/trace",{
    method: "POST",headers: {
      origin: "https://poc.example","content-type": "application/json",
    },body: new ReadableStream({ start() {} }),duplex: "half",
  });
  const timedOut = await handlers.trace(stalled);
  assert.equal(timedOut.status,408);
  assert.equal((await timedOut.json()).code,"request_timeout");
  assert.equal(called,false);
});

test("gameplay audio and readiness modules have no collector dependency", () => {
  for (const relative of [
    "app/api/game/state-route.ts","app/api/audio-stream/route.ts",
    "app/api/audio-source/route.ts","app/api/ready/route.ts","app/api/health/route.ts",
  ]) {
    const source = readFileSync(resolve(webRoot,relative),"utf8");
    assert.doesNotMatch(source,
      /diagnostic-(?:collector|producer)|DIAGNOSTICS_(?:GAME_TOKEN|RELAY_TOKEN|SERVICE_ORIGIN)/,
      relative);
  }
});

test("browser errors never forward an unregistered dependency code", async () => {
  const handlers = createDiagnosticRouteHandlers({ mediation: {
    start: async () => { throw new StateGatewayError(503,"private_state_detail"); },
    stop: async () => {},status: async () => {},read: async () => {},
  } });
  const response = await handlers.trace(request({
    action: "start",requestId: randomUUID(),runId: randomUUID(),
  }));
  assert.equal(response.status,503);
  assert.deepEqual(await response.json(),{
    error: "Diagnostics are temporarily unavailable.",code: "diagnostic_unavailable",
  });

  const mismatched = createDiagnosticRouteHandlers({ mediation: {
    start: async () => { throw new DiagnosticCollectorGatewayError(401,"collector_degraded"); },
    stop: async () => {},status: async () => {},read: async () => {},
  } });
  const normalized = await mismatched.trace(request({
    action: "start",requestId: randomUUID(),runId: randomUUID(),
  }));
  assert.equal(normalized.status,503);
  assert.equal((await normalized.json()).code,"collector_degraded");
});

test("listener routes expose only the three consent actions and one report shape", async () => {
  const calls = [];
  const handlers = createDiagnosticListenerRouteHandlers({ mediation: {
    optIn: async (value) => { calls.push(["optIn",value]); return { status: "enabled" }; },
    synchronize: async (value) => {
      calls.push(["synchronize",value]); return { status: "accepted" };
    },
    stop: async (value) => { calls.push(["stop",value]); return { status: "revoked" }; },
    report: async (value) => { calls.push(["report",value]); return { status: "accepted" }; },
  } });
  const requestId = randomUUID();
  const runId = randomUUID();
  const listenerInstanceId = randomUUID();
  const grantId = randomUUID();
  for (const body of [
    { action: "opt_in",requestId,runId,listenerInstanceId,
      firstAllowedSequence: 0,localConsentStartedMs: 10 },
    { action: "synchronize",requestId,grantId },
    { action: "stop",requestId,grantId },
  ]) assert.equal((await handlers.listener(request(body))).status,200);
  assert.equal((await handlers.listenerReport(request({
    grantId,measurementCore: {},sampleObservation: {},
  }))).status,200);
  assert.deepEqual(calls.map(([name]) => name),["optIn","synchronize","stop","report"]);

  const extra = await handlers.listener(request({
    action: "stop",requestId,grantId,traceId: randomUUID(),
  }));
  assert.equal(extra.status,400);
  assert.equal((await extra.json()).code,"request_invalid");
});

test("listener route failure codes retain their canonical browser status", async () => {
  const handlers = createDiagnosticListenerRouteHandlers({ mediation: {
    optIn: async () => { throw new DiagnosticMediationError(409,"grant_lost"); },
    synchronize: async () => {},stop: async () => {},report: async () => {},
  } });
  const response = await handlers.listener(request({
    action: "opt_in",requestId: randomUUID(),runId: randomUUID(),
    listenerInstanceId: randomUUID(),firstAllowedSequence: 0,localConsentStartedMs: 10,
  }));
  assert.equal(response.status,409);
  assert.equal((await response.json()).code,"grant_lost");
});
