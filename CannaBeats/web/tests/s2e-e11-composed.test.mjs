import assert from "node:assert/strict";
import { createHash,randomUUID } from "node:crypto";
import { mkdtempSync,rmSync,writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createDiagnosticService } from "../../diagnostics-service/src/server.mjs";
import { createDiagnosticMaintenanceClient } from "../../diagnostics-service/src/maintenance-client.mjs";
import { openDatabase,sha256 } from "../../spikes/access-spotify-poc/db.mjs";
import { createApp,readConfig } from "../../spikes/access-spotify-poc/server.mjs";
import { StateOwner } from "../../state-service/src/owner.mjs";
import { createStateServer } from "../../state-service/src/server.mjs";
import { validateMeasurementJson } from "../lib/s2e-e1-contract.mjs";
import {
  acceptSynchronizationSample,composeUploadedEnvelope,
  createServerContextFixtureForTest,createSynchronizationIssuanceFixtureForTest,
  mapMeasurementAlignment,
} from "../lib/s2e-e2-correlation.mjs";
import { createAccessGatewayClient } from "../lib/server/access-gateway.mjs";
import { createDiagnosticCollectorClient } from "../lib/server/diagnostic-collector-client.mjs";
import { createDiagnosticMediation } from "../lib/server/diagnostic-mediation.mjs";
import { createDiagnosticRouteHandlers } from "../lib/server/diagnostic-routes.mjs";
import { createGameStateClient } from "../lib/server/state-client.mjs";

const bytes = (value) => Buffer.from(JSON.stringify(value));
const listen = (service) => new Promise((resolve,reject) => {
  const server = service.listen(0,"127.0.0.1",() => resolve({
    server,origin: `http://127.0.0.1:${server.address().port}`,
  }));
  server.once("error",reject);
});
const close = (server) => new Promise((resolve) => server.close(resolve));

function sourceReport(instanceId,sequence,start,overrides = {}) {
  return { schemaVersion: 1,kind: "source_window",instanceId,sequence,
    monotonicStartMs: start,durationMs: 10_000,measurements: {
      sampleRate: 48_000,channels: 2,encoding: "s16le",
      capturedFrames: sequence * 48_000,enqueuedFrames: sequence * 48_000,
      publishedFrames: sequence * 48_000,publishedBytes: sequence * 192_000,
      captureGapCount: 0,droppedUploadCount: 0,reconnectCount: 0,
      publisherRestartCount: 0,publisherState: "publishing",
      playbackObservation: "playing",...overrides,
    } };
}

function relayReport(instanceId,sequence,start,overrides = {}) {
  return { schemaVersion: 1,kind: "relay_window",instanceId,sequence,
    monotonicStartMs: start,durationMs: 10_000,measurements: {
      sampleRate: 48_000,channels: 2,encoding: "s16le",
      ingressFrames: sequence * 48_000,ingressBytes: sequence * 192_000,
      ingressGapCount: 0,rejectedIngressCount: 0,droppedIngressCount: 0,
      acceptedListenerCount: 2,closedListenerCount: 0,
      deliveredBytes: sequence * 192_000,backpressureClosureCount: 0,
      generationFenceDisconnectCount: 0,activeListenerCount: 2,...overrides,
    } };
}

function listenerReport(instanceId,start,overrides = {}) {
  return { schemaVersion: 1,kind: "listener_window",instanceId,sequence: 1,
    monotonicStartMs: start,durationMs: 10_000,measurements: {
      connectionAttemptSequence: 0,receivedBytes: 192_000,receivedFrames: 48_000,
      chunkCount: 100,chunkGap: { status: "observed",count: 99,meanMs: 10,maxMs: 20 },
      reconnectCount: 0,terminalCategory: "open",bufferDepth: {
        status: "observed",sampleCount: 10,currentMs: 400,minMs: 300,
        maxMs: 500,meanMs: 410,trendMsPerSecond: 2,
      },underrunCount: 0,underrunDurationMs: 0,reprimeCount: 0,
      windowStartedInUnderrun: false,overflowCount: 0,discardedFrames: 0,
      resetCount: 0,sourceSampleRate: 48_000,sourceChannels: 2,
      outputSampleRate: 48_000,nominalRateRatio: 1,audioContextState: "running",
      baseLatencyMs: { status: "observed",value: 12 },
      outputLatencyMs: { status: "unsupported" },visibilityState: "visible",
      suspensionCount: 0,longTasks: { status: "observed",count: 0,maxDurationMs: 0 },
      signalPresence: "present",clippingSeverity: "none",browserFamily: "safari",
      browserMajor: { status: "observed",value: 18 },osFamily: "ios",
      displayMode: "browser",implementationVersion: 1,...overrides,
    } };
}

function faultReports(kind,offset) {
  const source = randomUUID();
  const relay = randomUUID();
  const listeners = [randomUUID(),randomUUID()];
  const delivery = { reconnectCount: 1 };
  const buffer = { bufferDepth: {
    status: "observed",sampleCount: 10,currentMs: 99,minMs: 50,
    maxMs: 500,meanMs: 200,trendMsPerSecond: -1,
  } };
  const output = { audioContextState: "suspended",suspensionCount: 1 };
  if (kind === "missing") return [];
  const sourceCurrent = kind === "source_suspected" ? 20_000 : 70_000;
  const relayPrior = kind === "source_suspected" ? 30_000 : 10_000;
  const relayCurrent = ["source_suspected","relay_suspected"].includes(kind)
    ? 40_000 : 70_000;
  const listenerFault = ["source_suspected","relay_suspected",
    "listener_delivery_suspected"].includes(kind) ? delivery
    : kind === "listener_buffer_suspected" ? buffer
      : kind === "browser_output_suspected" ? output : {};
  return [
    ["source",sourceReport(source,0,offset)],
    ["source",sourceReport(source,1,offset + sourceCurrent,
      kind === "source_suspected" ? { captureGapCount: 1 } : {})],
    ["relay",relayReport(relay,0,offset + relayPrior)],
    ["relay",relayReport(relay,1,offset + relayCurrent,
      ["source_suspected","relay_suspected"].includes(kind)
        ? { ingressGapCount: 1 } : {})],
    ["listener",listenerReport(listeners[0],offset + 60_000,listenerFault)],
    ["listener",listenerReport(listeners[1],offset + 60_000,
      ["source_suspected","relay_suspected"].includes(kind) ? delivery : {})],
  ];
}

function comparisonRequest(traceId,cookie) {
  return new Request("http://game.test/api/diagnostics/comparison",{
    method: "POST",headers: {
      origin: "http://game.test","content-type": "application/json",cookie,
    },body: JSON.stringify({ traceId }),
  });
}

test("composed host comparison proves five fixed faults and missing evidence", async () => {
  const root = mkdtempSync(join(tmpdir(),"cannabeats-e11-composed-"));
  const hostId = randomUUID();
  const runId = randomUUID();
  const sourceId = randomUUID();
  const sessionToken = `host-session-${randomUUID()}`;
  const accessGameToken = "access-e11-game-scope-token-000001";
  const collectorGameToken = "collector-e11-game-scope-token-0001";
  const collectorMaintenanceToken = "collector-e11-maintenance-token-001";
  const stateCredentials = {
    activationToken: "state-activation-token",operatorToken: "state-operator-token",
    accessToken: "state-access-token",gameToken: "state-game-token",
    accessPrincipalAssertionKey: "state-access-principal-assertion",
    gamePrincipalAssertionKey: "state-game-principal-assertion",
  };
  let accessServer;
  let stateServer;
  let diagnostics;
  let accessDb;
  let now = 100;
  try {
    const statePath = join(root,"state.sqlite");
    const owner = new StateOwner(statePath,{ allowDevelopmentActivation: true });
    owner.activate({ now: 1 });
    owner.createLobby({ commandId: randomUUID(),code: "E11CMP",hostPrincipalId: hostId,now: 2 });
    owner.createRun({ commandId: randomUUID(),lobbyCode: "E11CMP",runId,
      actorPrincipalId: hostId,now: 3 });
    owner.registerManagedSource({ commandId: randomUUID(),sourceId,
      displayName: "Comparison source",
      tokenHash: createHash("sha256").update("comparison-source-token").digest("hex"),now: 4 });
    owner.acquireManagedLease({ commandId: randomUUID(),lobbyCode: "E11CMP",sourceId,
      actorPrincipalId: hostId,leaseDurationMs: 600_000,now: 5 });
    owner.close();
    ({ server: stateServer } = await listen(createStateServer({
      databasePath: statePath,credentials: stateCredentials,clock: () => now,
    })));
    const stateOrigin = `http://127.0.0.1:${stateServer.address().port}`;

    const accessPath = join(root,"access.sqlite");
    const hostReleasePath = join(root,"host-release.dmg");
    writeFileSync(hostReleasePath,"test host release");
    const accessConfig = readConfig({ origin: "http://access.test",rpID: "access.test",
      databasePath: accessPath,gameServiceOrigin: "http://game.test",
      gameServiceToken: accessGameToken,hostReleasePath,
      hostReleaseName: "host-release.dmg",hostReleaseChannel: "interim",
      environment: "test",applicationVersion: "test",catalogVersion: "test",port: 0 });
    accessDb = openDatabase(accessPath);
    const wallNow = Date.now();
    accessDb.prepare("INSERT INTO users (id,display_name,role,created_at) VALUES (?,?,'host',?)")
      .run(hostId,"Comparison Host",wallNow);
    accessDb.prepare(`INSERT INTO sessions
      (token_hash,user_id,created_at,expires_at,last_seen_at) VALUES (?,?,?,?,?)`)
      .run(sha256(sessionToken),hostId,wallNow,wallNow + 60_000,wallNow);
    ({ server: accessServer } = await listen(
      createApp({ config: accessConfig,db: accessDb,logWrite: () => {} }).app,
    ));
    const accessOrigin = `http://127.0.0.1:${accessServer.address().port}`;

    diagnostics = createDiagnosticService({ databasePath: join(root,"diagnostics.sqlite"),
      host: "127.0.0.1",port: 0,authenticatedApi: {
        gameToken: collectorGameToken,maintenanceToken: collectorMaintenanceToken,
      },volumeTopology: { diagnostics: "diag",access: "access",state: "state" },
      clock: () => now });
    const address = await diagnostics.start();
    const collector = createDiagnosticCollectorClient({
      origin: `http://127.0.0.1:${address.port}`,token: collectorGameToken,
    });
    const state = createGameStateClient({ origin: stateOrigin,token: stateCredentials.gameToken,
      principalAssertionKey: stateCredentials.gamePrincipalAssertionKey,clock: () => now });
    const mediation = createDiagnosticMediation({
      access: createAccessGatewayClient({ origin: accessOrigin,token: accessGameToken }),
      state: { runHost: (value) => state.diagnosticRunHost(value),
        managedStream: (value) => state.diagnosticManagedStream(value) },
      collector,clock: () => now,
    });
    const routes = createDiagnosticRouteHandlers({ mediation });
    const cookie = `cb_session=${sessionToken}`;
    let firstTraceId = null;
    let finalTraceId = null;

    const cases = ["source_suspected","relay_suspected","listener_delivery_suspected",
      "listener_buffer_suspected","browser_output_suspected","missing"];
    for (let caseIndex = 0; caseIndex < cases.length; caseIndex += 1) {
      const expected = cases[caseIndex];
      if (caseIndex > 0) now += 1;
      const started = await mediation.start({
        headers: { authorization: "",cookie },requestId: randomUUID(),runId,
      });
      firstTraceId ??= started.traceId;
      finalTraceId = started.traceId;
      const found = await collector.traceContext({ traceId: started.traceId });
      assert.equal(found.status,"found");
      const trace = found.state;
      const reports = faultReports(expected,now + 1_000);
      const prepared = new Set();
      for (const [family,reportValue] of reports) {
        const report = validateMeasurementJson(bytes(reportValue));
        const sampleId = randomUUID();
        const issuance = createSynchronizationIssuanceFixtureForTest(bytes({
          sampleId,timebaseId: trace.traceId,instanceId: report.instanceId,
          serverReceiveMs: report.monotonicStartMs,serverSendMs: report.monotonicStartMs,
        }));
        assert.equal((await collector.putIssuance({ traceId: trace.traceId,issuance })).status,
          "accepted");
        if (!prepared.has(report.instanceId) && family === "relay") {
          const result = await collector.bindRelay({
            command: { requestId: randomUUID(),operation: "relay_bind",
              parameters: { relayGenerationId: report.instanceId } },
            authority: { authorityVersion: 1,operation: "relay_bind",traceId: trace.traceId,
              segmentId: trace.segment.segmentId,leaseId: trace.segment.leaseId,
              relayGenerationId: report.instanceId },
          });
          assert.equal(result.status,"accepted");
        }
        if (!prepared.has(report.instanceId) && family === "listener") {
          const result = await collector.optIn({
            command: { requestId: randomUUID(),operation: "consent_opt_in",parameters: {
              listenerInstanceId: report.instanceId,firstAllowedSequence: 0,
              localConsentStartedMs: report.monotonicStartMs - 1,
            } },
            authority: { authorityVersion: 1,operation: "consent_opt_in",nowMs: now,
              traceId: trace.traceId,listenerInstanceId: report.instanceId },
          });
          assert.equal(result.status,"accepted");
        }
        prepared.add(report.instanceId);
        const sample = acceptSynchronizationSample(bytes({
          sampleId,instanceId: report.instanceId,localSendMs: report.monotonicStartMs,
          localReceiveMs: report.monotonicStartMs,
        }),issuance);
        const authority = family === "source"
          ? { authorityKind: "source",role: "source",sourceId,
            sourceInstanceId: report.instanceId }
          : family === "relay"
            ? { authorityKind: "relay",role: "relay",relayGenerationId: report.instanceId }
            : { authorityKind: "listener",role: "member",
              listenerInstanceId: report.instanceId };
        const context = createServerContextFixtureForTest(bytes({
          contextVersion: 1,traceId: trace.traceId,runId: trace.runId,
          runGeneration: trace.runGeneration,correlationSegmentId: trace.segment.segmentId,
          leaseId: trace.segment.leaseId,...authority,
        }));
        const envelope = composeUploadedEnvelope(
          report,mapMeasurementAlignment(report,sample),context,
        );
        now = Math.max(now,report.monotonicStartMs + 10_001);
        const ingested = await collector.ingestReport({
          envelope,grantGeneration: family === "listener" ? 1 : null,
        });
        assert.equal(ingested.status,"accepted");
      }

      const response = await routes.comparison(comparisonRequest(started.traceId,cookie));
      assert.equal(response.status,200,await response.clone().text());
      const comparison = await response.json();
      assert.equal(comparison.diagnosis.result,
        expected === "missing" ? "insufficient_evidence" : expected,
        JSON.stringify(comparison));
      assert.equal(comparison.reportCount,reports.length);
      assert.equal(response.headers.get("cache-control"),"no-store");
      assert.equal(JSON.stringify(comparison).includes(sourceId),false);

      now += 1;
      const stopped = await mediation.stop({ headers: { authorization: "",cookie },
        requestId: randomUUID(),traceId: started.traceId });
      assert.equal(stopped.status,"ended");
      if (caseIndex === 0) {
        const endedResponse = await routes.comparison(comparisonRequest(started.traceId,cookie));
        assert.equal(endedResponse.status,200);
        assert.equal((await endedResponse.json()).diagnosis.result,expected);
      }
    }

    const maintenance = createDiagnosticMaintenanceClient({
      origin: `http://127.0.0.1:${address.port}`,token: collectorMaintenanceToken,
    });
    assert.equal((await maintenance.purge({
      requestId: randomUUID(),traceId: finalTraceId,
    })).status,"purged");
    const purged = await routes.comparison(comparisonRequest(finalTraceId,cookie));
    assert.equal(purged.status,404);
    assert.equal((await purged.json()).code,"diagnostic_not_found");

    await diagnostics.close();
    diagnostics = null;
    const unavailable = await routes.comparison(comparisonRequest(firstTraceId,cookie));
    assert.equal(unavailable.status,503);
    assert.equal((await unavailable.json()).code,"collector_unavailable");
    assert.equal((await state.diagnosticRunHost({ runId,principalId: hostId })).isHost,true);
  } finally {
    if (diagnostics) await diagnostics.close();
    if (accessServer?.listening) await close(accessServer);
    accessDb?.close();
    if (stateServer?.listening) await close(stateServer);
    rmSync(root,{ recursive: true,force: true });
  }
});
