export function classifyManagedCommandFailure(stage) {
  if (stage === "prepare") return "failed";
  if (stage === "begin" || stage === "provider") return "outcome_unknown";
  throw new Error(`Unknown managed command execution stage: ${stage}`);
}

export function shouldExecuteManagedControllerCommand(controller) {
  if (!controller || typeof controller !== "object" || Array.isArray(controller)) return false;
  if (controller.lease) return true;
  return controller.command?.handoff === true && controller.command?.kind === "pause";
}

export function reconcileManagedProviderObservation(command, playback) {
  if (!command || !playback || typeof playback.paused !== "boolean") return null;
  if (command.kind === "pause" && playback.paused) return "paused";
  if (command.kind === "resume" && !playback.paused) return "playing";
  if (command.kind === "play" && !playback.paused && typeof command.trackUri === "string"
      && playback.trackUri === command.trackUri) return "playing";
  return null;
}

export function classifyPlaybackObservation(playback) {
  if (!playback || typeof playback !== "object" || typeof playback.paused !== "boolean") {
    return "unknown";
  }
  return playback.paused ? "paused" : "playing";
}
