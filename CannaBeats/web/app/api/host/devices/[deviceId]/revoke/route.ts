import { deviceRevokeRoute } from "../../../../../../lib/server/release/host-routes.mjs";
import { releaseRuntime } from "../../../../../../lib/server/release/runtime.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ deviceId: string }> },
) {
  const { deviceId } = await context.params;
  return deviceRevokeRoute(request, releaseRuntime, deviceId);
}
