import assert from "node:assert/strict";
import { test } from "node:test";
import {
  resolveSessionRecovery,
  resolveManagedRecoveryWork,
  resolveSourceHandoff,
  SESSION_RECOVERY_OUTCOMES,
  SOURCE_HANDOFF_OUTCOMES,
  SOURCE_HANDOFF_STATES,
  transitionSourceHandoff,
} from "../src/recovery-contract.mjs";

test("every persisted managed recovery product state has one finite action", () => {
  const cases = [
    [{ leasePresent: true,commandState: "queued" },"claim"],
    [{ leasePresent: true,commandState: "claimed" },"retry_claim"],
    [{ leasePresent: true,commandState: "executing" },"reconcile_provider"],
    [{ leasePresent: false,handoffState: "stop_required",commandState: "queued" },"claim"],
    [{ leasePresent: false,handoffState: "stop_claimed",commandState: "claimed" },"retry_claim"],
    [{ leasePresent: false,handoffState: "stop_executing",commandState: "executing" },"reconcile_provider"],
    [{ leasePresent: false,handoffState: "quarantined",commandState: "outcome_unknown" },"reconcile_provider"],
    [{ leasePresent: false,handoffState: "quarantined",commandState: "failed" },"operator_review"],
  ];
  for (const [input,action] of cases) assert.equal(resolveManagedRecoveryWork(input).action,action);
});

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

test("terminal pending actions remain reconcilable and missing locators reject explicitly", () => {
  const ended = { code: "END234",status: "ended",isHost: true };
  const active = { code: "ACT234",status: "playing",isHost: true };
  assert.deepEqual(resolveSessionRecovery({
    authenticated: true,pendingActionLobbyCode: ended.code,memberships: [ended],
  }),{ outcome: "action_reconciliation_required",lobbies: [ended] });
  assert.deepEqual(resolveSessionRecovery({
    authenticated: true,pendingActionLobbyCode: "OLD234",memberships: [active],
  }),{ outcome: "resume",lobbies: [active],pendingActionRejected: true });
  assert.deepEqual(resolveSessionRecovery({
    authenticated: true,pendingActionLobbyCode: "OLD234",memberships: [],
  }),{ outcome: "none",lobbies: [],pendingActionRejected: true });
});

test("source handoff authority requires a confirmed safe stop before reuse", () => {
  assert.equal(transitionSourceHandoff("clear","release_safe"),"clear");
  assert.equal(transitionSourceHandoff("clear","release_playing"),"stop_required");
  assert.equal(transitionSourceHandoff("stop_required","claim"),"stop_claimed");
  assert.equal(transitionSourceHandoff("stop_claimed","begin"),"stop_executing");
  assert.equal(transitionSourceHandoff("stop_executing","complete_paused"),"clear");
  assert.equal(transitionSourceHandoff("clear","release_inflight"),"quarantined");
  assert.equal(transitionSourceHandoff("quarantined","reconcile_paused"),"clear");
  assert.throws(() => transitionSourceHandoff("quarantined","claim"),/forbidden/);
  assert.throws(() => transitionSourceHandoff("stop_executing","complete_playing"),/forbidden/);
  const observed = new Set(["clear","stop_required","stop_claimed","stop_executing","quarantined"]);
  assert.deepEqual([...SOURCE_HANDOFF_STATES].sort(),[...observed].sort());
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
