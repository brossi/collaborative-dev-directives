import { observeRoute } from "../../../lib/server/observability";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function getHealth() {
  return Response.json(
    { ok: true, service: "cannabeats-game" },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export const GET = observeRoute(getHealth);
