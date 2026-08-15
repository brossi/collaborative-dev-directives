import { readFileSync } from "node:fs";

import { createGameStateClient } from "./state-client.mjs";
import { createDiagnosticSourceStateClient } from "./diagnostic-source-state-client.mjs";
import { createDiagnosticCollectorClient } from "./diagnostic-collector-client.mjs";
import { createDiagnosticMediation,DiagnosticMediationError } from "./diagnostic-mediation.mjs";
import { createDiagnosticProducerMediation } from "./diagnostic-producer-mediation.mjs";
import {
  diagnosticRequestUuid,diagnosticRouteErrorResponse,exactDiagnosticRequest,
  readDiagnosticRequestBody,
} from "./diagnostic-routes.mjs";

function secret(valueName,fileName) {
  const direct = process.env[valueName]?.trim();
  if (direct) return direct;
  const path = process.env[fileName];
  return path ? readFileSync(path,"utf8").trim() : "";
}

let productionService = null;

function createProductionService() {
  const collector = () => createDiagnosticCollectorClient({ maxResponseBytes: 8_192 });
  const collectorBoundary = {
    traceContext: (value) => collector().traceContext(value),
    relayReceiptContext: (value) => collector().relayReceiptContext(value),
    relayBindingContext: (value) => collector().relayBindingContext(value),
    reportIdentityContext: (value) => collector().reportIdentityContext(value),
    issuanceContext: (value) => collector().issuanceContext(value),
    putIssuance: (value) => collector().putIssuance(value),
    bindRelay: (value) => collector().bindRelay(value),
    ingestReport: (value) => collector().ingestReport(value),
    endTrace: (value) => collector().endTrace(value),
    rotateSegment: (value) => collector().rotateSegment(value),
  };
  const relayState = {
    authority: (value) => createGameStateClient().diagnosticManagedStream(value),
  };
  const reconciler = createDiagnosticMediation({
    access: { principal: () => { throw new Error("producer_principal_forbidden"); } },
    state: {
      runHost: () => { throw new Error("producer_host_authority_forbidden"); },
      managedStream: relayState.authority,
    },
    collector: collectorBoundary,
  });
  return createDiagnosticProducerMediation({
    sourceState: createDiagnosticSourceStateClient(),relayState,
    collector: collectorBoundary,reconcile: reconciler.reconcile,
    relayToken: secret(
      "CANNABEATS_DIAGNOSTICS_RELAY_TOKEN","CANNABEATS_DIAGNOSTICS_RELAY_TOKEN_FILE",
    ),
    collectorGameToken: secret(
      "CANNABEATS_DIAGNOSTICS_GAME_TOKEN","CANNABEATS_DIAGNOSTICS_GAME_TOKEN_FILE",
    ),
  });
}

function authorization(request) {
  return request.headers.get("authorization") ?? "";
}

function noStore(value) {
  return Response.json(value,{ headers: { "Cache-Control": "no-store" } });
}

export function createDiagnosticProducerRouteHandlers({ mediation,bodyDeadlineMs } = {}) {
  const service = () => mediation ?? (productionService ??= createProductionService());
  const options = bodyDeadlineMs ? { deadlineMs: bodyDeadlineMs } : {};

  async function sourceReport(request) {
    try {
      const producer = service();
      const auth = await producer.authenticateSource(authorization(request));
      const body = await readDiagnosticRequestBody(request,options);
      if (body.action === "open") {
        exactDiagnosticRequest(body,["action","requestId","sourceInstanceId"]);
        return noStore(await producer.openSource({
          auth,requestId: diagnosticRequestUuid(body.requestId),
          sourceInstanceId: diagnosticRequestUuid(body.sourceInstanceId),
        }));
      }
      if (body.action === "synchronize") {
        exactDiagnosticRequest(body,["action","requestId","sourceGrantId"]);
        return noStore(await producer.synchronizeSource({
          auth,requestId: diagnosticRequestUuid(body.requestId),
          sourceGrantId: diagnosticRequestUuid(body.sourceGrantId),
        }));
      }
      exactDiagnosticRequest(body,["sourceGrantId","measurementCore","sampleObservation"]);
      return noStore(await producer.reportSource({
        auth,sourceGrantId: diagnosticRequestUuid(body.sourceGrantId),
        measurementCore: body.measurementCore,sampleObservation: body.sampleObservation,
      }));
    } catch (error) { return diagnosticRouteErrorResponse(error); }
  }

  async function relayGeneration(request) {
    try {
      const producer = service();
      producer.authenticateRelay(authorization(request));
      const body = await readDiagnosticRequestBody(request,options);
      if (body.action === "bind") {
        exactDiagnosticRequest(body,["action","requestId","relayGenerationId"]);
        return noStore(await producer.bindRelay({
          requestId: diagnosticRequestUuid(body.requestId),
          relayGenerationId: diagnosticRequestUuid(body.relayGenerationId),
        }));
      }
      if (body.action === "synchronize") {
        exactDiagnosticRequest(body,["action","requestId","relayGenerationId"]);
        return noStore(await producer.synchronizeRelay({
          requestId: diagnosticRequestUuid(body.requestId),
          relayGenerationId: diagnosticRequestUuid(body.relayGenerationId),
        }));
      }
      throw new DiagnosticMediationError(400,"request_invalid");
    } catch (error) { return diagnosticRouteErrorResponse(error); }
  }

  async function relayReport(request) {
    try {
      const producer = service();
      producer.authenticateRelay(authorization(request));
      const body = exactDiagnosticRequest(
        await readDiagnosticRequestBody(request,options),
        ["relayGenerationId","measurementCore","sampleObservation"],
      );
      return noStore(await producer.reportRelay({
        relayGenerationId: diagnosticRequestUuid(body.relayGenerationId),
        measurementCore: body.measurementCore,sampleObservation: body.sampleObservation,
      }));
    } catch (error) { return diagnosticRouteErrorResponse(error); }
  }

  return Object.freeze({ source: sourceReport,relayGeneration,relayReport });
}
