import { createDiagnosticListenerRouteHandlers } from "../../../../lib/server/diagnostic-routes.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return createDiagnosticListenerRouteHandlers().listenerReport(request);
}
