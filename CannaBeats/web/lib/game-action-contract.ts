type ActionPolicy = {
  authority: "host" | "member" | "active-player";
  returnsAudio: boolean;
  advancesRevision: true;
};

export const GAME_ACTION_POLICIES = {
  abandon: { authority: "host", returnsAudio: true, advancesRevision: true },
  audioAcquire: { authority: "host", returnsAudio: true, advancesRevision: true },
  audioSelect: { authority: "host", returnsAudio: true, advancesRevision: true },
  audioRelease: { authority: "host", returnsAudio: true, advancesRevision: true },
  audioControl: { authority: "member", returnsAudio: true, advancesRevision: true },
  addPlayer: { authority: "host", returnsAudio: false, advancesRevision: true },
  removePlayer: { authority: "host", returnsAudio: false, advancesRevision: true },
  rules: { authority: "host", returnsAudio: false, advancesRevision: true },
  start: { authority: "host", returnsAudio: false, advancesRevision: true },
  begin: { authority: "host", returnsAudio: true, advancesRevision: true },
  place: { authority: "active-player", returnsAudio: false, advancesRevision: true },
  retract: { authority: "active-player", returnsAudio: false, advancesRevision: true },
  reveal: { authority: "host", returnsAudio: false, advancesRevision: true },
  advance: { authority: "host", returnsAudio: true, advancesRevision: true },
  skip: { authority: "host", returnsAudio: true, advancesRevision: true },
} as const satisfies Record<string, ActionPolicy>;

export type RunBoundMutationAction = keyof typeof GAME_ACTION_POLICIES;

export const RUN_BOUND_MUTATION_ACTIONS = Object.freeze(
  Object.keys(GAME_ACTION_POLICIES) as RunBoundMutationAction[],
);

const RUN_BOUND_MUTATION_ACTION_SET = new Set<string>(RUN_BOUND_MUTATION_ACTIONS);

export function isRunBoundMutationAction(action: string): action is RunBoundMutationAction {
  return RUN_BOUND_MUTATION_ACTION_SET.has(action);
}

export const REVISION_ADVANCING_ACTIONS = new Set<string>(
  RUN_BOUND_MUTATION_ACTIONS.filter((action) => GAME_ACTION_POLICIES[action].advancesRevision),
);

export const AUDIO_RESPONSE_ACTIONS = new Set<string>(
  RUN_BOUND_MUTATION_ACTIONS.filter((action) => GAME_ACTION_POLICIES[action].returnsAudio),
);
