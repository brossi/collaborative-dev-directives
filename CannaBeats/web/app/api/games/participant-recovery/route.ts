import { participantRecoveryRoute } from "../../../../lib/server/release/game-admission-routes.mjs";
import { releaseRuntime } from "../../../../lib/server/release/runtime.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return participantRecoveryRoute(request, releaseRuntime);
}
