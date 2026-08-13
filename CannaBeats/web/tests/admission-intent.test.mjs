import assert from "node:assert/strict";
import { test } from "node:test";
import {
  clearAdmissionIntent,durableAdmissionIntent,releaseExpiredAdmissionIntent,
} from "../lib/admission-intent.ts";

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
    createActionId: () => `123e4567-e89b-42d3-a456-${String(++sequence).padStart(12,"0")}` };
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
    createActionId: () => `123e4567-e89b-42d3-a456-${String(++sequence).padStart(12,"0")}` });
  const changed = durableAdmissionIntent({ code: "ABC234",name: "Different",storage,
    createActionId: () => `123e4567-e89b-42d3-a456-${String(++sequence).padStart(12,"0")}` });
  assert.deepEqual(changed,first);
  assert.equal(sequence,1);
});

test("malformed browser admission locators are discarded and regenerated", () => {
  const storage = memoryStorage();
  storage.setItem("cannabeats.admission.ABC234",JSON.stringify({
    code: "ABC234",name: "Guest",actionId: "not-a-uuid",
  }));
  const replacement = "123e4567-e89b-42d3-a456-426614174000";
  const intent = durableAdmissionIntent({
    code: "ABC234",name: "Guest",storage,createActionId: () => replacement,
  });
  assert.deepEqual(intent,{ actionId: replacement,code: "ABC234",name: "Guest" });
  assert.equal(storage.dump(),JSON.stringify(intent));
});

test("only the finite expired response releases a durable admission locator", () => {
  const storage = memoryStorage();
  const original = "123e4567-e89b-42d3-a456-426614174000";
  durableAdmissionIntent({ code: "ABC234",name: "Guest",storage,createActionId: () => original });
  assert.equal(releaseExpiredAdmissionIntent({
    status: 503,responseCode: "dependency_unavailable",code: "ABC234",storage,
  }),false);
  assert.match(storage.dump(),new RegExp(original));
  assert.equal(releaseExpiredAdmissionIntent({
    status: 410,responseCode: "expired",code: "ABC234",storage,
  }),true);
  const replacement = "123e4567-e89b-42d3-a456-426614174001";
  assert.equal(durableAdmissionIntent({
    code: "ABC234",name: "Guest",storage,createActionId: () => replacement,
  }).actionId,replacement);
});
