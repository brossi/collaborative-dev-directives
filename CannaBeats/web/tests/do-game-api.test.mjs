import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { after, before, test } from "node:test";
import { openDatabase, sha256 } from "../../spikes/access-spotify-poc/db.mjs";

const temporaryDirectory = mkdtempSync(join(tmpdir(), "cannabeats-game-test-"));
const databasePath = join(temporaryDirectory, "game.sqlite");
const internalToken = "game-api-test-internal-token";
const hostCookie = `host-browser-${randomUUID()}`;
const playerToken = `desktop-player-${randomUUID()}`;
const db = openDatabase(databasePath);
const builtCatalog = JSON.parse(readFileSync(new URL("../data/catalog.json", import.meta.url), "utf8"));
const stageAndScreenUris = new Set(
  builtCatalog.filter((song) => song.themes?.length).map((song) => song.uri),
);
const hostId = randomUUID();
const playerId = randomUUID();
const now = Date.now();

db.prepare("INSERT INTO users (id, display_name, role, created_at) VALUES (?, ?, 'host', ?)")
  .run(hostId, "Test Host", now);
db.prepare("INSERT INTO users (id, display_name, role, created_at) VALUES (?, ?, 'player', ?)")
  .run(playerId, "Test Player", now);
db.prepare(`
  INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at)
  VALUES (?, ?, ?, ?, ?)
`).run(sha256(hostCookie), hostId, now, now + 60_000, now);
db.prepare(`
  INSERT INTO desktop_sessions
    (token_hash, user_id, display_name, created_at, expires_at, last_seen_at)
  VALUES (?, ?, ?, ?, ?, ?)
`).run(sha256(playerToken), playerId, "Test Desktop", now, now + 60_000, now);

let processHandle;
let origin;
let serverOutput = "";

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForHealth() {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/game/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`The DigitalOcean game build did not start in time. ${serverOutput.slice(-2_000)}`);
}

before(async () => {
  const port = await availablePort();
  origin = `http://127.0.0.1:${port}`;
  processHandle = spawn(
    process.execPath,
    [".next/standalone/server.js"],
    {
      cwd: new URL("..", import.meta.url),
      env: {
        ...process.env,
        HOSTNAME: "127.0.0.1",
        PORT: String(port),
        CANNABEATS_APP_ORIGIN: origin,
        CANNABEATS_DATABASE_PATH: databasePath,
        CANNABEATS_GAME_SERVICE_TOKEN: internalToken,
        CANNABEATS_PUBLIC_GAME_ORIGIN: `${origin}/game`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  processHandle.stdout.on("data", (chunk) => { serverOutput += chunk; });
  processHandle.stderr.on("data", (chunk) => { serverOutput += chunk; });
  await waitForHealth();
});

after(async () => {
  processHandle?.kill("SIGTERM");
  if (processHandle && processHandle.exitCode === null) {
    await new Promise((resolve) => processHandle.once("exit", resolve));
  }
  db.close();
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

async function gamePost(body, headers = {}) {
  return fetch(`${origin}/game/api/game`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

test("an authenticated lobby owns an internal game run and preserves host authority", async () => {
  const sessionCode = "TEST23";
  db.prepare(`
    INSERT INTO game_sessions (code, host_user_id, status, created_at, updated_at)
    VALUES (?, ?, 'lobby', ?, ?)
  `).run(sessionCode, hostId, now, now);
  db.prepare(`
    INSERT INTO game_session_members (session_code, user_id, joined_at, last_seen_at)
    VALUES (?, ?, ?, ?)
  `).run(sessionCode, hostId, now, now);

  const beforePreparation = await fetch(`${origin}/game/api/game?code=${sessionCode}`, {
    headers: { Cookie: `cb_session=${hostCookie}` },
  });
  assert.equal(beforePreparation.status, 409);

  const createdResponse = await gamePost(
    { action: "prepare", code: sessionCode },
    { Cookie: `cb_session=${hostCookie}`, Origin: origin },
  );
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();
  assert.equal(created.room.code, sessionCode);
  assert.equal(created.room.phase, "lobby");
  assert.equal(created.room.isHost, true);
  const lobby = db.prepare("SELECT active_run_id FROM game_sessions WHERE code = ?").get(sessionCode);
  assert.match(lobby.active_run_id, /^[0-9a-f-]{36}$/);
  assert.equal(db.prepare("SELECT session_code FROM game_runs WHERE id = ?").get(lobby.active_run_id).session_code, sessionCode);
  assert.equal(db.prepare("SELECT 1 FROM rooms WHERE code = ?").get(sessionCode), undefined);

  const anonymous = await fetch(`${origin}/game/api/game?code=${sessionCode}`);
  assert.equal(anonymous.status, 401);

  const hostView = await fetch(`${origin}/game/api/game?code=${sessionCode}`, {
    headers: { Cookie: `cb_session=${hostCookie}` },
  });
  assert.equal(hostView.status, 200);
  assert.equal((await hostView.json()).room.isHost, true);

  const playerView = await fetch(`${origin}/game/api/game?code=${sessionCode}`, {
    headers: { Authorization: `Bearer ${playerToken}` },
  });
  assert.equal(playerView.status, 404);

  const launchTicket = `desktop-launch-${randomUUID()}`;
  db.prepare(`
    INSERT INTO desktop_web_tickets
      (token_hash, desktop_session_hash, session_code, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(sha256(launchTicket), sha256(playerToken), sessionCode, Date.now(), Date.now() + 60_000);
  db.prepare(`
    INSERT INTO game_session_members (session_code, user_id, joined_at, last_seen_at)
    VALUES (?, ?, ?, ?)
  `).run(sessionCode, playerId, Date.now(), Date.now());
  const handoff = await fetch(
    `${origin}/game/desktop?ticket=${encodeURIComponent(launchTicket)}`,
    { redirect: "manual" },
  );
  assert.equal(handoff.status, 303);
  assert.equal(new URL(handoff.headers.get("location")).searchParams.get("session"), sessionCode);
  assert.match(handoff.headers.get("set-cookie"), /^cb_desktop_web=.*HttpOnly; Secure; SameSite=Strict/);
  const desktopWebCookie = handoff.headers.get("set-cookie").split(";", 1)[0];
  const webView = await fetch(`${origin}/game/api/game?code=${sessionCode}`, {
    headers: { Cookie: desktopWebCookie },
  });
  assert.equal(webView.status, 200);
  assert.equal((await webView.json()).room.isHost, false);
  const replayedHandoff = await fetch(
    `${origin}/game/desktop?ticket=${encodeURIComponent(launchTicket)}`,
    { redirect: "manual" },
  );
  assert.equal(replayedHandoff.status, 401);

  const joined = await gamePost(
    { action: "join", code: sessionCode, name: "Desktop Player" },
    { Authorization: `Bearer ${playerToken}` },
  );
  assert.equal(joined.status, 201);
  assert.equal((await joined.json()).room.players.length, 1);

  const added = await gamePost(
    { action: "addPlayer", code: sessionCode, name: "Shared Screen Player" },
    { Cookie: `cb_session=${hostCookie}`, Origin: origin },
  );
  assert.equal(added.status, 201);
  assert.equal((await added.json()).room.players.length, 2);

  const themed = await gamePost(
    {
      action: "rules",
      code: sessionCode,
      rules: { preset: "broadway-tv-movies", catalogScope: "broadway-tv-movies" },
    },
    { Cookie: `cb_session=${hostCookie}`, Origin: origin },
  );
  assert.equal(themed.status, 200);
  assert.equal((await themed.json()).room.rules.catalogScope, "broadway-tv-movies");

  const started = await gamePost(
    { action: "start", code: sessionCode },
    { Cookie: `cb_session=${hostCookie}`, Origin: origin },
  );
  assert.equal(started.status, 200);
  const readyRoom = (await started.json()).room;
  assert.ok(stageAndScreenUris.has(readyRoom.currentSong.uri));
  assert.ok(readyRoom.players.every((player) => player.timeline.every(
    (song) => stageAndScreenUris.has(song.uri),
  )));
  const begun = await gamePost(
    { action: "begin", code: sessionCode },
    { Cookie: `cb_session=${hostCookie}`, Origin: origin },
  );
  assert.equal(begun.status, 200);
  const activePlayer = readyRoom.players.find((player) => player.id === readyRoom.activePlayerId);
  const placementHeaders = activePlayer.control === "host"
    ? { Cookie: `cb_session=${hostCookie}`, Origin: origin }
    : { Authorization: `Bearer ${playerToken}` };
  const submitted = await gamePost(
    { action: "place", code: sessionCode, playerId: activePlayer.id, index: 0 },
    placementHeaders,
  );
  assert.equal(submitted.status, 200);
  const lockedRoom = (await submitted.json()).room;
  assert.equal(lockedRoom.phase, "placed");

  const retracted = await gamePost(
    { action: "retract", code: sessionCode, playerId: activePlayer.id },
    placementHeaders,
  );
  assert.equal(retracted.status, 200);
  assert.equal((await retracted.json()).room.phase, "playing");

  const finalPlacement = await gamePost(
    { action: "place", code: sessionCode, playerId: activePlayer.id, index: 0 },
    placementHeaders,
  );
  assert.equal(finalPlacement.status, 200);
  assert.equal((await finalPlacement.json()).room.phase, "placed");

  const revealed = await gamePost(
    { action: "reveal", code: sessionCode },
    { Cookie: `cb_session=${hostCookie}`, Origin: origin },
  );
  assert.equal(revealed.status, 200);
  const answeredRoom = (await revealed.json()).room;
  assert.equal(answeredRoom.phase, "revealed");
  assert.ok(answeredRoom.currentSong);
  assert.equal(typeof answeredRoom.result.correct, "boolean");

  const resumed = await gamePost(
    { action: "prepare", code: sessionCode },
    { Cookie: `cb_session=${hostCookie}`, Origin: origin },
  );
  assert.equal(resumed.status, 200);
  assert.equal((await resumed.json()).room.code, sessionCode);
});

test("a host-issued capability admits an accountless guest only to its lobby", async () => {
  const sessionCode = "GUEST2";
  db.prepare(`
    INSERT INTO game_sessions (code, host_user_id, status, created_at, updated_at)
    VALUES (?, ?, 'lobby', ?, ?)
  `).run(sessionCode, hostId, Date.now(), Date.now());
  db.prepare(`
    INSERT INTO game_session_members (session_code, user_id, joined_at, last_seen_at)
    VALUES (?, ?, ?, ?)
  `).run(sessionCode, hostId, Date.now(), Date.now());

  const prepared = await gamePost(
    { action: "prepare", code: sessionCode },
    { Cookie: `cb_session=${hostCookie}`, Origin: origin },
  );
  assert.equal(prepared.status, 201);

  const anonymousInvite = await gamePost(
    { action: "guestInvite", code: sessionCode },
    { Origin: origin },
  );
  assert.equal(anonymousInvite.status, 401);

  const inviteResponse = await gamePost(
    { action: "guestInvite", code: sessionCode },
    { Cookie: `cb_session=${hostCookie}`, Origin: origin },
  );
  assert.equal(inviteResponse.status, 200);
  const { guestInvite } = await inviteResponse.json();
  assert.match(guestInvite, /^[A-Za-z0-9_-]{32,128}$/);
  assert.equal(
    db.prepare("SELECT 1 FROM game_guest_invites WHERE token_hash = ?").get(guestInvite),
    undefined,
  );
  assert.ok(db.prepare("SELECT 1 FROM game_guest_invites WHERE token_hash = ?").get(sha256(guestInvite)));

  const bareCode = await gamePost(
    { action: "joinGuest", code: sessionCode, name: "Uninvited" },
    { Origin: origin },
  );
  assert.equal(bareCode.status, 403);

  const joinedResponse = await gamePost(
    { action: "joinGuest", code: sessionCode, name: "Phone Guest", invite: guestInvite },
    { Origin: origin },
  );
  assert.equal(joinedResponse.status, 201);
  const joined = await joinedResponse.json();
  assert.equal(joined.room.players.length, 1);
  assert.equal(joined.room.players[0].name, "Phone Guest");
  const setCookie = joinedResponse.headers.get("set-cookie");
  assert.match(setCookie, /^cb_guest=/);
  assert.match(setCookie, /HttpOnly; Secure; SameSite=Strict/);
  assert.match(setCookie, /Path=\/game/);
  const guestCookie = setCookie.split(";", 1)[0];

  const guestView = await fetch(`${origin}/game/api/game?code=${sessionCode}`, {
    headers: { Cookie: guestCookie },
  });
  assert.equal(guestView.status, 200);
  assert.equal((await guestView.json()).room.isHost, false);

  const hostAction = await gamePost(
    { action: "addPlayer", code: sessionCode, name: "Not Allowed" },
    { Cookie: guestCookie, Origin: origin },
  );
  assert.equal(hostAction.status, 403);

  const otherSessionCode = "OTHER2";
  db.prepare(`
    INSERT INTO game_sessions (code, host_user_id, status, created_at, updated_at)
    VALUES (?, ?, 'lobby', ?, ?)
  `).run(otherSessionCode, hostId, Date.now(), Date.now());
  const otherView = await fetch(`${origin}/game/api/game?code=${otherSessionCode}`, {
    headers: { Cookie: guestCookie },
  });
  assert.equal(otherView.status, 404);
  const otherJoin = await gamePost(
    { action: "join", code: otherSessionCode, name: "Scope Escape" },
    { Cookie: guestCookie, Origin: origin },
  );
  assert.equal(otherJoin.status, 404);

  db.prepare("UPDATE game_guest_invites SET revoked_at = ? WHERE token_hash = ?")
    .run(Date.now(), sha256(guestInvite));
  const revokedJoin = await gamePost(
    { action: "joinGuest", code: sessionCode, name: "Second Guest", invite: guestInvite },
    { Origin: origin },
  );
  assert.equal(revokedJoin.status, 403);

  const existingGuestStillWorks = await fetch(`${origin}/game/api/game?code=${sessionCode}`, {
    headers: { Cookie: guestCookie },
  });
  assert.equal(existingGuestStillWorks.status, 200);

  const secondInviteResponse = await gamePost(
    { action: "guestInvite", code: sessionCode },
    { Cookie: `cb_session=${hostCookie}`, Origin: origin },
  );
  assert.equal(secondInviteResponse.status, 200);
  const secondInvite = (await secondInviteResponse.json()).guestInvite;
  const started = await gamePost(
    { action: "start", code: sessionCode },
    { Cookie: `cb_session=${hostCookie}`, Origin: origin },
  );
  assert.equal(started.status, 200);
  assert.ok(db.prepare(`
    SELECT revoked_at FROM game_guest_invites WHERE token_hash = ? AND revoked_at IS NOT NULL
  `).get(sha256(secondInvite)));

  const postStartJoin = await gamePost(
    { action: "joinGuest", code: sessionCode, name: "Late Guest", invite: secondInvite },
    { Origin: origin },
  );
  assert.equal(postStartJoin.status, 403);
  const admittedGuestAfterStart = await fetch(`${origin}/game/api/game?code=${sessionCode}`, {
    headers: { Cookie: guestCookie },
  });
  assert.equal(admittedGuestAfterStart.status, 200);
});
