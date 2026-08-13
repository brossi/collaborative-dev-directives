import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach, test } from "node:test";
import { getStateGame,postStateGame } from "../app/api/game/state-route.ts";
import {
  GAME_CLIENT_CONTRACT_HEADER,
  GAME_CLIENT_CONTRACT_VERSION,
} from "../lib/game-client-contract.ts";

const originalFetch = globalThis.fetch;
const originalEnvironment = Object.fromEntries([
  "CANNABEATS_ACCESS_SERVICE_INTERNAL_ORIGIN",
  "CANNABEATS_STATE_SERVICE_ORIGIN",
  "CANNABEATS_GAME_SERVICE_TOKEN",
  "CANNABEATS_STATE_GAME_TOKEN",
  "CANNABEATS_STATE_GAME_PRINCIPAL_ASSERTION_KEY",
  "CANNABEATS_APP_ORIGIN",
].map((key) => [key, process.env[key]]));

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function configure() {
  process.env.CANNABEATS_ACCESS_SERVICE_INTERNAL_ORIGIN = "http://access:3002";
  process.env.CANNABEATS_STATE_SERVICE_ORIGIN = "http://state:3010";
  process.env.CANNABEATS_GAME_SERVICE_TOKEN = "game-internal-token";
  process.env.CANNABEATS_STATE_GAME_TOKEN = "state-game-token";
  process.env.CANNABEATS_STATE_GAME_PRINCIPAL_ASSERTION_KEY = "state-game-key";
  process.env.CANNABEATS_APP_ORIGIN = "https://poc.example";
}

function stateRequest(url, init = {}) {
  const headers = new Headers(init.headers);
  if (!headers.has(GAME_CLIENT_CONTRACT_HEADER)) {
    headers.set(GAME_CLIENT_CONTRACT_HEADER, GAME_CLIENT_CONTRACT_VERSION);
  }
  return new Request(url, { ...init, headers });
}

function room(runId, revision = 0) {
  return {
    runId, runGeneration: 1, revision, code: "ABC234", phase: "lobby", players: [],
    activePlayerId: null, activePlayerIndex: 0, round: 0, currentSong: null,
    placement: null, retractionUsed: false, result: null, winnerId: null,
    rules: {
      preset: "family", minYear: 1920, maxYear: 2026,
      eraWeights: { early: 5, midcentury: 10, classics: 25, millennial: 30, current: 30 },
      targetScore: 10, allowRetraction: true, catalogScope: "all",
    },
    isHost: true,
  };
}

test("state-backed prepare resolves identity externally and creates one idempotent owner run", async () => {
  configure();
  const actionId = randomUUID();
  const calls = [];
  let createdRunId = null;
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).startsWith("http://access:3002")) {
      return Response.json({ principal: { id: "host-1", role: "host", kind: "account" } });
    }
    const parsed = new URL(url);
    if (options.method === "POST" && parsed.pathname.endsWith("/runs")) {
      const body = JSON.parse(options.body);
      assert.equal(body.commandId, actionId);
      createdRunId = body.runId;
      return Response.json({ ...room(createdRunId), state: room(createdRunId), replayed: false });
    }
    if (parsed.pathname.endsWith("/audio")) {
      return Response.json({ selection: "managed", mode: "local", sourceOnline: false, status: "disconnected" });
    }
    if (parsed.pathname === "/v1/lobbies/ABC234") {
      return Response.json(createdRunId
        ? { lobbyCode: "ABC234", runId: createdRunId, state: room(createdRunId) }
        : { lobbyCode: "ABC234", runId: null, state: null });
    }
    throw new Error(`unexpected ${url}`);
  };
  const response = await postStateGame(stateRequest("https://poc.example/game/api/game", {
    method: "POST",
    headers: { origin: "https://poc.example", "content-type": "application/json", cookie: "cb_session=x" },
    body: JSON.stringify({ action: "prepare", actionId, code: "ABC234" }),
  }));
  assert.equal(response.status, 201);
  const payload = await response.json();
  assert.equal(payload.room.runId, createdRunId);
  assert.deepEqual(payload.action, { id: actionId, accepted: true, replayed: false });
  assert.equal(calls.filter((call) => call.url.endsWith("/runs")).length, 1);
});

test("state-backed game actions translate legacy wire names into typed owner commands", async () => {
  configure();
  const actionId = randomUUID();
  const runId = randomUUID();
  let actionBody;
  globalThis.fetch = async (url, options) => {
    if (String(url).startsWith("http://access:3002")) {
      return Response.json({ principal: { id: "host-1", role: "host", kind: "account" } });
    }
    actionBody = JSON.parse(options.body);
    return Response.json({ state: room(runId, 5), replayed: false });
  };
  const response = await postStateGame(stateRequest("https://poc.example/game/api/game", {
    method: "POST",
    headers: { origin: "https://poc.example", "content-type": "application/json", cookie: "cb_session=x" },
    body: JSON.stringify({
      action: "rules", actionId, code: "ABC234", expectedRunId: runId,
      expectedRunGeneration: 1, expectedRevision: 4, rules: { targetScore: 8 },
    }),
  }));
  assert.equal(response.status, 200);
  assert.deepEqual(actionBody.command, { type: "configure_rules", rules: { targetScore: 8 } });
  assert.equal((await response.json()).room.revision, 5);
});

test("state-backed admission and history never read the legacy game database", async () => {
  configure();
  const actionId = randomUUID();
  const runId = randomUUID();
  const joined = room(runId,1);
  joined.players = [{ id: "player-1",name: "Phone",control: "phone",timeline: [] }];
  globalThis.fetch = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/api/internal/game/admit") return Response.json({
      principal: { id: "player-1",role: "player",kind: "account" },
      admission: { state: joined,replayed: false },
    });
    if (parsed.pathname === "/api/internal/game/principal") return Response.json({
      principal: { id: "player-1",role: "player",kind: "account" },
    });
    if (parsed.pathname === `/v1/history/${runId}`) return Response.json({
      history: { runId,lobbyId: "ABC234",events: [] },
    });
    throw new Error(`unexpected ${url}`);
  };
  const admission = await postStateGame(stateRequest("https://poc.example/game/api/game", {
    method: "POST",headers: { origin: "https://poc.example","content-type": "application/json" },
    body: JSON.stringify({ action: "join",actionId,code: "ABC234",name: "Phone" }),
  }));
  assert.equal(admission.status,201);
  assert.equal((await admission.json()).playerId,"player-1");
  const history = await getStateGame(stateRequest(
    `https://poc.example/game/api/game?runId=${runId}`,
    { headers: { cookie: "cb_session=x" } },
  ));
  assert.equal((await history.json()).history.runId,runId);
});

test("an expired admission locator remains a finite terminal response through Game", async () => {
  configure();
  globalThis.fetch = async (url) => {
    if (new URL(url).pathname === "/api/internal/game/admit") {
      return Response.json({ code: "expired",error: "Admission retry window expired" },{ status: 410 });
    }
    throw new Error(`unexpected ${url}`);
  };
  const response = await postStateGame(stateRequest("https://poc.example/game/api/game",{
    method: "POST",headers: { origin: "https://poc.example","content-type": "application/json" },
    body: JSON.stringify({
      action: "joinGuest",actionId: randomUUID(),code: "ABC234",name: "Phone",invite: "fresh",
    }),
  }));
  assert.equal(response.status,410);
  assert.equal((await response.json()).code,"expired");
});

test("state-backed recovery derives the same phone seat without browser session authority", async () => {
  configure();
  const runId = randomUUID();
  const recoveredRoom = room(runId,7);
  recoveredRoom.isHost = false;
  recoveredRoom.players = [{ id: "player-1",name: "Phone",control: "phone",timeline: [] }];
  globalThis.fetch = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/api/internal/game/recover-principal") return Response.json({
      outcome: "authenticated",
      principal: { id: "player-1",role: "player",kind: "guest",sessionCode: "ABC234" },
      sessionCookie: "cb_guest=refreshed; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=86400",
    });
    if (parsed.pathname === "/v1/recovery") return Response.json({
      outcome: "resume",
      lobbies: [{
        code: "ABC234",status: "playing",isHost: false,runId,runGeneration: 1,
        revision: 7,seatPlayerId: "player-1",
      }],
    });
    if (parsed.pathname === "/v1/lobbies/ABC234") return Response.json({ state: recoveredRoom });
    if (parsed.pathname === "/v1/lobbies/ABC234/audio") return Response.json({
      selection: "managed",mode: "local",sourceOnline: false,status: "disconnected",
    });
    throw new Error(`unexpected ${url}`);
  };
  const response = await getStateGame(stateRequest(
    "https://poc.example/game/api/game?recover=1&clientContractVersion=2",
    { headers: { cookie: "cb_guest=same-device" } },
  ));
  assert.equal(response.status,200);
  assert.match(response.headers.get("set-cookie"),/^cb_guest=refreshed/);
  const payload = await response.json();
  assert.deepEqual(payload.session,{ code: "ABC234",playerId: "player-1" });
  assert.equal(payload.room.runId,runId);
  assert.equal(payload.room.revision,7);
  assert.equal(payload.recovery.outcome,"resume");
});

test("expired same-device recovery stops before State and returns the finite credential outcome", async () => {
  configure();
  let stateCalled = false;
  globalThis.fetch = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/api/internal/game/recover-principal") {
      return Response.json({ outcome: "credential_expired" });
    }
    stateCalled = true;
    throw new Error(`unexpected ${url}`);
  };
  const response = await getStateGame(stateRequest(
    "https://poc.example/game/api/game?recover=1&clientContractVersion=2&preferredLobbyCode=ABC234",
    { headers: { cookie: "cb_guest=expired" } },
  ));
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{
    recovery: { outcome: "credential_expired",lobbies: [] },
  });
  assert.equal(stateCalled,false);
  assert.equal(response.headers.get("set-cookie"),null);
});

test("an incompatible client is rejected before Access or State identity disclosure", async () => {
  configure();
  let dependencyCalled = false;
  globalThis.fetch = async () => {
    dependencyCalled = true;
    throw new Error("dependency must not be called");
  };
  const response = await getStateGame(stateRequest(
    "https://poc.example/game/api/game?recover=1&clientContractVersion=1",
    { headers: { cookie: "cb_guest=still-secret", [GAME_CLIENT_CONTRACT_HEADER]: "1" } },
  ));
  assert.equal(response.status,426);
  assert.deepEqual(await response.json(),{
    recovery: { outcome: "client_upgrade_required",lobbies: [] },
    error: "Reload after updating CannaBeats to continue.",
    code: "client_upgrade_required",
  });
  assert.equal(dependencyCalled,false);
});

test("versionless ordinary reads and mutations stop before identity or state disclosure", async () => {
  configure();
  let dependencyCalled = false;
  globalThis.fetch = async () => {
    dependencyCalled = true;
    throw new Error("dependency must not be called");
  };
  const read = await getStateGame(new Request(
    "https://poc.example/game/api/game?code=ABC234",
    { headers: { cookie: "cb_guest=still-secret" } },
  ));
  const mutation = await postStateGame(new Request("https://poc.example/game/api/game", {
    method: "POST",
    headers: { origin: "https://poc.example", "content-type": "application/json" },
    body: JSON.stringify({ action: "prepare", actionId: randomUUID(), code: "ABC234" }),
  }));
  assert.equal(read.status,426);
  assert.equal(mutation.status,426);
  assert.equal((await read.json()).code,"client_upgrade_required");
  assert.equal((await mutation.json()).code,"client_upgrade_required");
  assert.equal(dependencyCalled,false);
});

test("startup recovery preserves a pending lobby target for exact reconciliation", async () => {
  configure();
  const runId = randomUUID();
  const recoveredRoom = room(runId,7);
  recoveredRoom.isHost = false;
  recoveredRoom.players = [{ id: "player-1",name: "Phone",control: "phone",timeline: [] }];
  let recoveryQuery;
  let accessRecoveryBody;
  globalThis.fetch = async (url,options = {}) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/api/internal/game/recover-principal") {
      accessRecoveryBody = JSON.parse(options.body);
      return Response.json({
        outcome: "authenticated",principal: { id: "player-1",role: "player",kind: "guest" },
      });
    }
    if (parsed.pathname === "/v1/recovery") {
      recoveryQuery = parsed.searchParams;
      return Response.json({
        outcome: "action_reconciliation_required",
        lobbies: [{
          code: "ABC234",status: "playing",isHost: false,runId,runGeneration: 1,
          revision: 7,seatPlayerId: "player-1",
        }],
      });
    }
    if (parsed.pathname === "/v1/lobbies/ABC234") return Response.json({ state: recoveredRoom });
    if (parsed.pathname === "/v1/lobbies/ABC234/audio") return Response.json({
      selection: "managed",mode: "local",sourceOnline: false,status: "disconnected",
    });
    throw new Error(`unexpected ${url}`);
  };
  const response = await getStateGame(stateRequest(
    "https://poc.example/game/api/game?recover=1&clientContractVersion=2&pendingActionLobbyCode=ABC234",
    { headers: { cookie: "cb_guest=same-device" } },
  ));
  const payload = await response.json();
  assert.equal(payload.recovery.outcome,"action_reconciliation_required");
  assert.deepEqual(payload.session,{ code: "ABC234",playerId: "player-1" });
  assert.equal(accessRecoveryBody.pendingActionLobbyCode,"ABC234",
    "Access must receive the pending locator before deciding whether an expired active credential can recover");
  assert.equal(recoveryQuery.get("pendingActionLobbyCode"),"ABC234");
});
