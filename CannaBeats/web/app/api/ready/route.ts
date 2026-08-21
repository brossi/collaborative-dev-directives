import catalog from "../../../data/catalog.json";
import catalogManifest from "../../../data/catalog-manifest.json";
import { database } from "../../../lib/server/database";
import { observeRoute } from "../../../lib/server/observability";
import { accessGatewayConfigured } from "../../../lib/server/access-gateway.mjs";
import { stateGatewayConfigured } from "../../../lib/server/state-client.mjs";
import {
  releaseRuntime,
  unifiedRuntimeEnabled,
} from "../../../lib/server/release/runtime.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function getReadiness() {
  if (unifiedRuntimeEnabled()) {
    const readiness = releaseRuntime().readiness();
    return Response.json(readiness, {
      status: readiness.ready ? 200 : 503,
      headers: { "Cache-Control": "no-store" },
    });
  }
  try {
    let persistenceReady = false;
    if (stateGatewayConfigured() && accessGatewayConfigured()) {
      const [state,access] = await Promise.all([
        fetch(`${new URL(process.env.CANNABEATS_STATE_SERVICE_ORIGIN!).origin}/ready`, { cache: "no-store" }),
        fetch(`${new URL(process.env.CANNABEATS_ACCESS_SERVICE_INTERNAL_ORIGIN!).origin}/api/ready`, { cache: "no-store" }),
      ]);
      const stateBody = await state.json() as Record<string, unknown>;
      persistenceReady = state.ok && access.ok
        && stateBody.schemaGeneration === 4 && stateBody.protocolVersion === 4
        && stateBody.httpContractVersion === 1;
    } else {
      const databaseCheck = database().prepare("SELECT 1 AS ok").get() as { ok: number } | undefined;
      persistenceReady = databaseCheck?.ok === 1;
    }
    const configuredCatalogVersion = process.env.CANNABEATS_CATALOG_VERSION
      ?? catalogManifest.catalogVersion;
    if (!persistenceReady || !Array.isArray(catalog) || catalog.length === 0
        || catalogManifest.songCount !== catalog.length
        || !/^sha256:[0-9a-f]{64}$/.test(catalogManifest.catalogVersion)
        || configuredCatalogVersion !== catalogManifest.catalogVersion) {
      return Response.json(
        { ready: false, service: "cannabeats-game" },
        { status: 503, headers: { "Cache-Control": "no-store" } },
      );
    }
  } catch {
    return Response.json(
      { ready: false, service: "cannabeats-game" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
  return Response.json(
    { ready: true, service: "cannabeats-game" },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export const GET = observeRoute(getReadiness);
