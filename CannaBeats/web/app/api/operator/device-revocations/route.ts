import { operatorDeviceRevocationRoute } from "../../../../lib/server/release/operator-routes.mjs";
import { releaseRuntime } from "../../../../lib/server/release/runtime.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(request: Request) {
  return operatorDeviceRevocationRoute(request, releaseRuntime);
}
