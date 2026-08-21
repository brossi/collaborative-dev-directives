import { participantRemoveRoute } from "../../../../../../../lib/server/release/game-admission-routes.mjs";
import { releaseRuntime } from "../../../../../../../lib/server/release/runtime.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ gameId: string; participantId: string }> },
) {
  const { gameId, participantId } = await context.params;
  return participantRemoveRoute(request, releaseRuntime, gameId, participantId);
}
