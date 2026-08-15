import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  existsSync,linkSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync,
} from "node:fs";
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

test("admission is an idempotent generation-fenced owner command", () => {
  const owner = developmentOwner(join(root,"admission-fence.sqlite"));
  owner.activate({ now: 1 });
  assert.deepEqual(owner.authorityStatus().admission,{ open: true,generation: 0 });
  const closeId = randomUUID();
  assert.deepEqual(owner.setAdmission({
    commandId: closeId,open: false,expectedGeneration: 0,now: 2,
  }),{ open: false,generation: 1,replayed: false });
  assert.deepEqual(owner.setAdmission({
    commandId: closeId,open: false,expectedGeneration: 0,now: 3,
  }),{ open: false,generation: 1,replayed: true });
  assert.throws(() => owner.createLobby({
    commandId: randomUUID(),code: "CLS234",hostPrincipalId: randomUUID(),now: 4,
  }),/admission is closed/i);
  assert.throws(() => owner.setAdmission({
    commandId: randomUUID(),open: true,expectedGeneration: 0,now: 5,
  }),/generation is stale/i);
  assert.deepEqual(owner.setAdmission({
    commandId: randomUUID(),open: true,expectedGeneration: 1,now: 6,
  }),{ open: true,generation: 2,replayed: false });
  assert.equal(owner.createLobby({
    commandId: randomUUID(),code: "OPN234",hostPrincipalId: randomUUID(),now: 7,
  }).code,"OPN234");
  owner.close();
});

test("rollback floor survives restoration of a pre-admission database snapshot", () => {
  const path = join(root,"rollback-floor.sqlite");
  const owner = developmentOwner(path);
  owner.activate({ now: 1 });
  const preAdmission = owner.exportSnapshot({ directory: root }).snapshot;
  owner.createLobby({
    commandId: randomUUID(),code: "FLR234",hostPrincipalId: randomUUID(),now: 5,
  });
  assert.equal(owner.authorityStatus().first_admitted_at,5);
  owner.close();
  for (const suffix of ["","-wal","-shm"]) rmSync(`${path}${suffix}`,{ force: true });
  writeFileSync(path,preAdmission,{ mode: 0o600 });
  const restored = developmentOwner(path);
  assert.equal(restored.authorityStatus().first_admitted_at,5);
  restored.close();
});

test("access lobby projection and membership are owner-scoped and idempotent", () => {
  const owner = developmentOwner(join(root, "access-lobbies.sqlite"));
  owner.activate({ now: 1 });
  const host = randomUUID();
  const member = randomUUID();
  owner.createLobby({ commandId: randomUUID(), code: "ACC234", hostPrincipalId: host, now: 2 });
  assert.deepEqual(owner.accessLobbies({ principalId: host }).map((lobby) => lobby.code), ["ACC234"]);
  assert.throws(() => owner.accessLobby({ lobbyCode: "ACC234", principalId: member }), /membership/i);
  const commandId = randomUUID();
  assert.deepEqual(owner.addLobbyMember({
    commandId, lobbyCode: "ACC234", principalId: member,
    admittedByPrincipalId: member, now: 3,
  }), { lobbyCode: "ACC234", principalId: member, joinedAt: 3, admitted: true, replayed: false });
  assert.deepEqual(owner.addLobbyMember({
    commandId, lobbyCode: "ACC234", principalId: member,
    admittedByPrincipalId: member, now: 4,
  }), { lobbyCode: "ACC234", principalId: member, joinedAt: 3, admitted: true, replayed: true });
  const projection = owner.accessLobby({ lobbyCode: "ACC234", principalId: member });
  assert.deepEqual(Object.keys(projection).sort(), [
    "admissionOpen", "code", "createdAt", "hostPrincipalId", "members", "runGeneration", "status", "updatedAt",
  ]);
  assert.deepEqual(projection.members.map((entry) => entry.principalId).sort(), [host,member].sort());
  assert.deepEqual(owner.recoverPrincipal({ principalId: member }), {
    outcome: "resume",
    lobbies: [{
      code: "ACC234",status: "lobby",isHost: false,runId: null,
      runGeneration: 0,revision: null,seatPlayerId: null,
    }],
  });
  assert.equal(owner.recoverPrincipal({
    principalId: member,pendingActionLobbyCode: "ACC234",
  }).outcome,"action_reconciliation_required");
  assert.deepEqual(owner.recoverPrincipal({
    principalId: member,pendingActionLobbyCode: "MISS23",
  }),{
    outcome: "resume",pendingActionRejected: true,
    lobbies: [{
      code: "ACC234",status: "lobby",isHost: false,runId: null,
      runGeneration: 0,revision: null,seatPlayerId: null,
    }],
  });
  assert.deepEqual(owner.recoverPrincipal({ principalId: host }), {
    outcome: "resume",
    lobbies: [{
      code: "ACC234",status: "lobby",isHost: true,runId: null,
      runGeneration: 0,revision: null,seatPlayerId: null,
    }],
  });
  assert.deepEqual(owner.recoverPrincipal({ principalId: randomUUID() }), {
    outcome: "none",lobbies: [],
  });
  owner.close();
});

test("diagnostic authority is durable for hosts and current-only for managed streams", () => {
  const path = join(root,"diagnostic-authority.sqlite");
  const owner = developmentOwner(path);
  owner.activate({ now: 1 });
  const host = randomUUID();
  const member = randomUUID();
  const runId = randomUUID();
  const sourceId = randomUUID();
  owner.createLobby({ commandId: randomUUID(),code: "DIA234",hostPrincipalId: host,now: 2 });
  owner.addLobbyMember({
    commandId: randomUUID(),lobbyCode: "DIA234",principalId: member,
    admittedByPrincipalId: member,now: 3,
  });
  owner.createRun({
    commandId: randomUUID(),lobbyCode: "DIA234",runId,actorPrincipalId: host,now: 4,
  });
  owner.registerManagedSource({
    commandId: randomUUID(),sourceId,displayName: "Diagnostic Source",
    tokenHash: "d".repeat(64),now: 5,
  });
  const lease = owner.acquireManagedLease({
    commandId: randomUUID(),lobbyCode: "DIA234",sourceId,
    actorPrincipalId: host,leaseDurationMs: 100,now: 6,
  });
  const before = owner.validate();
  assert.deepEqual(owner.diagnosticRunHostAuthority({ runId,principalId: host }),{
    authorityVersion: 1,status: "active",runId,runGeneration: 1,isHost: true,
  });
  assert.deepEqual(owner.diagnosticRunMemberAuthority({ runId,principalId: host }),{
    authorityVersion: 1,status: "active",runId,runGeneration: 1,role: "host",
  });
  assert.deepEqual(owner.diagnosticRunMemberAuthority({ runId,principalId: member }),{
    authorityVersion: 1,status: "active",runId,runGeneration: 1,role: "member",
  });
  assert.throws(() => owner.diagnosticRunHostAuthority({
    runId,principalId: member,
  }),/not found/i);
  assert.deepEqual(owner.diagnosticManagedStreamAuthority({ now: 7 }),{
    authorityVersion: 1,status: "active",runId,runGeneration: 1,
    leaseId: lease.leaseId,sourceId,leaseExpiresAt: 106,
  });
  assert.deepEqual(owner.diagnosticManagedStreamAuthority({ sourceId,now: 106 }),{
    authorityVersion: 1,status: "absent",
  });
  assert.deepEqual(owner.diagnosticManagedStreamAuthority({ sourceId,now: 107 }),{
    authorityVersion: 1,status: "absent",
  });
  assert.deepEqual(owner.diagnosticManagedStreamAuthority({
    sourceId: randomUUID(),now: 7,
  }),{ authorityVersion: 1,status: "absent" });
  assert.deepEqual(owner.validate(),before);
  owner.close();

  const reopened = developmentOwner(path);
  assert.deepEqual(reopened.diagnosticRunHostAuthority({ runId,principalId: host }),{
    authorityVersion: 1,status: "active",runId,runGeneration: 1,isHost: true,
  });
  assert.deepEqual(reopened.diagnosticManagedStreamAuthority({ sourceId,now: 7 }),{
    authorityVersion: 1,status: "active",runId,runGeneration: 1,
    leaseId: lease.leaseId,sourceId,leaseExpiresAt: 106,
  });
  reopened.applyGameCommand({
    lobbyCode: "DIA234",actorPrincipalId: host,actionId: randomUUID(),
    expectedRunId: runId,expectedRunGeneration: 1,expectedRevision: 0,
    command: { type: "select_audio",mode: "local" },now: 8,
  });
  assert.deepEqual(reopened.diagnosticManagedStreamAuthority({ sourceId,now: 9 }),{
    authorityVersion: 1,status: "absent",
  });
  reopened.close();
});

test("diagnostic host authority survives terminal history sealing and purge", () => {
  const owner = developmentOwner(join(root,"diagnostic-ended-host.sqlite"));
  owner.activate({ now: 1 });
  const host = randomUUID();
  const runId = randomUUID();
  owner.createLobby({ commandId: randomUUID(),code: "END234",hostPrincipalId: host,now: 2 });
  owner.createRun({
    commandId: randomUUID(),lobbyCode: "END234",runId,actorPrincipalId: host,now: 3,
  });
  owner.applyGameCommand({
    lobbyCode: "END234",actorPrincipalId: host,actionId: randomUUID(),
    expectedRunId: runId,expectedRunGeneration: 1,expectedRevision: 0,
    command: { type: "abandon_game" },now: 4,
  });
  assert.deepEqual(owner.diagnosticRunHostAuthority({ runId,principalId: host }),{
    authorityVersion: 1,status: "ended",runId,runGeneration: 1,isHost: true,
  });
  owner.sealHistory({ commandId: randomUUID(),runId,now: 5 });
  owner.purgeHistory({ commandId: randomUUID(),runId,eligibleBefore: 4,now: 6 });
  assert.deepEqual(owner.diagnosticRunHostAuthority({ runId,principalId: host }),{
    authorityVersion: 1,status: "ended",runId,runGeneration: 1,isHost: true,
  });
  owner.close();
});

test("diagnostic authority rejects retained host and lease relationship substitution", () => {
  const build = (path) => {
    const owner = developmentOwner(path);
    owner.activate({ now: 1 });
    const host = randomUUID();
    const member = randomUUID();
    const secondHost = randomUUID();
    const sourceId = randomUUID();
    owner.createLobby({ commandId: randomUUID(),code: "DRA234",hostPrincipalId: host,now: 2 });
    owner.addLobbyMember({
      commandId: randomUUID(),lobbyCode: "DRA234",principalId: member,
      admittedByPrincipalId: member,now: 2,
    });
    owner.createRun({
      commandId: randomUUID(),lobbyCode: "DRA234",runId: randomUUID(),
      actorPrincipalId: host,now: 4,
    });
    owner.createLobby({
      commandId: randomUUID(),code: "DRB234",hostPrincipalId: secondHost,now: 5,
    });
    owner.createRun({
      commandId: randomUUID(),lobbyCode: "DRB234",runId: randomUUID(),
      actorPrincipalId: secondHost,now: 6,
    });
    owner.registerManagedSource({
      commandId: randomUUID(),sourceId,displayName: "Relationship Source",
      tokenHash: "c".repeat(64),now: 7,
    });
    const lease = owner.acquireManagedLease({
      commandId: randomUUID(),lobbyCode: "DRA234",sourceId,
      actorPrincipalId: host,leaseDurationMs: 100,now: 8,
    });
    owner.close();
    return { host,member,leaseId: lease.leaseId };
  };

  const hostPath = join(root,"diagnostic-host-substitution.sqlite");
  const hostFixture = build(hostPath);
  const hostDb = new DatabaseSync(hostPath);
  hostDb.prepare("UPDATE lobbies SET host_principal_id=? WHERE code='DRA234'")
    .run(hostFixture.member);
  hostDb.close();
  assert.throws(() => developmentOwner(hostPath),/creation evidence/i);

  const leasePath = join(root,"diagnostic-lease-substitution.sqlite");
  const leaseFixture = build(leasePath);
  const leaseDb = new DatabaseSync(leasePath);
  const leaseRow = leaseDb.prepare("SELECT * FROM managed_leases WHERE id=?")
    .get(leaseFixture.leaseId);
  leaseDb.prepare("DELETE FROM managed_leases WHERE id=?").run(leaseFixture.leaseId);
  leaseDb.prepare(`INSERT INTO managed_leases
    (id,source_id,lobby_code,acquired_by_principal_id,acquired_at,renewed_at,
     expires_at,playback_status,last_error_category) VALUES (?,?,?,?,?,?,?,?,?)`).run(
    leaseRow.id,leaseRow.source_id,"DRB234",leaseRow.acquired_by_principal_id,
    leaseRow.acquired_at,leaseRow.renewed_at,leaseRow.expires_at,
    leaseRow.playback_status,leaseRow.last_error_category,
  );
  leaseDb.close();
  assert.throws(() => developmentOwner(leasePath),/acquisition evidence/i);
});

test("gameplay lease evidence binds same-time acquisitions to their exact lobby and source", () => {
  const path = join(root,"diagnostic-gameplay-lease-substitution.sqlite");
  const owner = developmentOwner(path);
  const host = randomUUID();
  const runs = [randomUUID(),randomUUID()];
  const sources = [randomUUID(),randomUUID()].sort();
  owner.activate({ now: 1 });
  for (const [index,code] of ["DGC234","DGD234"].entries()) {
    owner.createLobby({ commandId: randomUUID(),code,hostPrincipalId: host,now: 2 + index });
    owner.createRun({
      commandId: randomUUID(),lobbyCode: code,runId: runs[index],actorPrincipalId: host,
      now: 4 + index,
    });
  }
  for (const [index,sourceId] of sources.entries()) owner.registerManagedSource({
    commandId: randomUUID(),sourceId,displayName: `Source ${index}`,
    tokenHash: String(index + 4).repeat(64),now: 6,
  });
  for (const sourceId of sources) owner.managedSourceWork({ authenticatedSourceId: sourceId,now: 6 });
  for (const [index,code] of ["DGC234","DGD234"].entries()) owner.applyGameCommand({
    lobbyCode: code,actorPrincipalId: host,actionId: randomUUID(),
    expectedRunId: runs[index],expectedRunGeneration: 1,expectedRevision: 0,
    command: { type: "select_audio",mode: "managed" },now: 7,
  });
  assert.doesNotThrow(() => owner.validate());
  owner.close();

  const changed = new DatabaseSync(path);
  const leases = changed.prepare("SELECT * FROM managed_leases ORDER BY lobby_code").all();
  changed.prepare("DELETE FROM managed_leases").run();
  const first = leases[0];
  changed.prepare(`INSERT INTO managed_leases
    (id,source_id,lobby_code,acquired_by_principal_id,acquired_at,renewed_at,
     expires_at,playback_status,last_error_category) VALUES (?,?,?,?,?,?,?,?,?)`).run(
    first.id,first.source_id,"DGD234",first.acquired_by_principal_id,first.acquired_at,
    first.renewed_at,first.expires_at,first.playback_status,first.last_error_category,
  );
  changed.close();
  assert.throws(() => developmentOwner(path),/acquisition evidence/i);
});

test("a pre-binding gameplay lease starts compatibly but grants no diagnostic authority", () => {
  const path = join(root,"diagnostic-legacy-gameplay-lease.sqlite");
  const owner = developmentOwner(path);
  const host = randomUUID();
  const runId = randomUUID();
  const sourceId = randomUUID();
  owner.activate({ now: 1 });
  owner.createLobby({ commandId: randomUUID(),code: "DGE234",hostPrincipalId: host,now: 2 });
  owner.createRun({
    commandId: randomUUID(),lobbyCode: "DGE234",runId,actorPrincipalId: host,now: 3,
  });
  owner.registerManagedSource({
    commandId: randomUUID(),sourceId,displayName: "Legacy Source",
    tokenHash: "6".repeat(64),now: 4,
  });
  owner.managedSourceWork({ authenticatedSourceId: sourceId,now: 5 });
  owner.applyGameCommand({
    lobbyCode: "DGE234",actorPrincipalId: host,actionId: randomUUID(),
    expectedRunId: runId,expectedRunGeneration: 1,expectedRevision: 0,
    command: { type: "select_audio",mode: "managed" },now: 6,
  });
  owner.close();

  const changed = new DatabaseSync(path);
  const leaseId = changed.prepare("SELECT id FROM managed_leases").get().id;
  const triggerSql = changed.prepare(`SELECT sql FROM sqlite_master
    WHERE type='trigger' AND name='game_events_update_guard'`).get().sql;
  changed.exec("DROP TRIGGER game_events_update_guard");
  changed.prepare(`UPDATE game_events SET command_ref=NULL
    WHERE event_type='audio_lease_acquired' AND command_ref=?`).run(leaseId);
  changed.prepare("DELETE FROM state_commands WHERE command_id=?").run(leaseId);
  changed.exec(triggerSql);
  changed.close();

  const reopened = developmentOwner(path);
  assert.doesNotThrow(() => reopened.validate());
  assert.deepEqual(reopened.diagnosticManagedStreamAuthority({ now: 7 }),{
    authorityVersion: 1,status: "absent",
  });
  reopened.close();
});

test("diagnostic managed-stream lookup fails closed on ambiguous current authority", () => {
  const owner = developmentOwner(join(root,"diagnostic-ambiguous-stream.sqlite"));
  owner.activate({ now: 1 });
  const streams = [
    { code: "DMA234",host: randomUUID(),runId: randomUUID(),sourceId: randomUUID(),token: "a" },
    { code: "DMB234",host: randomUUID(),runId: randomUUID(),sourceId: randomUUID(),token: "b" },
  ];
  for (const [index,stream] of streams.entries()) {
    const now = 2 + index * 5;
    owner.createLobby({
      commandId: randomUUID(),code: stream.code,hostPrincipalId: stream.host,now,
    });
    owner.createRun({
      commandId: randomUUID(),lobbyCode: stream.code,runId: stream.runId,
      actorPrincipalId: stream.host,now: now + 1,
    });
    owner.registerManagedSource({
      commandId: randomUUID(),sourceId: stream.sourceId,displayName: `Source ${index}`,
      tokenHash: stream.token.repeat(64),now: now + 2,
    });
    owner.acquireManagedLease({
      commandId: randomUUID(),lobbyCode: stream.code,sourceId: stream.sourceId,
      actorPrincipalId: stream.host,leaseDurationMs: 100,now: now + 3,
    });
  }
  assert.throws(() => owner.diagnosticManagedStreamAuthority({ now: 11 }),/inconsistent/i);
  for (const stream of streams) {
    assert.equal(owner.diagnosticManagedStreamAuthority({
      sourceId: stream.sourceId,now: 11,
    }).runId,stream.runId);
  }
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

test("active startup and export reject semantically invalid state", () => {
  const path = join(root,"semantic-export.sqlite");
  const owner = developmentOwner(path);
  owner.activate({ now: 1 });
  const host = randomUUID();
  owner.createLobby({ commandId: randomUUID(),code: "SEM234",hostPrincipalId: host,now: 2 });
  owner.createRun({
    commandId: randomUUID(),runId: randomUUID(),lobbyCode: "SEM234",actorPrincipalId: host,now: 3,
  });
  const writable = new DatabaseSync(path);
  writable.prepare("UPDATE game_runs SET state='{}'").run();
  writable.close();
  assert.throws(() => owner.exportSnapshot({ directory: root }),/invariant validation failed/i);
  owner.close();
  assert.throws(() => developmentOwner(path),/invariant validation failed/i);
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
    sourceId, displayName: "Source", tokenHash: "a".repeat(64), now: 105,
  });
  owner.acquireManagedLease({
    lobbyCode: "AUD234", sourceId, actorPrincipalId: host,
    leaseDurationMs: 1_000, now: 106,
  });
  const command = owner.createManagedCommand({
    sourceId, lobbyCode: "AUD234", runId, runGeneration: 1, kind: "pause",
    requestedByPrincipalId: host, now: 110,
  });
  assert.equal(command.protocolVersion, 4);
  const claimRequest = randomUUID();
  const claimGeneration = randomUUID();
  const claimed = owner.transitionManagedCommand({
    requestId: claimRequest, commandId: command.commandId, action: "claim",
    authenticatedSourceId: sourceId, claimGeneration, now: 120,
  });
  assert.equal(claimed.state, "claimed");
  const claimRecovery = owner.managedSourceWork({ authenticatedSourceId: sourceId,now: 121 });
  assert.deepEqual(claimRecovery.command,{
    id: command.commandId,kind: "pause",trackUri: null,recovery: true,
  });
  assert.deepEqual(claimRecovery.recovery,{
    commandId: command.commandId,state: "claimed",claimGeneration,
    kind: "pause",trackUri: null,
  });
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

test("action replay rechecks current membership and returns current authority", () => {
  const path = join(root,"replay-membership.sqlite");
  const owner = developmentOwner(path);
  const host = randomUUID();
  const guest = randomUUID();
  const runId = randomUUID();
  const admissionAction = randomUUID();
  owner.activate({ now: 1 });
  owner.createLobby({ code: "REP234",hostPrincipalId: host,now: 2 });
  owner.createRun({ lobbyCode: "REP234",runId,actorPrincipalId: host,now: 3 });
  const admitted = owner.admitPlayer({
    lobbyCode: "REP234",actorPrincipalId: guest,actionId: admissionAction,
    expectedRunId: runId,expectedRunGeneration: 1,expectedRevision: 0,
    name: "Guest",now: 4,
  });
  assert.equal(admitted.revision,1);
  const hostMutation = {
    lobbyCode: "REP234",actorPrincipalId: host,actionId: randomUUID(),
    expectedRunId: runId,expectedRunGeneration: 1,expectedRevision: 1,
    command: { type: "configure_rules",rules: { targetScore: 7 } },now: 5,
  };
  const configured = owner.applyGameCommand(hostMutation);
  assert.equal(configured.revision,2);
  const replayed = owner.applyGameCommand({ ...hostMutation,now: 6 });
  assert.equal(replayed.replayed,true);
  assert.equal(replayed.revision,2);
  assert.equal(replayed.state.rules.targetScore,7);
  owner.applyGameCommand({
    lobbyCode: "REP234",actorPrincipalId: host,actionId: randomUUID(),
    expectedRunId: runId,expectedRunGeneration: 1,expectedRevision: 2,
    command: { type: "remove_player",playerId: guest },now: 7,
  });
  assert.throws(() => owner.admitPlayer({
    lobbyCode: "REP234",actorPrincipalId: guest,actionId: admissionAction,
    expectedRunId: runId,expectedRunGeneration: 1,expectedRevision: 0,
    name: "Guest",now: 8,
  }),/membership/i);
  owner.close();
});

test("committed admission replays across a closed admission fence", () => {
  const owner = developmentOwner(join(root,"admission-replay-fence.sqlite"));
  owner.activate({ now: 1 });
  const host = randomUUID();
  const guest = randomUUID();
  owner.createLobby({ commandId: randomUUID(),code: "ARF234",hostPrincipalId: host,now: 2 });
  const run = owner.createRun({
    commandId: randomUUID(),lobbyCode: "ARF234",actorPrincipalId: host,now: 3,
  });
  const request = {
    lobbyCode: "ARF234",actorPrincipalId: guest,actionId: randomUUID(),
    expectedRunId: run.runId,expectedRunGeneration: run.runGeneration,
    expectedRevision: 0,name: "Fence Guest",now: 4,
  };
  const accepted = owner.admitPlayer(request);
  owner.setAdmission({ commandId: randomUUID(),open: false,expectedGeneration: 0,now: 5 });
  const replay = owner.admitPlayer({ ...request,now: 6 });
  assert.equal(replay.replayed,true);
  assert.equal(replay.revision,accepted.revision);
  owner.close();
});

test("later lobbies preserve the first durable rollback floor", () => {
  const rollbackFloorPath = join(root,"multi-lobby.rollback-floor.json");
  const owner = developmentOwner(join(root,"multi-lobby.sqlite"),{ rollbackFloorPath });
  owner.activate({ now: 1 });
  owner.createLobby({
    commandId: randomUUID(),code: "MLA234",hostPrincipalId: randomUUID(),now: 10,
  });
  owner.createLobby({
    commandId: randomUUID(),code: "MLB234",hostPrincipalId: randomUUID(),now: 20,
  });
  assert.equal(owner.authorityStatus().first_admitted_at,10);
  assert.equal(JSON.parse(readFileSync(rollbackFloorPath,"utf8")).firstAdmittedAt,10);
  owner.close();
});

test("managed-source authority records are canonical and bounded", () => {
  const owner = developmentOwner(join(root,"source-registration.sqlite"));
  owner.activate({ now: 1 });
  assert.throws(() => owner.registerManagedSource({
    commandId: randomUUID(),sourceId: "not-a-uuid",displayName: "Source",
    tokenHash: "a".repeat(64),now: 2,
  }),/canonical UUID/i);
  assert.throws(() => owner.registerManagedSource({
    commandId: randomUUID(),sourceId: randomUUID(),displayName: "x".repeat(81),
    tokenHash: "a".repeat(64),now: 3,
  }),/1-80/i);
  assert.throws(() => owner.registerManagedSource({
    commandId: randomUUID(),sourceId: randomUUID(),displayName: "Source",
    tokenHash: "not-a-digest",now: 4,
  }),/SHA-256/i);
  const sourceId = randomUUID();
  owner.registerManagedSource({
    commandId: randomUUID(),sourceId,displayName: "Canonical Source",
    tokenHash: "b".repeat(64),now: 5,
  });
  assert.throws(() => owner.updateManagedSource({
    commandId: randomUUID(),sourceId,action: "rotate",tokenHash: "A".repeat(64),now: 6,
  }),/token hash is invalid/i);
  owner.close();
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
    sourceId, displayName: "Typed source", tokenHash: "a".repeat(64), now: 4,
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
  const history = owner.memberHistory({ runId,principalId: guest });
  assert.equal(history.runId,runId);
  assert.equal(history.lobbyId,"PLY234");
  assert.equal(history.coverage.complete,true);
  assert.ok(history.events.some((entry) => entry.type === "track_requested"));
  assert.throws(() => owner.memberHistory({ runId,principalId: randomUUID() }), /not found/i);
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

test("audio selection and controls share the room receipt and revision transaction", () => {
  const gameServices = createCatalogGameServices([
    { title: "One", artist: "Artist", year: 1960, uri: "spotify:track:one" },
    { title: "Two", artist: "Artist", year: 1980, uri: "spotify:track:two" },
    { title: "Three", artist: "Artist", year: 2000, uri: "spotify:track:three" },
  ], { random: () => 0 });
  const owner = developmentOwner(join(root, "typed-audio-actions.sqlite"), gameServices);
  const host = randomUUID();
  const runId = randomUUID();
  const sourceId = randomUUID();
  owner.activate({ now: 1 });
  owner.createLobby({ commandId: randomUUID(), code: "SND234", hostPrincipalId: host, now: 2 });
  owner.createRun({ commandId: randomUUID(), lobbyCode: "SND234", runId, actorPrincipalId: host, now: 3 });
  owner.registerManagedSource({
    commandId: randomUUID(), sourceId, displayName: "Source", tokenHash: "a".repeat(64), now: 4,
  });
  owner.managedSourceWork({ authenticatedSourceId: sourceId, now: 5 });
  let revision = 0;
  const act = (command, now) => owner.applyGameCommand({
    lobbyCode: "SND234", actorPrincipalId: host, actionId: randomUUID(),
    expectedRunId: runId, expectedRunGeneration: 1, expectedRevision: revision++, command, now,
  });
  assert.equal(act({ type: "select_audio", mode: "managed" }, 6).revision, 1);
  assert.equal(owner.audioView({ lobbyCode: "SND234", now: 7 }).mode, "managed");
  act({ type: "add_host_player", name: "Host" }, 8);
  act({ type: "start_game" }, 9);
  assert.equal(act({ type: "begin_round" }, 10).managedCommands.length, 1);
  assert.equal(act({ type: "control_audio", kind: "pause" }, 11).managedCommands.length, 1);
  assert.equal(act({ type: "release_audio" }, 12).revision, 6);
  assert.equal(owner.audioView({ lobbyCode: "SND234", now: 13 }).mode, "local");
  assert.doesNotThrow(() => owner.validate());
  owner.close();
});

test("in-game source selection reaps an expired lease owned by another lobby", () => {
  const owner = developmentOwner(join(root,"cross-lobby-select-expiry.sqlite"));
  const oldHost = randomUUID();
  const newHost = randomUUID();
  const oldRun = randomUUID();
  const newRun = randomUUID();
  const sourceId = randomUUID();
  owner.activate({ now: 1 });
  owner.createLobby({ code: "OLD345",hostPrincipalId: oldHost,now: 2 });
  owner.createRun({ lobbyCode: "OLD345",runId: oldRun,actorPrincipalId: oldHost,now: 3 });
  owner.createLobby({ code: "NEW456",hostPrincipalId: newHost,now: 4 });
  owner.createRun({ lobbyCode: "NEW456",runId: newRun,actorPrincipalId: newHost,now: 5 });
  owner.registerManagedSource({
    sourceId,displayName: "Shared source",tokenHash: "7".repeat(64),now: 6,
  });
  owner.managedSourceWork({ authenticatedSourceId: sourceId,now: 7 });
  owner.acquireManagedLease({
    lobbyCode: "OLD345",sourceId,actorPrincipalId: oldHost,leaseDurationMs: 5,now: 8,
  });
  const pause = owner.createManagedCommand({
    sourceId,lobbyCode: "OLD345",runId: oldRun,runGeneration: 1,kind: "pause",
    requestedByPrincipalId: oldHost,now: 9,
  });
  const generation = randomUUID();
  for (const [action,now] of [["claim",10],["begin",11]]) owner.transitionManagedCommand({
    commandId: pause.commandId,action,authenticatedSourceId: sourceId,
    claimGeneration: generation,now,
  });
  owner.transitionManagedCommand({
    commandId: pause.commandId,action: "complete",authenticatedSourceId: sourceId,
    claimGeneration: generation,
    outcomeFingerprint: { ok: true,playbackStatus: "paused",errorCategory: null },now: 12,
  });
  const selected = owner.applyGameCommand({
    lobbyCode: "NEW456",actorPrincipalId: newHost,actionId: randomUUID(),
    expectedRunId: newRun,expectedRunGeneration: 1,expectedRevision: 0,
    command: { type: "select_audio",mode: "managed" },now: 14,
  });
  assert.equal(selected.revision,1);
  assert.equal(owner.audioView({ lobbyCode: "NEW456",now: 14 }).handoff.outcome,"owned");
  assert.doesNotThrow(() => owner.validate());
  owner.close();
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
    sourceId, displayName: "Atomic source", tokenHash: "a".repeat(64), now: 6,
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
    sourceId, displayName: "History Source", tokenHash: "a".repeat(64), now: 31,
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
  const handoffWork = owner.managedSourceWork({ authenticatedSourceId: sourceId, now: 44 });
  assert.equal(handoffWork.handoff.state, "stop_required");
  assert.equal(handoffWork.command.kind, "pause");
  const stopGeneration = randomUUID();
  owner.transitionManagedCommand({
    commandId: handoffWork.command.id,action: "claim",authenticatedSourceId: sourceId,
    claimGeneration: stopGeneration,now: 44,
  });
  owner.transitionManagedCommand({
    commandId: handoffWork.command.id,action: "begin",authenticatedSourceId: sourceId,
    claimGeneration: stopGeneration,now: 44,
  });
  owner.transitionManagedCommand({
    commandId: handoffWork.command.id,action: "complete",authenticatedSourceId: sourceId,
    claimGeneration: stopGeneration,
    outcomeFingerprint: { ok: true,playbackStatus: "paused",errorCategory: null },now: 44,
  });
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
  assert.deepEqual(purged.counts, { events: 12, receipts: 1 });
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
    sourceId, displayName: "Lease Source", tokenHash: "a".repeat(64), now: 31,
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

  assert.throws(() => owner.acquireManagedLease({
    lobbyCode: "LSE234", sourceId, actorPrincipalId: host,
    leaseDurationMs: 5, now: 50,
  }),/handoff|quarantined/i);
  assert.equal(owner.transitionManagedCommand({
    commandId: delivered.commandId, action: "complete",
    authenticatedSourceId: sourceId, claimGeneration: claimed.claimGeneration,
    outcomeFingerprint: { ok: true, playbackStatus: "playing", errorCategory: null }, now: 50,
  }).state, "completed");
  const handoffWork = owner.managedSourceWork({ authenticatedSourceId: sourceId, now: 51 });
  assert.equal(handoffWork.command.kind,"pause");
  const stopGeneration = randomUUID();
  owner.transitionManagedCommand({
    commandId: handoffWork.command.id,action: "claim",authenticatedSourceId: sourceId,
    claimGeneration: stopGeneration,now: 51,
  });
  owner.transitionManagedCommand({
    commandId: handoffWork.command.id,action: "begin",authenticatedSourceId: sourceId,
    claimGeneration: stopGeneration,now: 52,
  });
  owner.transitionManagedCommand({
    commandId: handoffWork.command.id,action: "complete",authenticatedSourceId: sourceId,
    claimGeneration: stopGeneration,
    outcomeFingerprint: { ok: true,playbackStatus: "paused",errorCategory: null },now: 53,
  });
  const replacement = owner.acquireManagedLease({
    lobbyCode: "LSE234", sourceId, actorPrincipalId: host,
    leaseDurationMs: 5, now: 54,
  });
  const confirmedPause = owner.createManagedCommand({
    sourceId, lobbyCode: "LSE234", runId, runGeneration: 1, kind: "pause",
    requestedByPrincipalId: host, now: 55,
  });
  const confirmedGeneration = randomUUID();
  for (const [action,now] of [["claim",56],["begin",57]]) owner.transitionManagedCommand({
    commandId: confirmedPause.commandId,action,authenticatedSourceId: sourceId,
    claimGeneration: confirmedGeneration,now,
  });
  owner.transitionManagedCommand({
    commandId: confirmedPause.commandId,action: "complete",authenticatedSourceId: sourceId,
    claimGeneration: confirmedGeneration,
    outcomeFingerprint: { ok: true,playbackStatus: "paused",errorCategory: null },now: 58,
  });
  const expiring = owner.createManagedCommand({
    sourceId, lobbyCode: "LSE234", runId, runGeneration: 1, kind: "pause",
    requestedByPrincipalId: host, now: 58,
  });
  assert.equal(replacement.expiresAt, 59);
  assert.throws(() => owner.transitionManagedCommand({
    commandId: expiring.commandId, action: "claim",
    authenticatedSourceId: sourceId, claimGeneration: randomUUID(), now: 60,
  }), /expired/i);
  const expiryCommand = randomUUID();
  const expired = owner.expireManagedLeases({ commandId: expiryCommand, now: 60 });
  assert.deepEqual(expired.expired, [{
    leaseId: replacement.leaseId,
    transitions: [{ commandId: expiring.commandId, state: "cancelled" }],
    handoff: { state: "clear" },
  }]);
  assert.deepEqual(owner.expireManagedLeases({ commandId: expiryCommand, now: 70 }), {
    ...expired, replayed: true,
  });
  assert.equal(owner.acquireManagedLease({
    lobbyCode: "LSE234", sourceId, actorPrincipalId: host,
    leaseDurationMs: 10, now: 61,
  }).expiresAt, 71);
  owner.close();
});

test("releasing a lease preserves work that was already outcome-unknown", () => {
  const path = join(root,"preexisting-unknown-handoff.sqlite");
  const owner = developmentOwner(path);
  const hostA = randomUUID();
  const hostB = randomUUID();
  const runA = randomUUID();
  const runB = randomUUID();
  const sourceId = randomUUID();
  owner.activate({ now: 1 });
  owner.createLobby({ code: "UNK234",hostPrincipalId: hostA,now: 2 });
  owner.createRun({ lobbyCode: "UNK234",runId: runA,actorPrincipalId: hostA,now: 3 });
  owner.createLobby({ code: "NXT345",hostPrincipalId: hostB,now: 4 });
  owner.createRun({ lobbyCode: "NXT345",runId: runB,actorPrincipalId: hostB,now: 5 });
  owner.registerManagedSource({
    sourceId,displayName: "Unknown Source",tokenHash: "c".repeat(64),now: 6,
  });
  const lease = owner.acquireManagedLease({
    lobbyCode: "UNK234",sourceId,actorPrincipalId: hostA,leaseDurationMs: 100,now: 7,
  });
  const command = owner.createManagedCommand({
    sourceId,lobbyCode: "UNK234",runId: runA,runGeneration: 1,kind: "resume",
    requestedByPrincipalId: hostA,now: 8,
  });
  const generation = randomUUID();
  owner.transitionManagedCommand({
    commandId: command.commandId,action: "claim",authenticatedSourceId: sourceId,
    claimGeneration: generation,now: 9,
  });
  owner.transitionManagedCommand({
    commandId: command.commandId,action: "begin",authenticatedSourceId: sourceId,
    claimGeneration: generation,now: 10,
  });
  owner.transitionManagedCommand({
    commandId: command.commandId,action: "lose_authority",authenticatedSourceId: sourceId,
    claimGeneration: generation,reasonCode: "game_api_unavailable",now: 11,
  });

  const released = owner.releaseManagedLease({
    leaseId: lease.leaseId,actorPrincipalId: hostA,now: 12,
  });
  assert.equal(released.handoff.state,"stop_required");
  assert.deepEqual(released.transitions,[{
    commandId: command.commandId,state: "outcome_unknown",
  }]);
  assert.equal(owner.audioView({ lobbyCode: "NXT345",now: 13 }).handoff.outcome,"quarantined");
  assert.throws(() => owner.acquireManagedLease({
    lobbyCode: "NXT345",sourceId,actorPrincipalId: hostB,leaseDurationMs: 100,now: 13,
  }),/handoff|quarantined/i);
  const uncertain = owner.managedSourceWork({ authenticatedSourceId: sourceId,now: 13 });
  assert.equal(uncertain.command,null);
  assert.deepEqual(uncertain.recovery,{
    commandId: command.commandId,state: "outcome_unknown",claimGeneration: generation,
    kind: "resume",trackUri: null,action: "reconcile_provider",
  });
  owner.transitionManagedCommand({
    commandId: command.commandId,action: "complete",authenticatedSourceId: sourceId,
    claimGeneration: generation,
    outcomeFingerprint: { ok: true,playbackStatus: "playing",errorCategory: null },now: 14,
  });
  const stop = owner.managedSourceWork({ authenticatedSourceId: sourceId,now: 15 });
  assert.equal(stop.command.kind,"pause");
  assert.equal(stop.command.handoff,true);
  owner.close();
});

test("acquisition atomically reaps an expired safe lease", () => {
  const path = join(root,"lazy-expiry.sqlite");
  const owner = developmentOwner(path);
  const host = randomUUID();
  const runId = randomUUID();
  const sourceId = randomUUID();
  owner.activate({ now: 1 });
  owner.createLobby({ code: "EXP234",hostPrincipalId: host,now: 2 });
  owner.createRun({ lobbyCode: "EXP234",runId,actorPrincipalId: host,now: 3 });
  owner.registerManagedSource({
    sourceId,displayName: "Expiry Source",tokenHash: "d".repeat(64),now: 4,
  });
  owner.acquireManagedLease({
    lobbyCode: "EXP234",sourceId,actorPrincipalId: host,leaseDurationMs: 5,now: 5,
  });
  const pause = owner.createManagedCommand({
    sourceId,lobbyCode: "EXP234",runId,runGeneration: 1,kind: "pause",
    requestedByPrincipalId: host,now: 6,
  });
  const generation = randomUUID();
  for (const [action,now] of [["claim",7],["begin",8]]) owner.transitionManagedCommand({
    commandId: pause.commandId,action,authenticatedSourceId: sourceId,
    claimGeneration: generation,now,
  });
  owner.transitionManagedCommand({
    commandId: pause.commandId,action: "complete",authenticatedSourceId: sourceId,
    claimGeneration: generation,
    outcomeFingerprint: { ok: true,playbackStatus: "paused",errorCategory: null },now: 9,
  });

  const reacquired = owner.acquireManagedLease({
    lobbyCode: "EXP234",sourceId,actorPrincipalId: host,leaseDurationMs: 10,now: 11,
  });
  assert.equal(reacquired.expiresAt,21);
  assert.equal(owner.audioView({ lobbyCode: "EXP234",now: 12 }).handoff.outcome,"owned");
  assert.doesNotThrow(() => owner.validate(),
    "lazy expiry must commit evidence accepted by the canonical validator");
  owner.close();
  const reopened = developmentOwner(path);
  assert.equal(reopened.audioView({ lobbyCode: "EXP234",now: 12 }).handoff.outcome,"owned");
  reopened.close();
});

test("acquisition persists recovery work when an expired lease may still be playing", () => {
  const path = join(root,"lazy-playing-expiry.sqlite");
  const owner = developmentOwner(path);
  const hostA = randomUUID();
  const hostB = randomUUID();
  const runA = randomUUID();
  const runB = randomUUID();
  const sourceId = randomUUID();
  owner.activate({ now: 1 });
  owner.createLobby({ code: "OLD234",hostPrincipalId: hostA,now: 2 });
  owner.createRun({ lobbyCode: "OLD234",runId: runA,actorPrincipalId: hostA,now: 3 });
  owner.createLobby({ code: "NEW345",hostPrincipalId: hostB,now: 4 });
  owner.createRun({ lobbyCode: "NEW345",runId: runB,actorPrincipalId: hostB,now: 5 });
  owner.registerManagedSource({
    sourceId,displayName: "Playing Expiry Source",tokenHash: "f".repeat(64),now: 6,
  });
  const lease = owner.acquireManagedLease({
    lobbyCode: "OLD234",sourceId,actorPrincipalId: hostA,leaseDurationMs: 5,now: 7,
  });
  const resume = owner.createManagedCommand({
    sourceId,lobbyCode: "OLD234",runId: runA,runGeneration: 1,kind: "resume",
    requestedByPrincipalId: hostA,now: 8,
  });
  const generation = randomUUID();
  for (const [action,now] of [["claim",9],["begin",10]]) owner.transitionManagedCommand({
    commandId: resume.commandId,action,authenticatedSourceId: sourceId,
    claimGeneration: generation,now,
  });
  owner.transitionManagedCommand({
    commandId: resume.commandId,action: "complete",authenticatedSourceId: sourceId,
    claimGeneration: generation,
    outcomeFingerprint: { ok: true,playbackStatus: "playing",errorCategory: null },now: 11,
  });

  const result = owner.acquireManagedLease({
    commandId: randomUUID(),lobbyCode: "NEW345",sourceId,actorPrincipalId: hostB,
    leaseDurationMs: 100,now: 13,
  });
  assert.equal(result.status,"recovery_required");
  assert.equal(result.expiredLeaseId,lease.leaseId);
  assert.equal(result.handoff.state,"stop_required");
  const work = owner.managedSourceWork({ authenticatedSourceId: sourceId,now: 13 });
  assert.equal(work.command.kind,"pause");
  assert.equal(work.command.handoff,true);
  assert.equal(owner.audioView({ lobbyCode: "NEW345",now: 13 }).handoff.outcome,"quarantined");
  assert.doesNotThrow(() => owner.validate());
  owner.close();
});

test("an error never substitutes for positive paused evidence before source reuse", () => {
  for (const boundary of ["release","expiry","terminal"]) {
    const owner = developmentOwner(join(root,`error-handoff-${boundary}.sqlite`));
    const hostA = randomUUID();
    const hostB = randomUUID();
    const runA = randomUUID();
    const runB = randomUUID();
    const sourceId = randomUUID();
    owner.activate({ now: 1 });
    owner.createLobby({ code: "ERR234",hostPrincipalId: hostA,now: 2 });
    owner.createRun({ lobbyCode: "ERR234",runId: runA,actorPrincipalId: hostA,now: 3 });
    owner.createLobby({ code: "NEW456",hostPrincipalId: hostB,now: 4 });
    owner.createRun({ lobbyCode: "NEW456",runId: runB,actorPrincipalId: hostB,now: 5 });
    owner.registerManagedSource({
      sourceId,displayName: `Error ${boundary}`,tokenHash: "9".repeat(64),now: 6,
    });
    const lease = owner.acquireManagedLease({
      lobbyCode: "ERR234",sourceId,actorPrincipalId: hostA,
      leaseDurationMs: boundary === "expiry" ? 10 : 100,now: 7,
    });
    const playing = owner.createManagedCommand({
      sourceId,lobbyCode: "ERR234",runId: runA,runGeneration: 1,kind: "resume",
      requestedByPrincipalId: hostA,now: 8,
    });
    const playingGeneration = randomUUID();
    for (const [action,now] of [["claim",9],["begin",10]]) owner.transitionManagedCommand({
      commandId: playing.commandId,action,authenticatedSourceId: sourceId,
      claimGeneration: playingGeneration,now,
    });
    owner.transitionManagedCommand({
      commandId: playing.commandId,action: "complete",authenticatedSourceId: sourceId,
      claimGeneration: playingGeneration,
      outcomeFingerprint: { ok: true,playbackStatus: "playing",errorCategory: null },now: 11,
    });
    const failedPause = owner.createManagedCommand({
      sourceId,lobbyCode: "ERR234",runId: runA,runGeneration: 1,kind: "pause",
      requestedByPrincipalId: hostA,now: 12,
    });
    const failedGeneration = randomUUID();
    for (const [action,now] of [["claim",13],["begin",14]]) owner.transitionManagedCommand({
      commandId: failedPause.commandId,action,authenticatedSourceId: sourceId,
      claimGeneration: failedGeneration,now,
    });
    owner.transitionManagedCommand({
      commandId: failedPause.commandId,action: "fail",authenticatedSourceId: sourceId,
      claimGeneration: failedGeneration,
      outcomeFingerprint: {
        ok: false,playbackStatus: "error",errorCategory: "spotify_unavailable",
      },reasonCode: "spotify_unavailable",now: 15,
    });

    if (boundary === "release") {
      const released = owner.releaseManagedLease({
        leaseId: lease.leaseId,actorPrincipalId: hostA,now: 16,
      });
      assert.equal(released.handoff.state,"stop_required");
    } else if (boundary === "expiry") {
      const recovered = owner.acquireManagedLease({
        commandId: randomUUID(),lobbyCode: "NEW456",sourceId,
        actorPrincipalId: hostB,leaseDurationMs: 100,now: 18,
      });
      assert.equal(recovered.status,"recovery_required");
      assert.equal(recovered.handoff.state,"stop_required");
    } else {
      owner.applyGameCommand({
        lobbyCode: "ERR234",actorPrincipalId: hostA,actionId: randomUUID(),
        expectedRunId: runA,expectedRunGeneration: 1,expectedRevision: 0,
        command: { type: "abandon_game" },now: 16,
      });
    }
    assert.equal(owner.audioView({ lobbyCode: "NEW456",now: 19 }).handoff.outcome,"quarantined");
    assert.throws(() => owner.acquireManagedLease({
      lobbyCode: "NEW456",sourceId,actorPrincipalId: hostB,
      leaseDurationMs: 100,now: 19,
    }),/handoff|quarantined/i);
    const stop = owner.managedSourceWork({ authenticatedSourceId: sourceId,now: 19 });
    assert.equal(stop.command.kind,"pause");
    assert.equal(stop.command.handoff,true);
    assert.doesNotThrow(() => owner.validate());
    owner.close();
  }
});

test("a playing source must acknowledge the handoff stop before another lobby can acquire it", () => {
  const path = join(root,"source-handoff.sqlite");
  const owner = developmentOwner(path);
  const hostA = randomUUID();
  const hostB = randomUUID();
  const runA = randomUUID();
  const runB = randomUUID();
  const sourceId = randomUUID();
  owner.activate({ now: 10 });
  owner.createLobby({ code: "HND234",hostPrincipalId: hostA,now: 20 });
  owner.createRun({ lobbyCode: "HND234",runId: runA,actorPrincipalId: hostA,now: 21 });
  owner.createLobby({ code: "NXT234",hostPrincipalId: hostB,now: 22 });
  owner.createRun({ lobbyCode: "NXT234",runId: runB,actorPrincipalId: hostB,now: 23 });
  owner.registerManagedSource({
    sourceId,displayName: "Handoff Source",tokenHash: "b".repeat(64),now: 24,
  });
  const lease = owner.acquireManagedLease({
    lobbyCode: "HND234",sourceId,actorPrincipalId: hostA,leaseDurationMs: 100,now: 25,
  });
  const resume = owner.createManagedCommand({
    sourceId,lobbyCode: "HND234",runId: runA,runGeneration: 1,kind: "resume",
    requestedByPrincipalId: hostA,now: 26,
  });
  const generation = randomUUID();
  owner.transitionManagedCommand({
    commandId: resume.commandId,action: "claim",authenticatedSourceId: sourceId,
    claimGeneration: generation,now: 27,
  });
  owner.transitionManagedCommand({
    commandId: resume.commandId,action: "begin",authenticatedSourceId: sourceId,
    claimGeneration: generation,now: 28,
  });
  owner.transitionManagedCommand({
    commandId: resume.commandId,action: "complete",authenticatedSourceId: sourceId,
    claimGeneration: generation,
    outcomeFingerprint: { ok: true,playbackStatus: "playing",errorCategory: null },now: 29,
  });

  assert.throws(() => owner.updateManagedSource({
    sourceId,action: "disable",now: 30,
  }), /confirm safe playback/i);
  assert.equal(owner.audioView({ lobbyCode: "HND234",now: 30 }).leaseId,lease.leaseId);

  const released = owner.releaseManagedLease({
    leaseId: lease.leaseId,actorPrincipalId: hostA,now: 31,
  });
  assert.equal(released.handoff.state,"stop_required");
  assert.equal(owner.audioView({ lobbyCode: "HND234",now: 31 }).handoff.outcome,"recovering");
  assert.equal(owner.audioView({ lobbyCode: "NXT234",now: 31 }).handoff.outcome,"quarantined");
  assert.throws(() => owner.acquireManagedLease({
    lobbyCode: "NXT234",sourceId,actorPrincipalId: hostB,leaseDurationMs: 100,now: 31,
  }),/handoff|quarantined/i);
  assert.throws(() => owner.applyGameCommand({
    lobbyCode: "NXT234",actorPrincipalId: hostB,actionId: randomUUID(),
    expectedRunId: runB,expectedRunGeneration: 1,expectedRevision: 0,
    command: { type: "select_audio",mode: "managed" },now: 31,
  }),/handoff|quarantined/i,
  "the gameplay selection path must expose the same recovery boundary as direct acquisition");

  owner.applyGameCommand({
    lobbyCode: "HND234",actorPrincipalId: hostA,actionId: randomUUID(),
    expectedRunId: runA,expectedRunGeneration: 1,expectedRevision: 0,
    command: { type: "abandon_game" },now: 32,
  });
  assert.doesNotThrow(() => owner.validate(),
    "terminal reconciliation must preserve an already-open handoff stop");

  const work = owner.managedSourceWork({ authenticatedSourceId: sourceId,now: 32 });
  assert.equal(work.lease,null);
  assert.equal(work.command.kind,"pause");
  assert.equal(work.command.handoff,true);
  const stopGeneration = randomUUID();
  owner.transitionManagedCommand({
    commandId: work.command.id,action: "claim",authenticatedSourceId: sourceId,
    claimGeneration: stopGeneration,now: 33,
  });
  const retryableClaim = owner.managedSourceWork({ authenticatedSourceId: sourceId,now: 33 });
  assert.equal(retryableClaim.command.id,work.command.id);
  assert.equal(retryableClaim.command.recovery,true);
  assert.equal(retryableClaim.recovery.action,"retry_claim");
  owner.transitionManagedCommand({
    commandId: work.command.id,action: "begin",authenticatedSourceId: sourceId,
    claimGeneration: stopGeneration,now: 34,
  });
  owner.transitionManagedCommand({
    commandId: work.command.id,action: "complete",authenticatedSourceId: sourceId,
    claimGeneration: stopGeneration,
    outcomeFingerprint: { ok: true,playbackStatus: "paused",errorCategory: null },now: 35,
  });
  assert.equal(owner.audioView({ lobbyCode: "NXT234",now: 36 }).handoff.outcome,"available");
  assert.equal(owner.acquireManagedLease({
    lobbyCode: "NXT234",sourceId,actorPrincipalId: hostB,leaseDurationMs: 100,now: 36,
  }).lobbyCode,"NXT234");
  owner.close();
});

test("a reviewed paused attestation recovers a failed handoff stop", () => {
  const path = join(root,"reviewed-handoff-recovery.sqlite");
  const owner = developmentOwner(path);
  const hostA = randomUUID();
  const hostB = randomUUID();
  const runA = randomUUID();
  const runB = randomUUID();
  const sourceId = randomUUID();
  owner.activate({ now: 1 });
  owner.createLobby({ code: "RCV234",hostPrincipalId: hostA,now: 2 });
  owner.createRun({ lobbyCode: "RCV234",runId: runA,actorPrincipalId: hostA,now: 3 });
  owner.createLobby({ code: "NEW234",hostPrincipalId: hostB,now: 4 });
  owner.createRun({ lobbyCode: "NEW234",runId: runB,actorPrincipalId: hostB,now: 5 });
  owner.registerManagedSource({
    sourceId,displayName: "Recovery Source",tokenHash: "e".repeat(64),now: 6,
  });
  const lease = owner.acquireManagedLease({
    lobbyCode: "RCV234",sourceId,actorPrincipalId: hostA,leaseDurationMs: 100,now: 7,
  });
  const playing = owner.createManagedCommand({
    sourceId,lobbyCode: "RCV234",runId: runA,runGeneration: 1,kind: "resume",
    requestedByPrincipalId: hostA,now: 8,
  });
  const playingGeneration = randomUUID();
  for (const [action,now] of [["claim",9],["begin",10]]) owner.transitionManagedCommand({
    commandId: playing.commandId,action,authenticatedSourceId: sourceId,
    claimGeneration: playingGeneration,now,
  });
  owner.transitionManagedCommand({
    commandId: playing.commandId,action: "complete",authenticatedSourceId: sourceId,
    claimGeneration: playingGeneration,
    outcomeFingerprint: { ok: true,playbackStatus: "playing",errorCategory: null },now: 11,
  });
  const released = owner.releaseManagedLease({
    leaseId: lease.leaseId,actorPrincipalId: hostA,now: 12,
  });
  const work = owner.managedSourceWork({ authenticatedSourceId: sourceId,now: 13 });
  const stopGeneration = randomUUID();
  for (const [action,now] of [["claim",13],["begin",14]]) owner.transitionManagedCommand({
    commandId: work.command.id,action,authenticatedSourceId: sourceId,
    claimGeneration: stopGeneration,now,
  });
  owner.transitionManagedCommand({
    commandId: work.command.id,action: "fail",authenticatedSourceId: sourceId,
    claimGeneration: stopGeneration,
    outcomeFingerprint: { ok: false,playbackStatus: "error",errorCategory: "spotify_unavailable" },
    reasonCode: "spotify_unavailable",now: 15,
  });
  assert.equal(owner.audioView({ lobbyCode: "NEW234",now: 16 }).handoff.outcome,"quarantined");
  assert.throws(() => owner.acquireManagedLease({
    lobbyCode: "NEW234",sourceId,actorPrincipalId: hostB,leaseDurationMs: 100,now: 16,
  }),/handoff|quarantined/i);
  assert.deepEqual(owner.operatorReport({ now: 16 }).sourceHandoffs,[{
    handoffId: released.handoff.id,sourceId,priorLobbyCode: "RCV234",
    stopCommandId: work.command.id,state: "quarantined",updatedAt: 15,
    commandState: "failed",playbackStatus: "error",
  }]);

  const recoveryCommand = randomUUID();
  const recovered = owner.resolveManagedSourceHandoff({
    commandId: recoveryCommand,handoffId: released.handoff.id,
    resolution: "confirmed_paused",now: 17,
  });
  assert.deepEqual(recovered,{
    handoffId: released.handoff.id,state: "safe",resolution: "confirmed_paused",replayed: false,
  });
  assert.deepEqual(owner.resolveManagedSourceHandoff({
    commandId: recoveryCommand,handoffId: released.handoff.id,
    resolution: "confirmed_paused",now: 18,
  }),{ ...recovered,replayed: true });
  assert.equal(owner.acquireManagedLease({
    lobbyCode: "NEW234",sourceId,actorPrincipalId: hostB,leaseDurationMs: 100,now: 19,
  }).lobbyCode,"NEW234");
  owner.close();
});

test("a reviewed pause atomically resolves an unknown handoff command", () => {
  const path = join(root,"reviewed-unknown-handoff.sqlite");
  const owner = developmentOwner(path);
  const host = randomUUID();
  const runId = randomUUID();
  const sourceId = randomUUID();
  owner.activate({ now: 1 });
  owner.createLobby({ code: "ATT234",hostPrincipalId: host,now: 2 });
  owner.createRun({ lobbyCode: "ATT234",runId,actorPrincipalId: host,now: 3 });
  owner.registerManagedSource({
    sourceId,displayName: "Attested Source",tokenHash: "1".repeat(64),now: 4,
  });
  const lease = owner.acquireManagedLease({
    lobbyCode: "ATT234",sourceId,actorPrincipalId: host,leaseDurationMs: 100,now: 5,
  });
  const resume = owner.createManagedCommand({
    sourceId,lobbyCode: "ATT234",runId,runGeneration: 1,kind: "resume",
    requestedByPrincipalId: host,now: 6,
  });
  const resumeGeneration = randomUUID();
  for (const [action,now] of [["claim",7],["begin",8]]) owner.transitionManagedCommand({
    commandId: resume.commandId,action,authenticatedSourceId: sourceId,
    claimGeneration: resumeGeneration,now,
  });
  owner.transitionManagedCommand({
    commandId: resume.commandId,action: "complete",authenticatedSourceId: sourceId,
    claimGeneration: resumeGeneration,
    outcomeFingerprint: { ok: true,playbackStatus: "playing",errorCategory: null },now: 9,
  });
  const released = owner.releaseManagedLease({
    leaseId: lease.leaseId,actorPrincipalId: host,now: 10,
  });
  const work = owner.managedSourceWork({ authenticatedSourceId: sourceId,now: 11 });
  const stopGeneration = randomUUID();
  for (const [action,now] of [["claim",11],["begin",12]]) owner.transitionManagedCommand({
    commandId: work.command.id,action,authenticatedSourceId: sourceId,
    claimGeneration: stopGeneration,now,
  });
  owner.transitionManagedCommand({
    commandId: work.command.id,action: "lose_authority",authenticatedSourceId: sourceId,
    claimGeneration: stopGeneration,reasonCode: "game_api_unavailable",now: 13,
  });

  owner.resolveManagedSourceHandoff({
    commandId: randomUUID(),handoffId: released.handoff.id,
    resolution: "confirmed_paused",now: 14,
  });
  const read = openStateStoreReadOnly(path);
  assert.deepEqual({ ...read.prepare(`SELECT command_state,playback_status
    FROM managed_command_current WHERE id=?`).get(work.command.id) },{
    command_state: "completed",playback_status: "paused",
  });
  assert.deepEqual({ ...read.prepare(`SELECT actor_type,actor_ref FROM game_events
    WHERE command_ref=? AND event_type='audio_command_completed'`).get(work.command.id) },{
    actor_type: "system",actor_ref: null,
  });
  read.close();
  assert.doesNotThrow(() => owner.validate());
  owner.close();
});
