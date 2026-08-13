import assert from "node:assert/strict";
import { test } from "node:test";
import { clearAdmissionIntent,durableAdmissionIntent } from "../lib/admission-intent.ts";

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key,value) => values.set(key,value),
    removeItem: (key) => values.delete(key),
    dump: () => [...values.values()].join("\n"),
  };
}

test("guest admission retries reuse one durable action without persisting the invitation", () => {
  const storage = memoryStorage();
  let sequence = 0;
  const input = { code: "ABC234",name: "Guest",storage,
    createActionId: () => `action-${++sequence}` };
  const first = durableAdmissionIntent(input);
  const retry = durableAdmissionIntent(input);
  assert.deepEqual(retry,first);
  assert.equal(sequence,1);
  assert.equal(storage.dump().includes("invite"),false);
  clearAdmissionIntent("ABC234",storage);
  assert.notEqual(durableAdmissionIntent(input).actionId,first.actionId);
});

test("an admission retry freezes its original identity even if the form name changes", () => {
  const storage = memoryStorage();
  let sequence = 0;
  const first = durableAdmissionIntent({ code: "ABC234",name: "Guest",storage,
    createActionId: () => `action-${++sequence}` });
  const changed = durableAdmissionIntent({ code: "ABC234",name: "Different",storage,
    createActionId: () => `action-${++sequence}` });
  assert.deepEqual(changed,first);
  assert.equal(sequence,1);
});
