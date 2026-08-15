import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname,resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createDiagnosticRouteHandlers } from "../lib/server/diagnostic-routes.mjs";
import { DiagnosticCollectorGatewayError } from "../lib/server/diagnostic-collector-client.mjs";
import { DiagnosticMediationError } from "../lib/server/diagnostic-mediation.mjs";
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
    assert.doesNotMatch(source,/diagnostic-collector|DIAGNOSTICS_(?:GAME_TOKEN|SERVICE_ORIGIN)/,relative);
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
