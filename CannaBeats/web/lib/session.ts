export type GameSession = {
  code: string;
  hostToken?: string;
  playerId?: string;
  joinOrigin?: string;
};

export const SESSION_KEY = "cannabeats-session";
export const PLAYER_NAME_KEY = "cannabeats-player-name";
export const HOST_RULES_KEY = "cannabeats-host-rules";
