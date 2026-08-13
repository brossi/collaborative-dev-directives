#!/usr/bin/env node
import { createServer } from "node:net";
import { randomBytes,randomUUID } from "node:crypto";
import {
  chmodSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,rmSync,writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename,dirname,join,resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const deploymentDirectory = resolve(dirname(fileURLToPath(import.meta.url)),"..");
const repositoryRoot = resolve(deploymentDirectory,"../..");
const keep = process.env.CANNABEATS_KEEP_REHEARSAL === "1";
const work = mkdtempSync(join(tmpdir(),"cannabeats-state-cutover-"));
const suffix = `${process.pid}-${randomBytes(4).toString("hex")}`;
const project = `cannabeats-rehearsal-${suffix}`;
const accessVolume = `${project}-access`;
const stateVolume = `${project}-state`;
const restoredProject = `${project}-restored`;
const restoredAccessVolume = `${restoredProject}-access`;
const restoredStateVolume = `${restoredProject}-state`;
const secretsDirectory = join(work,"secrets");
const backupsDirectory = join(work,"backups");
const restoreDirectory = join(work,"restore");
const releasesDirectory = join(work,"releases");
const hostReleasesDirectory = join(work,"host-releases");
const evidencePath = resolve(process.env.CANNABEATS_REHEARSAL_EVIDENCE
  ?? join(repositoryRoot,"docs/evidence/state-cutover-local.json"));
const catalogVersion = JSON.parse(readFileSync(join(repositoryRoot,"web/data/catalog-manifest.json"),"utf8"))
  .catalogVersion;
const releaseEpoch = `local-rehearsal-${suffix}`;
const secretNames = [
  "audio-relay-ingest-token","audio-relay-listen-token","game-service-token",
  "state-activation-token","state-operator-token","state-access-token","state-game-token",
  "state-access-principal-assertion-key","state-game-principal-assertion-key",
  "backup-passphrase",
];
const evidence = {
  format: "cannabeats-state-cutover-rehearsal",formatVersion: 1,
  startedAt: new Date().toISOString(),project,releaseEpoch,steps: [],
};

function run(command,args,{ cwd = deploymentDirectory,env = {},capture = false,allowFailure = false } = {}) {
  const result = spawnSync(command,args,{
    cwd,env: { ...process.env,...environment,...env },encoding: "utf8",
    stdio: capture || allowFailure ? ["ignore","pipe","pipe"] : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`${command} ${args.join(" ")} failed (${result.status}):\n${result.stderr ?? ""}`);
  }
  return result;
}

function compose(files,profiles,args,options = {}) {
  const command = ["compose","-p",project];
  for (const file of files) command.push("-f",file);
  for (const profile of profiles) command.push("--profile",profile);
  return run("docker",[...command,...args],options);
}

function composeFor(projectName,files,profiles,args,options = {}) {
  const command = ["compose","-p",projectName];
  for (const file of files) command.push("-f",file);
  for (const profile of profiles) command.push("--profile",profile);
  return run("docker",[...command,...args],options);
}

function record(step,details = {}) {
  evidence.steps.push({ step,at: new Date().toISOString(),...details });
  process.stdout.write(`\n[rehearsal] ${step}\n`);
}

async function unusedPort() {
  return await new Promise((resolvePort,reject) => {
    const server = createServer();
    server.unref();
    server.on("error",reject);
    server.listen(0,"127.0.0.1",() => {
      const address = server.address();
      server.close(() => resolvePort(address.port));
    });
  });
}

async function waitJson(url,predicate,{ headers = {},attempts = 90 } = {}) {
  let last = "no response";
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url,{ headers,signal: AbortSignal.timeout(2_000) });
      const body = await response.json();
      if (response.ok && predicate(body)) return body;
      last = `${response.status} ${JSON.stringify(body)}`;
    } catch (error) { last = error.message; }
    await new Promise((resolveWait) => setTimeout(resolveWait,1_000));
  }
  throw new Error(`Timed out waiting for ${url}: ${last}`);
}

async function postJson(url,token,body) {
  const response = await fetch(url,{
    method: "POST",headers: { authorization: `Bearer ${token}`,"content-type": "application/json" },
    body: JSON.stringify(body),signal: AbortSignal.timeout(30_000),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(`POST ${url} failed ${response.status}: ${JSON.stringify(payload)}`);
  return payload;
}

function parseLastJson(output) {
  for (const line of output.trim().split(/\r?\n/).reverse()) {
    try { return JSON.parse(line); } catch { /* compose may print progress */ }
  }
  throw new Error(`No JSON result found in output:\n${output}`);
}

function writeReleaseRecord(path,{ stateCutover }) {
  writeFileSync(path,`x-cannabeats-release:
  application-version: "local-rehearsal"
  catalog-version: "${catalogVersion}"
  schema-min-version: 0
  schema-max-version: 2
  schema-target-version: 1
  state-cutover: ${stateCutover}
  state-schema-min-generation: ${stateCutover ? 4 : 0}
  state-schema-max-generation: ${stateCutover ? 4 : 0}
  state-protocol-min-version: ${stateCutover ? 4 : 0}
  state-protocol-max-version: ${stateCutover ? 4 : 0}
  state-http-contract-version: ${stateCutover ? 1 : 0}
  release-epoch: ${stateCutover ? releaseEpoch : ""}
services:
  app:
    image: cannabeats/access-spotify-poc:local
  game:
    image: cannabeats/game:local
${stateCutover ? "  state:\n    image: cannabeats/state-service:local\n" : ""}`);
}

let environment = {};
try {
  mkdirSync(secretsDirectory,{ recursive: true,mode: 0o700 });
  mkdirSync(backupsDirectory,{ recursive: true,mode: 0o700 });
  mkdirSync(restoreDirectory,{ recursive: true,mode: 0o700 });
  mkdirSync(releasesDirectory,{ recursive: true,mode: 0o700 });
  mkdirSync(hostReleasesDirectory,{ recursive: true,mode: 0o700 });
  mkdirSync(join(work,"state-authority"),{ recursive: true,mode: 0o700 });
  mkdirSync(join(work,"restored-state-authority"),{ recursive: true,mode: 0o700 });
  for (const name of secretNames) {
    const value = name === "backup-passphrase"
      ? `local rehearsal passphrase ${randomBytes(32).toString("hex")}`
      : randomBytes(32).toString("hex");
    writeFileSync(join(secretsDirectory,name),`${value}\n`,{ mode: 0o600 });
    chmodSync(join(secretsDirectory,name),0o600);
  }
  const accessPort = 3002;
  const gamePort = 3003;
  const statePort = 3010;
  const [restoredAccessPort,restoredGamePort,restoredStatePort]
    = await Promise.all(Array.from({ length: 3 },() => unusedPort()));
  environment = {
    CANNABEATS_REPOSITORY_ROOT: repositoryRoot,
    CANNABEATS_DATA_VOLUME: accessVolume,CANNABEATS_STATE_DATA_VOLUME: stateVolume,
    CANNABEATS_REHEARSAL_ACCESS_PORT: String(accessPort),
    CANNABEATS_REHEARSAL_GAME_PORT: String(gamePort),
    CANNABEATS_REHEARSAL_STATE_PORT: String(statePort),CANNABEATS_STATE_PORT: String(statePort),
    // The containers retain their production transport checks. The public
    // application and relay origins are therefore declared as HTTPS even
    // though this harness reaches the loopback-published container ports over
    // plain HTTP and never contacts the deliberately unavailable relay.
    APP_ORIGIN: `https://127.0.0.1:${accessPort}`,RP_ID: "127.0.0.1",
    AUDIO_RELAY_ORIGIN: "https://127.0.0.1:9",
    CANNABEATS_APP_VERSION: "local-rehearsal",CANNABEATS_CATALOG_VERSION: catalogVersion,
    CANNABEATS_ENVIRONMENT: "local-rehearsal",CANNABEATS_RELEASE_EPOCH: releaseEpoch,
    CANNABEATS_BACKUP_DIR: backupsDirectory,CANNABEATS_BACKUP_KEEP: "2",
    CANNABEATS_STATE_AUTHORITY_DIR: join(work,"state-authority"),
    HOST_RELEASE_DIR: hostReleasesDirectory,
    AUDIO_RELAY_INGEST_TOKEN_HOST_FILE: join(secretsDirectory,"audio-relay-ingest-token"),
    AUDIO_RELAY_LISTEN_TOKEN_HOST_FILE: join(secretsDirectory,"audio-relay-listen-token"),
    GAME_SERVICE_TOKEN_HOST_FILE: join(secretsDirectory,"game-service-token"),
    STATE_ACTIVATION_TOKEN_HOST_FILE: join(secretsDirectory,"state-activation-token"),
    STATE_OPERATOR_TOKEN_HOST_FILE: join(secretsDirectory,"state-operator-token"),
    STATE_ACCESS_TOKEN_HOST_FILE: join(secretsDirectory,"state-access-token"),
    STATE_GAME_TOKEN_HOST_FILE: join(secretsDirectory,"state-game-token"),
    STATE_ACCESS_PRINCIPAL_ASSERTION_KEY_HOST_FILE:
      join(secretsDirectory,"state-access-principal-assertion-key"),
    STATE_GAME_PRINCIPAL_ASSERTION_KEY_HOST_FILE:
      join(secretsDirectory,"state-game-principal-assertion-key"),
    BACKUP_PASSPHRASE_HOST_FILE: join(secretsDirectory,"backup-passphrase"),
  };
  const base = ["compose.yaml","compose.rehearsal.yaml"];
  const cutover = ["compose.yaml","compose.state-cutover.yaml","compose.rehearsal.yaml"];
  const gitCommit = run("git",["rev-parse","HEAD"],{ cwd: repositoryRoot,capture: true }).stdout.trim();
  const worktreeStatus = run("git",["status","--porcelain"],{
    cwd: repositoryRoot,capture: true,
  }).stdout;
  record("build-images",{ gitCommit,worktreeDirty: Boolean(worktreeStatus.trim()) });
  compose(cutover,["state-cutover"],["build","app","game","state"]);
  evidence.images = Object.fromEntries(["access-spotify-poc","game","state-service"].map((name) => {
    const image = name === "game" ? "cannabeats/game:local"
      : name === "state-service" ? "cannabeats/state-service:local"
        : "cannabeats/access-spotify-poc:local";
    return [name,run("docker",["image","inspect","--format","{{.Id}}",image],{
      capture: true,
    }).stdout.trim()];
  }));

  const legacyPath = join(work,"legacy.sqlite");
  const fixtureResult = run(process.execPath,[
    "--experimental-strip-types",join(repositoryRoot,"state-service/scripts/create-rehearsal-monolith.mjs"),
    legacyPath,
  ],{ cwd: repositoryRoot,capture: true });
  const fixture = parseLastJson(fixtureResult.stdout);
  record("create-drained-monolith",{ legacyRunId: fixture.runId,legacyCode: fixture.code });
  const preCutoverBackup = join(backupsDirectory,"pre-cutover-monolith.cbbackup");
  run(process.execPath,[join(deploymentDirectory,"operations/backup.mjs"),"create",
    "--database",legacyPath,"--output",preCutoverBackup,
    "--passphrase-file",join(secretsDirectory,"backup-passphrase"),
    "--scratch-directory",restoreDirectory,"--application-version","pre-cutover",
    "--catalog-version",catalogVersion],{ capture: true });
  run(process.execPath,[join(deploymentDirectory,"operations/backup.mjs"),"verify",
    "--backup",preCutoverBackup,"--passphrase-file",join(secretsDirectory,"backup-passphrase"),
    "--scratch-directory",restoreDirectory],{ capture: true });
  const drain = parseLastJson(run(process.execPath,["-e",`
    const { DatabaseSync }=require('node:sqlite');const db=new DatabaseSync(process.argv[1],{readOnly:true});
    const active=db.prepare("SELECT COUNT(*) AS n FROM game_sessions WHERE status<>'ended'").get().n;
    const leases=db.prepare("SELECT COUNT(*) AS n FROM managed_audio_leases").get().n;
    const commands=db.prepare("SELECT COUNT(*) AS n FROM managed_audio_commands WHERE completed_at IS NULL").get().n;
    db.close();console.log(JSON.stringify({active,leases,commands}));
  `,legacyPath],{ cwd: repositoryRoot,capture: true }).stdout);
  if (drain.active || drain.leases || drain.commands) throw new Error(`Legacy drain failed: ${JSON.stringify(drain)}`);
  record("pre-cutover-backup-and-drain-proved",{
    backup: basename(preCutoverBackup),drain,priorImages: evidence.images,
  });
  run("docker",["volume","create",accessVolume],{ capture: true });
  run("docker",["volume","create",stateVolume],{ capture: true });
  run("docker",[
    "run","--rm","--user","0","-v",`${accessVolume}:/data`,"-v",`${work}:/seed:ro`,
    "cannabeats/access-spotify-poc:local","sh","-c",
    "cp /seed/legacy.sqlite /data/cannabeats-poc.sqlite && chown 1000:1000 /data /data/cannabeats-poc.sqlite",
  ]);
  run("docker",[
    "run","--rm","--user","0","-v",`${stateVolume}:/state`,
    "cannabeats/state-service:local","sh","-c","chown 1000:1000 /state",
  ]);

  record("migrate-monolith");
  const migrationRun = compose(base,["state-migration"],["run","--rm","state-migrate"],{ capture: true });
  const migration = parseLastJson(migrationRun.stdout);
  if (migration.replayed || migration.schemaGeneration !== 4 || migration.protocolVersion !== 4) {
    throw new Error(`Unexpected migration result: ${JSON.stringify(migration)}`);
  }
  record("migration-validated",{
    sourceDigest: migration.sourceDatabaseDigest,candidateDigest: migration.candidateDigest,
    rowCounts: migration.rowCounts,
  });

  compose(cutover,["state-cutover"],["up","-d","state"]);
  const candidate = await waitJson(`http://127.0.0.1:${statePort}/ready`,
    (body) => body.authority?.status === "candidate" && body.schemaGeneration === 4
      && body.protocolVersion === 4);
  record("candidate-ready",{ authority: candidate.authority.status });
  const activationToken = readFileSync(join(secretsDirectory,"state-activation-token"),"utf8").trim();
  const operatorToken = readFileSync(join(secretsDirectory,"state-operator-token"),"utf8").trim();
  const rejectedCandidateMutation = await fetch(
    `http://127.0.0.1:${statePort}/v1/admin/admission`,{
      method: "POST",headers: {
        authorization: `Bearer ${operatorToken}`,"content-type": "application/json",
      },body: JSON.stringify({ commandId: randomUUID(),open: true,expectedGeneration: 0 }),
      signal: AbortSignal.timeout(10_000),
    });
  if (rejectedCandidateMutation.status !== 409) {
    throw new Error(`Candidate mutation was not rejected (${rejectedCandidateMutation.status}).`);
  }
  record("candidate-mutation-rejected");
  const activation = await postJson(`http://127.0.0.1:${statePort}/v1/admin/activate`,activationToken,{
    commandId: randomUUID(),expectedSourceDigest: migration.sourceDatabaseDigest,
    expectedCandidateDigest: migration.candidateDigest,expectedSchemaGeneration: 4,
    expectedProtocolVersion: 4,releaseEpoch,
  });
  if (activation.status !== "active") throw new Error("State activation did not succeed.");
  record("candidate-activated-pre-admission");

  const priorReleaseRecord = join(work,"prior-release-compose.yaml");
  const stateReleaseRecord = join(work,"state-release-compose.yaml");
  const releaseStateTool = join(deploymentDirectory,"operations/release-state.mjs");
  writeReleaseRecord(priorReleaseRecord,{ stateCutover: false });
  writeReleaseRecord(stateReleaseRecord,{ stateCutover: true });
  run(process.execPath,[releaseStateTool,"bootstrap",releasesDirectory,priorReleaseRecord]);
  run(process.execPath,[
    releaseStateTool,"promote",releasesDirectory,stateReleaseRecord,"local-rehearsal-cutover",
  ]);
  const rollbackEnvironment = {
    CANNABEATS_COMPOSE_DIR: deploymentDirectory,CANNABEATS_RELEASE_DIR: releasesDirectory,
    COMPOSE_PROJECT_NAME: project,
    CANNABEATS_STATE_PORT: String(statePort),
    CANNABEATS_BOOTSTRAP_SCHEMA_MIN_VERSION: "0",CANNABEATS_BOOTSTRAP_SCHEMA_MAX_VERSION: "2",
    CANNABEATS_BOOTSTRAP_SCHEMA_TARGET_VERSION: "1",
  };
  run("bash",[join(deploymentDirectory,"deploy/rollback-release.sh")],{
    capture: true,env: rollbackEnvironment,
  });
  await waitJson(`http://127.0.0.1:${accessPort}/api/ready`,(body) => body.ready === true);
  await waitJson(`http://127.0.0.1:${gamePort}/game/api/ready`,(body) => body.ready === true);
  const legacySession = await fetch(`http://127.0.0.1:${accessPort}/api/game-sessions/${fixture.code}`,{
    headers: { cookie: `cb_session=${fixture.browserSession}` },signal: AbortSignal.timeout(10_000),
  });
  if (!legacySession.ok) throw new Error(`Pre-admission rollback did not preserve Access identity (${legacySession.status}).`);
  record("pre-admission-rollback-proved",{
    accessReady: true,gameReady: true,mechanism: "rollback-release.sh",
  });

  run(process.execPath,[
    releaseStateTool,"promote",releasesDirectory,stateReleaseRecord,"local-rehearsal-forward",
  ]);
  compose(base,[],["stop","app","game"]);
  compose(cutover,["state-cutover"],["up","-d","state","app","game"]);
  await waitJson(`http://127.0.0.1:${statePort}/ready`,
    (body) => body.authority?.status === "active" && body.authority?.first_admitted_at == null);
  await waitJson(`http://127.0.0.1:${accessPort}/api/ready`,(body) => body.ready === true);
  await waitJson(`http://127.0.0.1:${gamePort}/game/api/ready`,(body) => body.ready === true);
  const closedAuthority = await waitJson(`http://127.0.0.1:${statePort}/ready`,
    (body) => body.authority?.admission?.open === false);
  await postJson(`http://127.0.0.1:${statePort}/v1/admin/admission`,operatorToken,{
    commandId: randomUUID(),open: true,
    expectedGeneration: closedAuthority.authority.admission.generation,
  });
  const clientRun = run(process.execPath,[join(deploymentDirectory,"deploy/rehearsal-client.mjs")],{
    capture: true,allowFailure: true,env: {
      CANNABEATS_REHEARSAL_ACCESS_ORIGIN: `http://127.0.0.1:${accessPort}`,
      CANNABEATS_REHEARSAL_GAME_ORIGIN: `http://127.0.0.1:${gamePort}`,
      CANNABEATS_REHEARSAL_STATE_ORIGIN: `http://127.0.0.1:${statePort}`,
      CANNABEATS_REHEARSAL_BROWSER_SESSION: fixture.browserSession,
      CANNABEATS_REHEARSAL_OPERATOR_TOKEN: operatorToken,
      CANNABEATS_REHEARSAL_SOURCE_TOKEN:
        readFileSync(join(secretsDirectory,"state-game-token"),"utf8").trim() + "-source",
      CANNABEATS_REHEARSAL_EXPECTED_ORIGIN: `https://127.0.0.1:${accessPort}`,
    },
  });
  if (clientRun.status !== 0) {
    const diagnostics = compose(cutover,["state-cutover"],["logs","--no-color","--tail","120","app","state"],{
      capture: true,allowFailure: true,
    });
    throw new Error(`Rehearsal client failed:\n${clientRun.stderr}\n${diagnostics.stdout}\n${diagnostics.stderr}`);
  }
  const gameplay = parseLastJson(clientRun.stdout);
  if (gameplay.sourceHandoff !== "safe" || gameplay.secondLobbyAcquired !== true
      || typeof gameplay.secondCode !== "string") {
    throw new Error("Rehearsal did not prove the two-lobby source handoff fence.");
  }
  record("post-cutover-gameplay-and-history",gameplay);
  const sealed = await postJson(`http://127.0.0.1:${statePort}/v1/admin/history/seal`,operatorToken,{
    commandId: randomUUID(),runId: gameplay.runId,
  });
  if (sealed.lifecycle !== "sealed") throw new Error("Abandoned rehearsal history did not seal.");
  record("abandoned-history-sealed",{ runId: gameplay.runId });
  const liveHistory = async (runId) => {
    const response = await fetch(
      `http://127.0.0.1:${gamePort}/game/api/game?runId=${encodeURIComponent(runId)}`,
      { headers: {
        cookie: `cb_session=${fixture.browserSession}`,
        "x-cannabeats-client-contract": "2",
      },signal: AbortSignal.timeout(10_000) },
    );
    if (!response.ok) throw new Error(`Live history ${runId} failed with ${response.status}.`);
    return (await response.json()).history;
  };
  const [liveCompletedHistory,liveAbandonedHistory] = await Promise.all([
    liveHistory(fixture.runId),liveHistory(gameplay.runId),
  ]);
  const completedEventTypes = liveCompletedHistory.events.map((event) => event.type);
  const abandonedEventTypes = [...new Set(
    liveAbandonedHistory.events.map((event) => event.type),
  )].sort();
  if (liveCompletedHistory.current?.terminalOutcome !== "completed"
      || liveCompletedHistory.coverage?.complete !== true
      || liveCompletedHistory.retention?.lifecycle !== "sealed"
      || !completedEventTypes.includes("game_completed")
      || liveAbandonedHistory.coverage?.complete !== true
      || liveAbandonedHistory.retention?.lifecycle !== "sealed"
      || JSON.stringify(abandonedEventTypes) !== JSON.stringify(gameplay.eventTypes)) {
    throw new Error("Live completed/abandoned history did not meet the semantic backup oracle.");
  }
  record("pre-backup-history-oracle",{ completedEventTypes,abandonedEventTypes });

  const active = await waitJson(`http://127.0.0.1:${statePort}/ready`,
    (body) => body.authority?.status === "active" && Number.isSafeInteger(body.authority?.first_admitted_at));
  record("post-admission-rollback-floor",{ firstAdmittedAt: active.authority.first_admitted_at });

  compose(cutover,["state-cutover","operations"],["run","--rm","backup","run"]);
  const manifests = readdirSync(backupsDirectory).filter((name) => name.endsWith(".cbmanifest"));
  if (manifests.length !== 1) throw new Error(`Expected one coordinated manifest, found ${manifests.length}.`);
  const manifestPath = join(backupsDirectory,manifests[0]);
  run(process.execPath,[
    join(deploymentDirectory,"operations/coordinated-backup.mjs"),"verify","--manifest",manifestPath,
    "--passphrase-file",join(secretsDirectory,"backup-passphrase"),
    "--scratch-directory",restoreDirectory,
  ],{ capture: true });
  const restoredResult = run(process.execPath,[
    join(deploymentDirectory,"operations/coordinated-backup.mjs"),"restore","--manifest",manifestPath,
    "--output-directory",restoreDirectory,
    "--passphrase-file",join(secretsDirectory,"backup-passphrase"),
    "--scratch-directory",restoreDirectory,
  ],{ capture: true });
  const restoredSet = parseLastJson(restoredResult.stdout);
  const restoredAccess = restoredSet.accessOutputPath;
  const restoredState = restoredSet.stateOutputPath;
  run(process.execPath,["-e",`
    const { DatabaseSync }=require('node:sqlite');
    const a=new DatabaseSync(process.argv[1],{readOnly:true});
    const s=new DatabaseSync(process.argv[2],{readOnly:true});
    try {
      if(a.prepare('PRAGMA integrity_check').get().integrity_check!=='ok') throw Error('access integrity');
      if(s.prepare('PRAGMA integrity_check').get().integrity_check!=='ok') throw Error('state integrity');
      if(s.prepare("SELECT status FROM state_authority WHERE singleton='state'").get()?.status!=='active')
        throw Error('state authority');
      if(s.prepare('SELECT COUNT(*) AS count FROM lobbies').get().count<2) throw Error('state lobby count');
    } finally { a.close(); s.close(); }
  `,restoredAccess,restoredState],{ cwd: repositoryRoot });
  record("coordinated-backup-and-restore-proved",{ manifest: basename(manifestPath) });

  run("docker",["volume","create",restoredAccessVolume],{ capture: true });
  run("docker",["volume","create",restoredStateVolume],{ capture: true });
  run("docker",[
    "run","--rm","--user","0","-v",`${restoredAccessVolume}:/data`,
    "-v",`${restoreDirectory}:/restore:ro`,"cannabeats/access-spotify-poc:local","sh","-c",
    `cp /restore/current/access.sqlite /data/cannabeats-poc.sqlite && chown 1000:1000 /data /data/cannabeats-poc.sqlite`,
  ]);
  run("docker",[
    "run","--rm","--user","0","-v",`${restoredStateVolume}:/state`,
    "-v",`${restoreDirectory}:/restore:ro`,"cannabeats/state-service:local","sh","-c",
    `cp /restore/current/state.sqlite /state/cannabeats-state.sqlite && chown 1000:1000 /state /state/cannabeats-state.sqlite`,
  ]);
  const restoredAuthorityDirectory = join(work,"restored-state-authority");
  mkdirSync(restoredAuthorityDirectory,{ recursive: true,mode: 0o700 });
  run("cp",[join(restoreDirectory,"current/rollback-floor.json"),
    join(restoredAuthorityDirectory,"rollback-floor.json")]);
  const restoredEnvironment = {
    CANNABEATS_DATA_VOLUME: restoredAccessVolume,CANNABEATS_STATE_DATA_VOLUME: restoredStateVolume,
    CANNABEATS_REHEARSAL_ACCESS_PORT: String(restoredAccessPort),
    CANNABEATS_REHEARSAL_GAME_PORT: String(restoredGamePort),
    CANNABEATS_REHEARSAL_STATE_PORT: String(restoredStatePort),
    CANNABEATS_STATE_PORT: String(restoredStatePort),
    CANNABEATS_STATE_AUTHORITY_DIR: restoredAuthorityDirectory,
  };
  composeFor(restoredProject,cutover,["state-cutover"],["up","-d","state","app","game"],{
    env: restoredEnvironment,
  });
  const restoredStateReady = await waitJson(`http://127.0.0.1:${restoredStatePort}/ready`,
    (body) => body.authority?.status === "active" && body.authority?.admission?.open === false);
  await waitJson(`http://127.0.0.1:${restoredAccessPort}/api/ready`,(body) => body.ready === true);
  await waitJson(`http://127.0.0.1:${restoredGamePort}/game/api/ready`,(body) => body.ready === true);
  const restoredHistory = async (runId) => {
    const response = await fetch(
      `http://127.0.0.1:${restoredGamePort}/game/api/game?runId=${encodeURIComponent(runId)}`,
      { headers: {
        cookie: `cb_session=${fixture.browserSession}`,
        "x-cannabeats-client-contract": "2",
      },signal: AbortSignal.timeout(10_000) },
    );
    if (!response.ok) throw new Error(`Restored history ${runId} failed with ${response.status}.`);
    return await response.json();
  };
  const [restoredCompleted,restoredAbandoned] = await Promise.all([
    restoredHistory(fixture.runId),restoredHistory(gameplay.runId),
  ]);
  if (JSON.stringify(restoredCompleted.history) !== JSON.stringify(liveCompletedHistory)
      || JSON.stringify(restoredAbandoned.history) !== JSON.stringify(liveAbandonedHistory)) {
    throw new Error("Restored topology did not reconstruct completed and abandoned history.");
  }
  record("restored-topology-qualified",{
    admissionGeneration: restoredStateReady.authority.admission.generation,
    completedRunId: fixture.runId,abandonedRunId: gameplay.runId,
  });
  composeFor(restoredProject,cutover,["state-cutover"],["down","--remove-orphans"],{
    env: restoredEnvironment,capture: true,
  });

  const purged = await postJson(`http://127.0.0.1:${statePort}/v1/admin/history/purge`,operatorToken,{
    commandId: randomUUID(),runId: fixture.runId,eligibleBefore: Date.now() + 1_000,
  });
  if (purged.lifecycle !== "purged") {
    throw new Error(`Completed rehearsal history did not enter purge lifecycle: ${JSON.stringify(purged)}`);
  }
  if (purged.sanitization?.status !== "complete") {
    const sanitized = await postJson(
      `http://127.0.0.1:${statePort}/v1/admin/history/sanitize`,operatorToken,
      { commandId: randomUUID(),runId: fixture.runId },
    );
    if (sanitized.status !== "complete") throw new Error("Completed history sanitization remained pending.");
  }
  await waitJson(`http://127.0.0.1:${statePort}/ready`,(body) => body.sanitizationPending === 0);
  record("completed-history-purge-exercised",{ runId: fixture.runId,lifecycle: purged.lifecycle });

  compose(cutover,["state-cutover"],["restart","state","app","game"]);
  await waitJson(`http://127.0.0.1:${statePort}/ready`,
    (body) => body.authority?.status === "active" && body.sanitizationPending === 0
      && Number.isSafeInteger(body.authority?.first_admitted_at));
  await waitJson(`http://127.0.0.1:${gamePort}/game/api/ready`,(body) => body.ready === true);
  const [recoveredAbandoned,recoveredPurged] = await Promise.all([
    liveHistory(gameplay.runId),liveHistory(fixture.runId),
  ]);
  if (JSON.stringify(recoveredAbandoned) !== JSON.stringify(liveAbandonedHistory)
      || recoveredPurged.retention?.lifecycle !== "purged"
      || recoveredPurged.events?.length !== 0
      || recoveredPurged.current?.terminalOutcome !== "completed") {
    throw new Error("Restarted topology did not preserve retained and purged history semantics.");
  }
  record("restart-recovery-proved",{ purgedEvents: recoveredPurged.events.length });

  const rollback = run("bash",[join(deploymentDirectory,"deploy/rollback-release.sh")],{
    capture: true,allowFailure: true,env: rollbackEnvironment,
  });
  if (rollback.status === 0 || !/forbidden after the first state-owned lobby/i.test(rollback.stderr)) {
    throw new Error(`Post-admission rollback was not refused safely:\n${rollback.stdout}\n${rollback.stderr}`);
  }
  record("post-admission-monolith-rollback-refused");

  evidence.finishedAt = new Date().toISOString();
  evidence.status = "passed";
} catch (error) {
  evidence.finishedAt = new Date().toISOString();
  evidence.status = "failed";
  evidence.error = error instanceof Error ? error.message : String(error);
  console.error(`\nState cutover rehearsal failed: ${evidence.error}`);
  process.exitCode = 1;
} finally {
  const cleanupFailures = [];
  if (!keep) {
    try {
      const restoredDown = composeFor(restoredProject,
        ["compose.yaml","compose.state-cutover.yaml","compose.rehearsal.yaml"],
        ["state-cutover","operations"],["down","--remove-orphans"],
        { capture: true,allowFailure: true });
      if (restoredDown.status !== 0) cleanupFailures.push("restored compose down");
      const liveDown = compose(["compose.yaml","compose.state-cutover.yaml","compose.rehearsal.yaml"],
        ["state-cutover","state-migration","operations"],["down","--remove-orphans"],
        { capture: true,allowFailure: true });
      if (liveDown.status !== 0) cleanupFailures.push("live compose down");
    } catch (error) { cleanupFailures.push(`compose cleanup: ${error.message}`); }
    for (const volume of [accessVolume,stateVolume,restoredAccessVolume,restoredStateVolume]) {
      const removed = run("docker",["volume","rm",volume],{ capture: true,allowFailure: true });
      if (removed.status !== 0 && !/no such volume/i.test(removed.stderr ?? "")) {
        cleanupFailures.push(`volume ${volume}`);
      }
    }
    rmSync(work,{ recursive: true,force: true });
    evidence.cleanup = { status: cleanupFailures.length ? "failed" : "passed",failures: cleanupFailures };
    if (cleanupFailures.length) {
      evidence.status = "failed";
      process.exitCode = 1;
    }
  } else {
    evidence.cleanup = { status: "retained",work,project,restoredProject };
    process.stdout.write(`Rehearsal retained at ${work}; project ${project}.\n`);
  }
  evidence.finishedAt = new Date().toISOString();
  mkdirSync(dirname(evidencePath),{ recursive: true });
  writeFileSync(evidencePath,`${JSON.stringify(evidence,null,2)}\n`);
  if (evidence.status === "passed") {
    process.stdout.write(`\nState cutover rehearsal passed. Evidence: ${evidencePath}\n`);
  }
}
