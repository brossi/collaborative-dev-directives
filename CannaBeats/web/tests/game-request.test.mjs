import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { test } from "node:test";
import {
  actionUuid,
  commitGamePayload,
  commitJoinResult,
  commitRoomSnapshot,
  clearPendingGameIntent,
  GameApiError,
  loadPendingGameIntent,
  PENDING_GAME_INTENT_KEY,
  reconcileRoomSnapshot,
  resolvePendingGameRequest,
  requestGame,
  savePendingGameIntent,
} from "../lib/game-request.ts";

const fallbackCrypto = {
  getRandomValues(bytes) {
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = index;
    return bytes;
  },
};

const roomPlayerId = "92d36c98-08cf-4cc0-9dc9-452538183910";

const room = {
  runId: "c583b6a1-0eb6-4b62-93be-da18f4ee072c",
  runGeneration: 2,
  revision: 5,
  code: "TEST23",
  phase: "placed",
  players: [{ id: roomPlayerId, name: "Player", control: "phone", timeline: [] }],
  activePlayerId: roomPlayerId,
  activePlayerIndex: 0,
  round: 1,
  currentSong: null,
  placement: 0,
  retractionUsed: false,
  result: null,
  winnerId: null,
  rules: {
    preset: "family",
    minYear: 1920,
    maxYear: 2026,
    eraWeights: { early: 5, midcentury: 10, classics: 25, millennial: 30, current: 30 },
    targetScore: 10,
    allowRetraction: true,
    catalogScope: "all",
  },
  isHost: false,
};

test("action UUID generation works without secure-context randomUUID", () => {
  const id = actionUuid(fallbackCrypto);
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("a lost response body retries the identical action request", async () => {
  const bodies = [];
  let attempts = 0;
  const payload = await requestGame("/game/api/game", {
    action: "place",
    code: "TEST23",
    expectedRunId: "c583b6a1-0eb6-4b62-93be-da18f4ee072c",
    expectedRunGeneration: 2,
    expectedRevision: 4,
    playerId: "player-1",
    index: 0,
  }, {
    cryptoSource: fallbackCrypto,
    fetchImpl: async (_input, init) => {
      attempts += 1;
      bodies.push(init.body);
      if (attempts === 1) {
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => { throw new TypeError("response body was interrupted"); },
        };
      }
      return Response.json({
        room,
        action: { id: JSON.parse(init.body).actionId, accepted: true, replayed: true },
      });
    },
    timeoutMs: 100,
  });

  assert.equal(attempts, 2);
  assert.equal(bodies[0], bodies[1]);
  assert.equal(payload.action.replayed, true);
});

test("retryable requests have a bounded timeout for every attempt", async () => {
  let attempts = 0;
  await assert.rejects(
    requestGame("/game/api/game", { action: "reveal" }, {
      cryptoSource: fallbackCrypto,
      fetchImpl: (_input, init) => {
        attempts += 1;
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
        });
      },
      timeoutMs: 5,
    }),
    (error) => error instanceof GameApiError
      && error.code === "action_outcome_unknown"
      && error.actionId === "00010203-0405-4607-8809-0a0b0c0d0e0f",
  );
  assert.equal(attempts, 2);
});

test("stable API errors are preserved and are not retried", async () => {
  let attempts = 0;
  await assert.rejects(
    requestGame("/game/api/game", { action: "place" }, {
      cryptoSource: fallbackCrypto,
      fetchImpl: async () => {
        attempts += 1;
        return Response.json(
          { error: "The game changed.", code: "stale_action", correlationId: "correlation-1" },
          { status: 409 },
        );
      },
    }),
    (error) => error instanceof GameApiError
      && error.status === 409
      && error.code === "stale_action"
      && error.correlationId === "correlation-1",
  );
  assert.equal(attempts, 1);
});

test("a transient gateway response retries with the same action ID", async () => {
  const bodies = [];
  const payload = await requestGame("/game/api/game", {
    action: "retract",
    code: room.code,
    expectedRunId: room.runId,
    expectedRunGeneration: room.runGeneration,
    expectedRevision: room.revision - 1,
  }, {
    cryptoSource: fallbackCrypto,
    fetchImpl: async (_input, init) => {
      bodies.push(init.body);
      return bodies.length === 1
        ? Response.json({ error: "Temporarily unavailable." }, { status: 503 })
        : Response.json({
          room,
          action: { id: JSON.parse(init.body).actionId, accepted: true, replayed: true },
        });
    },
  });
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0], bodies[1]);
  assert.equal(payload.action.replayed, true);
});

test("an exhausted transient retry retains the uncertain action identity for reconciliation", async () => {
  const bodies = [];
  await assert.rejects(
    requestGame("/game/api/game", {
      action: "place",
      code: room.code,
      expectedRunId: room.runId,
      expectedRunGeneration: room.runGeneration,
      expectedRevision: room.revision - 1,
      playerId: "player-1",
      index: 0,
    }, {
      cryptoSource: fallbackCrypto,
      fetchImpl: async (_input, init) => {
        bodies.push(init.body);
        return Response.json({ error: "Temporarily unavailable." }, { status: 503 });
      },
    }),
    (error) => error instanceof GameApiError
      && error.code === "action_outcome_unknown"
      && error.actionId === JSON.parse(bodies[0]).actionId
      && JSON.stringify(error.pendingRequest) === bodies[0],
  );
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0], bodies[1]);
});

test("an uncertain action can be resolved only by replaying its complete original intent", async () => {
  let pendingError;
  const sentBodies = [];
  try {
    await requestGame("/game/api/game", {
      action: "place",
      code: room.code,
      expectedRunId: room.runId,
      expectedRunGeneration: room.runGeneration,
      expectedRevision: room.revision - 1,
      playerId: "player-1",
      index: 0,
    }, {
      cryptoSource: fallbackCrypto,
      fetchImpl: (_input, init) => {
        sentBodies.push(init.body);
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
        });
      },
      timeoutMs: 5,
    });
  } catch (error) {
    pendingError = error;
  }
  assert.ok(pendingError instanceof GameApiError);
  assert.ok(pendingError.pendingRequest);

  const resolved = await requestGame("/game/api/game", pendingError.pendingRequest, {
    fetchImpl: async (_input, init) => {
      sentBodies.push(init.body);
      return Response.json({
        room,
        action: { id: pendingError.actionId, accepted: true, replayed: true },
      });
    },
  });
  assert.equal(resolved.action.replayed, true);
  assert.equal(new Set(sentBodies).size, 1);
});

test("pending-intent resolution keeps controls blocked until the exact request is definitive", async () => {
  const pendingRequest = Object.freeze({
    action: "place",
    actionId: "00010203-0405-4607-8809-0a0b0c0d0e0f",
    code: room.code,
    expectedRunId: room.runId,
    expectedRunGeneration: room.runGeneration,
    expectedRevision: room.revision,
    playerId: roomPlayerId,
    index: 0,
  });
  const initial = new GameApiError(
    "Unknown outcome",
    502,
    "action_outcome_unknown",
    undefined,
    pendingRequest.actionId,
    pendingRequest,
  );
  const stillPending = new GameApiError(
    "Still unknown",
    502,
    "action_outcome_unknown",
    undefined,
    pendingRequest.actionId,
    pendingRequest,
  );
  const unresolved = await resolvePendingGameRequest(initial, async (request) => {
    assert.equal(request, pendingRequest);
    throw stillPending;
  });
  assert.equal(unresolved.kind, "pending");
  assert.equal(unresolved.keepBlocked, true);

  const rejected = await resolvePendingGameRequest(initial, async () => {
    throw new GameApiError("Stale action", 409, "stale_action");
  });
  assert.equal(rejected.kind, "rejected");
  assert.equal(rejected.keepBlocked, false);

  const confirmed = await resolvePendingGameRequest(initial, async () => ({ room }));
  assert.equal(confirmed.kind, "confirmed");
  assert.equal(confirmed.keepBlocked, false);
  assert.equal(confirmed.payload.room, room);
});

test("an unresolved mutation identity survives reload only for its original lobby", () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  const pendingRequest = Object.freeze({
    action: "advance",
    actionId: "00010203-0405-4607-8809-0a0b0c0d0e0f",
    code: room.code,
    expectedRunId: room.runId,
    expectedRunGeneration: room.runGeneration,
    expectedRevision: room.revision,
  });
  savePendingGameIntent(storage, pendingRequest);
  assert.equal(values.has(PENDING_GAME_INTENT_KEY), true);
  assert.deepEqual(loadPendingGameIntent(storage, room.code), pendingRequest);
  assert.equal(loadPendingGameIntent(storage, "OTHER2"), null);
  assert.equal(values.has(PENDING_GAME_INTENT_KEY), false);
  savePendingGameIntent(storage, pendingRequest);
  clearPendingGameIntent(storage);
  assert.equal(values.has(PENDING_GAME_INTENT_KEY), false);
});

test("every run-bound mutation response requires an authoritative room and retains its intent", async () => {
  for (const action of ["addPlayer", "removePlayer", "rules", "audioSelect", "start", "begin", "advance", "skip"]) {
    await assert.rejects(
      requestGame("/game/api/game", {
        action,
        code: room.code,
        expectedRunId: room.runId,
        expectedRunGeneration: room.runGeneration,
        expectedRevision: room.revision,
      }, {
        cryptoSource: fallbackCrypto,
        fetchImpl: async () => Response.json({}),
      }),
      (error) => error instanceof GameApiError
        && error.code === "invalid_response"
        && error.actionId === "00010203-0405-4607-8809-0a0b0c0d0e0f"
        && error.pendingRequest?.action === action,
    );
  }
});

test("successful transitions classify unreadable bodies as invalid responses", async () => {
  const unreadableResponses = [
    () => new Response("{", { status: 200, headers: { "content-type": "application/json" } }),
    () => new Response(null, { status: 204 }),
    () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => { throw new TypeError("response body was interrupted"); },
    }),
  ];

  for (const response of unreadableResponses) {
    await assert.rejects(
      requestGame("/game/api/game", {
        action: "advance",
        code: room.code,
        expectedRunId: room.runId,
        expectedRunGeneration: room.runGeneration,
        expectedRevision: room.revision,
      }, { cryptoSource: fallbackCrypto, fetchImpl: async () => response() }),
      (error) => error instanceof GameApiError
        && error.status === 502
        && error.code === "invalid_response"
        && error.actionId === "00010203-0405-4607-8809-0a0b0c0d0e0f"
        && error.pendingRequest?.action === "advance",
    );
  }
});

test("a mutation whose successful response body never starts remains an exact pending intent", async () => {
  const server = createHttpServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.flushHeaders();
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    await assert.rejects(
      requestGame(`http://127.0.0.1:${address.port}/game`, {
        action: "advance",
        code: room.code,
        expectedRunId: room.runId,
        expectedRunGeneration: room.runGeneration,
        expectedRevision: room.revision,
      }, { cryptoSource: fallbackCrypto, timeoutMs: 20 }),
      (error) => error instanceof GameApiError
        && ["action_outcome_unknown", "invalid_response"].includes(error.code)
        && error.actionId === "00010203-0405-4607-8809-0a0b0c0d0e0f"
        && error.pendingRequest?.action === "advance",
    );
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("a definitive database busy response stays distinguishable from an unknown outcome", async () => {
  let attempts = 0;
  await assert.rejects(
    requestGame("/game/api/game", {
      action: "place",
      code: room.code,
      expectedRunId: room.runId,
      expectedRunGeneration: room.runGeneration,
      expectedRevision: room.revision,
      playerId: "player-1",
      index: 0,
    }, {
      cryptoSource: fallbackCrypto,
      fetchImpl: async () => {
        attempts += 1;
        return Response.json(
          { error: "The game is temporarily busy.", code: "database_busy" },
          { status: 503 },
        );
      },
    }),
    (error) => error instanceof GameApiError
      && error.status === 503
      && error.code === "database_busy"
      && error.pendingRequest === undefined,
  );
  assert.equal(attempts, 2);
});

test("run-bound transition responses must match the requested run generation", async () => {
  const wrongRun = {
    ...room,
    runId: "2a7a8c90-6924-4b78-95eb-4cbb55bd50a0",
    revision: room.revision + 1,
  };
  await assert.rejects(
    requestGame("/game/api/game", {
      action: "addPlayer",
      code: room.code,
      expectedRunId: room.runId,
      expectedRunGeneration: room.runGeneration,
      expectedRevision: room.revision,
    }, { fetchImpl: async () => Response.json({ room: wrongRun }) }),
    (error) => error instanceof GameApiError && error.code === "invalid_response",
  );
});

test("audio is applied only with an accepted room snapshot", () => {
  const currentRoom = { ...room, revision: room.revision + 1 };
  const staleRoom = { ...room };
  const incomingAudio = {
    selection: "local",
    mode: "local",
    sourceOnline: false,
    status: "disconnected",
  };
  let appliedRoom = currentRoom;
  let appliedAudio = null;
  const reconciled = commitGamePayload(
    { room: currentRoom, sequence: 3 },
    { room: staleRoom, audio: incomingAudio },
    2,
    room.code,
    (nextRoom) => { appliedRoom = nextRoom; },
    (nextAudio) => { appliedAudio = nextAudio; },
  );
  assert.equal(reconciled.room, currentRoom);
  assert.equal(appliedRoom, currentRoom);
  assert.equal(appliedAudio, null);

  let sideEffects = 0;
  assert.throws(
    () => commitGamePayload(
      { room: currentRoom, sequence: 3 },
      { room: { ...currentRoom, revision: currentRoom.revision + 1 }, audio: { status: "playing" } },
      4,
      room.code,
      () => { sideEffects += 1; },
      () => { sideEffects += 1; },
    ),
    (error) => error instanceof GameApiError && error.code === "invalid_response",
  );
  assert.equal(sideEffects, 0);
});

test("relationally impossible room responses fail closed", async () => {
  const invalidRooms = [
    { ...room, activePlayerIndex: 3 },
    { ...room, activePlayerId: "042ba135-312b-4cf7-a053-f8f8ab6251c4" },
    { ...room, players: [room.players[0], room.players[0]] },
    { ...room, winnerId: "042ba135-312b-4cf7-a053-f8f8ab6251c4" },
    { ...room, placement: 2 },
    { ...room, result: { correct: false, index: 2 } },
    { ...room, rules: { ...room.rules, minYear: 2026, maxYear: 1920 } },
    {
      ...room,
      currentSong: { title: "Secret", artist: "Hidden", year: 2000, uri: "spotify:track:secret" },
    },
    { ...room, phase: "playing", placement: null, currentSong: null, isHost: true },
    { ...room, phase: "revealed", result: null },
    { ...room, phase: "finished", winnerId: null },
  ];
  for (const invalidRoom of invalidRooms) {
    await assert.rejects(
      requestGame("/game/api/game", {
        action: "audioSelect",
        code: room.code,
        expectedRunId: room.runId,
        expectedRunGeneration: room.runGeneration,
        expectedRevision: room.revision,
      }, { fetchImpl: async () => Response.json({ room: invalidRoom }) }),
      (error) => error instanceof GameApiError && error.code === "invalid_response",
    );
  }
});

test("cross-field-impossible audio responses fail closed", async () => {
  for (const invalidAudio of [
    { selection: "local", mode: "local", sourceOnline: true, status: "playing" },
    { selection: "local", mode: "managed", sourceOnline: true, status: "playing" },
    { selection: "managed", mode: "managed", sourceOnline: true, status: "playing" },
    { selection: "managed", mode: "local", sourceOnline: false, status: "ready" },
  ]) {
    await assert.rejects(
      requestGame("/game/api/game", {
        action: "audioSelect",
        code: room.code,
        expectedRunId: room.runId,
        expectedRunGeneration: room.runGeneration,
        expectedRevision: room.revision,
      }, {
        cryptoSource: fallbackCrypto,
        fetchImpl: async (_input, init) => Response.json({
          room,
          audio: invalidAudio,
          action: { id: JSON.parse(init.body).actionId, accepted: true, replayed: false },
        }),
      }),
      (error) => error instanceof GameApiError && error.code === "invalid_response",
    );
  }
});

test("retryable actions reject incomplete or mismatched successful responses", async () => {
  const invalidPayloads = [
    null,
    [],
    "accepted",
    {},
    { room: { runId: room.runId, revision: room.revision } },
    { room },
    { room, action: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", accepted: true, replayed: false } },
    {
      room: { ...room, players: [null] },
      action: { id: "00010203-0405-4607-8809-0a0b0c0d0e0f", accepted: true, replayed: false },
    },
    { room, action: { id: "00010203-0405-4607-8809-0a0b0c0d0e0f", accepted: false, replayed: false } },
    {
      room: { ...room, revision: 4 },
      action: { id: "00010203-0405-4607-8809-0a0b0c0d0e0f", accepted: true, replayed: false },
    },
  ];

  for (const invalidPayload of invalidPayloads) {
    let attempts = 0;
    await assert.rejects(
      requestGame("/game/api/game", {
        action: "place",
        code: room.code,
        expectedRunId: room.runId,
        expectedRunGeneration: room.runGeneration,
        expectedRevision: room.revision - 1,
      }, {
        cryptoSource: fallbackCrypto,
        fetchImpl: async () => {
          attempts += 1;
          return Response.json(invalidPayload);
        },
      }),
      (error) => error instanceof GameApiError
        && error.status === 502
        && error.code === "invalid_response"
        && error.actionId === "00010203-0405-4607-8809-0a0b0c0d0e0f",
    );
    assert.equal(attempts, 2);
  }
});

test("room snapshot reconciliation never moves a run backward and sequences run changes", () => {
  const runARevision8 = { ...room, revision: 8 };
  const runARevision9 = { ...room, revision: 9 };
  const runBRevision0 = {
    ...room,
    runId: "2a7a8c90-6924-4b78-95eb-4cbb55bd50a0",
    runGeneration: 3,
    revision: 0,
  };

  let cursor = reconcileRoomSnapshot({ room: null, sequence: 0 }, runARevision8, 1);
  cursor = reconcileRoomSnapshot(cursor, runARevision9, 3);
  cursor = reconcileRoomSnapshot(cursor, runARevision8, 2);
  assert.equal(cursor.room.revision, 9);
  assert.equal(cursor.sequence, 3);

  cursor = reconcileRoomSnapshot(cursor, runBRevision0, 2);
  assert.equal(cursor.room.runId, runBRevision0.runId);
  cursor = reconcileRoomSnapshot(cursor, runBRevision0, 4);
  assert.equal(cursor.room.runId, runBRevision0.runId);
  assert.equal(cursor.sequence, 4);

  cursor = reconcileRoomSnapshot(cursor, { ...runARevision9, runGeneration: 2 }, 5);
  assert.equal(cursor.room.runId, runBRevision0.runId);

  const reactivatedRunB = { ...runBRevision0, runGeneration: 4, revision: 0 };
  cursor = reconcileRoomSnapshot(cursor, reactivatedRunB, 6);
  assert.equal(cursor.room.runGeneration, 4);
  cursor = reconcileRoomSnapshot(cursor, { ...runBRevision0, runGeneration: 3, revision: 50 }, 7);
  assert.equal(cursor.room.runGeneration, 4);

  const otherLobby = { ...runARevision8, code: "OTHER2", runGeneration: 1 };
  cursor = reconcileRoomSnapshot(cursor, otherLobby, 8);
  assert.equal(cursor.room.code, otherLobby.code);

  const cleared = { room: null, sequence: 5 };
  let appliedRoom = runBRevision0;
  const lateBeforeLeave = commitRoomSnapshot(
    cleared,
    { ...runBRevision0, revision: 1 },
    4,
    room.code,
    (nextRoom) => { appliedRoom = nextRoom; },
  );
  assert.equal(lateBeforeLeave.room, null);
  assert.equal(appliedRoom, null);
  assert.equal(lateBeforeLeave.sequence, 5);

  assert.throws(
    () => commitRoomSnapshot(
      cursor,
      { ...runBRevision0, players: [null] },
      6,
      room.code,
      () => { throw new Error("invalid snapshots must not reach the setter"); },
    ),
    (error) => error instanceof GameApiError && error.code === "invalid_response",
  );

  let misroutedApplications = 0;
  assert.throws(
    () => commitRoomSnapshot(
      cursor,
      { ...runBRevision0, code: "OTHER2" },
      7,
      room.code,
      () => { misroutedApplications += 1; },
    ),
    (error) => error instanceof GameApiError && error.code === "invalid_response",
  );
  assert.equal(misroutedApplications, 0);
});

test("join validation suppresses room and session side effects for an invalid response", () => {
  const joinedPlayerId = "92d36c98-08cf-4cc0-9dc9-452538183910";
  const joinedRoom = {
    ...room,
    players: [{ id: joinedPlayerId, name: "Player", control: "phone", timeline: [] }],
    activePlayerId: joinedPlayerId,
  };
  let roomApplications = 0;
  let sessionWrites = 0;
  assert.throws(
    () => commitJoinResult(
      { playerId: joinedPlayerId, room: { ...room, players: [null] } },
      () => { roomApplications += 1; return room; },
      () => { sessionWrites += 1; },
    ),
    (error) => error instanceof GameApiError && error.code === "invalid_response",
  );
  assert.equal(roomApplications, 0);
  assert.equal(sessionWrites, 0);

  assert.throws(
    () => commitJoinResult(
      { playerId: "cf125ee5-7f2f-4a57-8491-8e93d0ead787", room: joinedRoom },
      () => { roomApplications += 1; return joinedRoom; },
      () => { sessionWrites += 1; },
    ),
    (error) => error instanceof GameApiError && error.code === "invalid_response",
  );
  assert.equal(roomApplications, 0);
  assert.equal(sessionWrites, 0);

  const committed = commitJoinResult(
    { playerId: joinedPlayerId, room: joinedRoom },
    (joinedRoom) => { roomApplications += 1; return joinedRoom; },
    () => { sessionWrites += 1; },
  );
  assert.equal(committed.playerId, joinedPlayerId);
  assert.equal(roomApplications, 1);
  assert.equal(sessionWrites, 1);
});
