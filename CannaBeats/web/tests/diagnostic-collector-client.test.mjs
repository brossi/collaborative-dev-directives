import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import {
  createDiagnosticCollectorClient,DiagnosticCollectorGatewayError,
} from "../lib/server/diagnostic-collector-client.mjs";

const token = "diagnostics-game-token-000000000000";

test("collector client sends only its fixed bearer and route families", async () => {
  const calls = [];
  const client = createDiagnosticCollectorClient({
    origin: "http://diagnostics:3020",token,
    fetchImpl: async (url,options) => {
      calls.push({ url:String(url),options });
      return Response.json({ status: "trace_absent" });
    },
  });
  const traceId = randomUUID();
  assert.deepEqual(await client.traceContext({ traceId }),{ status: "trace_absent" });
  assert.deepEqual(await client.startReceiptContext(randomUUID()),{ status: "trace_absent" });
  assert.deepEqual(await client.readTrace({ traceId,cursor: null }),{ status: "trace_absent" });
  assert.deepEqual(calls.map((call) => new URL(call.url).pathname),[
    "/v1/game/trace/context","/v1/game/trace/start-context","/v1/game/trace/read",
  ]);
  assert.ok(calls.every((call) => call.options.headers.authorization === `Bearer ${token}`));
});

test("collector client bounds malformed dependency output and timeout", async () => {
  const malformed = createDiagnosticCollectorClient({
    origin: "http://diagnostics:3020",token,
    fetchImpl: async () => new Response("private non-json output"),
  });
  await assert.rejects(() => malformed.traceContext({ active: true }),
    (error) => error instanceof DiagnosticCollectorGatewayError
      && error.status === 502 && error.code === "collector_response_invalid");

  const hostileFailure = createDiagnosticCollectorClient({
    origin: "http://diagnostics:3020",token,
    fetchImpl: async () => Response.json({ code: "private_database_path" },{ status: 503 }),
  });
  await assert.rejects(() => hostileFailure.traceContext({ active: true }),
    (error) => error instanceof DiagnosticCollectorGatewayError
      && error.status === 503 && error.code === "collector_unavailable");

  const malformedRead = createDiagnosticCollectorClient({
    origin: "http://diagnostics:3020",token,
    fetchImpl: async () => Response.json({
      status: "found",complete: true,
      metadata: {
        traceId: randomUUID(),status: "active",startedAtMs: 1,
        endedAtMs: null,endReason: null,reportCount: 1,
      },
      reports: [{ callerAuthored: true }],cursor: null,
    }),
  });
  await assert.rejects(() => malformedRead.readTrace({ traceId: randomUUID(),cursor: null }),
    (error) => error instanceof DiagnosticCollectorGatewayError
      && error.status === 502 && error.code === "collector_response_invalid");

  const incompleteFirstPage = createDiagnosticCollectorClient({
    origin: "http://diagnostics:3020",token,
    fetchImpl: async () => Response.json({
      status: "found",complete: true,
      metadata: {
        traceId: randomUUID(),status: "active",startedAtMs: 1,
        endedAtMs: null,endReason: null,reportCount: 1,
      },
      reports: [],cursor: null,
    }),
  });
  await assert.rejects(() => incompleteFirstPage.readTrace({
    traceId: randomUUID(),cursor: null,
  }),(error) => error.code === "collector_response_invalid");

  const hanging = createDiagnosticCollectorClient({
    origin: "http://diagnostics:3020",token,deadlineMs: 5,
    fetchImpl: async (_url,{ signal }) => new Promise((resolve,reject) => {
      signal.addEventListener("abort",() => reject(new Error("aborted")),{ once: true });
    }),
  });
  await assert.rejects(() => hanging.traceContext({ active: true }),
    (error) => error instanceof DiagnosticCollectorGatewayError
      && error.status === 503 && error.code === "collector_unavailable");
});

test("producer collector profile enforces its exact 8 KiB response cap", async () => {
  const client = createDiagnosticCollectorClient({
    origin: "http://diagnostics:3020",token,maxResponseBytes: 8192,
    fetchImpl: async () => new Response("x".repeat(8193)),
  });
  await assert.rejects(() => client.traceContext({ active: true }),
    (error) => error instanceof DiagnosticCollectorGatewayError
      && error.code === "collector_response_invalid");
});
