import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
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

test("the Host service creates a real room and only its owner receives host authority", async () => {
  const createdResponse = await gamePost(
    { action: "create", ownerUserId: hostId },
    { "X-CannaBeats-Internal-Token": internalToken },
  );
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();
  assert.match(created.room.code, /^[A-Z2-9]{4}$/);
  assert.equal(created.room.phase, "lobby");
  assert.equal(created.room.isHost, true);

  const anonymous = await fetch(`${origin}/game/api/game?code=${created.room.code}`);
  assert.equal(anonymous.status, 401);

  const hostView = await fetch(`${origin}/game/api/game?code=${created.room.code}`, {
    headers: { Cookie: `cb_session=${hostCookie}` },
  });
  assert.equal(hostView.status, 200);
  assert.equal((await hostView.json()).room.isHost, true);

  const playerView = await fetch(`${origin}/game/api/game?code=${created.room.code}`, {
    headers: { Authorization: `Bearer ${playerToken}` },
  });
  assert.equal(playerView.status, 200);
  assert.equal((await playerView.json()).room.isHost, false);

  const launchTicket = `desktop-launch-${randomUUID()}`;
  db.prepare(`
    INSERT INTO desktop_web_tickets
      (token_hash, desktop_session_hash, room_code, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(sha256(launchTicket), sha256(playerToken), created.room.code, Date.now(), Date.now() + 60_000);
  const handoff = await fetch(
    `${origin}/game/desktop?ticket=${encodeURIComponent(launchTicket)}`,
    { redirect: "manual" },
  );
  assert.equal(handoff.status, 303);
  assert.equal(new URL(handoff.headers.get("location")).searchParams.get("room"), created.room.code);
  assert.match(handoff.headers.get("set-cookie"), /^cb_desktop_web=.*HttpOnly; Secure; SameSite=Strict/);
  const desktopWebCookie = handoff.headers.get("set-cookie").split(";", 1)[0];
  const webView = await fetch(`${origin}/game/api/game?code=${created.room.code}`, {
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
    { action: "join", code: created.room.code, name: "Desktop Player" },
    { Authorization: `Bearer ${playerToken}` },
  );
  assert.equal(joined.status, 201);
  assert.equal((await joined.json()).room.players.length, 1);

  const added = await gamePost(
    { action: "addPlayer", code: created.room.code, name: "Shared Screen Player" },
    { Cookie: `cb_session=${hostCookie}`, Origin: origin },
  );
  assert.equal(added.status, 201);
  assert.equal((await added.json()).room.players.length, 2);

  const browserCreate = await gamePost(
    { action: "create", ownerUserId: hostId },
    { Cookie: `cb_session=${hostCookie}`, Origin: origin },
  );
  assert.equal(browserCreate.status, 403);

  const resumed = await gamePost(
    { action: "resume", ownerUserId: hostId, code: created.room.code },
    { "X-CannaBeats-Internal-Token": internalToken },
  );
  assert.equal(resumed.status, 200);
  assert.equal((await resumed.json()).room.code, created.room.code);
});
