import { observeRoute } from "../../../lib/server/observability";
import {
  releaseRuntime,
  unifiedRuntimeEnabled,
} from "../../../lib/server/release/runtime.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function getHealth() {
  const body = unifiedRuntimeEnabled() ? releaseRuntime().health() : {
    ok: true,
    service: "cannabeats-game",
  };
  return Response.json(
    body,
    { headers: { "Cache-Control": "no-store" } },
  );
}

export const GET = observeRoute(getHealth);
