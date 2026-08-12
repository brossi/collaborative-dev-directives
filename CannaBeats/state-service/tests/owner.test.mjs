import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { spawn } from "node:child_process";
import { symlinkSync } from "node:fs";
import { StateOwner } from "../src/owner.mjs";
import { openStateStoreReadOnly } from "../src/store.mjs";
import { createCatalogGameServices } from "../src/catalog.mjs";

const root = mkdtempSync(join(tmpdir(), "cannabeats-state-owner-"));
after(() => rmSync(root, { recursive: true, force: true }));
const developmentOwner = (path, options = {}) => new StateOwner(path, {
  ...options, allowDevelopmentActivation: true,
});

test("development activation requires an explicit owner mode", () => {
  const owner = new StateOwner(join(root, "production-activation.sqlite"));
  assert.throws(() => owner.activate({ now: 1 }), /attestation is invalid/i);
  owner.close();
});

test("idempotent state commands replay and conflicting identity reuse fails", () => {
  const path = join(root, "commands.sqlite");
  const owner = developmentOwner(path);
  assert.throws(() => developmentOwner(path), /operating-system owner/i);
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

test("state ownership is crash-released and canonical across path aliases", async () => {
  const path = join(root, "process-owned.sqlite");
  const modulePath = new URL("../src/owner.mjs", import.meta.url).href;
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    const { StateOwner } = await import(${JSON.stringify(modulePath)});
    new StateOwner(${JSON.stringify(path)});
    process.stdout.write('owned\\n');
    setInterval(() => {}, 1000);
  `], { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise((resolve, reject) => {
    child.stdout.once("data", resolve);
    child.once("error", reject);
  });
  assert.throws(() => developmentOwner(path), /operating-system owner/i);
  const alias = join(root, "process-owned-alias.sqlite");
  symlinkSync(path,alias);
  assert.throws(() => developmentOwner(alias), /operating-system owner/i);
  const hardlinkDirectory = join(root, "process-owned-hardlink");
  mkdirSync(hardlinkDirectory);
  const hardlinkAlias = join(hardlinkDirectory, "state.sqlite");
  linkSync(path,hardlinkAlias);
  assert.throws(() => developmentOwner(hardlinkAlias), /operating-system owner/i);
  child.kill("SIGKILL");
  await new Promise((resolve) => child.once("exit", resolve));
  const recovered = developmentOwner(path);
  recovered.close();
});

test("state ownership uses one identity across hard-linked database aliases", () => {
  const firstDirectory = join(root, "hardlink-first");
  const secondDirectory = join(root, "hardlink-second");
  mkdirSync(firstDirectory);
  mkdirSync(secondDirectory);
  const path = join(firstDirectory, "state.sqlite");
  const owner = developmentOwner(path);
  owner.close();
  const alias = join(secondDirectory, "state-alias.sqlite");
  linkSync(path,alias);
  const active = developmentOwner(path);
  assert.throws(() => developmentOwner(alias), /operating-system owner/i);
  active.close();
  const recovered = developmentOwner(alias);
  recovered.close();
});

test("activation runs the canonical invariant validator and rejects poisoned candidates", () => {
  const path = join(root, "poisoned-candidate.sqlite");
  const candidate = developmentOwner(path);
  candidate.close();
  const poisoned = new DatabaseSync(path);
  poisoned.prepare(`INSERT INTO lobbies
    (code,host_principal_id,status,created_at,updated_at)
    VALUES ('BAD234','principal','lobby',1,1)`).run();
  const poisonedRunId = randomUUID();
  poisoned.prepare(`INSERT INTO game_runs
    (id,lobby_code,state,revision,created_at,updated_at)
    VALUES (?,'BAD234','{}',0,1,1)`).run(poisonedRunId);
  poisoned.prepare(`INSERT INTO history_streams
    (run_id,baseline_revision,last_recorded_revision,lifecycle,started_at)
    VALUES (?,0,0,'recording',1)`).run(poisonedRunId);
  poisoned.prepare(`INSERT INTO history_transitions
    (run_id,sequence,from_state,to_state,reason,occurred_at)
    VALUES (?,1,NULL,'recording','run_created',1)`).run(poisonedRunId);
  poisoned.close();
  const reopened = developmentOwner(path);
  assert.throws(() => reopened.activate({ now: 2 }), /snapshot shape is invalid/i);
  assert.equal(reopened.authorityStatus().status, "candidate");
  reopened.close();
});

test("activation cannot be replay-short-circuited by a pre-seeded command receipt", () => {
  const path = join(root, "preseeded-activation.sqlite");
  const candidate = developmentOwner(path);
  candidate.close();
  const changed = new DatabaseSync(path);
  changed.prepare(`INSERT INTO state_commands
    (command_id,command_type,request_fingerprint,result,accepted_at)
    VALUES (?,?,?,json(?),1)`).run(
    randomUUID(),"activate_state_authority","a".repeat(64),JSON.stringify({ status: "active" }),
  );
  changed.close();
  const reopened = developmentOwner(path);
  assert.throws(() => reopened.activate({ now: 2 }), /commands issued before activation/i);
  assert.equal(reopened.authorityStatus().status, "candidate");
  reopened.close();
});

test("startup verifies the actual canonical schema and its immutable generation ledger", () => {
  const path = join(root, "schema-attestation.sqlite");
  const owner = developmentOwner(path);
  owner.close();
  const changed = new DatabaseSync(path);
  assert.throws(() => changed.prepare("DELETE FROM state_schema_generations").run(), /immutable/i);
  changed.exec("DROP TRIGGER game_events_insert_guard");
  changed.close();
  assert.throws(() => developmentOwner(path), /generation is not compatible/i);
});

test("activation rejects missing lifecycle and command-transition authority", () => {
  const path = join(root, "missing-transition-candidate.sqlite");
  const candidate = developmentOwner(path);
  candidate.close();
  const poisoned = new DatabaseSync(path);
  const host = randomUUID();
  const runId = randomUUID();
  const state = {
    runId, code: "GAP234", runGeneration: 1, revision: 0, phase: "lobby",
    players: [], activePlayerId: null, activePlayerIndex: null, round: 0,
    currentSong: null, result: null, winnerId: null, usedUris: [],
    rules: { targetScore: 7, minYear: 1920, maxYear: 2026, catalogScope: "all",
      eraWeights: { early: 1, midcentury: 1, classics: 1, millennial: 1, current: 1 } },
  };
  poisoned.prepare(`INSERT INTO lobbies
    (code,host_principal_id,status,active_run_id,run_generation,created_at,updated_at)
    VALUES ('GAP234',?,'playing',?,1,1,1)`).run(host,runId);
  poisoned.prepare(`INSERT INTO game_runs
    (id,lobby_code,state,revision,created_at,updated_at) VALUES (?,'GAP234',?,0,1,1)`)
    .run(runId,JSON.stringify(state));
  poisoned.prepare(`INSERT INTO history_streams
    (run_id,baseline_revision,last_recorded_revision,lifecycle,started_at)
    VALUES (?,0,0,'recording',1)`).run(runId);
  poisoned.close();
  const reopened = developmentOwner(path);
  assert.throws(() => reopened.activate({ now: 2 }), /lifecycle projection is stale/i);
  reopened.close();
});

test("managed command authority is an append-only owner-issued protocol", () => {
  const path = join(root, "managed.sqlite");
  const owner = developmentOwner(path);
  const host = randomUUID();
  owner.activate({ now: 90 });
  owner.createLobby({ code: "AUD234", hostPrincipalId: host, now: 100 });
  const runId = randomUUID();
  owner.createRun({
    lobbyCode: "AUD234", runId, actorPrincipalId: host,
    now: 102,
  });
  const sourceId = randomUUID();
  owner.registerManagedSource({
    sourceId, displayName: "Source", tokenHash: "hash", now: 105,
  });
  owner.acquireManagedLease({
    lobbyCode: "AUD234", sourceId, actorPrincipalId: host,
    leaseDurationMs: 1_000, now: 106,
  });
  const command = owner.createManagedCommand({
    sourceId, lobbyCode: "AUD234", runId, runGeneration: 1, kind: "pause",
    requestedByPrincipalId: host, now: 110,
  });
  assert.equal(command.protocolVersion, 3);
  const claimRequest = randomUUID();
  const claimGeneration = randomUUID();
  const claimed = owner.transitionManagedCommand({
    requestId: claimRequest, commandId: command.commandId, action: "claim",
    authenticatedSourceId: sourceId, claimGeneration, now: 120,
  });
  assert.equal(claimed.state, "claimed");
  assert.match(claimed.claimGeneration, /^[0-9a-f-]{36}$/i);
  assert.deepEqual(owner.transitionManagedCommand({
    requestId: claimRequest, commandId: command.commandId, action: "claim",
    authenticatedSourceId: sourceId, claimGeneration, now: 125,
  }), { ...claimed, replayed: true });
  assert.throws(() => {
    const direct = new DatabaseSync(path);
    try {
      direct.prepare(`INSERT INTO managed_command_transitions
        (command_id,sequence,from_state,to_state,claim_generation,occurred_at)
        VALUES (?,3,'claimed','executing',?,119)`).run(command.commandId,randomUUID());
    } finally { direct.close(); }
  }, /transition chain is invalid/i);
  assert.equal(owner.transitionManagedCommand({
    commandId: command.commandId, action: "begin",
    authenticatedSourceId: sourceId, claimGeneration: claimed.claimGeneration, now: 130,
  }).state, "executing");
  assert.throws(() => owner.transitionManagedCommand({
    commandId: command.commandId, action: "complete",
    authenticatedSourceId: sourceId, claimGeneration: randomUUID(),
    outcomeFingerprint: "wrong", now: 140,
  }), /forbidden|generation/i);
  assert.throws(() => owner.transitionManagedCommand({
    commandId: command.commandId, action: "complete",
    authenticatedSourceId: sourceId, claimGeneration: claimed.claimGeneration,
    outcomeFingerprint: { ok: true, playbackStatus: "playing", errorCategory: null }, now: 145,
  }), /contradicts its requested playback state/i);
  assert.equal(owner.transitionManagedCommand({
    commandId: command.commandId, action: "complete",
    authenticatedSourceId: sourceId, claimGeneration: claimed.claimGeneration,
    outcomeFingerprint: { ok: true, playbackStatus: "paused", errorCategory: null }, now: 150,
  }).state, "completed");
  assert.equal(owner.managedSourceWork({ authenticatedSourceId: sourceId, now: 151 })
    .lease.playbackStatus, "paused");
  assert.throws(() => owner.createManagedCommand({
    sourceId, lobbyCode: "AUD234", runId, runGeneration: 1, kind: "play",
    requestedByPrincipalId: host, now: 151,
  }), /requires an authoritative track URI/i);
  assert.throws(() => owner.createManagedCommand({
    sourceId, lobbyCode: "AUD234", runId, runGeneration: 1, kind: "pause",
    trackUri: "spotify:track:not-allowed", requestedByPrincipalId: host, now: 152,
  }), /cannot carry a track URI/i);
  const firstAtSameTime = owner.createManagedCommand({
    commandId: "ffffffff-ffff-4fff-bfff-ffffffffffff",
    sourceId, lobbyCode: "AUD234", runId, runGeneration: 1, kind: "pause",
    requestedByPrincipalId: host, now: 160,
  });
  owner.createManagedCommand({
    commandId: "00000000-0000-4000-8000-000000000001",
    sourceId, lobbyCode: "AUD234", runId, runGeneration: 1, kind: "resume",
    requestedByPrincipalId: host, now: 160,
  });
  assert.equal(owner.managedSourceWork({ authenticatedSourceId: sourceId, now: 161 })
    .command.id, firstAtSameTime.commandId);
  const forged = new DatabaseSync(path);
  forged.prepare(`INSERT INTO game_events
    (run_id,sequence,revision,event_type,outcome,actor_type,actor_ref,command_ref,detail_code,occurred_at)
    VALUES (?,(SELECT MAX(sequence)+1 FROM game_events WHERE run_id=?),
      0,'audio_command_failed','failed','player',?,?,?,162)`).run(
    runId,runId,host,firstAtSameTime.commandId,"play",
  );
  forged.close();
  assert.throws(() => owner.validate(), /event projection/i);
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

test("run mutation, receipt, event, coverage, and projection commit atomically", () => {
  const path = join(root, "run-mutation.sqlite");
  const owner = developmentOwner(path);
  const host = randomUUID();
  const runId = randomUUID();
  const actionId = randomUUID();
  owner.activate({ now: 10 });
  owner.createLobby({ code: "RUN234", hostPrincipalId: host, now: 20 });
  const created = owner.createRun({
    lobbyCode: "RUN234", runId, actorPrincipalId: host,
    now: 30,
  });
  assert.equal(created.runGeneration, 1);
  assert.equal(created.revision, 0);

  const input = {
    lobbyCode: "RUN234", actorPrincipalId: host, actionId,
    expectedRunId: runId, expectedRunGeneration: 1, expectedRevision: 0,
    command: { type: "configure_rules", rules: { targetScore: 7 } },
    now: 40,
  };
  const accepted = owner.applyGameCommand(input);
  assert.equal(accepted.replayed, false);
  assert.equal(accepted.revision, 1);
  assert.equal(accepted.state.revision, 1);
  assert.equal(accepted.state.runGeneration, 1);
  assert.deepEqual(owner.applyGameCommand({ ...input, now: 50 }), {
    ...accepted, replayed: true,
  });
  assert.throws(() => owner.applyGameCommand({
    ...input, command: { type: "configure_rules", rules: { targetScore: 8 } }, now: 60,
  }), /identity conflicts/i);
  assert.throws(() => owner.applyGameCommand({
    ...input, actionId: randomUUID(), expectedRevision: 0, now: 70,
  }), /context is stale/i);
  const guest = randomUUID();
  const joined = owner.admitPlayer({
    lobbyCode: "RUN234", actorPrincipalId: guest, actionId: randomUUID(),
    expectedRunId: runId, expectedRunGeneration: 1, expectedRevision: 1,
    name: "Guest",
    now: 80,
  });
  assert.equal(joined.revision, 2);
  assert.equal(owner.room({ lobbyCode: "RUN234", principalId: guest }).state.players[0].id, guest);
  assert.throws(() => owner.applyGameCommand({
    lobbyCode: "RUN234", actorPrincipalId: guest, actionId: randomUUID(),
    expectedRunId: runId, expectedRunGeneration: 1, expectedRevision: 2,
    command: {
      type: "abandon_game",
      nextState: { phase: "finished", winnerId: guest },
      event: { type: "game_completed", actorType: "system" },
    },
    now: 81,
  }), /host authority/i);
  assert.equal(owner.room({ lobbyCode: "RUN234", principalId: host }).status, "playing");
  owner.close();

  const read = openStateStoreReadOnly(path);
  assert.equal(read.prepare("SELECT revision FROM game_runs WHERE id=?").get(runId).revision, 2);
  assert.equal(read.prepare("SELECT COUNT(*) AS count FROM action_receipts WHERE run_id=?")
    .get(runId).count, 2);
  assert.deepEqual({ ...read.prepare(`SELECT event_type,outcome,actor_type,round
    FROM game_events WHERE run_id=? AND event_type='game_configured'`).get(runId) }, {
    event_type: "game_configured", outcome: "accepted", actor_type: "host", round: 0,
  });
  assert.equal(read.prepare(`SELECT last_recorded_revision FROM history_streams WHERE run_id=?`)
    .get(runId).last_recorded_revision, 2);
  read.close();
});

test("typed gameplay derives songs, roles, state, events, and member projections", () => {
  const path = join(root, "typed-gameplay.sqlite");
  const gameServices = createCatalogGameServices([
    { title: "First", artist: "Artist", year: 1950, uri: "spotify:track:first" },
    { title: "Second", artist: "Artist", year: 1970, uri: "spotify:track:second" },
    { title: "Third", artist: "Artist", year: 1990, uri: "spotify:track:third" },
    { title: "Fourth", artist: "Artist", year: 2010, uri: "spotify:track:fourth" },
  ], { random: () => 0 });
  const owner = developmentOwner(path, gameServices);
  const host = randomUUID();
  const guest = randomUUID();
  const runId = randomUUID();
  owner.activate({ now: 1 });
  owner.createLobby({ code: "PLY234", hostPrincipalId: host, now: 2 });
  owner.createRun({ lobbyCode: "PLY234", runId, actorPrincipalId: host, now: 3 });
  const sourceId = randomUUID();
  owner.registerManagedSource({
    sourceId, displayName: "Typed source", tokenHash: "typed-source-token", now: 4,
  });
  owner.acquireManagedLease({
    lobbyCode: "PLY234", sourceId, actorPrincipalId: host,
    leaseDurationMs: 1_000, now: 5,
  });
  let revision = 0;
  const act = (actorPrincipalId, command) => owner.applyGameCommand({
    lobbyCode: "PLY234", actorPrincipalId, actionId: randomUUID(),
    expectedRunId: runId, expectedRunGeneration: 1, expectedRevision: revision++,
    command, now: 10 + revision,
  });
  const hostPlayer = act(host, { type: "add_host_player", name: "Host seat" })
    .state.players[0].id;
  owner.admitPlayer({
    lobbyCode: "PLY234", actorPrincipalId: guest, actionId: randomUUID(),
    expectedRunId: runId, expectedRunGeneration: 1, expectedRevision: revision++,
    name: "Guest seat", now: 10 + revision,
  });
  const started = act(host, {
    type: "start_game",
    startingPlayerIndex: 1,
    currentSong: { title: "Injected", artist: "Caller", year: 2000, uri: "spotify:track:injected" },
  });
  assert.equal(started.state.activePlayerId, hostPlayer,
    "the owner selector, not caller input, chooses the starting player");
  assert.equal(started.state.currentSong.title, "Third");
  assert.equal("usedUris" in started.state, false);
  assert.equal(owner.room({ lobbyCode: "PLY234", principalId: guest }).state.currentSong, null);
  assert.equal(owner.room({ lobbyCode: "PLY234", principalId: host }).state.currentSong.title, "Third");
  const begun = act(host, { type: "begin_round" });
  assert.equal(begun.managedCommands.length, 1);
  assert.equal(begun.managedCommands[0].state, "queued");
  assert.throws(() => act(guest, { type: "place_song", playerId: guest, index: 0 }),
    /not this player's turn/i);
  revision -= 1;
  act(host, { type: "place_song", playerId: hostPlayer, index: 0 });
  const revealed = act(host, { type: "reveal_answer" });
  assert.equal(revealed.state.phase, "revealed");
  assert.equal(owner.room({ lobbyCode: "PLY234", principalId: guest }).state.currentSong.title, "Third");
  assert.equal("usedUris" in owner.room({ lobbyCode: "PLY234", principalId: host }).state, false);
  owner.close();

  const read = openStateStoreReadOnly(path);
  assert.equal(read.prepare(`SELECT COUNT(*) AS count FROM game_events
    WHERE run_id=? AND event_type='track_requested'`).get(runId).count, 1);
  assert.equal(read.prepare(`SELECT COUNT(*) AS count FROM game_events
    WHERE run_id=? AND event_type='audio_command_requested'`).get(runId).count, 1);
  assert.equal(read.prepare(`SELECT COUNT(*) AS count FROM managed_command_intents
    WHERE run_id=?`).get(runId).count, 1);
  assert.equal(read.prepare(`SELECT COUNT(*) AS count FROM game_events
    WHERE run_id=? AND event_type='answer_revealed'`).get(runId).count, 1);
  assert.equal(read.prepare(`SELECT COUNT(*) AS count FROM action_receipts
    WHERE run_id=?`).get(runId).count, 6);
  read.close();
});

test("a managed track request cannot commit separately from its room mutation", () => {
  const path = join(root, "typed-gameplay-audio-rollback.sqlite");
  const services = createCatalogGameServices([
    { title: "Seed", artist: "Artist", year: 1970, uri: "spotify:track:seed" },
    { title: "Round", artist: "Artist", year: 1990, uri: "spotify:track:round" },
  ], { random: () => 0 });
  const owner = developmentOwner(path, services);
  const host = randomUUID();
  const runId = randomUUID();
  const sourceId = randomUUID();
  owner.activate({ now: 1 });
  owner.createLobby({ code: "ATM234", hostPrincipalId: host, now: 2 });
  owner.createRun({ lobbyCode: "ATM234", runId, actorPrincipalId: host, now: 3 });
  owner.applyGameCommand({
    lobbyCode: "ATM234", actorPrincipalId: host, actionId: randomUUID(),
    expectedRunId: runId, expectedRunGeneration: 1, expectedRevision: 0,
    command: { type: "add_host_player", name: "Host" }, now: 4,
  });
  owner.applyGameCommand({
    lobbyCode: "ATM234", actorPrincipalId: host, actionId: randomUUID(),
    expectedRunId: runId, expectedRunGeneration: 1, expectedRevision: 1,
    command: { type: "start_game" }, now: 5,
  });
  assert.throws(() => owner.applyGameCommand({
    lobbyCode: "ATM234", actorPrincipalId: host, actionId: randomUUID(),
    expectedRunId: runId, expectedRunGeneration: 1, expectedRevision: 2,
    command: { type: "begin_round" }, now: 6,
  }), /managed playback authority is unavailable/i);
  assert.equal(owner.room({ lobbyCode: "ATM234", principalId: host }).state.phase, "ready");
  owner.registerManagedSource({
    sourceId, displayName: "Atomic source", tokenHash: "atomic-source-token", now: 6,
  });
  owner.acquireManagedLease({
    lobbyCode: "ATM234", sourceId, actorPrincipalId: host,
    leaseDurationMs: 1_000, now: 7,
  });
  const injected = new DatabaseSync(path);
  injected.exec(`CREATE TRIGGER fail_managed_enqueue BEFORE INSERT ON managed_command_intents
    BEGIN SELECT RAISE(ABORT, 'injected managed enqueue failure'); END;`);
  injected.close();
  assert.throws(() => owner.applyGameCommand({
    lobbyCode: "ATM234", actorPrincipalId: host, actionId: randomUUID(),
    expectedRunId: runId, expectedRunGeneration: 1, expectedRevision: 2,
    command: { type: "begin_round" }, now: 8,
  }), /injected managed enqueue failure/i);
  const room = owner.room({ lobbyCode: "ATM234", principalId: host });
  assert.equal(room.revision, 2);
  assert.equal(room.state.phase, "ready");
  owner.close();

  const read = openStateStoreReadOnly(path);
  assert.equal(read.prepare("SELECT COUNT(*) AS count FROM managed_command_intents").get().count, 0);
  assert.equal(read.prepare(`SELECT COUNT(*) AS count FROM game_events
    WHERE run_id=? AND event_type='track_requested'`).get(runId).count, 0);
  read.close();
});

test("a late receipt or history failure rolls the room revision and event back", () => {
  const path = join(root, "run-rollback.sqlite");
  const owner = developmentOwner(path);
  const host = randomUUID();
  const runId = randomUUID();
  const actionId = randomUUID();
  owner.activate({ now: 10 });
  owner.createLobby({ code: "RBK234", hostPrincipalId: host, now: 20 });
  owner.createRun({
    lobbyCode: "RBK234", runId, actorPrincipalId: host,
    now: 30,
  });
  const injected = new DatabaseSync(path);
  injected.exec(`CREATE TRIGGER audit_fail_event BEFORE INSERT ON game_events
    BEGIN SELECT RAISE(ABORT, 'injected event failure'); END;`);
  injected.close();
  assert.throws(() => owner.applyGameCommand({
    lobbyCode: "RBK234", actorPrincipalId: host, actionId,
    expectedRunId: runId, expectedRunGeneration: 1, expectedRevision: 0,
    command: { type: "configure_rules", rules: { targetScore: 7 } },
    now: 40,
  }), /injected event failure/i);
  const guest = randomUUID();
  assert.throws(() => owner.admitPlayer({
    lobbyCode: "RBK234", actorPrincipalId: guest, actionId: randomUUID(),
    expectedRunId: runId, expectedRunGeneration: 1, expectedRevision: 0,
    name: "Guest",
    now: 41,
  }), /injected event failure/i);
  owner.close();

  const read = openStateStoreReadOnly(path);
  assert.equal(read.prepare("SELECT revision FROM game_runs WHERE id=?").get(runId).revision, 0);
  assert.equal(read.prepare("SELECT COUNT(*) AS count FROM action_receipts WHERE run_id=?")
    .get(runId).count, 0);
  assert.equal(read.prepare("SELECT COUNT(*) AS count FROM game_events WHERE run_id=?")
    .get(runId).count, 0);
  assert.equal(read.prepare(`SELECT last_recorded_revision FROM history_streams WHERE run_id=?`)
    .get(runId).last_recorded_revision, 0);
  assert.equal(read.prepare(`SELECT COUNT(*) AS count FROM lobby_members
    WHERE lobby_code='RBK234' AND principal_id=?`).get(guest).count, 0);
  read.close();
});

test("terminal evidence seals and purges atomically while unresolved commands fail closed", () => {
  const path = join(root, "history-lifecycle.sqlite");
  const owner = developmentOwner(path);
  const host = randomUUID();
  const runId = randomUUID();
  const sourceId = randomUUID();
  owner.activate({ now: 10 });
  owner.createLobby({ code: "HIS234", hostPrincipalId: host, now: 20 });
  owner.createRun({
    lobbyCode: "HIS234", runId, actorPrincipalId: host,
    now: 30,
  });
  owner.registerManagedSource({
    sourceId, displayName: "History Source", tokenHash: "history-hash", now: 31,
  });
  owner.acquireManagedLease({
    lobbyCode: "HIS234", sourceId, actorPrincipalId: host,
    leaseDurationMs: 1_000, now: 31,
  });
  const purgeSentinel = "spotify:track:PURGE_SENTINEL_9f712";
  const delivered = owner.createManagedCommand({
    sourceId, lobbyCode: "HIS234", runId, runGeneration: 1, kind: "resume",
    requestedByPrincipalId: host, now: 32,
  });
  const deliveredClaim = owner.transitionManagedCommand({
    commandId: delivered.commandId, action: "claim",
    authenticatedSourceId: sourceId, claimGeneration: randomUUID(), now: 34,
  });
  const audio = owner.createManagedCommand({
    sourceId, lobbyCode: "HIS234", runId, runGeneration: 1, kind: "play",
    trackUri: purgeSentinel, requestedByPrincipalId: host, now: 35,
  });
  const terminal = owner.applyGameCommand({
    lobbyCode: "HIS234", actorPrincipalId: host, actionId: randomUUID(),
    expectedRunId: runId, expectedRunGeneration: 1, expectedRevision: 0,
    command: { type: "abandon_game" }, now: 40,
  });
  assert.equal(terminal.terminalOutcome, "abandoned");
  assert.throws(() => {
    const injected = new DatabaseSync(path);
    try {
      injected.prepare(`INSERT INTO action_receipts
        (run_id,actor_principal_id,action_id,action,request_fingerprint,result,revision,accepted_at)
        VALUES (?,?,?,?,?,json('{}'),NULL,?)`).run(
        runId,randomUUID(),randomUUID(),"late_action","0".repeat(64),41,
      );
    } finally { injected.close(); }
  }, /history is closed/i);
  assert.throws(() => {
    const injected = new DatabaseSync(path);
    try {
      injected.prepare(`INSERT INTO game_events
        (run_id,sequence,revision,event_type,outcome,actor_type,actor_ref,action_id,
         command_ref,round,detail_code,detail_value,reason_code,occurred_at)
        SELECT run_id,(SELECT MAX(sequence)+1 FROM game_events WHERE run_id=?),revision,
          event_type,outcome,actor_type,actor_ref,action_id,command_ref,round,detail_code,
          detail_value,reason_code,occurred_at FROM game_events
        WHERE run_id=? AND event_type='audio_lease_released'`).run(runId,runId);
    } finally { injected.close(); }
  }, /unique/i);
  assert.throws(() => {
    const injected = new DatabaseSync(path);
    try {
      injected.prepare(`INSERT INTO game_events
        (run_id,sequence,event_type,outcome,actor_type,occurred_at)
        VALUES (?,99,'player_joined','accepted','player',41)`).run(runId);
    } finally { injected.close(); }
  }, /history is closed/i);
  assert.throws(() => owner.transitionManagedCommand({
    commandId: audio.commandId, action: "claim", authenticatedSourceId: sourceId, now: 41,
  }), /forbidden|closed/i);
  assert.throws(() => owner.sealHistory({
    commandId: "4286317e-4954-40c6-8072-3c6b33658ba1", runId, now: 43,
  }), /incomplete|contradictory/i);
  const reconciled = owner.transitionManagedCommand({
    commandId: delivered.commandId, action: "complete",
    authenticatedSourceId: sourceId, claimGeneration: deliveredClaim.claimGeneration,
    outcomeFingerprint: { ok: true, playbackStatus: "playing", errorCategory: null }, now: 44,
  });
  assert.equal(reconciled.state, "completed");
  const sealed = owner.sealHistory({
    commandId: "9a1f7905-392a-455f-a020-4ae739e1f5b7", runId, now: 45,
  });
  assert.equal(sealed.lifecycle, "sealed");
  const pinnedReader = new DatabaseSync(path, { readOnly: true });
  pinnedReader.exec("BEGIN");
  assert.equal(pinnedReader.prepare(`SELECT track_uri FROM managed_command_payloads
    WHERE command_id=?`).get(audio.commandId).track_uri, purgeSentinel);
  const purgeCommand = "3d84a62a-a142-4b11-bc53-e6866fcc0a64";
  const purged = owner.purgeHistory({
    commandId: purgeCommand, runId, eligibleBefore: 40, now: 50,
  });
  assert.deepEqual(purged.counts, { events: 9, receipts: 1 });
  assert.equal(purged.lifecycle, "purged");
  assert.equal(purged.sanitization.status, "pending");
  assert.equal(readFileSync(`${path}-wal`).includes(Buffer.from(purgeSentinel)), true);
  pinnedReader.exec("COMMIT");
  pinnedReader.close();
  const sanitizeCommand = randomUUID();
  const sanitizeResult = owner.sanitizeHistory({
    commandId: sanitizeCommand, runId, now: 60,
  });
  assert.equal(sanitizeResult.status, "complete");
  assert.equal(owner.sanitizeHistory({
    commandId: sanitizeCommand, runId, now: 61,
  }).replayed, true);
  const sanitized = owner.purgeHistory({
    commandId: purgeCommand, runId, eligibleBefore: 40, now: 62,
  });
  assert.equal(sanitized.replayed, true);
  assert.equal(sanitized.sanitization.status, "complete");
  assert.throws(() => owner.transitionManagedCommand({
    commandId: delivered.commandId, action: "complete",
    authenticatedSourceId: sourceId, claimGeneration: deliveredClaim.claimGeneration,
    outcomeFingerprint: { ok: true, playbackStatus: "playing", errorCategory: null }, now: 61,
  }), /forbidden|history is closed/i);
  owner.close();

  const guarded = new DatabaseSync(path);
  guarded.exec("PRAGMA foreign_keys=ON");
  assert.throws(() => guarded.prepare(`UPDATE history_streams
    SET baseline_revision=1 WHERE run_id=?`).run(runId), /purged history is immutable/i);
  assert.throws(() => guarded.prepare(`INSERT INTO game_events
    (run_id,sequence,event_type,outcome,actor_type,occurred_at)
    VALUES (?,99,'audio_source_recovered','recovered','system',99)`).run(runId),
  /history is closed/i);
  assert.throws(() => guarded.prepare("DELETE FROM game_runs WHERE id=?").run(runId),
    /history boundary cannot be deleted/i);
  assert.throws(() => guarded.prepare("UPDATE game_runs SET state=? WHERE id=?")
    .run(JSON.stringify({ usedUris: ["spotify:track:RESURRECTED_PRIVATE"] }),runId),
  /purged run authority is immutable/i);
  guarded.close();
  assert.equal(readFileSync(path).includes(Buffer.from(purgeSentinel)), false,
    "purged command payload bytes must not remain in the checkpointed database");
  for (const sidecar of [`${path}-wal`, `${path}-shm`]) {
    if (existsSync(sidecar)) {
      assert.equal(readFileSync(sidecar).includes(Buffer.from(purgeSentinel)), false,
        "purged command payload bytes must not remain in SQLite sidecars");
    }
  }

  const read = openStateStoreReadOnly(path);
  assert.equal(read.prepare("SELECT COUNT(*) AS count FROM game_events WHERE run_id=?")
    .get(runId).count, 0);
  assert.equal(read.prepare("SELECT COUNT(*) AS count FROM action_receipts WHERE run_id=?")
    .get(runId).count, 0);
  assert.equal(read.prepare(`SELECT COUNT(*) AS count FROM managed_command_payloads payload
    JOIN managed_command_intents command ON command.id=payload.command_id
    WHERE command.run_id=?`).get(runId).count, 0);
  assert.equal(read.prepare("SELECT lifecycle FROM history_streams WHERE run_id=?")
    .get(runId).lifecycle, "purged");
  const retainedState = JSON.parse(read.prepare("SELECT state FROM game_runs WHERE id=?")
    .get(runId).state);
  assert.deepEqual(retainedState.usedUris, []);
  assert.equal(JSON.stringify(retainedState).includes("spotify:track:"), false);
  assert.deepEqual(read.prepare(`SELECT from_state,to_state FROM history_transitions
    WHERE run_id=? ORDER BY sequence`).all(runId).map((row) => ({ ...row })), [
    { from_state: null, to_state: "recording" },
    { from_state: "recording", to_state: "terminal_pending" },
    { from_state: "terminal_pending", to_state: "sealed" },
    { from_state: "sealed", to_state: "purging" },
    { from_state: "purging", to_state: "purged" },
  ]);
  assert.equal(read.prepare("SELECT final_revision FROM purge_tombstones WHERE run_id=?")
    .get(runId).final_revision, 1);
  read.close();
});

test("lease loss cancels queued work, makes delivered work unknown, and fences late begin", () => {
  const path = join(root, "lease-authority.sqlite");
  const owner = developmentOwner(path);
  const host = randomUUID();
  const runId = randomUUID();
  const sourceId = randomUUID();
  owner.activate({ now: 10 });
  owner.createLobby({ code: "LSE234", hostPrincipalId: host, now: 20 });
  owner.createRun({
    lobbyCode: "LSE234", runId, actorPrincipalId: host,
    now: 30,
  });
  owner.registerManagedSource({
    sourceId, displayName: "Lease Source", tokenHash: "lease-hash", now: 31,
  });
  const lease = owner.acquireManagedLease({
    lobbyCode: "LSE234", sourceId, actorPrincipalId: host,
    leaseDurationMs: 20, now: 40,
  });
  const delivered = owner.createManagedCommand({
    sourceId, lobbyCode: "LSE234", runId, runGeneration: 1, kind: "resume",
    requestedByPrincipalId: host, now: 41,
  });
  const claimed = owner.transitionManagedCommand({
    commandId: delivered.commandId, action: "claim",
    authenticatedSourceId: sourceId, claimGeneration: randomUUID(), now: 43,
  });
  const queued = owner.createManagedCommand({
    sourceId, lobbyCode: "LSE234", runId, runGeneration: 1, kind: "pause",
    requestedByPrincipalId: host, now: 43,
  });
  const released = owner.releaseManagedLease({
    leaseId: lease.leaseId, actorPrincipalId: host, now: 44,
  });
  assert.deepEqual(released.transitions.sort((left, right) =>
    left.commandId.localeCompare(right.commandId)), [
    { commandId: queued.commandId, state: "cancelled" },
    { commandId: delivered.commandId, state: "outcome_unknown" },
  ].sort((left, right) => left.commandId.localeCompare(right.commandId)));
  assert.throws(() => owner.transitionManagedCommand({
    commandId: delivered.commandId, action: "begin",
    authenticatedSourceId: sourceId, claimGeneration: claimed.claimGeneration, now: 45,
  }), /forbidden|expired/i);

  const replacement = owner.acquireManagedLease({
    lobbyCode: "LSE234", sourceId, actorPrincipalId: host,
    leaseDurationMs: 5, now: 50,
  });
  assert.equal(owner.transitionManagedCommand({
    commandId: delivered.commandId, action: "complete",
    authenticatedSourceId: sourceId, claimGeneration: claimed.claimGeneration,
    outcomeFingerprint: { ok: true, playbackStatus: "playing", errorCategory: null }, now: 50,
  }).state, "completed");
  assert.equal(owner.managedSourceWork({ authenticatedSourceId: sourceId, now: 51 })
    .lease.playbackStatus, "ready");
  const expiring = owner.createManagedCommand({
    sourceId, lobbyCode: "LSE234", runId, runGeneration: 1, kind: "pause",
    requestedByPrincipalId: host, now: 51,
  });
  assert.equal(replacement.expiresAt, 55);
  assert.throws(() => owner.transitionManagedCommand({
    commandId: expiring.commandId, action: "claim",
    authenticatedSourceId: sourceId, claimGeneration: randomUUID(), now: 56,
  }), /expired/i);
  const expiryCommand = randomUUID();
  const expired = owner.expireManagedLeases({ commandId: expiryCommand, now: 56 });
  assert.deepEqual(expired.expired, [{
    leaseId: replacement.leaseId,
    transitions: [{ commandId: expiring.commandId, state: "cancelled" }],
  }]);
  assert.deepEqual(owner.expireManagedLeases({ commandId: expiryCommand, now: 66 }), {
    ...expired, replayed: true,
  });
  assert.equal(owner.acquireManagedLease({
    lobbyCode: "LSE234", sourceId, actorPrincipalId: host,
    leaseDurationMs: 10, now: 57,
  }).expiresAt, 67);
  owner.close();
});
