export type Phase = "lobby" | "playing" | "placed" | "revealed" | "finished";

export type Song = {
  title: string;
  artist: string;
  year: number;
  uri?: string;
};

export type Player = {
  id: string;
  name: string;
  timeline: Song[];
};

export type PlacementResult = {
  correct: boolean;
  index: number;
};

export type RoomState = {
  code: string;
  phase: Phase;
  players: Player[];
  activePlayerId: string | null;
  activePlayerIndex: number;
  round: number;
  currentSong: Song | null;
  placement: number | null;
  result: PlacementResult | null;
  winnerId: string | null;
  usedUris: string[];
};

export type RoomView = Omit<RoomState, "usedUris"> & {
  isHost: boolean;
};
