import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { DiagnosticMediationError } from "../lib/server/diagnostic-mediation.mjs";
import { createDiagnosticProducerRouteHandlers } from "../lib/server/diagnostic-producer-routes.mjs";

function request(body,{ authorization = "Bearer producer-token",stream = false } = {}) {
  return new Request("https://poc.example/game/api/diagnostics/source-report",{
    method: "POST",headers: { authorization,"content-type": "application/json" },
    body: stream ? body : JSON.stringify(body),...(stream ? { duplex: "half" } : {}),
  });
}

test("producer routes authenticate before reading bounded bodies", async () => {
  let sourceCalls = 0;
  const handlers = createDiagnosticProducerRouteHandlers({ mediation: {
    authenticateSource: async () => {
      sourceCalls += 1;
      throw new DiagnosticMediationError(401,"authentication_required");
    },
    authenticateRelay: () => { throw new DiagnosticMediationError(401,"authentication_required"); },
  },bodyDeadlineMs: 5 });
  const stalled = new ReadableStream({ start() {} });
  const source = await handlers.source(request(stalled,{ stream: true }));
  assert.equal(source.status,401);
  assert.equal((await source.json()).code,"authentication_required");
  assert.equal(sourceCalls,1);
  const relay = await handlers.relayReport(request(stalled,{ stream: true }));
  assert.equal(relay.status,401);
  assert.equal((await relay.json()).code,"authentication_required");
});

test("producer routes accept only exact action families and do not echo authority labels", async () => {
  const calls = [];
  const handlers = createDiagnosticProducerRouteHandlers({ mediation: {
    authenticateSource: async () => ({ authenticated: "source" }),
    authenticateRelay: () => ({ authenticated: "relay" }),
    openSource: async (value) => { calls.push(["open",value]); return { status: "opened" }; },
    synchronizeSource: async (value) => {
      calls.push(["source-sync",value]); return { status: "accepted" };
    },
    reportSource: async (value) => {
      calls.push(["source-report",value]); return { status: "accepted" };
    },
    bindRelay: async (value) => { calls.push(["bind",value]); return { status: "accepted" }; },
    synchronizeRelay: async (value) => {
      calls.push(["relay-sync",value]); return { status: "accepted" };
    },
    reportRelay: async (value) => {
      calls.push(["relay-report",value]); return { status: "accepted" };
    },
  } });
  const ids = Array.from({ length: 5 },() => randomUUID());
  assert.equal((await handlers.source(request({
    action: "open",requestId: ids[0],sourceInstanceId: ids[1],
  }))).status,200);
  assert.equal((await handlers.source(request({
    action: "synchronize",requestId: ids[2],sourceGrantId: ids[3],
  }))).status,200);
  assert.equal((await handlers.relayGeneration(request({
    action: "bind",requestId: ids[2],relayGenerationId: ids[4],
  }))).status,200);
  const denied = await handlers.source(request({
    action: "open",requestId: ids[0],sourceInstanceId: ids[1],traceId: ids[4],
  }));
  assert.equal(denied.status,400);
  assert.equal((await denied.json()).code,"request_invalid");
  assert.deepEqual(calls.map(([name]) => name),["open","source-sync","bind"]);
});

test("producer route failures use the finite browser boundary", async () => {
  const handlers = createDiagnosticProducerRouteHandlers({ mediation: {
    authenticateRelay: () => ({ authenticated: true }),
    reportRelay: async () => { throw new Error("native secret"); },
  } });
  const response = await handlers.relayReport(request({
    relayGenerationId: randomUUID(),measurementCore: {},sampleObservation: {},
  }));
  assert.equal(response.status,503);
  assert.deepEqual(await response.json(),{
    error: "Diagnostics are temporarily unavailable.",code: "diagnostic_unavailable",
  });
});
