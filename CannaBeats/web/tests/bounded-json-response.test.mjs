import assert from "node:assert/strict";
import test from "node:test";

import { boundedJsonResponse } from "../lib/server/bounded-json-response.mjs";

test("server dependency JSON accepts its exact byte cap and rejects the next byte", async () => {
  assert.deepEqual(await boundedJsonResponse(new Response("{}"),2),{});
  await assert.rejects(() => boundedJsonResponse(new Response("{} "),2),/response_invalid/);
  await assert.rejects(() => boundedJsonResponse(new Response(new Uint8Array([0xff])),1));
});
