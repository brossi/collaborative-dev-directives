import { env } from "cloudflare:workers";
import catalog from "../../../data/catalog.json";
import type { RoomState, RoomView, Song } from "../../../lib/game";

type RoomRow = {
  code: string;
  host_token: string;
  state: string;
};

let schemaReady: Promise<unknown> | undefined;

function database() {
  if (!env.DB) throw new Error("Room storage is unavailable.");
  schemaReady ??= env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS rooms (
      code TEXT PRIMARY KEY,
      host_token TEXT NOT NULL,
      state TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `).run();
  return env.DB;
}

async function ready() {
  database();
  await schemaReady;
}

function fail(message: string, status = 400) {
  return Response.json({ error: message }, { status });
}

function makeCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: 4 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
}

async function loadRoom(code: string) {
  await ready();
  const row = await database()
    .prepare("SELECT code, host_token, state FROM rooms WHERE code = ?")
    .bind(code)
    .first<RoomRow>();
  if (!row) return null;
  return { row, state: JSON.parse(row.state) as RoomState };
}

async function saveRoom(state: RoomState) {
  await database()
    .prepare("UPDATE rooms SET state = ?, updated_at = CURRENT_TIMESTAMP WHERE code = ?")
    .bind(JSON.stringify(state), state.code)
    .run();
}

function pickSong(state: RoomState): Song {
  const available = (catalog as Song[]).filter(
    (song) => song.uri && !state.usedUris.includes(song.uri),
  );
  if (!available.length) throw new Error("The playable catalogue is exhausted.");
  const song = available[Math.floor(Math.random() * available.length)];
  state.usedUris.push(song.uri!);
  return song;
}

function roomView(state: RoomState, isHost: boolean): RoomView {
  const { usedUris: _usedUris, ...view } = state;
  void _usedUris;
  const mayRevealSong = isHost || state.phase === "revealed" || state.phase === "finished";
  return {
    ...view,
    currentSong: mayRevealSong ? state.currentSong : null,
    isHost,
  };
}

function requireHost(room: { row: RoomRow; state: RoomState }, token?: string) {
  return Boolean(token && token === room.row.host_token);
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const code = url.searchParams.get("code")?.trim().toUpperCase() ?? "";
    const token = url.searchParams.get("hostToken") ?? undefined;
    if (!code) return fail("Room code is required.");
    const room = await loadRoom(code);
    if (!room) return fail("Room not found.", 404);
    return Response.json({ room: roomView(room.state, requireHost(room, token)) });
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Unexpected error", 500);
  }
}

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as Record<string, unknown>;
    const action = String(payload.action ?? "");

    if (action === "create") {
      await ready();
      let code = makeCode();
      while (await loadRoom(code)) code = makeCode();
      const hostToken = crypto.randomUUID();
      const state: RoomState = {
        code,
        phase: "lobby",
        players: [],
        activePlayerId: null,
        activePlayerIndex: 0,
        round: 0,
        currentSong: null,
        placement: null,
        result: null,
        winnerId: null,
        usedUris: [],
      };
      await database()
        .prepare("INSERT INTO rooms (code, host_token, state) VALUES (?, ?, ?)")
        .bind(code, hostToken, JSON.stringify(state))
        .run();
      return Response.json({ room: roomView(state, true), hostToken }, { status: 201 });
    }

    const code = String(payload.code ?? "").trim().toUpperCase();
    const room = await loadRoom(code);
    if (!room) return fail("Room not found.", 404);
    const state = room.state;

    if (action === "join") {
      if (state.phase !== "lobby") return fail("This game has already started.");
      const name = String(payload.name ?? "").trim().slice(0, 24);
      if (!name) return fail("Player name is required.");
      const player = { id: crypto.randomUUID(), name, timeline: [] };
      state.players.push(player);
      await saveRoom(state);
      return Response.json({ room: roomView(state, false), playerId: player.id }, { status: 201 });
    }

    if (action === "start") {
      if (!requireHost(room, String(payload.hostToken ?? ""))) return fail("Host access required.", 403);
      if (state.phase !== "lobby") return fail("The game has already started.");
      if (!state.players.length) return fail("At least one player must join.");
      for (const player of state.players) player.timeline = [pickSong(state)];
      state.activePlayerIndex = 0;
      state.activePlayerId = state.players[0].id;
      state.currentSong = pickSong(state);
      state.round = 1;
      state.phase = "playing";
      await saveRoom(state);
      return Response.json({ room: roomView(state, true) });
    }

    if (action === "place") {
      const playerId = String(payload.playerId ?? "");
      const index = Number(payload.index);
      const player = state.players.find((candidate) => candidate.id === playerId);
      if (state.phase !== "playing" || playerId !== state.activePlayerId || !player) {
        return fail("It is not this player’s turn.", 409);
      }
      if (!Number.isInteger(index) || index < 0 || index > player.timeline.length) {
        return fail("Choose a valid timeline position.");
      }
      state.placement = index;
      state.phase = "placed";
      await saveRoom(state);
      return Response.json({ room: roomView(state, false) });
    }

    if (action === "reveal") {
      if (!requireHost(room, String(payload.hostToken ?? ""))) return fail("Host access required.", 403);
      if (state.phase !== "placed" || !state.currentSong || state.placement === null) {
        return fail("Wait for the active player to lock a placement.", 409);
      }
      const player = state.players[state.activePlayerIndex];
      const previous = player.timeline[state.placement - 1];
      const next = player.timeline[state.placement];
      const correct = (!previous || previous.year <= state.currentSong.year)
        && (!next || state.currentSong.year <= next.year);
      state.result = { correct, index: state.placement };
      if (correct) player.timeline.splice(state.placement, 0, state.currentSong);
      if (player.timeline.length >= 10) state.winnerId = player.id;
      state.phase = "revealed";
      await saveRoom(state);
      return Response.json({ room: roomView(state, true) });
    }

    if (action === "advance") {
      if (!requireHost(room, String(payload.hostToken ?? ""))) return fail("Host access required.", 403);
      if (state.phase !== "revealed") return fail("Reveal this round first.", 409);
      if (state.winnerId) {
        state.phase = "finished";
      } else {
        state.activePlayerIndex = (state.activePlayerIndex + 1) % state.players.length;
        state.activePlayerId = state.players[state.activePlayerIndex].id;
        state.currentSong = pickSong(state);
        state.placement = null;
        state.result = null;
        state.round += 1;
        state.phase = "playing";
      }
      await saveRoom(state);
      return Response.json({ room: roomView(state, true) });
    }

    if (action === "skip") {
      if (!requireHost(room, String(payload.hostToken ?? ""))) return fail("Host access required.", 403);
      if (state.phase !== "playing" && state.phase !== "placed") return fail("There is no active song to skip.", 409);
      state.currentSong = pickSong(state);
      state.placement = null;
      state.result = null;
      state.phase = "playing";
      await saveRoom(state);
      return Response.json({ room: roomView(state, true) });
    }

    return fail("Unknown action.");
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Unexpected error", 500);
  }
}
