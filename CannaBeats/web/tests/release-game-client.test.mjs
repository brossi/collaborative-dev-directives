import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, test } from "node:test";

import {
  RELEASE_GAME_CONTRACT, RELEASE_GAME_CONTRACT_HEADER, RELEASE_GAME_ROLE_HEADER,
  RELEASE_PENDING_ACTION_KEY, ReleaseClientError, acceptReleaseAction,
  clearPendingReleaseAction,
  loadPendingReleaseAction, loadPendingReleaseRecovery, savePendingReleaseAction,
  participantSnapshot, saveReleaseSession, sendReleaseAction,
} from "../lib/release-game-client.ts";

const originalFetch = globalThis.fetch;
const originalWindow = globalThis.window;

beforeEach(() => {
  globalThis.window = {
    clearTimeout() {},
    setTimeout(callback) { callback(); return 1; },
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.window = originalWindow;
});

function intent() {
  return {
    expectedRevision: 4,
    gameId: randomUUID(),
    operation: "place_song",
    payload: { index: 1 },
    requestId: randomUUID(),
    role: "participant",
  };
}

function state(action) {
  const playerId = randomUUID();
  return {
    activePlayerId: playerId,
    catalogVersion: `sha256:${"a".repeat(64)}`,
    gameId: action.gameId,
    phase: "placed",
    players: [{ control: "phone", id: playerId, name: "Player", timeline: [{
      artist: "Artist", title: "Song", uri: "spotify:track:0000000000000000000000", year: 2000,
    }] }],
    retractionUsed: false,
    revision: 5,
    round: 1,
    rules: {
      allowRetraction: true, catalogScope: "all",
      eraWeights: { early: 5, midcentury: 10, classics: 25, millennial: 30, current: 30 },
      maxYear: 2026, minYear: 1920, preset: "family", targetScore: 10,
    },
    winnerId: null,
  };
}

function accepted(action, overrides = {}) {
  return new Response(JSON.stringify({
    code: "accepted", gameId: action.gameId, revision: 5, state: state(action), ...overrides,
  }), { status: 200, headers: { "content-type": "application/json" } });
}

test("bounded retry preserves the exact action body, role, and request identity", async () => {
  const action = intent();
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: init.body, headers: new Headers(init.headers) });
    if (calls.length === 1) throw new TypeError("response lost");
    return accepted(action);
  };
  const result = await sendReleaseAction(action);
  assert.equal(result.revision, 5);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body, calls[1].body);
  assert.deepEqual(JSON.parse(calls[0].body), {
    expectedRevision: 4, operation: "place_song", payload: { index: 1 },
    requestId: action.requestId,
  });
  assert.equal(calls[0].headers.get(RELEASE_GAME_CONTRACT_HEADER), RELEASE_GAME_CONTRACT);
  assert.equal(calls[0].headers.get(RELEASE_GAME_ROLE_HEADER), "participant");
});

test("malformed successful action output stays outcome-unknown while finite stale state does not retry", async () => {
  const action = intent();
  let malformedCalls = 0;
  globalThis.fetch = async () => {
    malformedCalls += 1;
    return accepted(action, {
      state: { ...state(action), currentSong: null, placement: null, result: null },
    });
  };
  await assert.rejects(() => sendReleaseAction(action), (error) =>
    error instanceof ReleaseClientError && error.code === "outcome_unknown"
      && error.pending === action);
  assert.equal(malformedCalls, 3);
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ ok: false, code: "stale_state" }), {
      status: 409, headers: { "content-type": "application/json" },
    });
  };
  await assert.rejects(() => sendReleaseAction(action), (error) =>
    error instanceof ReleaseClientError && error.code === "stale_state");
  assert.equal(calls, 1);
});

test("pending action storage retains only a parseable complete intent", () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  const action = intent();
  savePendingReleaseAction(storage, action);
  assert.deepEqual(loadPendingReleaseAction(storage), action);
  values.set(RELEASE_PENDING_ACTION_KEY, JSON.stringify({ ...action, expectedRevision: "4" }));
  assert.equal(loadPendingReleaseAction(storage), null);
  assert.equal(values.has(RELEASE_PENDING_ACTION_KEY), false);
  savePendingReleaseAction(storage, action);
  clearPendingReleaseAction(storage);
  assert.equal(values.size, 0);
});

test("participant snapshots accept only the bounded active-audio projection", async () => {
  const action = intent();
  const audioSessionId = randomUUID();
  const snapshot = {
    audio: { audioSessionId, generation: 2, state: "active" },
    code: "snapshot", gameId: action.gameId, lifecycle: "active",
    participantId: randomUUID(), revision: 5, state: state(action),
  };
  globalThis.fetch = async () => new Response(JSON.stringify(snapshot), { status: 200 });
  assert.deepEqual((await participantSnapshot(action.gameId)).audio, snapshot.audio);
  globalThis.fetch = async () => new Response(JSON.stringify({
    ...snapshot, audio: { ...snapshot.audio, relayToken: "forbidden" },
  }), { status: 200 });
  await assert.rejects(() => participantSnapshot(action.gameId), (error) =>
    error instanceof ReleaseClientError && error.code === "invalid_response");
});

test("reload recovers and exactly replays a saved terminal action before active-game discovery", async () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  const pending = {
    ...intent(), operation: "advance_round", payload: {}, role: "host",
  };
  saveReleaseSession(storage, { gameId: pending.gameId, role: "host" });
  savePendingReleaseAction(storage, pending);
  const recovery = loadPendingReleaseRecovery(storage);
  assert.deepEqual(recovery, {
    pending, session: { gameId: pending.gameId, role: "host" },
  });
  let attempts = 0;
  const bodies = [];
  globalThis.fetch = async (_url, init) => {
    attempts += 1;
    bodies.push(init.body);
    if (attempts <= 3) return new Response("{truncated", {
      status: 200, headers: { "content-type": "application/json" },
    });
    const next = state(pending);
    return accepted(pending, { state: {
      ...next, currentSong: next.players[0].timeline[0], phase: "finished",
      placement: 0, result: { correct: true, index: 0 }, winnerId: next.players[0].id,
    } });
  };
  await assert.rejects(() => sendReleaseAction(recovery.pending), (error) =>
    error instanceof ReleaseClientError && error.code === "outcome_unknown");
  assert.deepEqual(loadPendingReleaseRecovery(storage), recovery);
  const replayed = await sendReleaseAction(recovery.pending);
  const acceptedOutcome = acceptReleaseAction(storage, replayed.state);
  assert.equal(acceptedOutcome.lifecycle, "completed");
  assert.equal(acceptedOutcome.state.phase, "finished");
  assert.equal(loadPendingReleaseAction(storage), null);
  assert.deepEqual(JSON.parse(bodies[0]), {
    expectedRevision: pending.expectedRevision, operation: pending.operation,
    payload: pending.payload, requestId: pending.requestId,
  });
  assert.equal(new Set(bodies).size, 1);
});
