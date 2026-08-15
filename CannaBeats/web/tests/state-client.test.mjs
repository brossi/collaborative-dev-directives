import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { test } from "node:test";
import { createGameStateClient, StateGatewayError } from "../lib/server/state-client.mjs";

test("game state client signs its principal and forwards the exact action identity", async () => {
  const calls = [];
  const client = createGameStateClient({
    origin: "http://state:3010", token: "game-token", principalAssertionKey: "game-key",
    clock: () => 200,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return Response.json({ accepted: true, replayed: false });
    },
  });
  const actionId = randomUUID();
  const runId = randomUUID();
  await client.recover({ principalId: "principal-1",preferredLobbyCode: "ABC123" });
  await client.action({
    actionId, code: "ABC123", expectedRunId: runId, expectedRunGeneration: 2,
    expectedRevision: 4, command: { type: "advance_round" }, principalId: "principal-1",
  });
  assert.equal(calls[0].url, "http://state:3010/v1/recovery?preferredLobbyCode=ABC123");
  assert.equal(calls[1].url, "http://state:3010/v1/lobbies/ABC123/actions");
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    actionId, expectedRunId: runId, expectedRunGeneration: 2,
    expectedRevision: 4, command: { type: "advance_round" },
  });
  const claim = "game\ncannabeats-state\ngame\nprincipal-1\n30200";
  assert.equal(calls[1].options.headers["x-cannabeats-principal-signature"],
    createHmac("sha256", "game-key").update(claim).digest("hex"));
});

test("game state client returns only stable gateway failures", async () => {
  const client = createGameStateClient({
    origin: "http://state:3010", token: "game-token", principalAssertionKey: "game-key",
    fetchImpl: async () => new Response("upstream internals", { status: 500 }),
  });
  await assert.rejects(() => client.room({ code: "ABC123", principalId: "p" }),
    (error) => error instanceof StateGatewayError && error.status === 502
      && error.code === "state_response_invalid");
});

test("diagnostic State calls separate principal host authority from unscoped stream authority", async () => {
  const calls = [];
  const client = createGameStateClient({
    origin: "http://state:3010",token: "game-token",principalAssertionKey: "game-key",
    clock: () => 200,
    fetchImpl: async (url,options) => {
      calls.push({ url:String(url),options });
      return Response.json({ authorityVersion: 1,status: "absent" });
    },
  });
  const runId = randomUUID();
  await client.diagnosticRunHost({ runId,principalId: "principal-1" });
  await client.diagnosticManagedStream();
  assert.deepEqual(JSON.parse(calls[0].options.body),{ runId });
  assert.equal(calls[0].options.headers["x-cannabeats-principal"],"principal-1");
  assert.deepEqual(JSON.parse(calls[1].options.body),{});
  assert.equal(Object.hasOwn(calls[1].options.headers,"x-cannabeats-principal"),false);
});
