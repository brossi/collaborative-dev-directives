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
    rotateSegment: ({ authority }) => ({ status: "accepted",state: collector.rotateSegment(authority) }),
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
  const mediation = createDiagnosticMediation({
    access: { principal: async () => ({ principal: { id: principalId } }) },
    state: {
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
    },
    collector: adapter,clock: () => now,
  });
  return {
    collector,mediation,authority,hostRuns,runId,leaseId,nextLeaseId,principalId,
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
