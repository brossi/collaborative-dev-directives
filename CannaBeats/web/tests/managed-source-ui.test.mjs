import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { classifyManagedCommandFailure } from "../../spikes/managed-audio-source-poc/source-ui/protocol.mjs";

test("provider protocol classifies only proven pre-effect failures as terminal failures", () => {
  assert.equal(classifyManagedCommandFailure("prepare"), "failed");
  assert.equal(classifyManagedCommandFailure("begin"), "outcome_unknown");
  assert.equal(classifyManagedCommandFailure("provider"), "outcome_unknown");
  assert.throws(() => classifyManagedCommandFailure("surprise"), /unknown.*stage/i);
});

test("the source UI reports ambiguous authorization and provider schedules as unknown", () => {
  const source = readFileSync(new URL(
    "../../spikes/managed-audio-source-poc/source-ui/app.js", import.meta.url,
  ), "utf8");
  assert.match(source, /classifyManagedCommandFailure\('begin'\).*reportManagedCommandUnknown/s);
  assert.match(source, /classifyManagedCommandFailure\('provider'\).*reportManagedCommandUnknown/s);
  assert.doesNotMatch(source, /catch \(error\) \{\s*outcome = \{ ok: false/s);
});
