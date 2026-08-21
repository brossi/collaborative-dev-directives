import { gameActionRoute } from "../../../../../lib/server/release/game-journey-routes.mjs";
import { releaseRuntime } from "../../../../../lib/server/release/runtime.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ gameId: string }> }) {
  const { gameId } = await context.params;
  return gameActionRoute(request, releaseRuntime, gameId);
}
