import { deviceListRoute } from "../../../../lib/server/release/host-routes.mjs";
import { releaseRuntime } from "../../../../lib/server/release/runtime.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return deviceListRoute(request, releaseRuntime);
}
