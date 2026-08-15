import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach,test } from "node:test";

import { DiagnosticCollector } from "../../diagnostics-service/src/collector.mjs";
import { createDiagnosticMediation } from "../lib/server/diagnostic-mediation.mjs";
import {
  createDiagnosticProducerMediation,createSourceGrantStore,
} from "../lib/server/diagnostic-producer-mediation.mjs";

const roots = [];
const SOURCE_TOKEN = "source-token-000000000000000000000000";
const RELAY_TOKEN = "relay-token-0000000000000000000000000";
const COLLECTOR_TOKEN = "collector-token-000000000000000000000";
afterEach(() => {
  while (roots.length) rmSync(roots.pop(),{ recursive: true,force: true });
});

async function fixture() {
  const root = mkdtempSync(join(tmpdir(),"cannabeats-e83c-"));
  roots.push(root);
  let now = 1_000;
  const collector = new DiagnosticCollector(join(root,"diagnostics.sqlite"),{ clock: () => now });
  const runId = randomUUID();
  const leaseId = randomUUID();
  const sourceId = randomUUID();
  const sourceInstanceId = randomUUID();
  const authority = { status: "active",runGeneration: 1,leaseId };
  const stream = () => authority.status === "absent"
    ? { authorityVersion: 1,status: "absent" }
    : {
      authorityVersion: 1,status: "active",runId,
      runGeneration: authority.runGeneration,leaseId: authority.leaseId,
      sourceId,leaseExpiresAt: now + 120_000,
    };
  const adapter = {
    traceContext: (locator) => collector.traceContext(locator),
    startReceiptContext: (requestId) => collector.traceStartReceiptContext(requestId),
    relayReceiptContext: (requestId) => collector.relayReceiptContext(requestId),
    relayBindingContext: (relayGenerationId) => collector.relayBindingContext(relayGenerationId),
    reportIdentityContext: ({ traceId,instanceId,sequence }) => (
      collector.reportIdentityContext(traceId,instanceId,sequence)
    ),
    issuanceContext: (sampleId) => collector.issuanceContext(sampleId),
    putIssuance: ({ traceId,issuance }) => collector.putIssuance(traceId,issuance),
    bindRelay: ({ command,authority: operationAuthority }) => (
      collector.bindRelay(command,operationAuthority)
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
  const state = {
    runHost: async () => ({
      authorityVersion: 1,status: "active",runId,runGeneration: authority.runGeneration,
      isHost: true,
    }),
    managedStream: async () => stream(),
  };
  const host = createDiagnosticMediation({
    access: { principal: async () => ({ principal: { id: randomUUID() } }) },
    state,collector: adapter,clock: () => now,
  });
  const started = await host.start({
    headers: { cookie: "cb_session=test" },requestId: randomUUID(),runId,
  });
  const createProducer = () => createDiagnosticProducerMediation({
    sourceState: { authority: async ({ authorization }) => {
      if (authorization !== `Bearer ${SOURCE_TOKEN}`) throw Object.assign(new Error("denied"),{
        status: 403,
      });
      return stream();
    } },
    relayState: { authority: async () => stream() },collector: adapter,
    reconcile: host.reconcile,relayToken: RELAY_TOKEN,collectorGameToken: COLLECTOR_TOKEN,
    clock: () => now,
  });
  return {
    adapter,authority,collector,createProducer,host,runId,sourceInstanceId,started,
    headers: { cookie: "cb_session=test" },
    setNow: (value) => { now = value; },
  };
}

function sourceTransition(instanceId,sequence = 0) {
  return {
    schemaVersion: 1,kind: "source_transition",instanceId,sequence,
    monotonicStartMs: 120 + sequence,durationMs: 0,
    measurements: { type: "capture_started",category: "observed" },
  };
}

function relayTransition(instanceId,sequence = 0) {
  return {
    schemaVersion: 1,kind: "relay_transition",instanceId,sequence,
    monotonicStartMs: 120 + sequence,durationMs: 0,
    measurements: { type: "generation_started",category: "observed" },
  };
}

test("source grant open is exact-replay safe and credential scoped", async () => {
  const f = await fixture();
  const producer = f.createProducer();
  const auth = await producer.authenticateSource(`Bearer ${SOURCE_TOKEN}`);
  const input = {
    auth,requestId: randomUUID(),sourceInstanceId: f.sourceInstanceId,
  };
  const opened = await producer.openSource(input);
  assert.equal(opened.status,"opened");
  assert.deepEqual(await producer.openSource(input),{ ...opened,status: "replayed" });
  await assert.rejects(() => producer.openSource({
    ...input,sourceInstanceId: randomUUID(),
  }),(error) => error.code === "request_conflict");
  await assert.rejects(() => producer.authenticateSource(`Bearer ${RELAY_TOKEN}`),
    (error) => error.code === "authentication_required");
  const restarted = f.createProducer();
  const restartedAuth = await restarted.authenticateSource(`Bearer ${SOURCE_TOKEN}`);
  await assert.rejects(() => restarted.synchronizeSource({
    auth: restartedAuth,requestId: randomUUID(),sourceGrantId: opened.sourceGrantId,
  }),(error) => error.code === "source_session_lost");
  f.collector.close();
});

test("source synchronization and report bind exact instance trace and retained replay", async () => {
  const f = await fixture();
  const producer = f.createProducer();
  const auth = await producer.authenticateSource(`Bearer ${SOURCE_TOKEN}`);
  const grant = await producer.openSource({
    auth,requestId: randomUUID(),sourceInstanceId: f.sourceInstanceId,
  });
  const issued = await producer.synchronizeSource({
    auth,requestId: randomUUID(),sourceGrantId: grant.sourceGrantId,
  });
  const observation = {
    sampleId: issued.sampleId,instanceId: f.sourceInstanceId,
    localSendMs: 100,localReceiveMs: 120,
  };
  const accepted = await producer.reportSource({
    auth,sourceGrantId: grant.sourceGrantId,
    measurementCore: sourceTransition(f.sourceInstanceId),sampleObservation: observation,
  });
  assert.equal(accepted.status,"accepted");
  const originalReportContext = f.adapter.reportIdentityContext;
  f.adapter.reportIdentityContext = async (locator) => {
    const retained = await originalReportContext(locator);
    if (retained.status !== "found") return retained;
    return {
      ...retained,envelope: {
        ...retained.envelope,serverContext: {
          ...retained.envelope.serverContext,runId: randomUUID(),
        },
      },
    };
  };
  await assert.rejects(() => producer.reportSource({
    auth,sourceGrantId: grant.sourceGrantId,
    measurementCore: sourceTransition(f.sourceInstanceId),sampleObservation: {},
  }),(error) => error.code === "report_conflict");
  f.adapter.reportIdentityContext = originalReportContext;
  assert.equal((await producer.reportSource({
    auth,sourceGrantId: grant.sourceGrantId,
    measurementCore: sourceTransition(f.sourceInstanceId),sampleObservation: {},
  })).status,"replayed");
  let lookupCount = 0;
  f.authority.leaseId = randomUUID();
  f.adapter.reportIdentityContext = async (locator) => {
    lookupCount += 1;
    return lookupCount === 1
      ? originalReportContext({
        traceId: locator.traceId,instanceId: locator.instanceId,sequence: 0,
      })
      : originalReportContext(locator);
  };
  await assert.rejects(() => producer.reportSource({
    auth,sourceGrantId: grant.sourceGrantId,
    measurementCore: sourceTransition(f.sourceInstanceId,1),sampleObservation: observation,
  }),(error) => error.code === "report_conflict");
  assert.equal(lookupCount,1);
  f.adapter.reportIdentityContext = originalReportContext;
  await assert.rejects(() => producer.reportSource({
    auth,sourceGrantId: grant.sourceGrantId,
    measurementCore: { ...sourceTransition(f.sourceInstanceId),monotonicStartMs: 121 },
    sampleObservation: observation,
  }),(error) => error.code === "report_conflict");
  await assert.rejects(() => producer.reportSource({
    auth,sourceGrantId: grant.sourceGrantId,
    measurementCore: sourceTransition(f.sourceInstanceId,1),sampleObservation: observation,
  }),(error) => error.code === "stale_correlation");
  f.collector.close();
});

test("relay binding survives mediation restart and never rebinds after handoff", async () => {
  const f = await fixture();
  let producer = f.createProducer();
  producer.authenticateRelay(`Bearer ${RELAY_TOKEN}`);
  const requestId = randomUUID();
  const relayGenerationId = randomUUID();
  const originalBind = f.adapter.bindRelay;
  let loseResponse = true;
  f.adapter.bindRelay = async (value) => {
    const result = await originalBind(value);
    if (loseResponse) {
      loseResponse = false;
      throw new Error("simulated response loss");
    }
    return result;
  };
  await assert.rejects(() => producer.bindRelay({ requestId,relayGenerationId }),
    /simulated response loss/);
  const accepted = await producer.bindRelay({ requestId,relayGenerationId });
  assert.equal(accepted.status,"replayed");
  f.adapter.bindRelay = originalBind;
  const synchronizeRequestId = randomUUID();
  const issuance = await producer.synchronizeRelay({
    requestId: synchronizeRequestId,relayGenerationId,
  });
  const report = await producer.reportRelay({
    relayGenerationId,measurementCore: relayTransition(relayGenerationId),
    sampleObservation: {
      sampleId: issuance.sampleId,instanceId: relayGenerationId,
      localSendMs: 100,localReceiveMs: 120,
    },
  });
  assert.equal(report.status,"accepted");
  await f.host.stop({
    headers: f.headers,requestId: randomUUID(),traceId: f.started.traceId,
  });
  assert.equal((await producer.synchronizeRelay({
    requestId: synchronizeRequestId,relayGenerationId,
  })).status,"replayed");
  producer = f.createProducer();
  assert.deepEqual(await producer.bindRelay({ requestId,relayGenerationId }),{
    ...accepted,status: "replayed",
  });
  f.authority.leaseId = randomUUID();
  assert.equal((await producer.bindRelay({ requestId,relayGenerationId })).leaseId,
    accepted.leaseId);
  assert.equal((await producer.reportRelay({
    relayGenerationId,measurementCore: relayTransition(relayGenerationId),
    sampleObservation: {},
  })).status,"replayed");
  await assert.rejects(() => producer.bindRelay({
    requestId,relayGenerationId: randomUUID(),
  }),(error) => error.code === "request_conflict");
  f.collector.close();
});

test("source grant store enforces advertised 7/8/9 capacity and same-key depth", async () => {
  const store = createSourceGrantStore({ maxGrants: 8,clock: () => 0 });
  const record = (id) => ({
    sourceGrantId: id,credentialFingerprint: "f",expiresAtMs: 10,
    retainedUntilMs: 20,
  });
  const ids = Array.from({ length: 9 },() => randomUUID());
  for (let index = 0; index < 7; index += 1) {
    store.install(randomUUID(),`fingerprint-${index}`,record(ids[index]));
  }
  assert.equal(store.size(),7);
  store.install(randomUUID(),"fingerprint-7",record(ids[7]));
  assert.equal(store.size(),8);
  assert.throws(() => store.install(randomUUID(),"fingerprint-8",record(ids[8])),
    (error) => error.code === "quota_exhausted");

  let release;
  const held = store.serial("same",() => new Promise((resolve) => { release = resolve; }));
  const queued = store.serial("same",async () => "queued");
  await assert.rejects(() => store.serial("same",async () => "third"),
    (error) => error.code === "collector_busy");
  release("held");
  assert.equal(await held,"held");
  assert.equal(await queued,"queued");
});

test("source grant expiry equality is deterministic", () => {
  let now = 9;
  const store = createSourceGrantStore({ clock: () => now });
  const sourceGrantId = randomUUID();
  store.install(randomUUID(),"request",{
    sourceGrantId,credentialFingerprint: "credential",expiresAtMs: 10,retainedUntilMs: 20,
  });
  assert.equal(store.find(sourceGrantId,"credential").sourceGrantId,sourceGrantId);
  now = 10;
  assert.throws(() => store.find(sourceGrantId,"credential"),
    (error) => error.code === "stale_correlation");
  now = 20;
  assert.throws(() => store.find(sourceGrantId,"credential",{ allowExpired: true }),
    (error) => error.code === "source_session_lost");
  assert.equal(store.size(),0);
});
