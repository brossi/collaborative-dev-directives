import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { StateOwner } from "../src/owner.mjs";
import { openStateStoreReadOnly } from "../src/store.mjs";

const root = mkdtempSync(join(tmpdir(), "cannabeats-state-owner-"));
after(() => rmSync(root, { recursive: true, force: true }));

test("idempotent state commands replay and conflicting identity reuse fails", () => {
  const path = join(root, "commands.sqlite");
  const owner = new StateOwner(path);
  const commandId = randomUUID();
  const hostPrincipalId = randomUUID();
  assert.throws(() => owner.createLobby({
    commandId, code: "ABC234", hostPrincipalId, now: 90,
  }), /candidate/i);
  owner.activate({ now: 95 });
  assert.deepEqual(owner.createLobby({
    commandId, code: "ABC234", hostPrincipalId, now: 100,
  }), { code: "ABC234", status: "lobby", replayed: false });
  assert.deepEqual(owner.createLobby({
    commandId, code: "ABC234", hostPrincipalId, now: 200,
  }), { code: "ABC234", status: "lobby", replayed: true });
  assert.throws(() => owner.createLobby({
    commandId, code: "XYZ234", hostPrincipalId, now: 300,
  }), /identity conflicts/i);
  owner.close();
});

test("managed command authority is an append-only owner-issued protocol", () => {
  const path = join(root, "managed.sqlite");
  const owner = new StateOwner(path);
  const host = randomUUID();
  owner.activate({ now: 90 });
  owner.createLobby({ code: "AUD234", hostPrincipalId: host, now: 100 });
  const sourceId = randomUUID();
  owner.registerManagedSource({
    sourceId, displayName: "Source", tokenHash: "hash", now: 105,
  });
  const command = owner.createManagedCommand({
    sourceId, lobbyCode: "AUD234", runGeneration: 0, kind: "pause",
    requestedByPrincipalId: host, now: 110,
  });
  assert.equal(command.protocolVersion, 2);
  const claimRequest = randomUUID();
  const claimed = owner.transitionManagedCommand({
    requestId: claimRequest, commandId: command.commandId, action: "claim", now: 120,
  });
  assert.equal(claimed.state, "claimed");
  assert.match(claimed.claimGeneration, /^[0-9a-f-]{36}$/i);
  assert.deepEqual(owner.transitionManagedCommand({
    requestId: claimRequest, commandId: command.commandId, action: "claim", now: 125,
  }), { ...claimed, replayed: true });
  assert.equal(owner.transitionManagedCommand({
    commandId: command.commandId, action: "begin",
    claimGeneration: claimed.claimGeneration, now: 130,
  }).state, "executing");
  assert.throws(() => owner.transitionManagedCommand({
    commandId: command.commandId, action: "complete",
    claimGeneration: randomUUID(), outcomeFingerprint: "wrong", now: 140,
  }), /forbidden|generation/i);
  assert.equal(owner.transitionManagedCommand({
    commandId: command.commandId, action: "complete",
    claimGeneration: claimed.claimGeneration,
    outcomeFingerprint: '{"ok":true,"playbackStatus":"paused"}', now: 150,
  }).state, "completed");
  assert.equal(owner.authorityStatus().first_admitted_at, 100);
  owner.close();

  const read = openStateStoreReadOnly(path);
  assert.deepEqual(read.prepare(`SELECT from_state,to_state FROM managed_command_transitions
    WHERE command_id=? ORDER BY sequence`).all(command.commandId).map((row) => ({ ...row })), [
    { from_state: null, to_state: "queued" },
    { from_state: "queued", to_state: "claimed" },
    { from_state: "claimed", to_state: "executing" },
    { from_state: "executing", to_state: "completed" },
  ]);
  assert.throws(() => read.prepare("UPDATE managed_command_transitions SET to_state='failed'").run(),
    /read.?only/i);
  read.close();
});
