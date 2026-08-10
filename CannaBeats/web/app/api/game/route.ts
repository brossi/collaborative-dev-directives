import { randomUUID, timingSafeEqual } from "node:crypto";
import catalog from "../../../data/catalog.json";
import { normalizePlayerControl, type RoomState, type RoomView, type Song } from "../../../lib/game";
import { DEFAULT_GAME_RULES, ERA_BUCKETS, normalizeRules } from "../../../lib/rules";
import { database, randomToken, sha256 } from "../../../lib/server/database";
import {
  acquireManagedAudioLease,
  enqueueManagedAudioCommand,
  managedAudioView,
  releaseManagedAudioLease,
  renewManagedAudioLease,
} from "../../../lib/server/managed-audio";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RunRow = {
  id: string;
  session_code: string;
  host_user_id: string;
  state: string;
};

type Principal = {
  id: string;
  display_name: string;
  role: "host" | "player";
  kind: "account" | "guest";
  sessionCode?: string;
};

const SESSION_COOKIE = "cb_session";
const DESKTOP_WEB_COOKIE = "cb_desktop_web";
const GUEST_COOKIE = "cb_guest";
// Abandoned lobbies still need a cleanup ceiling; starting a game revokes its invites immediately.
const GUEST_ACCESS_MAX_TTL_MS = 8 * 60 * 60 * 1000;

function parseCookies(header = "") {
  return Object.fromEntries(
    header.split(";").map((entry) => entry.trim()).filter(Boolean).map((entry) => {
      const separator = entry.indexOf("=");
      if (separator === -1) return [entry, ""];
      return [entry.slice(0, separator), decodeURIComponent(entry.slice(separator + 1))];
    }),
  );
}

function currentPrincipal(request: Request): Principal | null {
  const authorization = request.headers.get("authorization") ?? "";
  const bearer = /^Bearer ([A-Za-z0-9_-]{32,128})$/.exec(authorization);
  if (bearer) {
    const principal = database().prepare(`
      SELECT users.id, users.display_name, users.role
      FROM desktop_sessions JOIN users ON users.id = desktop_sessions.user_id
      WHERE desktop_sessions.token_hash = ?
        AND desktop_sessions.revoked_at IS NULL
        AND desktop_sessions.expires_at > ?
    `).get(sha256(bearer[1]), Date.now()) as Principal | undefined;
    if (principal) {
      database().prepare(`
        UPDATE desktop_sessions SET last_seen_at = ? WHERE token_hash = ?
      `).run(Date.now(), sha256(bearer[1]));
      return { ...principal, kind: "account" };
    }
  }

  const cookies = parseCookies(request.headers.get("cookie") ?? "");
  const desktopWebToken = cookies[DESKTOP_WEB_COOKIE];
  if (desktopWebToken) {
    const tokenHash = sha256(desktopWebToken);
    const principal = database().prepare(`
      SELECT users.id, users.display_name, users.role
      FROM desktop_web_sessions
      JOIN desktop_sessions
        ON desktop_sessions.token_hash = desktop_web_sessions.desktop_session_hash
      JOIN users ON users.id = desktop_sessions.user_id
      WHERE desktop_web_sessions.token_hash = ?
        AND desktop_web_sessions.expires_at > ?
        AND desktop_sessions.expires_at > ?
        AND desktop_sessions.revoked_at IS NULL
    `).get(tokenHash, Date.now(), Date.now()) as Principal | undefined;
    if (principal) {
      database().prepare(`
        UPDATE desktop_web_sessions SET last_seen_at = ? WHERE token_hash = ?
      `).run(Date.now(), tokenHash);
      return { ...principal, kind: "account" };
    }
  }

  const token = cookies[SESSION_COOKIE];
  if (token) {
    const principal = database().prepare(`
      SELECT users.id, users.display_name, users.role
      FROM sessions JOIN users ON users.id = sessions.user_id
      WHERE sessions.token_hash = ? AND sessions.expires_at > ?
    `).get(sha256(token), Date.now()) as Omit<Principal, "kind"> | undefined;
    if (principal) {
      database().prepare("UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?")
        .run(Date.now(), sha256(token));
      return { ...principal, kind: "account" };
    }
  }

  const guestToken = cookies[GUEST_COOKIE];
  if (!guestToken) return null;
  const guestHash = sha256(guestToken);
  const guest = database().prepare(`
    SELECT users.id, users.display_name, users.role, game_guest_sessions.session_code AS sessionCode
    FROM game_guest_sessions JOIN users ON users.id = game_guest_sessions.user_id
    WHERE game_guest_sessions.token_hash = ?
      AND game_guest_sessions.expires_at > ?
      AND game_guest_sessions.revoked_at IS NULL
  `).get(guestHash, Date.now()) as Omit<Principal, "kind"> | undefined;
  if (!guest) return null;
  database().prepare("UPDATE game_guest_sessions SET last_seen_at = ? WHERE token_hash = ?")
    .run(Date.now(), guestHash);
  return { ...guest, kind: "guest" };
}

function constantTimeEqual(left: string, right: string) {
  const first = Buffer.from(left);
  const second = Buffer.from(right);
  return first.length === second.length && timingSafeEqual(first, second);
}

function mutationOriginAccepted(request: Request) {
  if (request.headers.has("authorization")) return true;
  const expected = new URL(
    process.env.CANNABEATS_APP_ORIGIN ?? new URL(request.url).origin,
  ).origin;
  const supplied = request.headers.get("origin") ?? "";
  return Boolean(supplied && constantTimeEqual(expected, supplied));
}

function fail(message: string, status = 400) {
  return Response.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
}

function newRoomState(code: string, rules: unknown): RoomState {
  return {
    code,
    phase: "lobby",
    players: [],
    activePlayerId: null,
    activePlayerIndex: 0,
    round: 0,
    currentSong: null,
    placement: null,
    retractionUsed: false,
    result: null,
    winnerId: null,
    rules: normalizeRules(rules ?? DEFAULT_GAME_RULES),
    usedUris: [],
  };
}

function loadRoom(code: string) {
  const row = database().prepare(`
    SELECT game_runs.id, game_runs.session_code, game_sessions.host_user_id, game_runs.state
    FROM game_sessions JOIN game_runs ON game_runs.id = game_sessions.active_run_id
    WHERE game_sessions.code = ?
  `).get(code) as RunRow | undefined;
  if (!row) return null;
  const state = JSON.parse(row.state) as RoomState & { inputMode?: unknown };
  for (const player of state.players) {
    player.control = normalizePlayerControl(player.control, state.inputMode);
  }
  delete state.inputMode;
  state.retractionUsed ??= false;
  state.rules = normalizeRules(state.rules ?? DEFAULT_GAME_RULES);
  return { row, state };
}

function saveRoom(state: RoomState) {
  database().prepare(`
    UPDATE game_runs SET state = ?, updated_at = ?
    WHERE id = (SELECT active_run_id FROM game_sessions WHERE code = ?)
  `)
    .run(JSON.stringify(state), Date.now(), state.code);
}

function pickSong(state: RoomState): Song {
  const stageAndScreenThemes = new Set([
    "film-soundtracks",
    "oscar-songs",
    "tony-musicals",
    "tv-soundtracks",
  ]);
  const available = (catalog as Song[]).filter(
    (song) => song.uri
      && !state.usedUris.includes(song.uri)
      && song.year >= state.rules.minYear
      && song.year <= state.rules.maxYear
      && (state.rules.catalogScope === "all"
        || song.themes?.some((theme) => stageAndScreenThemes.has(theme))),
  );
  if (!available.length) throw new Error("The playable catalogue is exhausted.");
  const weightedBuckets = ERA_BUCKETS.map((era) => ({
    songs: available.filter((song) => song.year >= era.min && song.year <= era.max),
    weight: state.rules.eraWeights[era.id],
  })).filter((bucket) => bucket.songs.length && bucket.weight > 0);
  const totalWeight = weightedBuckets.reduce((total, bucket) => total + bucket.weight, 0);
  let songs = available;
  if (totalWeight > 0) {
    let draw = Math.random() * totalWeight;
    const bucket = weightedBuckets.find((candidate) => {
      draw -= candidate.weight;
      return draw <= 0;
    }) ?? weightedBuckets[weightedBuckets.length - 1];
    songs = bucket.songs;
  }
  const song = songs[Math.floor(Math.random() * songs.length)];
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

function revealPlacement(state: RoomState) {
  if (!state.currentSong || state.placement === null) {
    throw new Error("The submitted placement is incomplete.");
  }
  const player = state.players[state.activePlayerIndex];
  if (!player) throw new Error("The active player was not found.");
  const previous = player.timeline[state.placement - 1];
  const next = player.timeline[state.placement];
  const correct = (!previous || previous.year <= state.currentSong.year)
    && (!next || state.currentSong.year <= next.year);
  state.result = { correct, index: state.placement };
  if (correct) player.timeline.splice(state.placement, 0, state.currentSong);
  if (player.timeline.length >= state.rules.targetScore) state.winnerId = player.id;
  state.phase = "revealed";
}

function requirePrincipal(request: Request) {
  const principal = currentPrincipal(request);
  if (!principal) throw new Response("Sign in required", { status: 401 });
  return principal;
}

function isHost(room: { row: RunRow }, principal: Principal) {
  return room.row.host_user_id === principal.id;
}

function principalControlsPlayer(roomCode: string, principal: Principal, playerId: string) {
  return Boolean(database().prepare(`
    SELECT 1 FROM game_run_player_identities
    WHERE run_id = (SELECT active_run_id FROM game_sessions WHERE code = ?)
      AND user_id = ? AND player_id = ?
  `).get(roomCode, principal.id, playerId));
}

function isLobbyMember(code: string, principal: Principal) {
  if (principal.kind === "guest" && principal.sessionCode !== code) return false;
  return Boolean(database().prepare(`
    SELECT 1 FROM game_session_members WHERE session_code = ? AND user_id = ?
  `).get(code, principal.id));
}

function guestCookie(token: string, expiresAt: number) {
  const path = process.env.NEXT_PUBLIC_CANNABEATS_BASE_PATH || "/";
  const maxAge = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
  return `${GUEST_COOKIE}=${encodeURIComponent(token)}; Path=${path}; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

function joinPlayer(room: NonNullable<ReturnType<typeof loadRoom>>, principal: Principal, requestedName: unknown) {
  const lobby = database().prepare(`SELECT status FROM game_sessions WHERE code = ?`)
    .get(room.state.code) as { status: string } | undefined;
  if (!lobby) throw new Response("Game session not found", { status: 404 });
  if (lobby.status === "ended") throw new Response("This game session has ended", { status: 409 });
  const existing = database().prepare(`
    SELECT player_id FROM game_run_player_identities
    WHERE run_id = ? AND user_id = ?
  `).get(room.row.id, principal.id) as { player_id: string } | undefined;
  if (existing && room.state.players.some((player) => player.id === existing.player_id)) {
    database().prepare(`
      UPDATE game_run_player_identities SET last_seen_at = ? WHERE run_id = ? AND user_id = ?
    `).run(Date.now(), room.row.id, principal.id);
    return { playerId: existing.player_id, created: false };
  }
  if (room.state.phase !== "lobby") throw new Response("This game has already started", { status: 409 });
  const name = String(requestedName ?? principal.display_name).trim().slice(0, 24);
  if (!name) throw new Response("Player name is required", { status: 400 });
  if (existing) {
    database().prepare(`DELETE FROM game_run_player_identities WHERE run_id = ? AND user_id = ?`)
      .run(room.row.id, principal.id);
  }
  const player = { id: randomUUID(), name, control: "phone" as const, timeline: [] };
  room.state.players.push(player);
  const now = Date.now();
  database().exec("BEGIN IMMEDIATE");
  try {
    saveRoom(room.state);
    database().prepare(`
      INSERT INTO game_run_player_identities (run_id, user_id, player_id, joined_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(room.row.id, principal.id, player.id, now, now);
    database().prepare(`
      INSERT INTO game_session_members (session_code, user_id, joined_at, last_seen_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(session_code, user_id) DO UPDATE SET last_seen_at = excluded.last_seen_at
    `).run(room.state.code, principal.id, now, now);
    database().exec("COMMIT");
  } catch (error) {
    database().exec("ROLLBACK");
    throw error;
  }
  return { playerId: player.id, created: true };
}

function errorResponse(error: unknown) {
  if (error instanceof Response) return fail(
    error.status === 401 ? "Sign in required." : "Request was not accepted.",
    error.status,
  );
  return fail(error instanceof Error ? error.message : "Unexpected error", 500);
}

export async function GET(request: Request) {
  try {
    const principal = requirePrincipal(request);
    const url = new URL(request.url);
    const code = url.searchParams.get("code")?.trim().toUpperCase() ?? "";
    if (!code) return fail("Room code is required.");
    if (!isLobbyMember(code, principal)) return fail("Game session not found.", 404);
    const room = loadRoom(code);
    if (!room) return fail("The host has not prepared a game for this lobby yet.", 409);
    const callerIsHost = isHost(room, principal);
    return Response.json(
      {
        room: roomView(room.state, callerIsHost),
        audio: callerIsHost ? renewManagedAudioLease(code) : managedAudioView(code),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    if (!mutationOriginAccepted(request)) return fail("Request origin was not accepted.", 403);
    const payload = (await request.json()) as Record<string, unknown>;
    const action = String(payload.action ?? "");

    if (action === "prepare") {
      const principal = requirePrincipal(request);
      const code = String(payload.code ?? "").trim().toUpperCase();
      if (!/^[A-Z2-9]{6}$/.test(code)) return fail("Game code is invalid.");
      const lobby = database().prepare(`
        SELECT host_user_id, active_run_id, status FROM game_sessions WHERE code = ?
      `).get(code) as { host_user_id: string; active_run_id: string | null; status: string } | undefined;
      if (!lobby || lobby.host_user_id !== principal.id) return fail("Host access required.", 403);
      if (lobby.status === "ended") return fail("This lobby has ended.", 409);
      const existing = loadRoom(code);
      if (existing) return Response.json({ room: roomView(existing.state, true), created: false });
      const runId = randomUUID();
      const state = newRoomState(code, payload.rules);
      const now = Date.now();
      database().exec("BEGIN IMMEDIATE");
      try {
        database().prepare(`
          INSERT INTO game_runs (id, session_code, state, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(runId, code, JSON.stringify(state), now, now);
        database().prepare(`
          UPDATE game_sessions SET active_run_id = ?, updated_at = ? WHERE code = ?
        `).run(runId, now, code);
        database().exec("COMMIT");
      } catch (error) {
        database().exec("ROLLBACK");
        throw error;
      }
      const joinOrigin = process.env.CANNABEATS_PUBLIC_GAME_ORIGIN
        ?? `${new URL(request.url).origin}${process.env.NEXT_PUBLIC_CANNABEATS_BASE_PATH ?? ""}`;
      return Response.json(
        { room: roomView(state, true), created: true, joinOrigin },
        { status: 201 },
      );
    }

    if (action === "guestInvite") {
      const principal = requirePrincipal(request);
      const code = String(payload.code ?? "").trim().toUpperCase();
      if (!/^[A-Z2-9]{6}$/.test(code)) return fail("Game code is invalid.");
      const room = loadRoom(code);
      if (!room || !isHost(room, principal)) return fail("Host access required.", 403);
      if (room.state.phase !== "lobby") return fail("Guest invitations are locked after the game starts.", 409);
      const token = randomToken();
      const now = Date.now();
      const expiresAt = now + GUEST_ACCESS_MAX_TTL_MS;
      database().prepare(`
        INSERT INTO game_guest_invites
          (token_hash, session_code, created_by, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(sha256(token), code, principal.id, now, expiresAt);
      return Response.json({ guestInvite: token, expiresAt });
    }

    if (action === "joinGuest") {
      const code = String(payload.code ?? "").trim().toUpperCase();
      if (!/^[A-Z2-9]{6}$/.test(code)) return fail("Game code is invalid.");
      const room = loadRoom(code);
      if (!room) return fail("The host has not prepared a game for this lobby yet.", 409);

      const alreadyAuthorized = currentPrincipal(request);
      if (alreadyAuthorized?.kind === "guest" && alreadyAuthorized.sessionCode === code) {
        const joined = joinPlayer(room, alreadyAuthorized, payload.name);
        return Response.json(
          { room: roomView(room.state, false), playerId: joined.playerId },
          { status: joined.created ? 201 : 200 },
        );
      }

      const invitation = String(payload.invite ?? "");
      if (!/^[A-Za-z0-9_-]{32,128}$/.test(invitation)) return fail("This guest invitation is invalid.", 403);
      const invite = database().prepare(`
        SELECT expires_at FROM game_guest_invites
        WHERE token_hash = ? AND session_code = ? AND expires_at > ? AND revoked_at IS NULL
      `).get(sha256(invitation), code, Date.now()) as { expires_at: number } | undefined;
      if (!invite) return fail("This guest invitation is invalid or has expired.", 403);

      const accountPrincipal = alreadyAuthorized?.kind === "account" ? alreadyAuthorized : null;
      if (accountPrincipal) {
        const joined = joinPlayer(room, accountPrincipal, payload.name);
        return Response.json(
          { room: roomView(room.state, isHost(room, accountPrincipal)), playerId: joined.playerId },
          { status: joined.created ? 201 : 200 },
        );
      }

      const name = String(payload.name ?? "").trim().slice(0, 24);
      if (!name) return fail("Player name is required.");
      if (room.state.phase !== "lobby") return fail("This game has already started.", 409);
      const userId = randomUUID();
      const sessionToken = randomToken();
      const sessionHash = sha256(sessionToken);
      const now = Date.now();
      const expiresAt = Math.min(invite.expires_at, now + GUEST_ACCESS_MAX_TTL_MS);
      database().exec("BEGIN IMMEDIATE");
      try {
        database().prepare(`INSERT INTO users (id, display_name, role, created_at) VALUES (?, ?, 'player', ?)`)
          .run(userId, name, now);
        database().prepare(`
          INSERT INTO game_guest_users (user_id, session_code, created_at, expires_at)
          VALUES (?, ?, ?, ?)
        `).run(userId, code, now, expiresAt);
        database().prepare(`
          INSERT INTO game_guest_sessions
            (token_hash, user_id, session_code, created_at, expires_at, last_seen_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(sessionHash, userId, code, now, expiresAt, now);
        database().exec("COMMIT");
      } catch (error) {
        database().exec("ROLLBACK");
        throw error;
      }
      const principal: Principal = { id: userId, display_name: name, role: "player", kind: "guest", sessionCode: code };
      try {
        const joined = joinPlayer(room, principal, name);
        return Response.json(
          { room: roomView(room.state, false), playerId: joined.playerId },
          {
            status: 201,
            headers: { "Set-Cookie": guestCookie(sessionToken, expiresAt), "Cache-Control": "no-store" },
          },
        );
      } catch (error) {
        database().prepare("DELETE FROM users WHERE id = ?").run(userId);
        throw error;
      }
    }

    const principal = requirePrincipal(request);
    const code = String(payload.code ?? "").trim().toUpperCase();
    if (!/^[A-Z2-9]{6}$/.test(code)) return fail("Game code is invalid.");
    if (principal.kind === "guest" && principal.sessionCode !== code) {
      return fail("Game session not found.", 404);
    }
    if (action !== "join" && !isLobbyMember(code, principal)) return fail("Game session not found.", 404);
    const room = loadRoom(code);
    if (!room) return fail("The host has not prepared a game for this lobby yet.", 409);
    const state = room.state;
    const callerIsHost = isHost(room, principal);

    if (action === "audioAcquire") {
      if (!callerIsHost) return fail("Host access required.", 403);
      if (state.phase !== "lobby") return fail("Choose the audio source before the game starts.", 409);
      return Response.json({ room: roomView(state, true), audio: acquireManagedAudioLease(code, principal.id) });
    }

    if (action === "audioRelease") {
      if (!callerIsHost) return fail("Host access required.", 403);
      return Response.json({ room: roomView(state, true), audio: releaseManagedAudioLease(code) });
    }

    if (action === "audioControl") {
      if (state.phase !== "playing" && state.phase !== "placed") {
        return fail("Playback controls are not active for this round.", 409);
      }
      const command = String(payload.command ?? "");
      if (command !== "pause" && command !== "resume") return fail("Playback command is invalid.");
      return Response.json({
        room: roomView(state, callerIsHost),
        audio: enqueueManagedAudioCommand(code, principal.id, command),
      });
    }

    if (action === "join") {
      const joined = joinPlayer(room, principal, payload.name);
      return Response.json(
        { room: roomView(state, callerIsHost), playerId: joined.playerId },
        { status: joined.created ? 201 : 200 },
      );
    }

    if (action === "addPlayer") {
      if (!callerIsHost) return fail("Host access required.", 403);
      if (state.phase !== "lobby") return fail("Players are locked after the game starts.", 409);
      const name = String(payload.name ?? "").trim().slice(0, 24);
      if (!name) return fail("Player name is required.");
      state.players.push({ id: randomUUID(), name, control: "host", timeline: [] });
      saveRoom(state);
      return Response.json({ room: roomView(state, true) }, { status: 201 });
    }

    if (action === "removePlayer") {
      if (!callerIsHost) return fail("Host access required.", 403);
      if (state.phase !== "lobby") return fail("Players are locked after the game starts.", 409);
      const playerId = String(payload.playerId ?? "");
      if (!state.players.some((player) => player.id === playerId)) return fail("Player not found.", 404);
      state.players = state.players.filter((player) => player.id !== playerId);
      const identity = database().prepare(`
        SELECT user_id FROM game_run_player_identities WHERE run_id = ? AND player_id = ?
      `).get(room.row.id, playerId) as { user_id: string } | undefined;
      database().prepare("DELETE FROM game_run_player_identities WHERE run_id = ? AND player_id = ?")
        .run(room.row.id, playerId);
      if (identity && database().prepare("SELECT 1 FROM game_guest_users WHERE user_id = ?").get(identity.user_id)) {
        database().prepare("DELETE FROM users WHERE id = ?").run(identity.user_id);
      }
      saveRoom(state);
      return Response.json({ room: roomView(state, true) });
    }

    if (action === "rules") {
      if (!callerIsHost) return fail("Host access required.", 403);
      if (state.phase !== "lobby") return fail("Rules are locked after the game starts.", 409);
      state.rules = normalizeRules(payload.rules);
      saveRoom(state);
      return Response.json({ room: roomView(state, true) });
    }

    if (action === "start") {
      if (!callerIsHost) return fail("Host access required.", 403);
      if (state.phase !== "lobby") return fail("The game has already started.");
      if (!state.players.length) return fail("At least one player is required.");
      const audio = renewManagedAudioLease(code);
      if (audio.mode === "managed" && !audio.sourceOnline) {
        return fail("The managed audio source is offline.", 409);
      }
      for (const player of state.players) player.timeline = [pickSong(state)];
      state.activePlayerIndex = Math.floor(Math.random() * state.players.length);
      state.activePlayerId = state.players[state.activePlayerIndex].id;
      state.currentSong = pickSong(state);
      state.round = 1;
      state.retractionUsed = false;
      state.phase = "ready";
      database().prepare(`
        UPDATE game_guest_invites SET revoked_at = ?
        WHERE session_code = ? AND revoked_at IS NULL
      `).run(Date.now(), code);
      database().prepare("UPDATE game_sessions SET status = 'playing', updated_at = ? WHERE code = ?")
        .run(Date.now(), code);
      saveRoom(state);
      return Response.json({ room: roomView(state, true) });
    }

    if (action === "begin") {
      if (!callerIsHost) return fail("Host access required.", 403);
      if (state.phase !== "ready" || !state.currentSong) return fail("The first round is not ready.", 409);
      state.phase = "playing";
      saveRoom(state);
      const audio = renewManagedAudioLease(code);
      if (audio.mode === "managed") {
        enqueueManagedAudioCommand(code, principal.id, "play", state.currentSong.uri);
      }
      return Response.json({ room: roomView(state, true), audio: managedAudioView(code) });
    }

    if (action === "place") {
      const playerId = String(payload.playerId ?? "");
      const index = Number(payload.index);
      const player = state.players[state.activePlayerIndex];
      const hostIsPlacing = player?.control === "host" && callerIsHost;
      const activePlayerIsPlacing = player?.control === "phone"
        && playerId === state.activePlayerId
        && principalControlsPlayer(code, principal, playerId);
      if (state.phase !== "playing" || !player || (!hostIsPlacing && !activePlayerIsPlacing)) {
        return fail("It is not this player’s turn.", 409);
      }
      if (!Number.isInteger(index) || index < 0 || index > player.timeline.length) {
        return fail("Choose a valid timeline position.");
      }
      state.placement = index;
      state.phase = "placed";
      saveRoom(state);
      return Response.json({ room: roomView(state, callerIsHost) });
    }

    if (action === "retract") {
      const playerId = String(payload.playerId ?? "");
      const player = state.players[state.activePlayerIndex];
      const hostIsRetracting = player?.control === "host" && callerIsHost;
      const activePlayerIsRetracting = player?.control === "phone"
        && playerId === state.activePlayerId
        && principalControlsPlayer(code, principal, playerId);
      if (state.phase !== "placed" || (!hostIsRetracting && !activePlayerIsRetracting)) {
        return fail("There is no placement to retract.", 409);
      }
      if (!state.rules.allowRetraction) return fail("Retractions are disabled for this game.", 409);
      if (state.retractionUsed) return fail("This round’s retraction has already been used.", 409);
      state.placement = null;
      state.retractionUsed = true;
      state.phase = "playing";
      saveRoom(state);
      return Response.json({ room: roomView(state, callerIsHost) });
    }

    if (action === "reveal") {
      if (!callerIsHost) return fail("Host access required.", 403);
      if (state.phase !== "placed" || !state.currentSong || state.placement === null) {
        return fail("Wait for the active player to lock a placement.", 409);
      }
      revealPlacement(state);
      saveRoom(state);
      return Response.json({ room: roomView(state, true) });
    }

    if (action === "advance") {
      if (!callerIsHost) return fail("Host access required.", 403);
      if (state.phase !== "revealed") return fail("Reveal this round first.", 409);
      if (state.winnerId) {
        state.phase = "finished";
        database().prepare("UPDATE game_runs SET ended_at = ? WHERE id = ?").run(Date.now(), room.row.id);
      } else {
        state.activePlayerIndex = (state.activePlayerIndex + 1) % state.players.length;
        state.activePlayerId = state.players[state.activePlayerIndex].id;
        state.currentSong = pickSong(state);
        state.placement = null;
        state.retractionUsed = false;
        state.result = null;
        state.round += 1;
        state.phase = "playing";
      }
      saveRoom(state);
      if (state.phase === "finished") {
        releaseManagedAudioLease(code);
      } else if (managedAudioView(code).mode === "managed") {
        enqueueManagedAudioCommand(code, principal.id, "play", state.currentSong?.uri);
      }
      return Response.json({ room: roomView(state, true), audio: managedAudioView(code) });
    }

    if (action === "skip") {
      if (!callerIsHost) return fail("Host access required.", 403);
      if (state.phase !== "playing" && state.phase !== "placed") return fail("There is no active song to skip.", 409);
      state.currentSong = pickSong(state);
      state.placement = null;
      state.retractionUsed = false;
      state.result = null;
      state.phase = "playing";
      state.round += 1;
      saveRoom(state);
      if (managedAudioView(code).mode === "managed") {
        enqueueManagedAudioCommand(code, principal.id, "play", state.currentSong.uri);
      }
      return Response.json({ room: roomView(state, true), audio: managedAudioView(code) });
    }

    return fail("Unknown action.");
  } catch (error) {
    return errorResponse(error);
  }
}
