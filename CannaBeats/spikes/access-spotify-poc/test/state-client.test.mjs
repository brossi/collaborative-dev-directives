import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { test } from "node:test";
import { createAccessStateClient, StateClientError } from "../state-client.mjs";

test("access state client signs bounded claims and preserves mutation identity", async () => {
  const calls = [];
  const client = createAccessStateClient({
    origin: "http://state:3010/path-is-ignored",
    token: "access-token",
    principalAssertionKey: "assertion-key",
    clock: () => 100,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return Response.json({ code: "ABC123", status: "lobby" });
    },
  });
  const commandId = randomUUID();
  await client.createLobby({ commandId, code: "ABC123", principalId: "principal-1" });
  assert.equal(calls[0].url, "http://state:3010/v1/access/lobbies");
  assert.equal(calls[0].options.headers.authorization, "Bearer access-token");
  assert.deepEqual(JSON.parse(calls[0].options.body), { commandId, code: "ABC123" });
  const claim = "access\ncannabeats-state\naccess\nprincipal-1\n30100";
  assert.equal(calls[0].options.headers["x-cannabeats-principal-signature"],
    createHmac("sha256", "assertion-key").update(claim).digest("hex"));
  const actionId = randomUUID();
  await client.admit({
    actionId, code: "ABC123", principalId: "principal-1", name: "Phone",
    expectedRunId: randomUUID(), expectedRunGeneration: 1, expectedRevision: 0,
  });
  assert.equal(calls[1].url, "http://state:3010/v1/lobbies/ABC123/admissions");
  assert.equal(JSON.parse(calls[1].options.body).actionId, actionId);
});

test("access state client fails closed on state errors and invalid response bodies", async () => {
  const rejected = createAccessStateClient({
    origin: "http://state:3010", token: "token", principalAssertionKey: "key",
    fetchImpl: async () => Response.json({ code: "stale_context" }, { status: 409 }),
  });
  await assert.rejects(() => rejected.lobby({ code: "ABC123", principalId: "p" }),
    (error) => error instanceof StateClientError && error.status === 409
      && error.code === "stale_context");
  const malformed = createAccessStateClient({
    origin: "http://state:3010", token: "token", principalAssertionKey: "key",
    fetchImpl: async () => new Response("not-json", { status: 502 }),
  });
  await assert.rejects(() => malformed.lobbies({ principalId: "p" }),
    (error) => error instanceof StateClientError && error.code === "state_response_invalid");
});
