import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach,test } from "node:test";

import { DiagnosticCollector } from "../../diagnostics-service/src/collector.mjs";
import {
  createDiagnosticListenerMediation,createListenerGrantStore,
} from "../lib/server/diagnostic-listener-mediation.mjs";
import {
  createDiagnosticMediation,DiagnosticMediationError,
} from "../lib/server/diagnostic-mediation.mjs";

const roots = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop(),{ recursive: true,force: true });
});

async function fixture({ grants } = {}) {
  const root = mkdtempSync(join(tmpdir(),"cannabeats-e83b-"));
  roots.push(root);
  let now = 1_000;
  const collector = new DiagnosticCollector(join(root,"diagnostics.sqlite"),{ clock: () => now });
  const runId = randomUUID();
  const leaseId = randomUUID();
  const principalId = randomUUID();
  const listenerInstanceId = randomUUID();
  const headers = { authorization: "",cookie: "cb_session=test" };
  const authority = { runGeneration: 1,leaseId,memberStatus: "active",role: "member" };
  const access = { principal: async () => ({ principal: { id: principalId } }) };
  const state = {
    runHost: async () => ({
      authorityVersion: 1,status: "active",runId,runGeneration: authority.runGeneration,
      isHost: true,
    }),
    runMember: async ({ runId: requested,principalId: requestedPrincipal }) => {
      if (requested !== runId || requestedPrincipal !== principalId) {
        throw Object.assign(new Error("missing"),{ status: 404 });
      }
      return {
        authorityVersion: 1,status: authority.memberStatus,runId,
        runGeneration: authority.runGeneration,role: authority.role,
      };
    },
    managedStream: async () => ({
      authorityVersion: 1,status: "active",runId,runGeneration: authority.runGeneration,
      leaseId: authority.leaseId,sourceId: randomUUID(),leaseExpiresAt: now + 120_000,
    }),
  };
  const adapter = {
    traceContext: (locator) => collector.traceContext(locator),
    startReceiptContext: (requestId) => collector.traceStartReceiptContext(requestId),
    consentReceiptContext: (requestId,operation) => collector.consentReceiptContext(requestId,operation),
    reportIdentityContext: ({ traceId,instanceId,sequence }) => (
      collector.reportIdentityContext(traceId,instanceId,sequence)
    ),
    issuanceContext: (sampleId) => collector.issuanceContext(sampleId),
    putIssuance: ({ traceId,issuance }) => collector.putIssuance(traceId,issuance),
    optIn: ({ command,authority: operationAuthority }) => (
      collector.optIn(command,operationAuthority)
    ),
    stopSharing: ({ command,authority: operationAuthority }) => (
      collector.stopSharing(command,operationAuthority)
    ),
    ingestReport: ({ envelope,grantGeneration }) => collector.ingestReport(envelope,{
      receivedAt: now,grantGeneration,
    }),
    startTrace: ({ command,authority: operationAuthority }) => (
      collector.startTrace(command,operationAuthority)
    ),
    endTrace: ({ command,authority: operationAuthority }) => (
      collector.endTrace(command,operationAuthority)
    ),
    rotateSegment: ({ authority: operationAuthority }) => collector.rotateSegment(operationAuthority),
  };
  const host = createDiagnosticMediation({ access,state,collector: adapter,clock: () => now });
  await host.start({ headers,requestId: randomUUID(),runId });
  const listener = createDiagnosticListenerMediation({
    access,state,collector: adapter,reconcile: host.reconcile,grants,clock: () => now,
  });
  return {
    adapter,authority,collector,headers,listener,listenerInstanceId,principalId,runId,
    setNow: (value) => { now = value; },
  };
}

function listenerTransition(instanceId,sequence = 0) {
  return {
    schemaVersion: 1,kind: "listener_transition",instanceId,sequence,
    monotonicStartMs: 120 + sequence,durationMs: 0,
    measurements: {
      type: "request_started",category: "observed",
      connectionAttemptSequence: sequence,elapsedMs: 0,
    },
  };
}

test("listener opt-in returns one bounded grant and exact same-process replay", async () => {
  const f = await fixture();
  const input = {
    headers: f.headers,requestId: randomUUID(),runId: f.runId,
    listenerInstanceId: f.listenerInstanceId,firstAllowedSequence: 0,
    localConsentStartedMs: 100,
  };
  const accepted = await f.listener.optIn(input);
  assert.equal(accepted.status,"enabled");
  assert.equal(accepted.listenerInstanceId,f.listenerInstanceId);
  assert.deepEqual(await f.listener.optIn(input),accepted);
  await assert.rejects(() => f.listener.optIn({
    ...input,firstAllowedSequence: 1,
  }),(error) => error.code === "request_conflict");
  f.collector.close();
});

test("opt-in installs only the correlation reconciled after collector commit", async () => {
  const f = await fixture();
  const original = f.adapter.optIn;
  f.adapter.optIn = async (value) => {
    const result = original(value);
    f.authority.leaseId = randomUUID();
    return result;
  };
  const input = {
    headers: f.headers,requestId: randomUUID(),runId: f.runId,
    listenerInstanceId: f.listenerInstanceId,firstAllowedSequence: 0,
    localConsentStartedMs: 100,
  };
  const grant = await f.listener.optIn(input);
  assert.deepEqual(await f.listener.optIn(input),grant);
  assert.equal((await f.listener.synchronize({
    headers: f.headers,requestId: randomUUID(),grantId: grant.grantId,
  })).status,"accepted");
  f.collector.close();
});

test("opt-in commit with lost response reconciles from its same-process pending binding", async () => {
  const f = await fixture();
  const original = f.adapter.optIn;
  let lose = true;
  f.adapter.optIn = async (value) => {
    const result = original(value);
    if (lose) {
      lose = false;
      throw Object.assign(new Error("response lost"),{ status: 503 });
    }
    return result;
  };
  const input = {
    headers: f.headers,requestId: randomUUID(),runId: f.runId,
    listenerInstanceId: f.listenerInstanceId,firstAllowedSequence: 0,
    localConsentStartedMs: 100,
  };
  await assert.rejects(() => f.listener.optIn(input));
  assert.equal((await f.listener.optIn(input)).status,"enabled");
  f.collector.close();
});

test("retained consent without the memory principal binding fails closed after restart", async () => {
  const f = await fixture();
  const input = {
    headers: f.headers,requestId: randomUUID(),runId: f.runId,
    listenerInstanceId: f.listenerInstanceId,firstAllowedSequence: 0,
    localConsentStartedMs: 100,
  };
  await f.listener.optIn(input);
  const restarted = createDiagnosticListenerMediation({
    access: { principal: async () => ({ principal: { id: f.principalId } }) },
    state: {
      runMember: async () => ({
        authorityVersion: 1,status: "active",runId: f.runId,runGeneration: 1,role: "member",
      }),
    },
    collector: f.adapter,reconcile: async (trace) => trace,clock: () => 1_000,
  });
  await assert.rejects(() => restarted.optIn(input),(error) => (
    error instanceof DiagnosticMediationError && error.code === "grant_lost"
  ));
  const fresh = await restarted.optIn({ ...input,requestId: randomUUID() });
  assert.equal(fresh.generation,2);
  f.collector.close();
});

test("synchronization replay is bound to the grant's current trace segment", async () => {
  const f = await fixture();
  const grant = await f.listener.optIn({
    headers: f.headers,requestId: randomUUID(),runId: f.runId,
    listenerInstanceId: f.listenerInstanceId,firstAllowedSequence: 0,
    localConsentStartedMs: 100,
  });
  const request = { headers: f.headers,requestId: randomUUID(),grantId: grant.grantId };
  const issued = await f.listener.synchronize(request);
  assert.equal(issued.status,"accepted");
  assert.equal((await f.listener.synchronize(request)).status,"replayed");
  f.authority.leaseId = randomUUID();
  assert.equal((await f.listener.synchronize(request)).status,"replayed");
  await assert.rejects(() => f.listener.synchronize({
    headers: f.headers,requestId: randomUUID(),grantId: grant.grantId,
  }),(error) => error.code === "stale_correlation");
  f.collector.close();
});

test("grant store bounds records and concurrent tails at 31/32/33", async () => {
  let now = 100;
  const store = createListenerGrantStore({ clock: () => now });
  for (let index = 0; index < 31; index += 1) {
    store.rememberOptIn({
      requestId: randomUUID(),principalId: randomUUID(),runId: randomUUID(),
      listenerInstanceId: randomUUID(),expiresAtMs: 200,
    });
  }
  assert.equal(store.size(),31);
  store.rememberOptIn({
    requestId: randomUUID(),principalId: randomUUID(),runId: randomUUID(),
    listenerInstanceId: randomUUID(),expiresAtMs: 200,
  });
  assert.equal(store.size(),32);
  assert.throws(() => store.rememberOptIn({
    requestId: randomUUID(),principalId: randomUUID(),runId: randomUUID(),
    listenerInstanceId: randomUUID(),expiresAtMs: 200,
  }),(error) => error.code === "quota_exhausted");
  now = 200;
  assert.equal(store.size(),0);
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const operations = Array.from({ length: 32 },() => (
    store.serial(randomUUID(),async () => held)
  ));
  await assert.rejects(() => store.serial(randomUUID(),async () => {}),
    (error) => error.code === "quota_exhausted");
  release();
  await Promise.all(operations);

  let releaseSame;
  const sameHeld = new Promise((resolve) => { releaseSame = resolve; });
  const sameKey = randomUUID();
  const first = store.serial(sameKey,async () => sameHeld);
  const second = store.serial(sameKey,async () => "second");
  await assert.rejects(() => store.serial(sameKey,async () => "third"),
    (error) => error.code === "collector_busy");
  releaseSame();
  await Promise.all([first,second]);
});

test("accepted report replays after stop while unseen revoked work is rejected", async () => {
  const f = await fixture();
  const grant = await f.listener.optIn({
    headers: f.headers,requestId: randomUUID(),runId: f.runId,
    listenerInstanceId: f.listenerInstanceId,firstAllowedSequence: 0,
    localConsentStartedMs: 100,
  });
  const issued = await f.listener.synchronize({
    headers: f.headers,requestId: randomUUID(),grantId: grant.grantId,
  });
  const observation = {
    sampleId: issued.sampleId,instanceId: f.listenerInstanceId,
    localSendMs: 100,localReceiveMs: 120,
  };
  const report = {
    headers: f.headers,grantId: grant.grantId,
    measurementCore: listenerTransition(f.listenerInstanceId),
    sampleObservation: observation,
  };
  assert.equal((await f.listener.report(report)).status,"accepted");
  await assert.rejects(() => f.listener.report({
    ...report,measurementCore: { ...report.measurementCore,monotonicStartMs: 121 },
  }),(error) => error.code === "report_conflict");
  f.authority.memberStatus = "ended";
  await assert.rejects(() => f.listener.report({
    ...report,measurementCore: listenerTransition(f.listenerInstanceId,1),
  }),(error) => error.code === "stale_correlation");
  f.authority.memberStatus = "active";
  const stopped = await f.listener.stop({
    headers: f.headers,requestId: randomUUID(),grantId: grant.grantId,
  });
  assert.equal(stopped.status,"revoked");
  assert.equal((await f.listener.report(report)).status,"replayed");
  await assert.rejects(() => f.listener.report({
    ...report,measurementCore: listenerTransition(f.listenerInstanceId,1),
  }),(error) => error.code === "sharing_disabled");
  f.collector.close();
});

test("grant expiry equality and malformed retained receipt time fail finitely", async () => {
  const f = await fixture();
  const grant = await f.listener.optIn({
    headers: f.headers,requestId: randomUUID(),runId: f.runId,
    listenerInstanceId: f.listenerInstanceId,firstAllowedSequence: 0,
    localConsentStartedMs: 100,
  });
  const issued = await f.listener.synchronize({
    headers: f.headers,requestId: randomUUID(),grantId: grant.grantId,
  });
  const report = {
    headers: f.headers,grantId: grant.grantId,
    measurementCore: listenerTransition(f.listenerInstanceId),
    sampleObservation: {
      sampleId: issued.sampleId,instanceId: f.listenerInstanceId,
      localSendMs: 100,localReceiveMs: 120,
    },
  };
  await f.listener.report(report);
  const original = f.adapter.reportIdentityContext;
  f.adapter.reportIdentityContext = (value) => ({
    ...original(value),receivedAt: "private_database_path",
  });
  await assert.rejects(() => f.listener.report(report),
    (error) => error.code === "collector_response_invalid");
  f.setNow(901_000);
  await assert.rejects(() => f.listener.synchronize({
    headers: f.headers,requestId: randomUUID(),grantId: grant.grantId,
  }),(error) => error.code === "diagnostic_not_found");
  f.collector.close();
});
