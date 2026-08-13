#!/usr/bin/env node
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  closeSync,existsSync,fsyncSync,linkSync,mkdirSync,mkdtempSync,openSync,
  readFileSync,readdirSync,readSync,renameSync,rmSync,statSync,symlinkSync,unlinkSync,writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename,dirname,join,resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createBackup,restoreBackup,verifyBackup } from "./backup.mjs";

const FORMAT = "cannabeats-coordinated-backup";
const FORMAT_VERSION = 1;
const MANIFEST_NAME = /^cannabeats-\d{4}-\d{2}-\d{2}T\d{6}Z-coordinated\.cbmanifest$/;
const ARTIFACT_NAME = /^cannabeats-\d{4}-\d{2}-\d{2}T\d{6}Z-(access|state)\.cbbackup$/;

function timestampStem(now) {
  return `cannabeats-${now.toISOString().replace(/:/g, "").replace(/\.\d{3}Z$/, "Z")}`;
}

function hashFile(path) {
  const hash = createHash("sha256");
  const file = openSync(path,"r");
  const chunk = Buffer.alloc(1024 * 1024);
  try {
    for (;;) {
      const count = readSync(file,chunk,0,chunk.length,null);
      if (!count) break;
      hash.update(chunk.subarray(0,count));
    }
    return hash.digest("hex");
  } finally {
    closeSync(file);
  }
}

function syncDirectory(path) {
  const file = openSync(path,"r");
  try { fsyncSync(file); } finally { closeSync(file); }
}

function publishJson(path,payload) {
  const directory = dirname(path);
  const prepared = join(directory,`.${basename(path)}.${randomBytes(12).toString("hex")}.partial`);
  let linked = false;
  try {
    writeFileSync(prepared,`${JSON.stringify(payload,null,2)}\n`,{ mode: 0o600,flag: "wx" });
    const file = openSync(prepared,"r");
    try { fsyncSync(file); } finally { closeSync(file); }
    linkSync(prepared,path);
    linked = true;
    syncDirectory(directory);
    unlinkSync(prepared);
    syncDirectory(directory);
  } catch (error) {
    if (linked) {
      rmSync(path,{ force: true });
      syncDirectory(directory);
    }
    throw error;
  } finally {
    rmSync(prepared,{ force: true });
  }
}

function validDigest(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function readManifest(manifestPath) {
  const manifest = JSON.parse(readFileSync(manifestPath,"utf8"));
  if (manifest?.format !== FORMAT || manifest.formatVersion !== FORMAT_VERSION
      || typeof manifest.createdAt !== "string"
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
        .test(manifest.recoverySetId ?? "")
      || typeof manifest.releaseEpoch !== "string"
      || !/^[A-Za-z0-9._:-]{1,160}$/.test(manifest.releaseEpoch)
      || manifest.state?.schemaGeneration !== 3 || manifest.state?.protocolVersion !== 4
      || !Number.isSafeInteger(manifest.state?.admissionGeneration)
      || manifest.state.admissionGeneration < 1
      || (manifest.state?.firstAdmittedAt !== null
        && (!Number.isSafeInteger(manifest.state?.firstAdmittedAt)
          || manifest.state.firstAdmittedAt <= 0))
      || !validDigest(manifest.state?.snapshotSha256)) {
    throw new Error("Coordinated backup manifest is invalid.");
  }
  for (const role of ["access","state"]) {
    const artifact = manifest.artifacts?.[role];
    if (!artifact || !ARTIFACT_NAME.test(artifact.file) || !artifact.file.endsWith(`-${role}.cbbackup`)
        || !validDigest(artifact.sha256)) {
      throw new Error(`Coordinated ${role} backup manifest is invalid.`);
    }
  }
  return manifest;
}

export async function createCoordinatedBackup({
  accessDatabasePath,stateOrigin,stateOperatorToken,outputDirectory,passphraseFile,
  releaseEpoch,applicationVersion = "unknown",catalogVersion = "unknown",
  now = new Date(),scratchDirectory = tmpdir(),fetchImpl = fetch,
}) {
  if (!/^[A-Za-z0-9._:-]{1,160}$/.test(releaseEpoch ?? "")) {
    throw new Error("A bounded release epoch is required for coordinated backup.");
  }
  const directory = resolve(outputDirectory);
  mkdirSync(directory,{ recursive: true,mode: 0o700 });
  mkdirSync(scratchDirectory,{ recursive: true,mode: 0o700 });
  const work = mkdtempSync(join(resolve(scratchDirectory),"cannabeats-coordinated-"));
  const stem = timestampStem(now);
  const accessPath = join(directory,`${stem}-access.cbbackup`);
  const statePath = join(directory,`${stem}-state.cbbackup`);
  const manifestPath = join(directory,`${stem}-coordinated.cbmanifest`);
  const stateSnapshotPath = join(work,"state.sqlite");
  const recoverySetId = randomUUID();
  const created = [];
  let reopenAdmission = null;
  try {
    for (const path of [accessPath,statePath,manifestPath]) {
      if (existsSync(path)) throw new Error(`Refusing to overwrite coordinated backup material: ${path}`);
    }
    const stateBase = new URL(stateOrigin).origin;
    const readyResponse = await fetchImpl(`${stateBase}/ready`,{
      signal: AbortSignal.timeout(30_000),
    });
    if (!readyResponse.ok) throw new Error(`State readiness failed with status ${readyResponse.status}.`);
    const ready = await readyResponse.json();
    if (ready.authority?.release_epoch !== releaseEpoch
        || typeof ready.authority?.admission?.open !== "boolean"
        || !Number.isSafeInteger(ready.authority?.admission?.generation)) {
      throw new Error("State admission authority does not match the coordinated release.");
    }
    if (ready.authority.admission.open) {
      const closeId = randomUUID();
      const closeResponse = await fetchImpl(`${stateBase}/v1/admin/admission`,{
        method: "POST",
        headers: {
          authorization: `Bearer ${stateOperatorToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          commandId: closeId,open: false,
          expectedGeneration: ready.authority.admission.generation,
        }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!closeResponse.ok) throw new Error(`State admission close failed with status ${closeResponse.status}.`);
      const closed = await closeResponse.json();
      reopenAdmission = { expectedGeneration: closed.generation };
    }
    const response = await fetchImpl(`${stateBase}/v1/admin/export`,{
      headers: { authorization: `Bearer ${stateOperatorToken}` },
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw new Error(`State export failed with status ${response.status}.`);
    const snapshot = Buffer.from(await response.arrayBuffer());
    const snapshotSha256 = createHash("sha256").update(snapshot).digest("hex");
    if (response.headers.get("x-cannabeats-state-sha256") !== snapshotSha256
        || response.headers.get("x-cannabeats-release-epoch") !== releaseEpoch
        || response.headers.get("x-cannabeats-schema-generation") !== "3"
        || response.headers.get("x-cannabeats-protocol-version") !== "4"
        || response.headers.get("x-cannabeats-admission-open") !== "false") {
      throw new Error("State export contract does not match the coordinated release.");
    }
    const firstAdmittedHeader = response.headers.get("x-cannabeats-first-admitted-at");
    const firstAdmittedAt = firstAdmittedHeader === "none" ? null : Number(firstAdmittedHeader);
    if (firstAdmittedAt !== null
        && (!Number.isSafeInteger(firstAdmittedAt) || firstAdmittedAt <= 0)) {
      throw new Error("State export rollback-floor metadata is invalid.");
    }
    writeFileSync(stateSnapshotPath,snapshot,{ mode: 0o600,flag: "wx" });
    const access = await createBackup({
      databasePath: accessDatabasePath,outputPath: accessPath,passphraseFile,
      applicationVersion,catalogVersion,databaseRole: "access",releaseEpoch,now,
      recoverySetId,
      scratchDirectory: work,
    });
    created.push(accessPath);
    const state = await createBackup({
      databasePath: stateSnapshotPath,outputPath: statePath,passphraseFile,
      applicationVersion,catalogVersion,databaseRole: "state",releaseEpoch,now,
      recoverySetId,
      authorityFloor: { releaseEpoch,firstAdmittedAt },
      scratchDirectory: work,
    });
    created.push(statePath);
    const accessVerified = verifyBackup({ backupPath: accessPath,passphraseFile,scratchDirectory: work });
    const stateVerified = verifyBackup({ backupPath: statePath,passphraseFile,scratchDirectory: work });
    if (accessVerified.databaseRole !== "access" || stateVerified.databaseRole !== "state"
        || accessVerified.releaseEpoch !== releaseEpoch || stateVerified.releaseEpoch !== releaseEpoch
        || accessVerified.recoverySetId !== recoverySetId
        || stateVerified.recoverySetId !== recoverySetId) {
      throw new Error("Encrypted backup roles do not match the coordinated manifest.");
    }
    const manifest = {
      format: FORMAT,formatVersion: FORMAT_VERSION,createdAt: now.toISOString(),
      recoverySetId,releaseEpoch,applicationVersion,catalogVersion,
      state: {
        schemaGeneration: 3,protocolVersion: 4,snapshotSha256,
        admissionGeneration: Number(response.headers.get("x-cannabeats-admission-generation")),
        firstAdmittedAt,
      },
      artifacts: {
        access: { file: basename(accessPath),sha256: hashFile(accessPath),databaseSha256: access.database.sha256 },
        state: { file: basename(statePath),sha256: hashFile(statePath),databaseSha256: state.database.sha256 },
      },
    };
    publishJson(manifestPath,manifest);
    created.push(manifestPath);
    if (reopenAdmission) {
      const reopenResponse = await fetchImpl(`${stateBase}/v1/admin/admission`,{
        method: "POST",
        headers: {
          authorization: `Bearer ${stateOperatorToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          commandId: randomUUID(),open: true,
          expectedGeneration: reopenAdmission.expectedGeneration,
        }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!reopenResponse.ok) {
        throw new Error(`State admission reopen failed with status ${reopenResponse.status}.`);
      }
      reopenAdmission = null;
    }
    return { manifestPath,manifest };
  } catch (error) {
    for (const path of created.reverse()) rmSync(path,{ force: true });
    throw error;
  } finally {
    if (reopenAdmission) {
      try {
        await fetchImpl(`${new URL(stateOrigin).origin}/v1/admin/admission`,{
          method: "POST",
          headers: {
            authorization: `Bearer ${stateOperatorToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            commandId: randomUUID(),open: true,
            expectedGeneration: reopenAdmission.expectedGeneration,
          }),
          signal: AbortSignal.timeout(30_000),
        });
      } catch {}
    }
    rmSync(work,{ recursive: true,force: true });
  }
}

export function verifyCoordinatedBackup({ manifestPath,passphraseFile,scratchDirectory = tmpdir() }) {
  const manifest = readManifest(manifestPath);
  const directory = dirname(resolve(manifestPath));
  const verified = {};
  for (const role of ["access","state"]) {
    const artifact = manifest.artifacts[role];
    const path = join(directory,artifact.file);
    if (!existsSync(path) || !statSync(path).isFile() || hashFile(path) !== artifact.sha256) {
      throw new Error(`Coordinated ${role} backup digest does not match its manifest.`);
    }
    const result = verifyBackup({ backupPath: path,passphraseFile,scratchDirectory });
    if (result.databaseRole !== role || result.releaseEpoch !== manifest.releaseEpoch
        || result.recoverySetId !== manifest.recoverySetId
        || result.database.sha256 !== artifact.databaseSha256) {
      throw new Error(`Coordinated ${role} backup authority does not match its manifest.`);
    }
    verified[role] = result;
  }
  if (verified.state.authorityFloor?.releaseEpoch !== manifest.releaseEpoch
      || verified.state.authorityFloor?.firstAdmittedAt !== manifest.state.firstAdmittedAt) {
    throw new Error("Coordinated State rollback floor does not match its authenticated artifact.");
  }
  return { manifestPath,manifest,verified };
}

export function restoreCoordinatedBackup({
  manifestPath,outputDirectory,passphraseFile,scratchDirectory = tmpdir(),beforePublish,
}) {
  const { manifest,verified } = verifyCoordinatedBackup({
    manifestPath,passphraseFile,scratchDirectory,
  });
  const directory = dirname(resolve(manifestPath));
  let recoveredFirstAdmittedAt = verified.state.authorityFloor.firstAdmittedAt;
  for (const entry of readdirSync(directory,{ withFileTypes: true })) {
    if (!entry.isFile() || !MANIFEST_NAME.test(entry.name)
        || resolve(join(directory,entry.name)) === resolve(manifestPath)) continue;
    const sibling = verifyCoordinatedBackup({
      manifestPath: join(directory,entry.name),passphraseFile,scratchDirectory,
    });
    if (sibling.manifest.releaseEpoch !== manifest.releaseEpoch) continue;
    const siblingFloor = sibling.verified.state.authorityFloor.firstAdmittedAt;
    if (siblingFloor !== null
        && (recoveredFirstAdmittedAt === null || siblingFloor < recoveredFirstAdmittedAt)) {
      recoveredFirstAdmittedAt = siblingFloor;
    }
  }
  const recoveryRoot = resolve(outputDirectory);
  mkdirSync(recoveryRoot,{ recursive: true,mode: 0o700 });
  const prepared = mkdtempSync(join(recoveryRoot,".recovery-prepared-"));
  const generationName = `recovery-${manifest.recoverySetId}`;
  const generationDirectory = join(recoveryRoot,generationName);
  const selectorPath = join(recoveryRoot,"current");
  const preparedSelector = join(recoveryRoot,`.current-${randomBytes(12).toString("hex")}`);
  try {
    const access = restoreBackup({
      backupPath: join(directory,manifest.artifacts.access.file),
      outputPath: join(prepared,"access.sqlite"),passphraseFile,
    });
    const state = restoreBackup({
      backupPath: join(directory,manifest.artifacts.state.file),
      outputPath: join(prepared,"state.sqlite"),passphraseFile,
    });
    if (recoveredFirstAdmittedAt !== null) {
      publishJson(join(prepared,"rollback-floor.json"),{
        version: 1,releaseEpoch: manifest.releaseEpoch,
        firstAdmittedAt: recoveredFirstAdmittedAt,
      });
    }
    publishJson(join(prepared,"recovery-set.json"),{
      recoverySetId: manifest.recoverySetId,releaseEpoch: manifest.releaseEpoch,
      manifest: basename(resolve(manifestPath)),
    });
    syncDirectory(prepared);
    if (existsSync(generationDirectory)) {
      throw new Error(`Refusing to overwrite restored recovery generation: ${generationDirectory}`);
    }
    renameSync(prepared,generationDirectory);
    syncDirectory(recoveryRoot);
    if (beforePublish) beforePublish({ generationDirectory,selectorPath });
    symlinkSync(generationName,preparedSelector);
    renameSync(preparedSelector,selectorPath);
    syncDirectory(recoveryRoot);
    return {
      manifest,access,state,generationDirectory,selectorPath,
      accessOutputPath: join(selectorPath,"access.sqlite"),
      stateOutputPath: join(selectorPath,"state.sqlite"),
      rollbackFloorPath: join(selectorPath,"rollback-floor.json"),
      recoveredFirstAdmittedAt,
    };
  } catch (error) {
    rmSync(preparedSelector,{ force: true });
    rmSync(prepared,{ recursive: true,force: true });
    throw error;
  }
}

export function pruneCoordinatedBackups({
  directory,keep,passphraseFile,scratchDirectory = tmpdir(),
}) {
  if (!Number.isInteger(keep) || keep < 2 || keep > 365) {
    throw new Error("Coordinated backup retention must be between 2 and 365 sets.");
  }
  const manifests = readdirSync(directory,{ withFileTypes: true })
    .filter((entry) => entry.isFile() && MANIFEST_NAME.test(entry.name))
    .map((entry) => join(directory,entry.name)).sort().reverse();
  const sets = manifests.map((manifestPath) =>
    verifyCoordinatedBackup({ manifestPath,passphraseFile,scratchDirectory }));
  const removed = [];
  for (const { manifestPath,manifest } of sets.slice(keep)) {
    for (const role of ["access","state"]) {
      const path = join(directory,manifest.artifacts[role].file);
      rmSync(path); removed.push(basename(path));
    }
    rmSync(manifestPath); removed.push(basename(manifestPath));
  }
  if (removed.length) syncDirectory(directory);
  return { kept: sets.slice(0,keep).map((set) => basename(set.manifestPath)),removed };
}

function value(args,name,fallback = "") {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
}

async function main(args = process.argv.slice(2)) {
  const command = args[0];
  const passphraseFile = resolve(value(args,"passphrase-file",process.env.CANNABEATS_BACKUP_PASSPHRASE_FILE));
  const directory = resolve(value(args,"directory",process.env.CANNABEATS_BACKUP_DIRECTORY ?? "/backups"));
  const scratchDirectory = resolve(value(args,"scratch-directory",
    process.env.CANNABEATS_BACKUP_SCRATCH_DIRECTORY ?? tmpdir()));
  if (command === "run") {
    const token = (process.env.CANNABEATS_STATE_OPERATOR_TOKEN
      ?? readFileSync(process.env.CANNABEATS_STATE_OPERATOR_TOKEN_FILE,"utf8")).trim();
    const created = await createCoordinatedBackup({
      accessDatabasePath: resolve(value(args,"access-database",process.env.DATABASE_PATH)),
      stateOrigin: value(args,"state-origin",process.env.CANNABEATS_STATE_SERVICE_ORIGIN),
      stateOperatorToken: token,outputDirectory: directory,passphraseFile,
      releaseEpoch: value(args,"release-epoch",process.env.CANNABEATS_RELEASE_EPOCH),
      applicationVersion: value(args,"application-version",process.env.CANNABEATS_APP_VERSION ?? "unknown"),
      catalogVersion: value(args,"catalog-version",process.env.CANNABEATS_CATALOG_VERSION ?? "unknown"),
      scratchDirectory,
    });
    const verified = verifyCoordinatedBackup({
      manifestPath: created.manifestPath,passphraseFile,scratchDirectory,
    });
    const retention = pruneCoordinatedBackups({
      directory,keep: Number(value(args,"keep",process.env.CANNABEATS_BACKUP_KEEP ?? 14)),
      passphraseFile,scratchDirectory,
    });
    console.log(JSON.stringify({ created,verified,retention }));
    return;
  }
  if (command === "verify") {
    console.log(JSON.stringify(verifyCoordinatedBackup({
      manifestPath: resolve(value(args,"manifest")),passphraseFile,scratchDirectory,
    })));
    return;
  }
  if (command === "restore") {
    console.log(JSON.stringify(restoreCoordinatedBackup({
      manifestPath: resolve(value(args,"manifest")),
      outputDirectory: resolve(value(args,"output-directory")),
      passphraseFile,scratchDirectory,
    })));
    return;
  }
  if (command === "prune") {
    console.log(JSON.stringify(pruneCoordinatedBackups({
      directory,keep: Number(value(args,"keep")),passphraseFile,scratchDirectory,
    })));
    return;
  }
  throw new Error("Usage: coordinated-backup.mjs run|verify|restore|prune");
}

if (resolve(process.argv[1] ?? "") === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
