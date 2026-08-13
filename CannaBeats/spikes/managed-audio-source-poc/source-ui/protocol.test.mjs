import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyManagedCommandFailure,shouldExecuteManagedControllerCommand,
} from "./protocol.mjs";

test("provider authorization and execution ambiguity remain fail closed", () => {
  assert.equal(classifyManagedCommandFailure("prepare"),"failed");
  assert.equal(classifyManagedCommandFailure("begin"),"outcome_unknown");
  assert.equal(classifyManagedCommandFailure("provider"),"outcome_unknown");
});

test("only a State-issued pause handoff executes without a live lease", () => {
  assert.equal(shouldExecuteManagedControllerCommand({ lease: { id: "lease" } }),true);
  assert.equal(shouldExecuteManagedControllerCommand({ lease: null,command: {
    kind: "pause",handoff: true,
  } }),true);
  assert.equal(shouldExecuteManagedControllerCommand({ lease: null,command: {
    kind: "play",handoff: true,
  } }),false);
  assert.equal(shouldExecuteManagedControllerCommand({ lease: null,command: {
    kind: "pause",handoff: false,
  } }),false);
});
