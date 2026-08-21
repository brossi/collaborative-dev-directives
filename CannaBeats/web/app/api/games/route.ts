import { gameCreateRoute } from "../../../lib/server/release/game-admission-routes.mjs";
import { releaseRuntime } from "../../../lib/server/release/runtime.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(request: Request) {
  return gameCreateRoute(request, releaseRuntime);
}
