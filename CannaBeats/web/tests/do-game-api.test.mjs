import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { after, before, test } from "node:test";
import { openDatabase, purgeExpired, sha256 } from "../../spikes/access-spotify-poc/db.mjs";
import { isRunBoundMutationAction, RUN_BOUND_MUTATION_ACTIONS } from "../lib/game-action-contract.ts";
import { requestGame } from "../lib/game-request.ts";

const temporaryDirectory = mkdtempSync(join(tmpdir(), "cannabeats-game-test-"));
const databasePath = join(temporaryDirectory, "game.sqlite");
const internalToken = "game-api-test-internal-token-value";
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

test("prepare decides whether a run exists only after acquiring the writer lock", () => {
  const source = readFileSync(new URL("../app/api/game/route.ts", import.meta.url), "utf8");
  const prepare = source.slice(source.indexOf('if (action === "prepare")'), source.indexOf('if (action === "guestInvite")'));
  const lock = prepare.indexOf('BEGIN IMMEDIATE');
  assert.ok(lock >= 0);
  assert.ok(prepare.indexOf('SELECT host_user_id', lock) > lock);
  assert.ok(prepare.indexOf('loadRoom(code)', lock) > lock);
});

test("every cataloged run mutation has exactly one shared executor case", () => {
  const source = readFileSync(new URL("../app/api/game/route.ts", import.meta.url), "utf8");
  const boundary = source.slice(source.indexOf("function mutateRoomOnce"), source.indexOf("function pickSong"));
  assert.ok(boundary.indexOf('db.exec("BEGIN IMMEDIATE")') < boundary.indexOf("isLobbyMember(code, principal)"));
  assert.ok(boundary.indexOf("isLobbyMember(code, principal)") < boundary.indexOf("loadRoom(code)"));
  assert.equal(boundary.match(/saveRoom\(current\.state\)/g)?.length, 1);
  assert.ok(boundary.indexOf("const result = mutate(current)") < boundary.indexOf("saveRoom(current.state)"));
  const executor = source.slice(
    source.indexOf("function executeRunBoundMutation"),
    source.indexOf("function errorResponse"),
  );
  assert.match(executor, /GAME_ACTION_POLICIES\[action\]\.authority === "host"/);
  for (const action of RUN_BOUND_MUTATION_ACTIONS) {
    assert.equal(executor.match(new RegExp(`case \\\"${action}\\\"`, "g"))?.length, 1, action);
    assert.doesNotMatch(
      source.slice(source.indexOf("async function postGame")),
      new RegExp(`if \\(action === \\\"${action}\\\"\\)`),
      `${action} bypasses the shared executor`,
    );
  }
});

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
let secondaryProcessHandle;
let secondaryOrigin;
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

async function waitForHealth(targetOrigin) {
  const deadline = Date.now() + 20_000;
  let lastHealth = "no response";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${targetOrigin}/game/api/ready`);
      if (response.ok) return;
      lastHealth = `${response.status} ${await response.text()}`;
    } catch (error) {
      lastHealth = String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`The DigitalOcean game build did not start in time (${lastHealth}). ${serverOutput.slice(-2_000)}`);
}

async function startGameProcess(targetOrigin, port) {
  const child = spawn(
    process.execPath,
    [".next/standalone/server.js"],
    {
      cwd: new URL("..", import.meta.url),
      env: {
        ...process.env,
        HOSTNAME: "127.0.0.1",
        PORT: String(port),
        CANNABEATS_APP_ORIGIN: targetOrigin,
        CANNABEATS_DATABASE_PATH: databasePath,
        CANNABEATS_DATABASE_BUSY_TIMEOUT_MS: "250",
        CANNABEATS_GAME_SERVICE_TOKEN: internalToken,
        CANNABEATS_PUBLIC_GAME_ORIGIN: `${targetOrigin}/game`,
        AUDIO_RELAY_ORIGIN: relayOrigin,
        AUDIO_RELAY_LISTEN_TOKEN_FILE: relayTokenPath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.on("data", (chunk) => { serverOutput += chunk; });
  child.stderr.on("data", (chunk) => { serverOutput += chunk; });
  await waitForHealth(targetOrigin);
  return child;
}

async function stopGameProcess(child) {
  child?.kill("SIGTERM");
  if (child && child.exitCode === null) {
    await new Promise((resolve) => child.once("exit", resolve));
  }
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
  processHandle = await startGameProcess(origin, port);
  const secondaryPort = await availablePort();
  secondaryOrigin = `http://127.0.0.1:${secondaryPort}`;
  secondaryProcessHandle = await startGameProcess(secondaryOrigin, secondaryPort);
  await sourcePost({ action: "poll" }, "source-schema-initializer-token-value");
  db.prepare(`
    INSERT INTO managed_audio_sources
      (id, display_name, token_hash, enabled, created_at, last_seen_at)
    VALUES (?, ?, ?, 1, ?, ?)
  `).run(managedSourceId, "Test Managed Source", sha256(managedSourceToken), Date.now(), Date.now());
});

after(async () => {
  await stopGameProcess(secondaryProcessHandle);
  await stopGameProcess(processHandle);
  if (relayServer) await new Promise((resolve) => relayServer.close(resolve));
  db.close();
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

async function gamePost(body, headers = {}, targetOrigin = origin) {
  let requestBody = body;
  if (isRunBoundMutationAction(String(body.action ?? ""))
      && body.actionId === undefined
      && !["place", "retract", "reveal"].includes(String(body.action))) {
    const code = String(body.code ?? "").trim().toUpperCase();
    const row = db.prepare(`
      SELECT game_runs.id AS run_id, game_runs.revision, game_sessions.run_generation
      FROM game_sessions JOIN game_runs ON game_runs.id = game_sessions.active_run_id
      WHERE game_sessions.code = ?
    `).get(code);
    if (row) {
      requestBody = {
        ...body,
        actionId: randomUUID(),
        expectedRunId: row.run_id,
        expectedRunGeneration: row.run_generation,
        expectedRevision: row.revision,
      };
    }
  }
  return fetch(`${targetOrigin}/game/api/game`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(requestBody),
  });
}

async function gameRequestLosingFirstBody(body, headers, message) {
  let attempts = 0;
  const payload = await requestGame(`${origin}/game/api/game`, body, {
    fetchImpl: async (input, init) => {
      attempts += 1;
      const response = await fetch(input, {
        ...init,
        headers: { ...Object.fromEntries(new Headers(init.headers)), ...headers },
      });
      if (attempts === 1) {
        return {
          ok: response.ok,
          status: response.status,
          headers: response.headers,
          json: async () => { throw new TypeError(message); },
        };
      }
      return response;
    },
  });
  return { attempts, payload };
}

function runContext(code) {
  const row = db.prepare(`
    SELECT game_runs.id AS run_id, game_runs.revision, game_sessions.run_generation
    FROM game_sessions JOIN game_runs ON game_runs.id = game_sessions.active_run_id
    WHERE game_sessions.code = ?
  `).get(code);
  assert.ok(row, `missing run context for ${code}`);
  return {
    expectedRunId: row.run_id,
    expectedRunGeneration: row.run_generation,
    expectedRevision: row.revision,
  };
}

function acknowledgeFixtureRevision(runId) {
  db.prepare(`
    UPDATE game_event_coverage
    SET last_recorded_revision = (SELECT revision FROM game_runs WHERE id = ?)
    WHERE run_id = ?
  `).run(runId, runId);
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

async function claimAndBeginSourceCommand(commandId) {
  const claimGeneration = randomUUID();
  const claim = await sourcePost({ action: "claim", commandId, claimGeneration });
  assert.equal(claim.status, 200);
  assert.deepEqual(await claim.json(), { accepted: true, status: "claimed", replayed: false });
  const begin = await sourcePost({ action: "begin", commandId, claimGeneration });
  assert.equal(begin.status, 200);
  assert.deepEqual(await begin.json(), { accepted: true, status: "executing", replayed: false });
  return claimGeneration;
}

test("liveness and readiness are distinct and return correlation references", async () => {
  const health = await fetch(`${origin}/game/api/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true, service: "cannabeats-game" });
  assert.match(health.headers.get("x-cannabeats-correlation-id"), /^[0-9a-f-]{36}$/);

  const readiness = await fetch(`${origin}/game/api/ready`);
  assert.equal(readiness.status, 200);
  assert.deepEqual(await readiness.json(), { ready: true, service: "cannabeats-game" });
  assert.match(serverOutput, /"event":"service\.started"/);
});

test("managed-source polling logs one failure transition and one recovery", async () => {
  await sourcePost({ action: "poll" });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const outputOffset = serverOutput.length;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await sourcePost({ action: "poll" }, "invalid-managed-source-token");
    assert.equal(response.status, 401);
  }
  assert.equal((await sourcePost({ action: "poll" })).status, 200);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const records = serverOutput.slice(outputOffset).split("\n").flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  }).filter((record) => ["dependency.unavailable", "dependency.recovered"].includes(record.event)
    && record.route === "/api/audio-source");
  assert.deepEqual(records.map((record) => record.event), [
    "dependency.unavailable", "dependency.recovered",
  ]);
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

test("an internal membership check keeps the public response correlation reference", async () => {
  const outputOffset = serverOutput.length;
  const response = await fetch(`${origin}/game/api/audio-stream?code=MISS23`);
  assert.equal(response.status, 401);
  const correlationId = response.headers.get("x-cannabeats-correlation-id");
  assert.match(correlationId, /^[0-9a-f-]{36}$/);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const records = serverOutput.slice(outputOffset).split("\n").flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  }).filter((record) => record.event === "http.request_failed"
    && ["/api/audio-stream", "/api/game"].includes(record.route));
  assert.deepEqual(new Set(records.map((record) => record.route)),
    new Set(["/api/audio-stream", "/api/game"]));
  assert.deepEqual(new Set(records.map((record) => record.correlationId)), new Set([correlationId]));
});

test("configured game origins can never receive forwarded user credentials", async () => {
  const leakedRequests = [];
  const untrustedServer = createHttpServer((request, response) => {
    leakedRequests.push(request.headers);
    response.writeHead(401, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "untrusted" }));
  });
  await new Promise((resolve, reject) => {
    untrustedServer.once("error", reject);
    untrustedServer.listen(0, "127.0.0.1", resolve);
  });
  const untrustedOrigin = `http://127.0.0.1:${untrustedServer.address().port}`;
  const isolatedPort = await availablePort();
  const isolatedOrigin = `http://127.0.0.1:${isolatedPort}`;
  let isolatedOutput = "";
  const isolatedProcess = spawn(process.execPath, [".next/standalone/server.js"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      HOSTNAME: "127.0.0.1",
      PORT: String(isolatedPort),
      CANNABEATS_APP_ORIGIN: isolatedOrigin,
      CANNABEATS_DATABASE_PATH: databasePath,
      CANNABEATS_GAME_SERVICE_TOKEN: internalToken,
      CANNABEATS_PUBLIC_GAME_ORIGIN: untrustedOrigin,
      AUDIO_RELAY_ORIGIN: relayOrigin,
      AUDIO_RELAY_LISTEN_TOKEN_FILE: relayTokenPath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  isolatedProcess.stdout.on("data", (chunk) => { isolatedOutput += chunk; });
  isolatedProcess.stderr.on("data", (chunk) => { isolatedOutput += chunk; });
  try {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      try {
        const readiness = await fetch(`${isolatedOrigin}/game/api/ready`);
        if (readiness.ok) break;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const sentinelCookie = `private-cookie-${randomUUID()}`;
    const sentinelAuthorization = `private-authorization-${randomUUID()}`;
    const response = await fetch(`${isolatedOrigin}/game/api/audio-stream?code=MISS23`, {
      headers: { Cookie: sentinelCookie, Authorization: `Bearer ${sentinelAuthorization}` },
    });
    assert.equal(response.status, 401, isolatedOutput.slice(-1_000));
    assert.equal(leakedRequests.length, 0, "configured external origin received a membership request");
  } finally {
    isolatedProcess.kill("SIGTERM");
    if (isolatedProcess.exitCode === null) {
      await new Promise((resolve) => isolatedProcess.once("exit", resolve));
    }
    await new Promise((resolve) => untrustedServer.close(resolve));
  }
  assert.match(isolatedOutput, /"event":"service\.stopping"/);
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

  db.exec("BEGIN IMMEDIATE");
  const concurrentPreparation = Promise.all([
    gamePost(
      { action: "prepare", code: sessionCode },
      { Cookie: `cb_session=${hostCookie}`, Origin: origin },
    ),
    gamePost(
      { action: "prepare", code: sessionCode },
      { Cookie: `cb_session=${hostCookie}`, Origin: secondaryOrigin },
      secondaryOrigin,
    ),
  ]);
  await new Promise((resolve) => setTimeout(resolve, 50));
  db.exec("ROLLBACK");
  const createdResponses = await concurrentPreparation;
  assert.deepEqual(createdResponses.map((response) => response.status).sort(), [200, 201]);
  const createdPayloads = await Promise.all(createdResponses.map((response) => response.json()));
  assert.equal(new Set(createdPayloads.map((payload) => payload.room.runId)).size, 1);
  assert.deepEqual(createdPayloads.map((payload) => payload.created).sort(), [false, true]);
  const created = createdPayloads[0];
  assert.equal(created.room.code, sessionCode);
  assert.equal(created.room.phase, "lobby");
  assert.equal(created.room.isHost, true);
  assert.match(created.room.runId, /^[0-9a-f-]{36}$/);
  assert.equal(created.room.runGeneration, 1);
  assert.equal(created.room.revision, 0);
  assert.equal(created.audio.selection, "managed");
  assert.equal(created.audio.mode, "local");
  assert.equal(created.audio.sourceOnline, false);
  const lobby = db.prepare("SELECT active_run_id FROM game_sessions WHERE code = ?").get(sessionCode);
  assert.match(lobby.active_run_id, /^[0-9a-f-]{36}$/);
  assert.equal(created.room.runId, lobby.active_run_id);
  assert.equal(db.prepare("SELECT session_code FROM game_runs WHERE id = ?").get(lobby.active_run_id).session_code, sessionCode);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM game_runs WHERE session_code = ?").get(sessionCode).count, 1);
  assert.equal(db.prepare("SELECT run_generation FROM game_sessions WHERE code = ?").get(sessionCode).run_generation, 1);
  assert.equal(db.prepare("SELECT 1 FROM rooms WHERE code = ?").get(sessionCode), undefined);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM managed_audio_leases").get().count, 0);

  const runBoundActions = [
    ["abandon", {}],
    ["audioAcquire", {}],
    ["audioSelect", { mode: "local" }],
    ["audioRelease", {}],
    ["audioControl", { command: "pause" }],
    ["addPlayer", { name: "Must not be added" }],
    ["removePlayer", { playerId: randomUUID() }],
    ["rules", { rules: { preset: "family" } }],
    ["start", {}],
    ["begin", {}],
    ["place", { playerId: randomUUID(), index: 0 }],
    ["retract", { playerId: randomUUID() }],
    ["reveal", {}],
    ["advance", {}],
    ["skip", {}],
  ];
  assert.deepEqual(
    runBoundActions.map(([action]) => action),
    RUN_BOUND_MUTATION_ACTIONS,
    "the stale-context matrix must enumerate the executable action catalog",
  );
  for (const [action, fields] of runBoundActions) {
    const stale = await gamePost(
      {
        action,
        actionId: randomUUID(),
        code: sessionCode,
        expectedRunId: randomUUID(),
        expectedRunGeneration: created.room.runGeneration,
        expectedRevision: created.room.revision,
        ...fields,
      },
      { Cookie: `cb_session=${hostCookie}`, Origin: origin },
    );
    assert.equal(stale.status, 409, `${action} must reject stale run context before action validation`);
    assert.equal((await stale.json()).code, "stale_action", action);
  }
  assert.equal(db.prepare("SELECT revision FROM game_runs WHERE id = ?").get(created.room.runId).revision, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM managed_audio_commands").get().count, 0);

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
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM managed_audio_leases WHERE session_code = ?")
      .get(sessionCode).count,
    0,
    "an authenticated GET must not reserve or renew playback",
  );

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

  const reserved = await gamePost(
    { action: "audioAcquire", code: sessionCode },
    { Cookie: `cb_session=${hostCookie}`, Origin: origin },
  );
  assert.equal(reserved.status, 200);
  assert.equal((await reserved.json()).audio.mode, "managed");
  assert.deepEqual(db.prepare(`
    SELECT event_type, outcome FROM game_events
    WHERE run_id = ? AND event_type = 'audio_lease_acquired' ORDER BY sequence
  `).all(created.room.runId).map((event) => ({ ...event })), [
    { event_type: "audio_lease_acquired", outcome: "accepted" },
  ]);

  const addPlayerRequest = {
    action: "addPlayer",
    actionId: randomUUID(),
    code: sessionCode,
    name: "Shared Screen Player",
    ...runContext(sessionCode),
  };
  const added = await gamePost(
    addPlayerRequest,
    { Cookie: `cb_session=${hostCookie}`, Origin: origin },
  );
  assert.equal(added.status, 201);
  const addedPayload = await added.json();
  assert.equal(addedPayload.room.players.length, 2);
  assert.equal(addedPayload.action.replayed, false);
  const replayedAdd = await gamePost(
    addPlayerRequest,
    { Cookie: `cb_session=${hostCookie}`, Origin: origin },
  );
  assert.equal(replayedAdd.status, 200);
  const replayedAddPayload = await replayedAdd.json();
  assert.equal(replayedAddPayload.action.replayed, true);
  assert.equal(replayedAddPayload.room.players.length, 2);

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
    { action: "poll", deviceId: "spotify:track:private token-capability-SECRET" },
    managedSourceToken,
    trustedCorrelation,
  );
  assert.equal(sourceHeartbeat.status, 200);
  assert.equal(sourceHeartbeat.headers.get("x-cannabeats-correlation-id"), trustedCorrelation);
  assert.equal((await sourceHeartbeat.json()).lease.sessionCode, sessionCode);
  const persistedSourceDeviceId = db.prepare(
    "SELECT device_id FROM managed_audio_sources WHERE id = ?",
  ).get(managedSourceId).device_id;
  const localSourceRequest = {
    action: "audioSelect",
    actionId: randomUUID(),
    code: sessionCode,
    mode: "local",
    ...runContext(sessionCode),
  };
  const localSource = await gamePost(
    localSourceRequest,
    { Cookie: `cb_session=${hostCookie}`, Origin: origin },
  );
  assert.equal(localSource.status, 200);
  const localSourcePayload = await localSource.json();
  assert.equal(localSourcePayload.audio.selection, "local");
  assert.equal(localSourcePayload.audio.mode, "local");
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM game_events
    WHERE run_id = ? AND event_type = 'audio_lease_released'
  `).get(created.room.runId).count, 1);
  const replayedLocalSource = await gamePost(
    localSourceRequest,
    { Cookie: `cb_session=${hostCookie}`, Origin: origin },
  );
  assert.equal((await replayedLocalSource.json()).action.replayed, true);
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
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM game_events
    WHERE run_id = ? AND event_type = 'audio_lease_acquired'
  `).get(created.room.runId).count, 2);
  assert.equal(
    db.prepare("SELECT 1 FROM managed_audio_sources WHERE token_hash = ?").get(managedSourceToken),
    undefined,
  );

  const startRequest = {
    action: "start",
    actionId: randomUUID(),
    code: sessionCode,
    ...runContext(sessionCode),
  };
  const { attempts: lostStartResponses, payload: startedPayload } = await gameRequestLosingFirstBody(
    startRequest,
    { Cookie: `cb_session=${hostCookie}`, Origin: origin },
    "simulated start response loss after commit",
  );
  assert.equal(lostStartResponses, 2);
  assert.equal(startedPayload.action.replayed, true);
  const readyRoom = startedPayload.room;
  assert.ok(stageAndScreenUris.has(readyRoom.currentSong.uri));
  assert.ok(readyRoom.players.every((player) => player.timeline.every(
    (song) => stageAndScreenUris.has(song.uri),
  )));
  const replayedStart = await gamePost(
    startRequest,
    { Cookie: `cb_session=${hostCookie}`, Origin: origin },
  );
  const replayedStartPayload = await replayedStart.json();
  assert.equal(replayedStartPayload.action.replayed, true);
  assert.equal(replayedStartPayload.room.revision, readyRoom.revision);
  const beginRequest = {
    action: "begin",
    actionId: randomUUID(),
    code: sessionCode,
    ...runContext(sessionCode),
  };
  const playCommandsBeforeBegin = db.prepare(`
    SELECT COUNT(*) AS count FROM managed_audio_commands WHERE kind = 'play'
  `).get().count;
  const { attempts: lostBeginResponses, payload: begunPayload } = await gameRequestLosingFirstBody(
    beginRequest,
    { Cookie: `cb_session=${hostCookie}`, Origin: origin },
    "simulated begin response loss after commit",
  );
  assert.equal(lostBeginResponses, 2);
  assert.equal(begunPayload.action.replayed, true);
  const playingRoom = begunPayload.room;
  assert.equal(playingRoom.runId, readyRoom.runId);
  assert.equal(playingRoom.revision, readyRoom.revision + 1);
  const replayedBegin = await gamePost(
    beginRequest,
    { Cookie: `cb_session=${hostCookie}`, Origin: origin },
  );
  assert.equal((await replayedBegin.json()).action.replayed, true);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM managed_audio_commands WHERE kind = 'play'").get().count,
    playCommandsBeforeBegin + 1,
  );
  const playerBeforeReveal = await fetch(`${origin}/game/api/game?code=${sessionCode}`, {
    headers: { Authorization: `Bearer ${playerToken}` },
  });
  assert.equal(playerBeforeReveal.status, 200);
  const playerBeforeRevealPayload = await playerBeforeReveal.json();
  assert.equal(playerBeforeRevealPayload.room.currentSong, null);
  assert.doesNotMatch(
    JSON.stringify(playerBeforeRevealPayload),
    new RegExp(playingRoom.currentSong.uri.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
  const playPoll = await sourcePost({ action: "poll", deviceId: "test-device" });
  assert.equal(playPoll.status, 200);
  const playWork = await playPoll.json();
  assert.equal(playWork.lease.sessionCode, sessionCode);
  assert.equal(playWork.command.kind, "play");
  assert.match(playWork.command.trackUri, /^spotify:track:/);
  const playClaimGeneration = await claimAndBeginSourceCommand(playWork.command.id);
  const playComplete = await sourcePost({
    action: "complete",
    commandId: playWork.command.id,
    claimGeneration: playClaimGeneration,
    ok: true,
    playbackStatus: "playing",
    deviceId: "test-device",
  });
  assert.equal(playComplete.status, 200);
  const replayedPlayComplete = await sourcePost({
    action: "complete",
    commandId: playWork.command.id,
    claimGeneration: playClaimGeneration,
    ok: true,
    playbackStatus: "playing",
    deviceId: "test-device",
  });
  assert.equal(replayedPlayComplete.status, 200);
  assert.equal((await replayedPlayComplete.json()).replayed, true);
  const conflictingPlayComplete = await sourcePost({
    action: "complete",
    commandId: playWork.command.id,
    claimGeneration: playClaimGeneration,
    ok: false,
    playbackStatus: "error",
    error: "managed_playback_failed",
    deviceId: "test-device",
  });
  assert.equal(conflictingPlayComplete.status, 409);
  const conflictingStatusComplete = await sourcePost({
    action: "complete",
    commandId: playWork.command.id,
    claimGeneration: playClaimGeneration,
    ok: true,
    playbackStatus: "paused",
    deviceId: "test-device",
  });
  assert.equal(conflictingStatusComplete.status, 409);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM game_events
    WHERE run_id = ? AND event_type = 'audio_command_completed' AND detail_code = 'play'
  `).get(playingRoom.runId).count, 1);
  const commandsBeforeRenewal = db.prepare(`
    SELECT COUNT(*) AS count FROM managed_audio_commands WHERE lease_id = (
      SELECT id FROM managed_audio_leases WHERE session_code = ?
    )
  `).get(sessionCode).count;
  const requestedBeforeRenewal = db.prepare(`
    SELECT COUNT(*) AS count FROM game_events
    WHERE run_id = ? AND event_type = 'audio_command_requested'
  `).get(playingRoom.runId).count;
  const renewed = await gamePost(
    { action: "audioAcquire", code: sessionCode },
    { Cookie: `cb_session=${hostCookie}`, Origin: origin },
  );
  assert.equal(renewed.status, 200);
  const commandsAfterRenewal = db.prepare(`
    SELECT COUNT(*) AS count FROM managed_audio_commands WHERE lease_id = (
      SELECT id FROM managed_audio_leases WHERE session_code = ?
    )
  `).get(sessionCode).count;
  const requestedAfterRenewal = db.prepare(`
    SELECT COUNT(*) AS count FROM game_events
    WHERE run_id = ? AND event_type = 'audio_command_requested'
  `).get(playingRoom.runId).count;

  const pauseContext = runContext(sessionCode);
  const beforeFailedAudioMutation = {
    commandCount: db.prepare("SELECT COUNT(*) AS count FROM managed_audio_commands").get().count,
    eventCount: db.prepare("SELECT COUNT(*) AS count FROM game_events WHERE run_id = ?")
      .get(pauseContext.expectedRunId).count,
    lease: db.prepare("SELECT playback_status FROM managed_audio_leases WHERE session_code = ?")
      .get(sessionCode),
    run: db.prepare("SELECT state, revision FROM game_runs WHERE id = ?").get(pauseContext.expectedRunId),
  };
  const failedAudioActionId = randomUUID();
  db.exec(`
    CREATE TRIGGER inject_audio_receipt_failure
    BEFORE INSERT ON game_action_receipts
    BEGIN
      SELECT RAISE(ABORT, 'injected audio receipt failure');
    END;
  `);
  try {
    const failedAudioMutation = await gamePost(
      {
        action: "audioControl",
        actionId: failedAudioActionId,
        code: sessionCode,
        command: "pause",
        ...pauseContext,
      },
      { Authorization: `Bearer ${playerToken}` },
    );
    assert.equal(failedAudioMutation.status, 500);
  } finally {
    db.exec("DROP TRIGGER inject_audio_receipt_failure");
  }
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM managed_audio_commands").get().count,
    beforeFailedAudioMutation.commandCount,
  );
  assert.deepEqual(
    db.prepare("SELECT playback_status FROM managed_audio_leases WHERE session_code = ?").get(sessionCode),
    beforeFailedAudioMutation.lease,
  );
  assert.deepEqual(
    db.prepare("SELECT state, revision FROM game_runs WHERE id = ?").get(pauseContext.expectedRunId),
    beforeFailedAudioMutation.run,
  );
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM game_action_receipts WHERE action_id = ?
  `).get(failedAudioActionId).count, 0);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM game_events WHERE run_id = ?")
      .get(pauseContext.expectedRunId).count,
    beforeFailedAudioMutation.eventCount,
  );
  const pauseRequest = {
    action: "audioControl",
    actionId: randomUUID(),
    code: sessionCode,
    command: "pause",
    ...pauseContext,
  };
  const { attempts: lostPauseResponses, payload: playerPausedPayload } = await gameRequestLosingFirstBody(
    pauseRequest,
    { Authorization: `Bearer ${playerToken}` },
    "simulated pause response loss after commit",
  );
  assert.equal(lostPauseResponses, 2);
  assert.equal(playerPausedPayload.action.replayed, true);
  assert.equal(playerPausedPayload.audio.status, "pausing");
  assert.equal(playerPausedPayload.room.revision, pauseContext.expectedRevision + 1);
  const staleResume = await gamePost(
    {
      ...pauseRequest,
      actionId: randomUUID(),
      command: "resume",
    },
    { Authorization: `Bearer ${playerToken}` },
  );
  assert.equal(staleResume.status, 409);
  assert.equal((await staleResume.json()).code, "stale_action");
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM managed_audio_commands WHERE kind IN ('pause', 'resume')
  `).get().count, 1);
  const playerCannotInjectTrack = await gamePost(
    { action: "audioControl", code: sessionCode, command: "play", trackUri: "spotify:track:attacker" },
    { Authorization: `Bearer ${playerToken}` },
  );
  assert.equal(playerCannotInjectTrack.status, 400);
  const pausePoll = await sourcePost({ action: "poll", deviceId: "test-device" });
  const pauseWork = await pausePoll.json();
  assert.equal(pauseWork.command.kind, "pause");
  const pauseClaimGeneration = await claimAndBeginSourceCommand(pauseWork.command.id);
  const pauseComplete = await sourcePost({
    action: "complete",
    commandId: pauseWork.command.id,
    claimGeneration: pauseClaimGeneration,
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
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM managed_audio_commands WHERE kind IN ('pause', 'resume')
  `).get().count, 2);
  const resumePoll = await sourcePost({ action: "poll", deviceId: "test-device" });
  const resumeWork = await resumePoll.json();
  assert.equal(resumeWork.command.kind, "resume");
  const resumeClaimGeneration = await claimAndBeginSourceCommand(resumeWork.command.id);
  assert.equal((await sourcePost({
    action: "complete",
    commandId: resumeWork.command.id,
    claimGeneration: resumeClaimGeneration,
    ok: true,
    playbackStatus: "playing",
    deviceId: "test-device",
  })).status, 200);
  const activePlayer = readyRoom.players.find((player) => player.id === readyRoom.activePlayerId);
  const placementHeaders = activePlayer.control === "host"
    ? { Cookie: `cb_session=${hostCookie}`, Origin: origin }
    : { Authorization: `Bearer ${playerToken}` };
  const secondaryPlacementHeaders = activePlayer.control === "host"
    ? { Cookie: `cb_session=${hostCookie}`, Origin: secondaryOrigin }
    : placementHeaders;
  const missingPlacementId = await gamePost(
    {
      action: "place", code: sessionCode, playerId: activePlayer.id, index: 0,
      expectedRunId: playingRoom.runId, expectedRunGeneration: playingRoom.runGeneration,
      expectedRevision: playingRoom.revision,
    },
    placementHeaders,
  );
  assert.equal(missingPlacementId.status, 400);
  assert.equal((await missingPlacementId.json()).code, "action_id_required");
  const nonV4PlacementId = await gamePost(
    {
      action: "place", actionId: "00010203-0405-1607-8809-0a0b0c0d0e0f",
      code: sessionCode, playerId: activePlayer.id, index: 0,
      expectedRunId: playingRoom.runId, expectedRunGeneration: playingRoom.runGeneration,
      expectedRevision: playingRoom.revision,
    },
    placementHeaders,
  );
  assert.equal(nonV4PlacementId.status, 400);
  assert.equal((await nonV4PlacementId.json()).code, "action_id_required");

  for (const staleContext of [
    {
      expectedRunId: randomUUID(), expectedRunGeneration: playingRoom.runGeneration,
      expectedRevision: playingRoom.revision,
    },
    {
      expectedRunId: playingRoom.runId, expectedRunGeneration: playingRoom.runGeneration,
      expectedRevision: playingRoom.revision - 1,
    },
    {
      expectedRunId: playingRoom.runId, expectedRunGeneration: playingRoom.runGeneration - 1,
      expectedRevision: playingRoom.revision,
    },
  ]) {
    const stalePlacement = await gamePost(
      {
        action: "place", actionId: randomUUID(), code: sessionCode,
        playerId: activePlayer.id, index: 0, ...staleContext,
      },
      placementHeaders,
    );
    assert.equal(stalePlacement.status, 409);
    assert.equal((await stalePlacement.json()).code, "stale_action");
  }

  const placementActionId = randomUUID();
  const placementContext = runContext(sessionCode);
  const placementRequest = {
    action: "place", actionId: placementActionId, code: sessionCode, playerId: activePlayer.id, index: 0,
    ...placementContext,
  };
  const otherActorHeaders = activePlayer.control === "host"
    ? { Authorization: `Bearer ${playerToken}` }
    : { Cookie: `cb_session=${hostCookie}`, Origin: origin };
  const stateBeforeInjectedFailure = db.prepare(`
    SELECT state, revision FROM game_runs WHERE id = ?
  `).get(playingRoom.runId);
  const eventsBeforeInjectedFailure = db.prepare(
    "SELECT COUNT(*) AS count FROM game_events WHERE run_id = ?",
  ).get(playingRoom.runId).count;
  const unauthorizedPlacement = await gamePost(placementRequest, otherActorHeaders);
  assert.equal(unauthorizedPlacement.status, 409);
  assert.deepEqual(
    db.prepare("SELECT state, revision FROM game_runs WHERE id = ?").get(playingRoom.runId),
    stateBeforeInjectedFailure,
  );
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM game_action_receipts WHERE action_id = ?
  `).get(placementActionId).count, 0);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM game_events WHERE run_id = ?").get(playingRoom.runId).count,
    eventsBeforeInjectedFailure,
  );
  db.exec(`
    CREATE TRIGGER inject_action_receipt_failure
    BEFORE INSERT ON game_action_receipts
    BEGIN
      SELECT RAISE(ABORT, 'injected action receipt failure');
    END;
  `);
  try {
    const failedReceipt = await gamePost(placementRequest, placementHeaders);
    assert.equal(failedReceipt.status, 500);
  } finally {
    db.exec("DROP TRIGGER inject_action_receipt_failure");
  }
  assert.deepEqual(
    db.prepare("SELECT state, revision FROM game_runs WHERE id = ?").get(playingRoom.runId),
    stateBeforeInjectedFailure,
  );
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM game_action_receipts WHERE action_id = ?
  `).get(placementActionId).count, 0);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM game_events WHERE run_id = ?").get(playingRoom.runId).count,
    eventsBeforeInjectedFailure,
  );

  db.exec("BEGIN IMMEDIATE");
  const lockStartedAt = Date.now();
  let busyPlacement;
  try {
    busyPlacement = await gamePost(placementRequest, secondaryPlacementHeaders, secondaryOrigin);
  } finally {
    db.exec("ROLLBACK");
  }
  assert.equal(busyPlacement.status, 503);
  assert.equal((await busyPlacement.json()).code, "database_busy");
  assert.ok(Date.now() - lockStartedAt < 1_000, "test lock timeout should remain short");
  assert.deepEqual(
    db.prepare("SELECT state, revision FROM game_runs WHERE id = ?").get(playingRoom.runId),
    stateBeforeInjectedFailure,
  );

  const concurrentPlacements = await Promise.all([
    gamePost(placementRequest, placementHeaders),
    gamePost(placementRequest, secondaryPlacementHeaders, secondaryOrigin),
  ]);
  assert.deepEqual(concurrentPlacements.map((response) => response.status), [200, 200]);
  const concurrentPlacementPayloads = await Promise.all(
    concurrentPlacements.map((response) => response.json()),
  );
  assert.deepEqual(
    concurrentPlacementPayloads.map((payload) => payload.action.replayed).sort(),
    [false, true],
  );
  for (const payload of concurrentPlacementPayloads) {
    assert.equal(payload.room.phase, "placed");
    assert.equal(payload.action.id, placementActionId);
    assert.equal(payload.action.accepted, true);
  }
  const crossActorReuse = await gamePost(placementRequest, otherActorHeaders);
  assert.equal(crossActorReuse.status, 409);
  const placementConflict = await gamePost(
    { ...placementRequest, index: 1 },
    placementHeaders,
  );
  assert.equal(placementConflict.status, 409);
  assert.equal((await placementConflict.json()).code, "action_id_conflict");
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM game_action_receipts WHERE action_id = ?
  `).get(placementActionId).count, 1);

  const retractActionId = randomUUID();
  const retractRequest = {
    action: "retract", actionId: retractActionId, code: sessionCode, playerId: activePlayer.id,
    expectedRunId: concurrentPlacementPayloads[0].room.runId,
    expectedRunGeneration: concurrentPlacementPayloads[0].room.runGeneration,
    expectedRevision: concurrentPlacementPayloads[0].room.revision,
  };
  let lostRetractionResponses = 0;
  const retractedPayload = await requestGame(`${origin}/game/api/game`, retractRequest, {
    fetchImpl: async (input, init) => {
      lostRetractionResponses += 1;
      const response = await fetch(input, {
        ...init,
        headers: { ...Object.fromEntries(new Headers(init.headers)), ...placementHeaders },
      });
      if (lostRetractionResponses === 1) {
        return {
          ok: response.ok,
          status: response.status,
          headers: response.headers,
          json: async () => { throw new TypeError("simulated response loss after commit"); },
        };
      }
      return response;
    },
  });
  assert.equal(lostRetractionResponses, 2);
  assert.equal(retractedPayload.room.phase, "playing");
  assert.equal(retractedPayload.action.replayed, true);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM game_action_receipts WHERE action_id = ?
  `).get(retractActionId).count, 1);
  const replayedRetraction = await gamePost(retractRequest, placementHeaders);
  assert.equal(replayedRetraction.status, 200);
  const replayedRetractionPayload = await replayedRetraction.json();
  assert.equal(replayedRetractionPayload.room.phase, "playing");
  assert.equal(replayedRetractionPayload.room.retractionUsed, true);
  assert.equal(replayedRetractionPayload.action.replayed, true);
  const conflictingRetraction = await gamePost(
    { ...retractRequest, playerId: randomUUID() },
    placementHeaders,
  );
  assert.equal(conflictingRetraction.status, 409);
  assert.equal((await conflictingRetraction.json()).code, "action_id_conflict");

  const finalPlacementActionId = randomUUID();
  const finalPlacement = await gamePost(
    {
      action: "place", actionId: finalPlacementActionId, code: sessionCode,
      playerId: activePlayer.id, index: 0,
      expectedRunId: replayedRetractionPayload.room.runId,
      expectedRunGeneration: replayedRetractionPayload.room.runGeneration,
      expectedRevision: replayedRetractionPayload.room.revision,
    },
    placementHeaders,
  );
  assert.equal(finalPlacement.status, 200);
  const finalPlacementRoom = (await finalPlacement.json()).room;
  assert.equal(finalPlacementRoom.phase, "placed");

  const revealActionId = randomUUID();
  const revealRequest = {
    action: "reveal", actionId: revealActionId, code: sessionCode,
    expectedRunId: finalPlacementRoom.runId, expectedRunGeneration: finalPlacementRoom.runGeneration,
    expectedRevision: finalPlacementRoom.revision,
  };
  const { attempts: lostRevealResponses, payload: revealedPayload } = await gameRequestLosingFirstBody(
    revealRequest,
    { Cookie: `cb_session=${hostCookie}`, Origin: origin },
    "simulated reveal response loss after commit",
  );
  assert.equal(lostRevealResponses, 2);
  assert.equal(revealedPayload.action.replayed, true);
  const answeredRoom = revealedPayload.room;
  assert.equal(answeredRoom.phase, "revealed");
  assert.ok(answeredRoom.currentSong);
  assert.equal(typeof answeredRoom.result.correct, "boolean");
  const activeTimelineLength = answeredRoom.players
    .find((player) => player.id === activePlayer.id).timeline.length;
  const replayedReveal = await gamePost(
    revealRequest,
    { Cookie: `cb_session=${hostCookie}`, Origin: origin },
  );
  assert.equal(replayedReveal.status, 200);
  const replayedRevealPayload = await replayedReveal.json();
  assert.equal(replayedRevealPayload.action.replayed, true);
  assert.equal(
    replayedRevealPayload.room.players.find((player) => player.id === activePlayer.id).timeline.length,
    activeTimelineLength,
  );
  const conflictingReveal = await gamePost(
    { ...revealRequest, expectedRevision: revealRequest.expectedRevision + 1 },
    { Cookie: `cb_session=${hostCookie}`, Origin: origin },
  );
  assert.equal(conflictingReveal.status, 409);
  assert.equal((await conflictingReveal.json()).code, "action_id_conflict");

  const playCommandsBeforeAdvance = db.prepare(`
    SELECT COUNT(*) AS count FROM managed_audio_commands WHERE kind = 'play'
  `).get().count;
  const advanceRequest = {
    action: "advance",
    actionId: randomUUID(),
    code: sessionCode,
    expectedRunId: answeredRoom.runId,
    expectedRunGeneration: answeredRoom.runGeneration,
    expectedRevision: answeredRoom.revision,
  };
  const { attempts: lostAdvanceResponses, payload: advancedPayload } = await gameRequestLosingFirstBody(
    advanceRequest,
    { Cookie: `cb_session=${hostCookie}`, Origin: origin },
    "simulated advance response loss after commit",
  );
  assert.equal(lostAdvanceResponses, 2);
  assert.equal(advancedPayload.action.replayed, true);
  assert.equal(advancedPayload.room.phase, "playing");
  assert.equal(advancedPayload.room.round, answeredRoom.round + 1);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM managed_audio_commands WHERE kind = 'play'").get().count,
    playCommandsBeforeAdvance + 1,
  );
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM game_action_receipts WHERE action_id = ?
  `).get(advanceRequest.actionId).count, 1);

  const skipRequest = {
    action: "skip",
    actionId: randomUUID(),
    code: sessionCode,
    expectedRunId: advancedPayload.room.runId,
    expectedRunGeneration: advancedPayload.room.runGeneration,
    expectedRevision: advancedPayload.room.revision,
  };
  const { attempts: lostSkipResponses, payload: skippedPayload } = await gameRequestLosingFirstBody(
    skipRequest,
    { Cookie: `cb_session=${hostCookie}`, Origin: origin },
    "simulated skip response loss after commit",
  );
  assert.equal(lostSkipResponses, 2);
  assert.equal(skippedPayload.action.replayed, true);
  assert.equal(skippedPayload.room.round, advancedPayload.room.round + 1);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM managed_audio_commands WHERE kind = 'play'").get().count,
    playCommandsBeforeAdvance + 2,
  );
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM game_action_receipts WHERE action_id = ?
  `).get(skipRequest.actionId).count, 1);

  const resumed = await gamePost(
    { action: "prepare", code: sessionCode },
    { Cookie: `cb_session=${hostCookie}`, Origin: origin },
  );
  assert.equal(resumed.status, 200);
  assert.equal((await resumed.json()).room.code, sessionCode);

  const pendingBeforeRelease = db.prepare(`
    SELECT COUNT(*) AS count FROM managed_audio_commands WHERE completed_at IS NULL
  `).get().count;
  assert.ok(pendingBeforeRelease > 0);
  const released = await gamePost(
    { action: "audioRelease", code: sessionCode },
    { Cookie: `cb_session=${hostCookie}`, Origin: origin },
  );
  assert.equal(released.status, 200);
  assert.equal((await released.json()).audio.mode, "local");
  const replayAfterRelease = await sourcePost({
    action: "complete",
    commandId: playWork.command.id,
    claimGeneration: playClaimGeneration,
    ok: true,
    playbackStatus: "playing",
    deviceId: "private-provider-device-id",
  });
  const replayAfterReleasePayload = await replayAfterRelease.json();
  assert.deepEqual({
    persistedSourceDeviceId,
    commandsBeforeRenewal,
    commandsAfterRenewal,
    requestedBeforeRenewal,
    requestedAfterRenewal,
    replayAfterReleaseStatus: replayAfterRelease.status,
    replayAfterReleaseReplayed: replayAfterReleasePayload.replayed,
  }, {
    persistedSourceDeviceId: null,
    commandsBeforeRenewal,
    commandsAfterRenewal: commandsBeforeRenewal,
    requestedBeforeRenewal,
    requestedAfterRenewal: requestedBeforeRenewal,
    replayAfterReleaseStatus: 200,
    replayAfterReleaseReplayed: true,
  });
  assert.equal((await (await sourcePost({ action: "poll", deviceId: "test-device" })).json()).lease, null);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM game_events
    WHERE run_id = ? AND event_type = 'audio_command_cancelled'
      AND outcome = 'cancelled' AND reason_code = 'explicit_release'
  `).get(playingRoom.runId).count, pendingBeforeRelease);
  const releasesBeforeNoop = db.prepare(`
    SELECT COUNT(*) AS count FROM game_events
    WHERE run_id = ? AND event_type = 'audio_lease_released'
  `).get(playingRoom.runId).count;
  assert.equal((await gamePost(
    { action: "audioRelease", code: sessionCode },
    { Cookie: `cb_session=${hostCookie}`, Origin: origin },
  )).status, 200);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM game_events
    WHERE run_id = ? AND event_type = 'audio_lease_released'
  `).get(playingRoom.runId).count, releasesBeforeNoop);

  const expiredLeaseId = randomUUID();
  const expiredCommandId = randomUUID();
  db.prepare(`
    INSERT INTO managed_audio_leases
      (id, source_id, session_code, acquired_by, acquired_at, renewed_at, expires_at, playback_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'starting')
  `).run(
    expiredLeaseId, managedSourceId, sessionCode, hostId,
    Date.now() - 120_000, Date.now() - 120_000, Date.now() - 1,
  );
  db.prepare(`
    INSERT INTO managed_audio_commands
      (id, lease_id, source_id, session_code, kind, track_uri, requested_by, created_at)
    VALUES (?, ?, ?, ?, 'play', 'spotify:track:expiredFixture', ?, ?)
  `).run(expiredCommandId, expiredLeaseId, managedSourceId, sessionCode, hostId, Date.now() - 60_000);
  const expiredPoll = await sourcePost({ action: "poll", deviceId: "test-device" });
  assert.equal(expiredPoll.status, 200);
  assert.equal((await expiredPoll.json()).lease, null);
  assert.deepEqual(db.prepare(`
    SELECT event_type, outcome, reason_code, command_ref FROM game_events
    WHERE run_id = ? AND sequence > (
      SELECT COALESCE(MAX(sequence), 0) - 2 FROM game_events WHERE run_id = ?
    ) ORDER BY sequence
  `).all(playingRoom.runId, playingRoom.runId).map((event) => ({ ...event })), [
    {
      event_type: "audio_command_cancelled", outcome: "cancelled",
      reason_code: "lease_expired", command_ref: expiredCommandId,
    },
    {
      event_type: "audio_lease_expired", outcome: "failed",
      reason_code: null, command_ref: null,
    },
  ]);

  const delayedPlacement = {
    action: "place",
    actionId: randomUUID(),
    code: sessionCode,
    playerId: activePlayer.id,
    index: 0,
    expectedRunId: answeredRoom.runId,
    expectedRunGeneration: answeredRoom.runGeneration,
    expectedRevision: answeredRoom.revision,
  };
  const rejectedBeforeRollback = await gamePost(delayedPlacement, placementHeaders);
  assert.equal(rejectedBeforeRollback.status, 409);
  const sliceOneState = JSON.parse(db.prepare("SELECT state FROM game_runs WHERE id = ?")
    .get(answeredRoom.runId).state);
  sliceOneState.phase = "playing";
  sliceOneState.placement = null;
  db.prepare("UPDATE game_runs SET state = ?, updated_at = ? WHERE id = ?")
    .run(JSON.stringify(sliceOneState), Date.now(), answeredRoom.runId);
  const replayedAfterRollbackWrite = await gamePost(delayedPlacement, placementHeaders);
  assert.equal(replayedAfterRollbackWrite.status, 409);
  assert.equal((await replayedAfterRollbackWrite.json()).code, "stale_action");

  const expiredGuestId = randomUUID();
  const retainedReceiptId = randomUUID();
  db.prepare("INSERT INTO users (id, display_name, role, created_at) VALUES (?, 'Expired Guest', 'player', ?)")
    .run(expiredGuestId, Date.now() - 10_000);
  db.prepare(`
    INSERT INTO game_guest_users (user_id, session_code, created_at, expires_at)
    VALUES (?, ?, ?, ?)
  `).run(expiredGuestId, sessionCode, Date.now() - 10_000, Date.now() - 1);
  db.prepare(`
    INSERT INTO game_action_receipts
      (run_id, actor_id, action_id, action, request_fingerprint, accepted_at)
    VALUES (?, ?, ?, 'place', 'retention-fingerprint', ?)
  `).run(playingRoom.runId, expiredGuestId, retainedReceiptId, Date.now() - 5_000);

  purgeExpired(db, Date.now());
  assert.equal(db.prepare("SELECT 1 FROM users WHERE id = ?").get(expiredGuestId), undefined);
  assert.equal(db.prepare("SELECT actor_id FROM game_action_receipts WHERE action_id = ?")
    .get(retainedReceiptId).actor_id, expiredGuestId);

  const disposableRunId = randomUUID();
  const disposableReceiptId = randomUUID();
  db.prepare(`
    INSERT INTO game_runs (id, session_code, state, created_at, updated_at)
    VALUES (?, ?, '{}', ?, ?)
  `).run(disposableRunId, sessionCode, Date.now(), Date.now());
  db.prepare(`
    INSERT INTO game_action_receipts
      (run_id, actor_id, action_id, action, request_fingerprint, accepted_at)
    VALUES (?, ?, ?, 'reveal', 'run-cascade-fingerprint', ?)
  `).run(disposableRunId, hostId, disposableReceiptId, Date.now());
  db.prepare("DELETE FROM game_runs WHERE id = ?").run(disposableRunId);
  assert.equal(db.prepare("SELECT 1 FROM game_action_receipts WHERE action_id = ?")
    .get(disposableReceiptId), undefined);

  const abandoned = await gamePost(
    { action: "abandon", code: sessionCode },
    { Cookie: `cb_session=${hostCookie}`, Origin: origin },
  );
  assert.equal(abandoned.status, 200);
  const abandonedPayload = await abandoned.json();
  assert.equal(abandonedPayload.action.accepted, true);
  const abandonedHistoryResponse = await fetch(
    `${origin}/game/api/game?runId=${encodeURIComponent(playingRoom.runId)}`,
    { headers: { Cookie: `cb_session=${hostCookie}` } },
  );
  assert.equal(abandonedHistoryResponse.status, 200);
  const abandonedHistory = (await abandonedHistoryResponse.json()).history;
  assert.equal(abandonedHistory.current.endedAt > 0, true);
  assert.equal(abandonedHistory.current.terminalOutcome, "abandoned");
  assert.equal(abandonedHistory.coverage.complete, false);
  assert.ok(abandonedHistory.coverage.lastRecordedRevision < abandonedHistory.coverage.currentRevision);
  const abandonedTypes = new Set(abandonedHistory.events.map((event) => event.type));
  for (const eventType of [
    "player_joined",
    "game_started",
    "track_requested",
    "placement_locked",
    "placement_retracted",
    "answer_revealed",
    "round_advanced",
    "track_skipped",
    "game_abandoned",
    "audio_command_requested",
    "audio_command_delivered",
    "audio_command_completed",
    "audio_command_failed",
    "audio_source_recovered",
  ]) {
    assert.equal(abandonedTypes.has(eventType), true, `missing abandoned history event ${eventType}`);
  }
  assert.deepEqual(
    abandonedHistory.events
      .filter((event) => event.commandRef === playWork.command.id)
      .map((event) => event.type),
    ["audio_command_requested", "audio_command_delivered", "audio_command_completed"],
  );
  assert.equal(abandonedHistory.events.at(-1).type, "game_abandoned");
  assert.doesNotMatch(JSON.stringify(abandonedHistory), /spotify:track|Expired Guest|Test Host/i);
  const afterAbandon = await gamePost(
    { action: "skip", code: sessionCode },
    { Cookie: `cb_session=${hostCookie}`, Origin: origin },
  );
  assert.equal(afterAbandon.status, 409);
  assert.equal((await afterAbandon.json()).code, "game_ended");
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

  const staleIdentity = db.prepare(`
    SELECT run_id, user_id, player_id FROM game_run_player_identities WHERE player_id = ?
  `).get(joined.playerId);
  const stateWithoutStalePlayer = JSON.parse(db.prepare(`
    SELECT state FROM game_runs WHERE id = ?
  `).get(staleIdentity.run_id).state);
  stateWithoutStalePlayer.players = stateWithoutStalePlayer.players
    .filter((player) => player.id !== staleIdentity.player_id);
  db.prepare("UPDATE game_runs SET state = ?, updated_at = ? WHERE id = ?")
    .run(JSON.stringify(stateWithoutStalePlayer), Date.now(), staleIdentity.run_id);
  acknowledgeFixtureRevision(staleIdentity.run_id);
  db.exec(`
    CREATE TRIGGER inject_stale_identity_repair_failure
    BEFORE UPDATE OF state ON game_runs
    WHEN OLD.id = '${staleIdentity.run_id}'
    BEGIN
      SELECT RAISE(ABORT, 'injected stale identity repair failure');
    END;
  `);
  try {
    const failedRepair = await gamePost(
      { action: "join", code: sessionCode, name: "Phone Guest" },
      { Cookie: guestCookie, Origin: origin },
    );
    assert.equal(failedRepair.status, 500);
  } finally {
    db.exec("DROP TRIGGER inject_stale_identity_repair_failure");
  }
  assert.deepEqual(
    db.prepare(`
      SELECT run_id, user_id, player_id FROM game_run_player_identities
      WHERE run_id = ? AND user_id = ?
    `).get(staleIdentity.run_id, staleIdentity.user_id),
    staleIdentity,
  );
  const repairedJoin = await gamePost(
    { action: "join", code: sessionCode, name: "Phone Guest" },
    { Cookie: guestCookie, Origin: origin },
  );
  assert.equal(repairedJoin.status, 201);
  joined.playerId = (await repairedJoin.json()).playerId;

  const guestIdentity = db.prepare(`
    SELECT user_id FROM game_run_player_identities WHERE player_id = ?
  `).get(joined.playerId);
  db.exec(`
    CREATE TRIGGER inject_remove_player_save_failure
    BEFORE UPDATE OF state ON game_runs
    WHEN OLD.session_code = '${sessionCode}'
    BEGIN
      SELECT RAISE(ABORT, 'injected remove-player save failure');
    END;
  `);
  try {
    const failedRemoval = await gamePost(
      { action: "removePlayer", code: sessionCode, playerId: joined.playerId },
      { Cookie: `cb_session=${hostCookie}`, Origin: origin },
    );
    assert.equal(failedRemoval.status, 500);
  } finally {
    db.exec("DROP TRIGGER inject_remove_player_save_failure");
  }
  assert.ok(db.prepare("SELECT 1 FROM users WHERE id = ?").get(guestIdentity.user_id));
  assert.ok(db.prepare(`
    SELECT 1 FROM game_run_player_identities WHERE player_id = ? AND user_id = ?
  `).get(joined.playerId, guestIdentity.user_id));
  assert.equal(JSON.parse(db.prepare(`
    SELECT state FROM game_runs WHERE session_code = ?
  `).get(sessionCode).state).players.some((player) => player.id === joined.playerId), true);

  const secondInviteResponse = await gamePost(
    { action: "guestInvite", code: sessionCode },
    { Cookie: `cb_session=${hostCookie}`, Origin: origin },
  );
  assert.equal(secondInviteResponse.status, 200);
  const secondInvite = (await secondInviteResponse.json()).guestInvite;
  const localAudio = await gamePost(
    { action: "audioSelect", code: sessionCode, mode: "local" },
    { Cookie: `cb_session=${hostCookie}`, Origin: origin },
  );
  assert.equal(localAudio.status, 200);
  db.exec(`
    CREATE TRIGGER inject_start_save_failure
    BEFORE UPDATE OF state ON game_runs
    WHEN OLD.session_code = '${sessionCode}'
    BEGIN
      SELECT RAISE(ABORT, 'injected start save failure');
    END;
  `);
  try {
    const failedStart = await gamePost(
      { action: "start", code: sessionCode },
      { Cookie: `cb_session=${hostCookie}`, Origin: origin },
    );
    assert.equal(failedStart.status, 500);
  } finally {
    db.exec("DROP TRIGGER inject_start_save_failure");
  }
  assert.equal(db.prepare("SELECT status FROM game_sessions WHERE code = ?").get(sessionCode).status, "lobby");
  assert.equal(db.prepare(`
    SELECT revoked_at FROM game_guest_invites WHERE token_hash = ?
  `).get(sha256(secondInvite)).revoked_at, null);
  assert.equal(JSON.parse(db.prepare(`
    SELECT state FROM game_runs WHERE session_code = ?
  `).get(sessionCode).state).phase, "lobby");
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

  const finishingRun = db.prepare(`
    SELECT id, state FROM game_runs WHERE session_code = ?
  `).get(sessionCode);
  const finishingState = JSON.parse(finishingRun.state);
  finishingState.phase = "revealed";
  finishingState.winnerId = joined.playerId;
  db.prepare("UPDATE game_runs SET state = ?, updated_at = ? WHERE id = ?")
    .run(JSON.stringify(finishingState), Date.now(), finishingRun.id);
  acknowledgeFixtureRevision(finishingRun.id);
  const beforeFailedFinish = db.prepare(`
    SELECT state, revision, ended_at FROM game_runs WHERE id = ?
  `).get(finishingRun.id);
  db.exec(`
    CREATE TRIGGER inject_finish_save_failure
    BEFORE UPDATE OF state ON game_runs
    WHEN OLD.session_code = '${sessionCode}'
    BEGIN
      SELECT RAISE(ABORT, 'injected finish save failure');
    END;
  `);
  try {
    const failedFinish = await gamePost(
      { action: "advance", code: sessionCode },
      { Cookie: `cb_session=${hostCookie}`, Origin: origin },
    );
    assert.equal(failedFinish.status, 500);
  } finally {
    db.exec("DROP TRIGGER inject_finish_save_failure");
  }
  assert.deepEqual(
    db.prepare("SELECT state, revision, ended_at FROM game_runs WHERE id = ?").get(finishingRun.id),
    beforeFailedFinish,
  );
  const completed = await gamePost(
    { action: "advance", code: sessionCode },
    { Cookie: `cb_session=${hostCookie}`, Origin: origin },
  );
  assert.equal(completed.status, 200);
  assert.equal((await completed.json()).room.phase, "finished");
  const completedHistoryResponse = await fetch(
    `${origin}/game/api/game?runId=${encodeURIComponent(finishingRun.id)}`,
    { headers: { Cookie: `cb_session=${hostCookie}` } },
  );
  assert.equal(completedHistoryResponse.status, 200);
  const completedHistory = (await completedHistoryResponse.json()).history;
  assert.equal(completedHistory.current.phase, "finished");
  assert.equal(completedHistory.current.terminalOutcome, "completed");
  assert.equal(completedHistory.coverage.complete, true);
  assert.equal(completedHistory.events.at(-1).type, "game_completed");
  assert.equal(completedHistory.events.at(-1).outcome, "completed");
});
