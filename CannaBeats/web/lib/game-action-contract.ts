export const RUN_BOUND_MUTATION_ACTIONS = [
  "audioAcquire",
  "audioSelect",
  "audioRelease",
  "audioControl",
  "addPlayer",
  "removePlayer",
  "rules",
  "start",
  "begin",
  "place",
  "retract",
  "reveal",
  "advance",
  "skip",
] as const;

export type RunBoundMutationAction = typeof RUN_BOUND_MUTATION_ACTIONS[number];

const RUN_BOUND_MUTATION_ACTION_SET = new Set<string>(RUN_BOUND_MUTATION_ACTIONS);

export function isRunBoundMutationAction(action: string): action is RunBoundMutationAction {
  return RUN_BOUND_MUTATION_ACTION_SET.has(action);
}

export const ROOM_STATE_MUTATION_ACTIONS = new Set<string>([
  "addPlayer",
  "removePlayer",
  "rules",
  "start",
  "begin",
  "place",
  "retract",
  "reveal",
  "advance",
  "skip",
]);

export const AUDIO_RESPONSE_ACTIONS = new Set<string>([
  "audioAcquire",
  "audioSelect",
  "audioRelease",
  "audioControl",
  "begin",
  "advance",
  "skip",
]);
