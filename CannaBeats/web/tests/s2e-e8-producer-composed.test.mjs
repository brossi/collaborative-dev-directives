import assert from "node:assert/strict";
import { createHash,randomUUID } from "node:crypto";
import { mkdtempSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createDiagnosticService } from "../../diagnostics-service/src/server.mjs";
import { StateOwner } from "../../state-service/src/owner.mjs";
import { createStateServer } from "../../state-service/src/server.mjs";
import { createDiagnosticCollectorClient } from "../lib/server/diagnostic-collector-client.mjs";
import { createDiagnosticMediation } from "../lib/server/diagnostic-mediation.mjs";
import { createDiagnosticProducerMediation } from "../lib/server/diagnostic-producer-mediation.mjs";
import { createDiagnosticProducerRouteHandlers } from "../lib/server/diagnostic-producer-routes.mjs";
import { createDiagnosticSourceStateClient } from "../lib/server/diagnostic-source-state-client.mjs";
import { createGameStateClient } from "../lib/server/state-client.mjs";

const listen = (service) => new Promise((resolve,reject) => {
  const server = service.listen(0,"127.0.0.1",() => resolve({
    server,origin: `http://127.0.0.1:${server.address().port}`,
  }));
  server.once("error",reject);
});
const close = (server) => new Promise((resolve) => server.close(resolve));

function sourceTransition(instanceId) {
  return {
    schemaVersion: 1,kind: "source_transition",instanceId,sequence: 0,
    monotonicStartMs: 120,durationMs: 0,
    measurements: { type: "capture_started",category: "observed" },
  };
}

function routeRequest(body,token) {
  return new Request("http://game.test/api/diagnostics/source-report",{
    method: "POST",headers: {
      authorization: `Bearer ${token}`,"content-type": "application/json",
    },body: JSON.stringify(body),
  });
}

test("composed producer path authenticates through State and persists through collector HTTP", async () => {
  const root = mkdtempSync(join(tmpdir(),"cannabeats-e83c-composed-"));
  const hostId = randomUUID();
  const runId = randomUUID();
  const sourceId = randomUUID();
  const sourceToken = "source-composed-token-0000000000000001";
  const relayToken = "relay-composed-token-00000000000000001";
  const collectorGameToken = "collector-composed-game-token-00000001";
  const collectorMaintenanceToken = "collector-composed-maint-token-0000000";
  const stateCredentials = {
    activationToken: "state-activation-token",operatorToken: "state-operator-token",
    accessToken: "state-access-token",gameToken: "state-game-token",
    accessPrincipalAssertionKey: "state-access-principal-assertion",
    gamePrincipalAssertionKey: "state-game-principal-assertion",
  };
  let stateServer;
  let diagnostics;
  try {
    const statePath = join(root,"state.sqlite");
    const owner = new StateOwner(statePath,{ allowDevelopmentActivation: true });
    owner.activate({ now: 1 });
    owner.createLobby({ commandId: randomUUID(),code: "E83C23",hostPrincipalId: hostId,now: 2 });
    owner.createRun({
      commandId: randomUUID(),lobbyCode: "E83C23",runId,actorPrincipalId: hostId,now: 3,
    });
    owner.registerManagedSource({
      commandId: randomUUID(),sourceId,displayName: "Producer source",
      tokenHash: createHash("sha256").update(sourceToken).digest("hex"),now: 4,
    });
    owner.acquireManagedLease({
      commandId: randomUUID(),lobbyCode: "E83C23",sourceId,
      actorPrincipalId: hostId,leaseDurationMs: 600_000,now: 5,
    });
    owner.close();
    ({ server: stateServer } = await listen(createStateServer({
      databasePath: statePath,credentials: stateCredentials,clock: () => 100,
    })));
    const stateOrigin = `http://127.0.0.1:${stateServer.address().port}`;

    diagnostics = createDiagnosticService({
      databasePath: join(root,"diagnostics.sqlite"),host: "127.0.0.1",port: 0,
      authenticatedApi: {
        gameToken: collectorGameToken,maintenanceToken: collectorMaintenanceToken,
      },
      volumeTopology: { diagnostics: "diag",access: "access",state: "state" },
      clock: () => 100,
    });
    const address = await diagnostics.start();
    const collector = createDiagnosticCollectorClient({
      origin: `http://127.0.0.1:${address.port}`,token: collectorGameToken,
    });
    const gameState = createGameStateClient({
      origin: stateOrigin,token: stateCredentials.gameToken,
      principalAssertionKey: stateCredentials.gamePrincipalAssertionKey,clock: () => 100,
    });
    const host = createDiagnosticMediation({
      access: { principal: async () => ({ principal: { id: hostId } }) },
      state: {
        runHost: (value) => gameState.diagnosticRunHost(value),
        managedStream: (value) => gameState.diagnosticManagedStream(value),
      },collector,clock: () => 100,
    });
    await host.start({ headers: {},requestId: randomUUID(),runId });
    const producer = createDiagnosticProducerMediation({
      sourceState: createDiagnosticSourceStateClient({ origin: stateOrigin }),
      relayState: { authority: (value) => gameState.diagnosticManagedStream(value) },
      collector,reconcile: host.reconcile,relayToken,
      collectorGameToken,clock: () => 100,
    });
    const routes = createDiagnosticProducerRouteHandlers({ mediation: producer });
    const sourceInstanceId = randomUUID();
    const openedResponse = await routes.source(routeRequest({
      action: "open",requestId: randomUUID(),sourceInstanceId,
    },sourceToken));
    assert.equal(openedResponse.status,200,await openedResponse.clone().text());
    const opened = await openedResponse.json();
    assert.equal(opened.status,"opened");
    const syncResponse = await routes.source(routeRequest({
      action: "synchronize",requestId: randomUUID(),sourceGrantId: opened.sourceGrantId,
    },sourceToken));
    assert.equal(syncResponse.status,200,await syncResponse.clone().text());
    const issuance = await syncResponse.json();
    const reportResponse = await routes.source(routeRequest({
      sourceGrantId: opened.sourceGrantId,measurementCore: sourceTransition(sourceInstanceId),
      sampleObservation: {
        sampleId: issuance.sampleId,instanceId: sourceInstanceId,
        localSendMs: 100,localReceiveMs: 120,
      },
    },sourceToken));
    assert.equal(reportResponse.status,200,await reportResponse.clone().text());
    assert.equal((await reportResponse.json()).status,"accepted");
    const retained = await collector.reportIdentityContext({
      traceId: opened.traceId,instanceId: sourceInstanceId,sequence: 0,
    });
    assert.equal(retained.status,"found");
    assert.equal(retained.envelope.serverContext.sourceId,sourceId);
  } finally {
    if (diagnostics) await diagnostics.close();
    if (stateServer?.listening) await close(stateServer);
    rmSync(root,{ recursive: true,force: true });
  }
});
