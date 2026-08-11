import {
  authenticateManagedAudioSource,
  completeManagedAudioCommand,
  pollManagedAudioSource,
} from "../../../lib/server/managed-audio";
import { observeRoute } from "../../../lib/server/observability";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function response(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

async function postAudioSource(request: Request) {
  const source = authenticateManagedAudioSource(request.headers.get("authorization"));
  if (!source) return response({ error: "Managed source authentication required." }, 401);

  let payload: Record<string, unknown>;
  try {
    payload = await request.json() as Record<string, unknown>;
  } catch {
    return response({ error: "A JSON request body is required." }, 400);
  }
  const action = String(payload.action ?? "");
  const deviceId = typeof payload.deviceId === "string" && payload.deviceId.length <= 200
    ? payload.deviceId
    : null;

  if (action === "poll") {
    return response(pollManagedAudioSource(source.id, deviceId));
  }

  if (action === "complete") {
    const commandId = String(payload.commandId ?? "");
    const playbackStatus = String(payload.playbackStatus ?? "");
    if (!/^[0-9a-f-]{36}$/.test(commandId)) return response({ error: "Command ID is invalid." }, 400);
    if (!["ready", "playing", "paused", "error"].includes(playbackStatus)) {
      return response({ error: "Playback status is invalid." }, 400);
    }
    const completed = completeManagedAudioCommand(
      source.id,
      commandId,
      payload.ok === true,
      playbackStatus as "ready" | "playing" | "paused" | "error",
      typeof payload.error === "string" ? payload.error : null,
      deviceId,
    );
    return completed
      ? response({ completed: true })
      : response({ error: "Command was not pending for this source." }, 409);
  }

  return response({ error: "Unknown managed source action." }, 400);
}

// The authenticated source controller is an internal hop and may continue the
// correlation reference generated for its command. Public routes never do.
export const POST = observeRoute(postAudioSource, {
  acceptCorrelationId: (request) => Boolean(
    authenticateManagedAudioSource(request.headers.get("authorization")),
  ),
});
