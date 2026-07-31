export type GameSession = {
  code: string;
  hostToken?: string;
  playerId?: string;
  joinOrigin?: string;
};

export const SESSION_KEY = "cannabeats-session";
