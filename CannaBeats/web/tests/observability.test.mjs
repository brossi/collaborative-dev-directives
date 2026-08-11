import assert from "node:assert/strict";
import { test } from "node:test";
import {
  correlatedResponse,
  createGameOperationalLogger,
  createRouteTransitionReporter,
} from "../lib/server/observability.ts";

test("game operational records enforce a field allowlist and sentinel redaction", () => {
  const records = [];
  const sentinel = "private-provider-payload-abcdefghijklmnopqrstuvwxyz123456";
  const logger = createGameOperationalLogger({
    write: (_level, line) => records.push(JSON.parse(line)),
    now: () => new Date("2026-08-11T12:00:00Z"),
  });
  const record = logger.error("dependency.failed", `Bearer ${sentinel}`, {
    correlationId: "4a551bd5-8f87-42c3-82cc-789f19bbcc18",
    method: "GET",
    route: "/api/audio-stream?ticket=private",
    status: 503,
    reasonCode: "relay_unavailable",
    authorization: `Bearer ${sentinel}`,
    cookie: `cb_session=${sentinel}`,
    providerPayload: sentinel,
    trackUri: "spotify:track:1234567890123456789012",
  });
  assert.equal(records.length, 1);
  assert.equal(record.authorization, undefined);
  assert.equal(record.cookie, undefined);
  assert.equal(record.providerPayload, undefined);
  assert.equal(record.trackUri, undefined);
  assert.equal(record.route, "/api/audio-stream");
  assert.doesNotMatch(JSON.stringify(record), new RegExp(sentinel));
});

test("polling failures and recoveries emit only state transitions", () => {
  const records = [];
  const logger = createGameOperationalLogger({
    write: (_level, line) => records.push(JSON.parse(line)),
  });
  const transitions = createRouteTransitionReporter(logger);
  transitions.observe("/api/audio-source", 200);
  transitions.observe("/api/audio-source", 200);
  transitions.observe("/api/audio-source", 503);
  transitions.observe("/api/audio-source", 503);
  transitions.observe("/api/audio-source", 200);
  transitions.observe("/api/audio-source", 200);
  assert.deepEqual(records.map((record) => record.event), [
    "dependency.unavailable", "dependency.recovered",
  ]);
});

test("every game error becomes a stable JSON envelope", async () => {
  const correlationId = "4a551bd5-8f87-42c3-82cc-789f19bbcc18";
  const response = await correlatedResponse(
    new Response("private upstream failure", { status: 502, headers: { "Content-Type": "text/plain" } }),
    correlationId,
  );
  assert.equal(response.headers.get("x-cannabeats-correlation-id"), correlationId);
  assert.match(response.headers.get("content-type"), /^application\/json/);
  assert.deepEqual(await response.json(), {
    error: "Unexpected server error",
    code: "unexpected_server_error",
    correlationId,
  });
});
