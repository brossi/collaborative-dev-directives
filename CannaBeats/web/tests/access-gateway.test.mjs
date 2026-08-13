import assert from "node:assert/strict";
import { test } from "node:test";
import { AccessGatewayError, createAccessGatewayClient } from "../lib/server/access-gateway.mjs";

test("game resolves identity through the access-scoped internal gateway", async () => {
  const calls = [];
  const client = createAccessGatewayClient({
    origin: "http://access:3002", token: "game-service-token",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return Response.json({ principal: { id: "p", role: "host", kind: "account" } });
    },
  });
  assert.equal((await client.principal({ authorization: "Bearer abc", cookie: "cb_session=def" }))
    .principal.id, "p");
  assert.equal(calls[0].url, "http://access:3002/api/internal/game/principal");
  assert.equal(calls[0].options.headers["x-cannabeats-internal-token"], "game-service-token");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    authorization: "Bearer abc", cookie: "cb_session=def",
  });
});

test("access gateway failures remain bounded", async () => {
  const client = createAccessGatewayClient({
    origin: "http://access:3002", token: "token",
    fetchImpl: async () => new Response("private detail", { status: 500 }),
  });
  await assert.rejects(() => client.principal({}),
    (error) => error instanceof AccessGatewayError && error.code === "access_response_invalid");
});

test("guest invitation calls carry the durable action identity", async () => {
  let body;
  const client = createAccessGatewayClient({
    origin: "http://access:3002",token: "token",
    fetchImpl: async (_url,options) => {
      body = JSON.parse(options.body);
      return Response.json({ guestInvite: "x".repeat(43),expiresAt: 123 });
    },
  });
  await client.guestInvite({
    authorization: "Bearer browser",cookie: "cb_session=x",
    actionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",code: "ABC234",
  });
  assert.deepEqual(body,{
    authorization: "Bearer browser",cookie: "cb_session=x",
    actionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",code: "ABC234",
  });
});
