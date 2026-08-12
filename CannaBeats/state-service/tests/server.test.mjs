import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createStateServer } from "../src/server.mjs";

const root = mkdtempSync(join(tmpdir(), "cannabeats-state-server-"));
after(() => rmSync(root, { recursive: true, force: true }));

test("HTTP boundary authenticates callers and derives the lobby host from its principal claim", async () => {
  const server = createStateServer({
    databasePath: join(root, "server.sqlite"), serviceToken: "service-secret",
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const origin = `http://127.0.0.1:${port}`;
  try {
    assert.equal((await fetch(`${origin}/v1/lobbies`, { method: "POST" })).status, 401);
    const headers = {
      authorization: "Bearer service-secret",
      "content-type": "application/json",
      "x-cannabeats-principal": "opaque-principal-1",
    };
    const candidate = await fetch(`${origin}/v1/lobbies`, {
      method: "POST", headers,
      body: JSON.stringify({ commandId: "b7246a76-3bcb-4da1-9d7a-11ef56ed3ea4", code: "BAD234" }),
    });
    assert.equal(candidate.status, 409);
    const activation = await fetch(`${origin}/v1/admin/activate`, {
      method: "POST", headers,
      body: JSON.stringify({ commandId: "451653d1-0077-43f9-90db-68c9c71b6630" }),
    });
    assert.equal((await activation.json()).status, "active");
    const request = { commandId: "2c53f9fa-8882-45b0-9874-01ca670f4444", code: "SRV234" };
    const first = await fetch(`${origin}/v1/lobbies`, {
      method: "POST", headers, body: JSON.stringify(request),
    });
    assert.deepEqual(await first.json(), { code: "SRV234", status: "lobby", replayed: false });
    const replay = await fetch(`${origin}/v1/lobbies`, {
      method: "POST", headers, body: JSON.stringify(request),
    });
    assert.deepEqual(await replay.json(), { code: "SRV234", status: "lobby", replayed: true });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
