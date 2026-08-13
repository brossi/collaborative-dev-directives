import assert from "node:assert/strict";
import { test } from "node:test";
import {
  resolveSessionRecovery,
  resolveSourceHandoff,
  SESSION_RECOVERY_OUTCOMES,
  SOURCE_HANDOFF_OUTCOMES,
} from "../src/recovery-contract.mjs";

const host = { code: "HOST23", status: "playing", isHost: true };
const guest = { code: "PLAY23", status: "playing", isHost: false };

test("session recovery outcomes form one precedence-ordered authority matrix", () => {
  const cases = [
    [{ authenticated: true, contractCompatible: false, memberships: [host] }, "client_upgrade_required"],
    [{ authenticated: false }, "authentication_required"],
    [{ authenticated: false, credentialExpired: true }, "credential_expired"],
    [{ authenticated: true, pendingActionLobbyCode: guest.code, memberships: [guest] },
      "action_reconciliation_required"],
    [{ authenticated: true, memberships: [] }, "none"],
    [{ authenticated: true, memberships: [host] }, "resume"],
    [{ authenticated: true, memberships: [host, guest] }, "choose"],
    [{ authenticated: true, preferredLobbyCode: guest.code, memberships: [host, guest] }, "resume"],
    [{ authenticated: true, memberships: [{ ...host, status: "lobby" }] }, "resume"],
    [{ authenticated: true, memberships: [{ ...host, status: "ended" }] }, "none"],
  ];
  const observed = new Set();
  for (const [input, outcome] of cases) {
    const result = resolveSessionRecovery(input);
    assert.equal(result.outcome, outcome);
    observed.add(outcome);
  }
  assert.deepEqual([...SESSION_RECOVERY_OUTCOMES].sort(), [...observed].sort());
});

test("source handoff never grants another lobby authority over unresolved playback", () => {
  const cases = [
    [{ requestedLobbyCode: "NEXT23" }, "available", true, false],
    [{ requestedLobbyCode: "NEXT23", leaseLobbyCode: "NEXT23" }, "owned", false, true],
    [{ requestedLobbyCode: "NEXT23", leaseLobbyCode: "OTHER2" }, "busy", false, false],
    [{ requestedLobbyCode: "NEXT23", unresolvedLobbyCode: "NEXT23" }, "recovering", false, false],
    [{ requestedLobbyCode: "NEXT23", unresolvedLobbyCode: "OTHER2" }, "quarantined", false, false],
  ];
  const observed = new Set();
  for (const [input, outcome, mayAcquire, mayListen] of cases) {
    const result = resolveSourceHandoff(input);
    assert.equal(result.outcome, outcome);
    assert.equal(result.mayAcquire, mayAcquire);
    assert.equal(result.mayListen, mayListen);
    assert.equal(result.localFallback, true);
    observed.add(outcome);
  }
  assert.deepEqual([...SOURCE_HANDOFF_OUTCOMES].sort(), [...observed].sort());
});
