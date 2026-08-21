import { playbackTransitionRoute } from "../../../../../../../../lib/server/release/playback-routes.mjs";
import { releaseRuntime } from "../../../../../../../../lib/server/release/runtime.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ gameId: string; commandId: string }> },
) {
  const { gameId, commandId } = await context.params;
  return playbackTransitionRoute(request, releaseRuntime, gameId, commandId);
}
