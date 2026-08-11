import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { after, before, test } from "node:test";
import { openDatabase, sha256 } from "../../spikes/access-spotify-poc/db.mjs";

const temporaryDirectory = mkdtempSync(join(tmpdir(), "cannabeats-game-test-"));
const databasePath = join(temporaryDirectory, "game.sqlite");
const internalToken = "game-api-test-internal-token";
const managedSourceToken = `managed-source-${randomUUID().replaceAll("-", "")}`;
const managedSourceId = randomUUID();
const relayListenToken = `relay-listen-${randomUUID().replaceAll("-", "")}`;
const relayTokenPath = join(temporaryDirectory, "relay-listen-token");
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
let relayOrigin;
let relayServer;
let serverOutput = "";
const relayCorrelationIds = [];

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
      const response = await fetch(`${origin}/game/api/ready`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`The DigitalOcean game build did not start in time. ${serverOutput.slice(-2_000)}`);
}

before(async () => {
  writeFileSync(relayTokenPath, `${relayListenToken}\n`, { mode: 0o600 });
  relayServer = createHttpServer((request, response) => {
    if (request.url !== "/stream.pcm" || request.headers.authorization !== `Bearer ${relayListenToken}`) {
      response.writeHead(401).end();
      return;
    }
    relayCorrelationIds.push(request.headers["x-cannabeats-correlation-id"]);
    response.writeHead(200, {
      "Content-Type": "audio/L16;rate=48000;channels=2",
      "X-Audio-Rate": "48000",
      "X-Audio-Channels": "2",
      "X-Audio-Encoding": "s16le",
    });
    response.end(Buffer.from([0, 0, 0, 0, 1, 0, 1, 0]));
  });
  await new Promise((resolve, reject) => {
    relayServer.once("error", reject);
    relayServer.listen(0, "127.0.0.1", resolve);
  });
  relayOrigin = `http://127.0.0.1:${relayServer.address().port}`;
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
        AUDIO_RELAY_ORIGIN: relayOrigin,
        AUDIO_RELAY_LISTEN_TOKEN_FILE: relayTokenPath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  processHandle.stdout.on("data", (chunk) => { serverOutput += chunk; });
  processHandle.stderr.on("data", (chunk) => { serverOutput += chunk; });
  await waitForHealth();
  await sourcePost({ action: "poll" }, "source-schema-initializer-token-value");
  db.prepare(`
    INSERT INTO managed_audio_sources
      (id, display_name, token_hash, enabled, created_at, last_seen_at)
    VALUES (?, ?, ?, 1, ?, ?)
  `).run(managedSourceId, "Test Managed Source", sha256(managedSourceToken), Date.now(), Date.now());
});

after(async () => {
  processHandle?.kill("SIGTERM");
  if (processHandle && processHandle.exitCode === null) {
    await new Promise((resolve) => processHandle.once("exit", resolve));
  }
  if (relayServer) await new Promise((resolve) => relayServer.close(resolve));
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

async function sourcePost(body, token = managedSourceToken, suppliedCorrelationId) {
  return fetch(`${origin}/game/api/audio-source`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(suppliedCorrelationId ? { "X-CannaBeats-Correlation-ID": suppliedCorrelationId } : {}),
    },
    body: JSON.stringify(body),
  });
}

test("liveness and readiness are distinct and return correlation references", async () => {
  const health = await fetch(`${origin}/game/api/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true, service: "cannabeats-game" });
  assert.match(health.headers.get("x-cannabeats-correlation-id"), /^[0-9a-f-]{36}$/);

  const readiness = await fetch(`${origin}/game/api/ready`);
  assert.equal(readiness.status, 200);
  assert.deepEqual(await readiness.json(), { ready: true, service: "cannabeats-game" });
});

test("unexpected game failures return only a stable safe envelope", async () => {
  const sessionCode = "ERR234";
  const runId = randomUUID();
  const sentinel = `private-provider-payload-${randomUUID()}`;
  db.prepare(`
    INSERT INTO game_sessions (code, host_user_id, status, active_run_id, created_at, updated_at)
    VALUES (?, ?, 'playing', ?, ?, ?)
  `).run(sessionCode, hostId, runId, Date.now(), Date.now());
  db.prepare(`
    INSERT INTO game_session_members (session_code, user_id, joined_at, last_seen_at)
    VALUES (?, ?, ?, ?)
  `).run(sessionCode, hostId, Date.now(), Date.now());
  db.prepare(`
    INSERT INTO game_runs (id, session_code, state, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(runId, sessionCode, `{${sentinel}`, Date.now(), Date.now());
  const response = await fetch(`${origin}/game/api/game?code=${sessionCode}`, {
    headers: { Cookie: `cb_session=${hostCookie}` },
  });
  assert.equal(response.status, 500);
  const body = await response.json();
  assert.equal(body.error, "Unexpected server error");
  assert.equal(body.code, "unexpected_server_error");
  assert.equal(body.correlationId, response.headers.get("x-cannabeats-correlation-id"));
  assert.doesNotMatch(JSON.stringify(body), new RegExp(sentinel));
  assert.doesNotMatch(serverOutput, new RegExp(sentinel));
});

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
  assert.equal(created.audio.selection, "managed");
  assert.equal(created.audio.mode, "managed");
  assert.equal(created.audio.sourceOnline, true);
  const lobby = db.prepare("SELECT active_run_id FROM game_sessions WHERE code = ?").get(sessionCode);
  assert.match(lobby.active_run_id, /^[0-9a-f-]{36}$/);
  assert.equal(db.prepare("SELECT session_code FROM game_runs WHERE id = ?").get(lobby.active_run_id).session_code, sessionCode);
  assert.equal(db.prepare("SELECT 1 FROM rooms WHERE code = ?").get(sessionCode), undefined);

  const anonymous = await fetch(`${origin}/game/api/game?code=${sessionCode}`);
  assert.equal(anonymous.status, 401);
  const anonymousBody = await anonymous.json();
  assert.equal(anonymousBody.code, "authentication_required");
  assert.equal(anonymousBody.correlationId, anonymous.headers.get("x-cannabeats-correlation-id"));

  const anonymousAudio = await fetch(`${origin}/game/api/audio-stream?code=${sessionCode}`);
  assert.equal(anonymousAudio.status, 401);

  const hostAudio = await fetch(`${origin}/game/api/audio-stream?code=${sessionCode}`, {
    headers: { Cookie: `cb_session=${hostCookie}` },
  });
  assert.equal(hostAudio.status, 200);
  assert.equal(hostAudio.headers.get("x-audio-rate"), "48000");
  assert.equal(hostAudio.headers.get("x-audio-channels"), "2");
  assert.equal(hostAudio.headers.get("x-audio-encoding"), "s16le");
  assert.equal(relayCorrelationIds.at(-1), hostAudio.headers.get("x-cannabeats-correlation-id"));
  assert.deepEqual(new Uint8Array(await hostAudio.arrayBuffer()), new Uint8Array([0, 0, 0, 0, 1, 0, 1, 0]));

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

  const playerCannotAcquireSource = await gamePost(
    { action: "audioAcquire", code: sessionCode },
    { Authorization: `Bearer ${playerToken}` },
  );
  assert.equal(playerCannotAcquireSource.status, 403);
  const playerCannotSelectSource = await gamePost(
    { action: "audioSelect", code: sessionCode, mode: "local" },
    { Authorization: `Bearer ${playerToken}` },
  );
  assert.equal(playerCannotSelectSource.status, 403);

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

  const untrustedCorrelation = randomUUID();
  const unauthenticatedSource = await sourcePost(
    { action: "poll" },
    "not-a-real-source-token-value-000000",
    untrustedCorrelation,
  );
  assert.equal(unauthenticatedSource.status, 401);
  assert.notEqual(unauthenticatedSource.headers.get("x-cannabeats-correlation-id"), untrustedCorrelation);
  const trustedCorrelation = randomUUID();
  const sourceHeartbeat = await sourcePost(
    { action: "poll", deviceId: "test-device" },
    managedSourceToken,
    trustedCorrelation,
  );
  assert.equal(sourceHeartbeat.status, 200);
  assert.equal(sourceHeartbeat.headers.get("x-cannabeats-correlation-id"), trustedCorrelation);
  assert.equal((await sourceHeartbeat.json()).lease.sessionCode, sessionCode);
  const localSource = await gamePost(
    { action: "audioSelect", code: sessionCode, mode: "local" },
    { Cookie: `cb_session=${hostCookie}`, Origin: origin },
  );
  assert.equal(localSource.status, 200);
  const localSourcePayload = await localSource.json();
  assert.equal(localSourcePayload.audio.selection, "local");
  assert.equal(localSourcePayload.audio.mode, "local");
  const releasedHeartbeat = await sourcePost({ action: "poll", deviceId: "test-device" });
  assert.equal(releasedHeartbeat.status, 200);
  assert.equal((await releasedHeartbeat.json()).lease, null);
  const acquired = await gamePost(
    { action: "audioSelect", code: sessionCode, mode: "managed" },
    { Cookie: `cb_session=${hostCookie}`, Origin: origin },
  );
  assert.equal(acquired.status, 200);
  const acquiredPayload = await acquired.json();
  assert.equal(acquiredPayload.audio.selection, "managed");
  assert.equal(acquiredPayload.audio.mode, "managed");
  assert.equal(acquiredPayload.audio.sourceOnline, true);
  assert.equal(
    db.prepare("SELECT 1 FROM managed_audio_sources WHERE token_hash = ?").get(managedSourceToken),
    undefined,
  );

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
  const playPoll = await sourcePost({ action: "poll", deviceId: "test-device" });
  assert.equal(playPoll.status, 200);
  const playWork = await playPoll.json();
  assert.equal(playWork.lease.sessionCode, sessionCode);
  assert.equal(playWork.command.kind, "play");
  assert.match(playWork.command.trackUri, /^spotify:track:/);
  const playComplete = await sourcePost({
    action: "complete",
    commandId: playWork.command.id,
    ok: true,
    playbackStatus: "playing",
    deviceId: "test-device",
  });
  assert.equal(playComplete.status, 200);

  const playerPaused = await gamePost(
    { action: "audioControl", code: sessionCode, command: "pause" },
    { Authorization: `Bearer ${playerToken}` },
  );
  assert.equal(playerPaused.status, 200);
  assert.equal((await playerPaused.json()).audio.status, "pausing");
  const playerCannotInjectTrack = await gamePost(
    { action: "audioControl", code: sessionCode, command: "play", trackUri: "spotify:track:attacker" },
    { Authorization: `Bearer ${playerToken}` },
  );
  assert.equal(playerCannotInjectTrack.status, 400);
  const pausePoll = await sourcePost({ action: "poll", deviceId: "test-device" });
  const pauseWork = await pausePoll.json();
  assert.equal(pauseWork.command.kind, "pause");
  const pauseComplete = await sourcePost({
    action: "complete",
    commandId: pauseWork.command.id,
    ok: false,
    playbackStatus: "error",
    error: `Bearer ${relayListenToken} spotify:track:preRevealPrivateId test-device`,
    deviceId: "test-device",
  });
  assert.equal(pauseComplete.status, 200);
  const failedCommand = db.prepare("SELECT error FROM managed_audio_commands WHERE id = ?")
    .get(pauseWork.command.id);
  assert.equal(failedCommand.error, "managed_playback_failed");
  assert.ok(!JSON.stringify(failedCommand).includes(relayListenToken));
  const hostResumed = await gamePost(
    { action: "audioControl", code: sessionCode, command: "resume" },
    { Cookie: `cb_session=${hostCookie}`, Origin: origin },
  );
  assert.equal(hostResumed.status, 200);
  const resumePoll = await sourcePost({ action: "poll", deviceId: "test-device" });
  const resumeWork = await resumePoll.json();
  assert.equal(resumeWork.command.kind, "resume");
  assert.equal((await sourcePost({
    action: "complete",
    commandId: resumeWork.command.id,
    ok: true,
    playbackStatus: "playing",
    deviceId: "test-device",
  })).status, 200);
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

  const released = await gamePost(
    { action: "audioRelease", code: sessionCode },
    { Cookie: `cb_session=${hostCookie}`, Origin: origin },
  );
  assert.equal(released.status, 200);
  assert.equal((await released.json()).audio.mode, "local");
  assert.equal((await (await sourcePost({ action: "poll", deviceId: "test-device" })).json()).lease, null);
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

  const guestAudio = await fetch(`${origin}/game/api/audio-stream?code=${sessionCode}`, {
    headers: { Cookie: guestCookie },
  });
  assert.equal(guestAudio.status, 200);
  assert.equal((await guestAudio.arrayBuffer()).byteLength, 8);

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
