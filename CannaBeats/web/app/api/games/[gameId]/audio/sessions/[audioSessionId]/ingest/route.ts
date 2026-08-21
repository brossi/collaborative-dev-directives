import { audioIngestRoute } from "../../../../../../../../lib/server/release/audio-routes.mjs";
import { releaseRuntime } from "../../../../../../../../lib/server/release/runtime.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ gameId: string; audioSessionId: string }> },
) {
  const { gameId, audioSessionId } = await context.params;
  return audioIngestRoute(request, releaseRuntime, gameId, audioSessionId);
}
