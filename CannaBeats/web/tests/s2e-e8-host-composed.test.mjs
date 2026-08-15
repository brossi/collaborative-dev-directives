import assert from "node:assert/strict";
import { createHash,randomUUID } from "node:crypto";
import { mkdtempSync,rmSync,writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createDiagnosticService } from "../../diagnostics-service/src/server.mjs";
import { openDatabase,sha256 } from "../../spikes/access-spotify-poc/db.mjs";
import { createApp,readConfig } from "../../spikes/access-spotify-poc/server.mjs";
import { StateOwner } from "../../state-service/src/owner.mjs";
import { createStateServer } from "../../state-service/src/server.mjs";
import { createAccessGatewayClient } from "../lib/server/access-gateway.mjs";
import { createDiagnosticCollectorClient } from "../lib/server/diagnostic-collector-client.mjs";
import { createDiagnosticMediation } from "../lib/server/diagnostic-mediation.mjs";
import { createDiagnosticRouteHandlers } from "../lib/server/diagnostic-routes.mjs";
import { createGameStateClient } from "../lib/server/state-client.mjs";

const listen = (service) => new Promise((resolve,reject) => {
  const server = service.listen(0,"127.0.0.1",() => resolve({
    server,origin: `http://127.0.0.1:${server.address().port}`,
  }));
  server.once("error",reject);
});
const close = (server) => new Promise((resolve) => server.close(resolve));

test("composed host mediation replays after collector commit and response loss", async () => {
  const root = mkdtempSync(join(tmpdir(),"cannabeats-e83a-composed-"));
  const hostId = randomUUID();
  const memberId = randomUUID();
  const runId = randomUUID();
  const sourceId = randomUUID();
  const sessionToken = `host-session-${randomUUID()}`;
  const memberSessionToken = `member-session-${randomUUID()}`;
  const accessGameToken = "access-game-scope-token-0000000001";
  const collectorGameToken = "collector-game-scope-token-000001";
  const collectorMaintenanceToken = "collector-maintenance-token-000001";
  const stateCredentials = {
    activationToken: "state-activation-token",operatorToken: "state-operator-token",
    accessToken: "state-access-token",gameToken: "state-game-token",
    accessPrincipalAssertionKey: "state-access-principal-assertion",
    gamePrincipalAssertionKey: "state-game-principal-assertion",
  };
  let accessServer;
  let stateServer;
  let stateOrigin;
  let diagnostics;
  let accessDb;
  try {
    const statePath = join(root,"state.sqlite");
    const owner = new StateOwner(statePath,{ allowDevelopmentActivation: true });
    owner.activate({ now: 1 });
    owner.createLobby({ commandId: randomUUID(),code: "E83A23",hostPrincipalId: hostId,now: 2 });
    owner.createRun({
      commandId: randomUUID(),lobbyCode: "E83A23",runId,actorPrincipalId: hostId,now: 3,
    });
    owner.registerManagedSource({
      commandId: randomUUID(),sourceId,displayName: "Composed source",
      tokenHash: createHash("sha256").update("composed-source-token").digest("hex"),now: 4,
    });
    owner.acquireManagedLease({
      commandId: randomUUID(),lobbyCode: "E83A23",sourceId,
      actorPrincipalId: hostId,leaseDurationMs: 600_000,now: 5,
    });
    owner.close();
    stateServer = createStateServer({
      databasePath: statePath,credentials: stateCredentials,clock: () => 100,
    });
    ({ server: stateServer,origin: stateOrigin } = await listen(stateServer));

    const accessPath = join(root,"access.sqlite");
    const hostReleasePath = join(root,"host-release.dmg");
    writeFileSync(hostReleasePath,"test host release");
    const accessConfig = readConfig({
      origin: "http://access.test",rpID: "access.test",databasePath: accessPath,
      gameServiceOrigin: "http://game.test",gameServiceToken: accessGameToken,
      hostReleasePath,hostReleaseName: "host-release.dmg",hostReleaseChannel: "interim",
      environment: "test",applicationVersion: "test",catalogVersion: "test",port: 0,
    });
    accessDb = openDatabase(accessPath);
    const now = Date.now();
    accessDb.prepare("INSERT INTO users (id,display_name,role,created_at) VALUES (?,?,'host',?)")
      .run(hostId,"Composed Host",now);
    accessDb.prepare("INSERT INTO users (id,display_name,role,created_at) VALUES (?,?,'player',?)")
      .run(memberId,"Composed Member",now);
    accessDb.prepare(`INSERT INTO sessions
      (token_hash,user_id,created_at,expires_at,last_seen_at) VALUES (?,?,?,?,?)`)
      .run(sha256(sessionToken),hostId,now,now + 60_000,now);
    accessDb.prepare(`INSERT INTO sessions
      (token_hash,user_id,created_at,expires_at,last_seen_at) VALUES (?,?,?,?,?)`)
      .run(sha256(memberSessionToken),memberId,now,now + 60_000,now);
    const accessApp = createApp({ config: accessConfig,db: accessDb,logWrite: () => {} }).app;
    let accessOrigin;
    ({ server: accessServer,origin: accessOrigin } = await listen(accessApp));

    const diagnosticsPath = join(root,"diagnostics.sqlite");
    const diagnosticsOptions = {
      databasePath: diagnosticsPath,host: "127.0.0.1",
      authenticatedApi: {
        gameToken: collectorGameToken,maintenanceToken: collectorMaintenanceToken,
      },
      volumeTopology: { diagnostics: "diag-test",access: "access-test",state: "state-test" },
      clock: () => 100,
    };
    diagnostics = createDiagnosticService({ ...diagnosticsOptions,port: 0 });
    const diagnosticsAddress = await diagnostics.start();
    const diagnosticsOrigin = `http://127.0.0.1:${diagnosticsAddress.port}`;

    const accessClient = createAccessGatewayClient({ origin: accessOrigin,token: accessGameToken });
    const stateClient = createGameStateClient({
        origin: stateOrigin,token: stateCredentials.gameToken,
        principalAssertionKey: stateCredentials.gamePrincipalAssertionKey,clock: () => 100,
      });
    assert.equal((await accessClient.principal({
      authorization: "",cookie: `cb_session=${sessionToken}`,
    })).principal.id,hostId);
    assert.equal((await stateClient.diagnosticRunHost({ runId,principalId: hostId })).isHost,true);
    assert.equal((await stateClient.diagnosticManagedStream()).runId,runId);
    let loseStartResponse = true;
    const collectorClient = createDiagnosticCollectorClient({
      origin: diagnosticsOrigin,token: collectorGameToken,
      fetchImpl: async (url,options) => {
        const response = await fetch(url,options);
        if (loseStartResponse && new URL(url).pathname === "/v1/game/trace/start") {
          loseStartResponse = false;
          await response.arrayBuffer();
          throw new Error("simulated response loss");
        }
        return response;
      },
    });
    assert.deepEqual(await collectorClient.traceContext({ active: true }),{
      status: "trace_absent",
    });
    const mediation = createDiagnosticMediation({
      access: accessClient,
      state: {
        runHost: (value) => stateClient.diagnosticRunHost(value),
        managedStream: (value) => stateClient.diagnosticManagedStream(value),
      },
      collector: collectorClient,
      clock: () => 100,
    });
    const routes = createDiagnosticRouteHandlers({ mediation });
    const requestId = randomUUID();
    const startedResponse = await routes.trace(new Request("http://game.test/api/diagnostics/trace",{
      method: "POST",headers: {
        origin: "http://game.test","content-type": "application/json",
        cookie: `cb_session=${sessionToken}`,
      },body: JSON.stringify({ action: "start",requestId,runId }),
    }));
    assert.equal(startedResponse.status,503);
    assert.equal((await startedResponse.json()).code,"collector_unavailable");

    await diagnostics.close();
    diagnostics = createDiagnosticService({ ...diagnosticsOptions,port: diagnosticsAddress.port });
    await diagnostics.start();

    const acceptedRetry = await routes.trace(new Request("http://game.test/api/diagnostics/trace",{
      method: "POST",headers: {
        origin: "http://game.test","content-type": "application/json",
        cookie: `cb_session=${sessionToken}`,
      },body: JSON.stringify({ action: "start",requestId,runId }),
    }));
    assert.equal(acceptedRetry.status,200,await acceptedRetry.clone().text());
    const started = await acceptedRetry.json();
    assert.equal(started.status,"active");
    assert.equal(started.runId,runId);

    const replayResponse = await routes.trace(new Request("http://game.test/api/diagnostics/trace",{
      method: "POST",headers: {
        origin: "http://game.test","content-type": "application/json",
        cookie: `cb_session=${sessionToken}`,
      },body: JSON.stringify({ action: "start",requestId,runId }),
    }));
    assert.equal(replayResponse.status,200);
    assert.deepEqual(await replayResponse.json(),started);

    const pageResponse = await routes.report(new Request("http://game.test/api/diagnostics/report",{
      method: "POST",headers: {
        origin: "http://game.test","content-type": "application/json",
        cookie: `cb_session=${sessionToken}`,
      },body: JSON.stringify({ traceId: started.traceId,cursor: null }),
    }));
    assert.equal(pageResponse.status,200);
    const page = await pageResponse.json();
    assert.equal(page.status,"found");
    assert.equal(page.complete,true);

    const denied = await routes.trace(new Request("http://game.test/api/diagnostics/trace",{
      method: "POST",headers: {
        origin: "http://game.test","content-type": "application/json",
        cookie: `cb_session=${memberSessionToken}`,
      },body: JSON.stringify({ action: "status",traceId: started.traceId }),
    }));
    assert.equal(denied.status,404);
    assert.deepEqual(await denied.json(),{
      error: "Diagnostic trace not found.",code: "diagnostic_not_found",
    });
  } finally {
    if (diagnostics) await diagnostics.close();
    if (accessServer?.listening) await close(accessServer);
    accessDb?.close();
    if (stateServer?.listening) await close(stateServer);
    rmSync(root,{ recursive: true,force: true });
  }
});
