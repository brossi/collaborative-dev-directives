import { challengeProveRoute } from "../../../../../lib/server/release/host-routes.mjs";
import { releaseRuntime } from "../../../../../lib/server/release/runtime.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(request: Request) {
  return challengeProveRoute(request, releaseRuntime);
}
