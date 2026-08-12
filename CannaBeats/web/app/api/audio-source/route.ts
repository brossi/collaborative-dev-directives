import {
  authenticateManagedAudioSource,
  beginManagedAudioCommand,
  claimManagedAudioCommand,
  completeManagedAudioCommand,
  markManagedAudioCommandOutcomeUnknown,
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
  if (action === "poll") {
    return response(pollManagedAudioSource(source.id));
  }

  const commandId = String(payload.commandId ?? "");
  const claimGeneration = String(payload.claimGeneration ?? "");
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (["claim", "begin", "outcome_unknown", "complete"].includes(action)) {
    if (!uuidPattern.test(commandId)) return response({ error: "Command ID is invalid." }, 400);
    if (!uuidPattern.test(claimGeneration)) return response({ error: "Claim generation is invalid." }, 400);
  }

  if (action === "outcome_unknown") {
    try {
      const result = markManagedAudioCommandOutcomeUnknown(
        source.id, commandId, claimGeneration,
      );
      if (result.status === "missing") return response({ error: "Command was not found for this source." }, 409);
      return response({ accepted: true, status: result.status, replayed: result.replayed });
    } catch (error) {
      if (error instanceof Error && (
        error.message.includes("generation conflict")
        || error.message.includes("forbidden transition")
      )) {
        return response({ error: "Command is not in a valid state for unknown reconciliation." }, 409);
      }
      throw error;
    }
  }

  if (action === "claim" || action === "begin") {
    try {
      const result = action === "claim"
        ? claimManagedAudioCommand(source.id, commandId, claimGeneration)
        : beginManagedAudioCommand(source.id, commandId, claimGeneration);
      if (result.status === "missing") return response({ error: "Command was not found for this source." }, 409);
      return response({ accepted: true, status: result.status, replayed: result.replayed });
    } catch (error) {
      if (error instanceof Error && error.message.includes("conflict")) {
        return response({ error: "Command claim conflicts with its recorded generation." }, 409);
      }
      if (error instanceof Error && error.message.includes("forbidden transition")) {
        return response({ error: "Command is not in a valid state for this action." }, 409);
      }
      throw error;
    }
  }

  if (action === "complete") {
    const playbackStatus = String(payload.playbackStatus ?? "");
    if (typeof payload.ok !== "boolean") return response({ error: "Completion result is invalid." }, 400);
    if (!["ready", "playing", "paused", "error"].includes(playbackStatus)) {
      return response({ error: "Playback status is invalid." }, 400);
    }
    let completion: ReturnType<typeof completeManagedAudioCommand>;
    try {
      completion = completeManagedAudioCommand(
        source.id,
        commandId,
        payload.ok === true,
        playbackStatus as "ready" | "playing" | "paused" | "error",
        typeof payload.error === "string" ? payload.error : null,
        claimGeneration,
        payload.protocolVersion === 1 ? 1 : 2,
      );
    } catch (error) {
      if (error instanceof Error && error.message.includes("completion state does not match")) {
        return response({ error: "Command completion state does not match its requested action." }, 400);
      }
      if (error instanceof Error && (
        error.message.includes("generation conflict")
        || error.message.includes("forbidden transition")
      )) {
        return response({ error: "Command is not in a valid state for this completion." }, 409);
      }
      throw error;
    }
    if (completion.status === "completed") return response({ completed: true, replayed: false });
    if (completion.status === "replayed") return response({ completed: true, replayed: true });
    return response({
      error: completion.status === "conflict"
        ? "Command completion conflicts with its recorded outcome."
        : "Command was not found for this source.",
    }, 409);
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
