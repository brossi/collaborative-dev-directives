import type { GameRules } from "./rules";

export type Phase = "lobby" | "ready" | "playing" | "placed" | "revealed" | "finished";
export type PlayerControl = "phone" | "host";

export function normalizePlayerControl(value: unknown, legacyInputMode?: unknown): PlayerControl {
  if (value === "phone" || value === "host") return value;
  return legacyInputMode === "host-screen" ? "host" : "phone";
}

export type Song = {
  title: string;
  artist: string;
  /** Chart year — when the song was a hit. The default answer a card asks for. */
  year: number;
  /** Publication year — when the recording first entered circulation. Absent
   *  where no source has it. Differs from `year` by decades for revivals. */
  releaseYear?: number;
  uri?: string;
};

export type Player = {
  id: string;
  name: string;
  control: PlayerControl;
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
  retractionUsed: boolean;
  result: PlacementResult | null;
  winnerId: string | null;
  rules: GameRules;
  usedUris: string[];
};

export type RoomView = Omit<RoomState, "usedUris"> & {
  isHost: boolean;
};
