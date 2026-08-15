import { createDiagnosticProducerRouteHandlers } from "../../../../lib/server/diagnostic-producer-routes.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return createDiagnosticProducerRouteHandlers().source(request);
}
