export function classifyManagedCommandFailure(stage) {
  if (stage === "prepare") return "failed";
  if (stage === "begin" || stage === "provider") return "outcome_unknown";
  throw new Error(`Unknown managed command execution stage: ${stage}`);
}
