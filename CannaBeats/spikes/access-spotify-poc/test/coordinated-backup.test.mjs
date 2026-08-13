import assert from "node:assert/strict";
import { createHash,randomUUID } from "node:crypto";
import { existsSync,mkdirSync,mkdtempSync,readFileSync,readlinkSync,rmSync,writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after,test } from "node:test";
import { StateOwner } from "../../../state-service/src/owner.mjs";
import { createStateServer } from "../../../state-service/src/server.mjs";
import { openDatabase } from "../db.mjs";
import {
  createCoordinatedBackup,restoreCoordinatedBackup,verifyCoordinatedBackup,
} from "../operations/coordinated-backup.mjs";

const root = mkdtempSync(join(tmpdir(),"cannabeats-coordinated-test-"));
after(() => rmSync(root,{ recursive: true,force: true }));

test("coordinated backup binds encrypted Access and State snapshots to one release epoch", async () => {
  const accessPath = join(root,"access.sqlite");
  const statePath = join(root,"state.sqlite");
  const backupDirectory = join(root,"backups");
  const scratchDirectory = join(root,"scratch");
  const passphraseFile = join(root,"passphrase");
  writeFileSync(passphraseFile,"coordinated recovery passphrase with enough bytes\n",{ mode: 0o600 });
  const access = openDatabase(accessPath);
  const userId = randomUUID();
  access.prepare("INSERT INTO users (id,display_name,role,created_at) VALUES (?,?,'host',?)")
    .run(userId,"Backup Host",1);
  access.close();
  const owner = new StateOwner(statePath,{ allowDevelopmentActivation: true });
  owner.activate({ commandId: randomUUID(),releaseEpoch: "development",now: 1 });
  owner.createLobby({ commandId: randomUUID(),code: "BKP234",hostPrincipalId: userId,now: 2 });
  owner.close();
  const credentials = {
    activationToken: "coordinated-activation",operatorToken: "coordinated-operator",
    accessToken: "coordinated-access",gameToken: "coordinated-game",
    accessPrincipalAssertionKey: "coordinated-access-assertion",
    gamePrincipalAssertionKey: "coordinated-game-assertion",
  };
  const server = createStateServer({ databasePath: statePath,credentials });
  await new Promise((resolve) => server.listen(0,"127.0.0.1",resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const created = await createCoordinatedBackup({
      accessDatabasePath: accessPath,stateOrigin: origin,
      stateOperatorToken: credentials.operatorToken,outputDirectory: backupDirectory,
      passphraseFile,releaseEpoch: "development",applicationVersion: "app-test",
      catalogVersion: "catalog-test",now: new Date("2026-08-12T20:00:00Z"),scratchDirectory,
    });
    assert.equal(created.manifest.releaseEpoch,"development");
    assert.match(created.manifest.recoverySetId,/^[0-9a-f-]{36}$/i);
    const verified = verifyCoordinatedBackup({
      manifestPath: created.manifestPath,passphraseFile,scratchDirectory,
    });
    assert.equal(verified.verified.access.databaseRole,"access");
    assert.equal(verified.verified.state.databaseRole,"state");
    assert.equal(created.manifest.state.firstAdmittedAt,2);
    const recoveryDirectory = join(root,"recovery");
    const restored = restoreCoordinatedBackup({
      manifestPath: created.manifestPath,outputDirectory: recoveryDirectory,
      passphraseFile,scratchDirectory,
    });
    assert.equal(readlinkSync(restored.selectorPath),`recovery-${created.manifest.recoverySetId}`);
    assert.equal(JSON.parse(readFileSync(restored.rollbackFloorPath,"utf8")).firstAdmittedAt,2);
    const accessCopy = new DatabaseSync(restored.accessOutputPath,{ readOnly: true });
    assert.equal(accessCopy.prepare("SELECT display_name FROM users WHERE id=?").get(userId).display_name,
      "Backup Host");
    accessCopy.close();
    const stateCopy = new DatabaseSync(restored.stateOutputPath,{ readOnly: true });
    assert.equal(stateCopy.prepare("SELECT status FROM state_authority").get().status,"active");
    assert.equal(JSON.parse(stateCopy.prepare(`SELECT result FROM state_commands
      WHERE command_type='set_admission' ORDER BY accepted_at DESC,command_id DESC LIMIT 1`)
      .get().result).open,false);
    assert.equal(stateCopy.prepare("SELECT host_principal_id FROM lobbies WHERE code='BKP234'")
      .get().host_principal_id,userId);
    stateCopy.close();
    const interruptedDirectory = join(root,"interrupted-recovery");
    assert.throws(() => restoreCoordinatedBackup({
      manifestPath: created.manifestPath,outputDirectory: interruptedDirectory,
      passphraseFile,scratchDirectory,beforePublish() { throw new Error("interrupted before selector"); },
    }),/interrupted before selector/);
    assert.equal(existsSync(join(interruptedDirectory,"current")),false);
    const liveReadiness = await (await fetch(`${origin}/ready`)).json();
    assert.equal(liveReadiness.authority.admission.open,true);
    const second = await createCoordinatedBackup({
      accessDatabasePath: accessPath,stateOrigin: origin,
      stateOperatorToken: credentials.operatorToken,outputDirectory: backupDirectory,
      passphraseFile,releaseEpoch: "development",applicationVersion: "app-test",
      catalogVersion: "catalog-test",now: new Date("2026-08-12T20:00:01Z"),scratchDirectory,
    });
    const forgedManifestPath = join(backupDirectory,"forged-coordinated.cbmanifest");
    const forged = structuredClone(created.manifest);
    const secondState = join(backupDirectory,second.manifest.artifacts.state.file);
    forged.artifacts.state = {
      ...second.manifest.artifacts.state,
      sha256: createHash("sha256").update(readFileSync(secondState)).digest("hex"),
    };
    writeFileSync(forgedManifestPath,`${JSON.stringify(forged)}\n`);
    assert.throws(() => verifyCoordinatedBackup({
      manifestPath: forgedManifestPath,passphraseFile,scratchDirectory,
    }),/recovery-set|authority does not match/i);
    const stateArtifact = join(backupDirectory,created.manifest.artifacts.state.file);
    const bytes = readFileSync(stateArtifact);
    bytes[bytes.length - 1] ^= 1;
    writeFileSync(stateArtifact,bytes);
    assert.throws(() => verifyCoordinatedBackup({
      manifestPath: created.manifestPath,passphraseFile,scratchDirectory,
    }),/digest does not match/i);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("restoring an older database set recovers the later authenticated rollback floor", async () => {
  const caseRoot = join(root,"older-set-floor");
  const accessPath = join(caseRoot,"access.sqlite");
  const statePath = join(caseRoot,"state.sqlite");
  const backupDirectory = join(caseRoot,"backups");
  const scratchDirectory = join(caseRoot,"scratch");
  const passphraseFile = join(caseRoot,"passphrase");
  mkdirSync(caseRoot,{ recursive: true });
  writeFileSync(passphraseFile,"older recovery set passphrase with enough bytes\n",{ mode: 0o600 });
  openDatabase(accessPath).close();
  let owner = new StateOwner(statePath,{ allowDevelopmentActivation: true });
  owner.activate({ commandId: randomUUID(),releaseEpoch: "development",now: 1 });
  owner.close();
  const credentials = {
    activationToken: "older-activation",operatorToken: "older-operator",
    accessToken: "older-access",gameToken: "older-game",
    accessPrincipalAssertionKey: "older-access-assertion",
    gamePrincipalAssertionKey: "older-game-assertion",
  };
  const serve = async () => {
    const server = createStateServer({ databasePath: statePath,credentials });
    await new Promise((resolve) => server.listen(0,"127.0.0.1",resolve));
    return server;
  };
  let server = await serve();
  const preAdmission = await createCoordinatedBackup({
    accessDatabasePath: accessPath,stateOrigin: `http://127.0.0.1:${server.address().port}`,
    stateOperatorToken: credentials.operatorToken,outputDirectory: backupDirectory,
    passphraseFile,releaseEpoch: "development",now: new Date("2026-08-12T21:00:00Z"),
    scratchDirectory,
  });
  await new Promise((resolve) => server.close(resolve));
  owner = new StateOwner(statePath,{ allowDevelopmentActivation: true });
  owner.createLobby({ commandId: randomUUID(),code: "FLR234",hostPrincipalId: randomUUID(),now: 10 });
  owner.close();
  server = await serve();
  await createCoordinatedBackup({
    accessDatabasePath: accessPath,stateOrigin: `http://127.0.0.1:${server.address().port}`,
    stateOperatorToken: credentials.operatorToken,outputDirectory: backupDirectory,
    passphraseFile,releaseEpoch: "development",now: new Date("2026-08-12T21:00:01Z"),
    scratchDirectory,
  });
  await new Promise((resolve) => server.close(resolve));
  const restored = restoreCoordinatedBackup({
    manifestPath: preAdmission.manifestPath,outputDirectory: join(caseRoot,"restore"),
    passphraseFile,scratchDirectory,
  });
  assert.equal(restored.recoveredFirstAdmittedAt,10);
  assert.equal(JSON.parse(readFileSync(restored.rollbackFloorPath,"utf8")).firstAdmittedAt,10);
  const restoredState = new DatabaseSync(restored.stateOutputPath,{ readOnly: true });
  assert.equal(restoredState.prepare("SELECT COUNT(*) AS count FROM lobbies").get().count,0);
  restoredState.close();
});
