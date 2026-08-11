import catalog from "../../../data/catalog.json";
import catalogManifest from "../../../data/catalog-manifest.json";
import { database } from "../../../lib/server/database";
import { observeRoute } from "../../../lib/server/observability";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function getReadiness() {
  const databaseCheck = database().prepare("SELECT 1 AS ok").get() as { ok: number } | undefined;
  const configuredCatalogVersion = process.env.CANNABEATS_CATALOG_VERSION
    ?? catalogManifest.catalogVersion;
  if (databaseCheck?.ok !== 1 || !Array.isArray(catalog) || catalog.length === 0
      || catalogManifest.songCount !== catalog.length
      || !/^sha256:[0-9a-f]{64}$/.test(catalogManifest.catalogVersion)
      || configuredCatalogVersion !== catalogManifest.catalogVersion) {
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
