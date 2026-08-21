import { diagnosticExportRoute } from "../../../../../../lib/server/release/host-experience-routes.mjs";
import { releaseRuntime } from "../../../../../../lib/server/release/runtime.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ gameId: string }> }) {
  const { gameId } = await context.params;
  return diagnosticExportRoute(request, releaseRuntime, gameId);
}
