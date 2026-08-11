import assert from "node:assert/strict";
import { test } from "node:test";
import {
  actionUuid,
  commitJoinResult,
  commitRoomSnapshot,
  GameApiError,
  reconcileRoomSnapshot,
  requestGame,
} from "../lib/game-request.ts";

const fallbackCrypto = {
  getRandomValues(bytes) {
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = index;
    return bytes;
  },
};

const room = {
  runId: "c583b6a1-0eb6-4b62-93be-da18f4ee072c",
  runGeneration: 2,
  revision: 5,
  code: "TEST23",
  phase: "placed",
  players: [],
  activePlayerId: null,
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
      && error.actionId === JSON.parse(bodies[0]).actionId,
  );
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0], bodies[1]);
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

  const otherLobby = { ...runARevision8, code: "OTHER2", runGeneration: 1 };
  cursor = reconcileRoomSnapshot(cursor, otherLobby, 6);
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
