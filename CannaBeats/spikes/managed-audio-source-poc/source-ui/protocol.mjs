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
