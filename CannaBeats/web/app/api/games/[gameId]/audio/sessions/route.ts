import { openAudioSessionRoute } from "../../../../../../lib/server/release/audio-routes.mjs";
import { releaseRuntime } from "../../../../../../lib/server/release/runtime.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ gameId: string }> }) {
  const { gameId } = await context.params;
  return openAudioSessionRoute(request, releaseRuntime, gameId);
}
