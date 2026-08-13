#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const composeDirectory = resolve(new URL("..", import.meta.url).pathname);
const rendered = JSON.parse(execFileSync("docker", [
  "compose",
  "-f", "compose.yaml",
  "-f", "compose.state-cutover.yaml",
  "--profile", "state-cutover",
  "--profile", "operations",
  "config", "--format", "json",
], {
  cwd: composeDirectory,encoding: "utf8",
  env: { ...process.env,CANNABEATS_RELEASE_EPOCH: process.env.CANNABEATS_RELEASE_EPOCH ?? "verification" },
}));

const stateVolume = rendered.volumes?.cannabeats_state_data?.name;
if (!stateVolume) throw new Error("The cutover state volume is not defined.");

const mounts = (service) => rendered.services[service]?.volumes ?? [];
const stateWriters = Object.entries(rendered.services).filter(([,service]) =>
  (service.volumes ?? []).some((volume) =>
    volume.source === stateVolume && volume.read_only !== true));
if (stateWriters.length !== 1 || stateWriters[0][0] !== "state") {
  throw new Error(`Runtime state volume writers are invalid: ${stateWriters.map(([name]) => name).join(",")}`);
}
for (const service of ["app","game","history","backup","operator"]) {
  if (mounts(service).some((volume) => volume.source === stateVolume)) {
    throw new Error(`${service} must not mount the state volume.`);
  }
}
const operatorTokenPath = "/run/secrets/cannabeats/state-operator-token";
if (mounts("app").some((volume) => volume.target === operatorTokenPath)) {
  throw new Error("The long-running Access service must not receive State operator authority.");
}
if (!mounts("operator").find((volume) => volume.target === operatorTokenPath)?.read_only
    || !mounts("operator").find((volume) => volume.target === "/data")?.read_only) {
  throw new Error("The bounded operator service must receive operator authority and Access read-only data.");
}
if (mounts("game").some((volume) => volume.target === "/data")) {
  throw new Error("Game must not mount the legacy monolith after cutover.");
}
for (const path of [
  "/run/secrets/cannabeats/game-service-token",
  "/run/secrets/cannabeats/audio-relay-listen-token",
  "/run/secrets/cannabeats/state-game-token",
  "/run/secrets/cannabeats/state-game-principal-assertion-key",
]) {
  const mount = mounts("game").find((volume) => volume.target === path);
  if (!mount?.read_only) throw new Error(`Game credential mount is missing or writable: ${path}`);
}
if (rendered.services.game.environment.CANNABEATS_DATABASE_PATH
    !== "/legacy-state-disabled/cannabeats.sqlite") {
  throw new Error("Game legacy database fail-closed path is not configured.");
}
if (rendered.services.history.environment.CANNABEATS_STATE_SERVICE_ORIGIN !== "http://state:3010") {
  throw new Error("History retention is not routed through State.");
}
if (mounts("history").some((volume) => volume.target === "/data" || volume.target === "/state")) {
  throw new Error("History retention must own no database mount.");
}
if (rendered.services.backup.network_mode === "none"
    || rendered.services.backup.environment.CANNABEATS_STATE_SERVICE_ORIGIN !== "http://state:3010"
    || !rendered.services.backup.entrypoint?.includes("operations/coordinated-backup.mjs")) {
  throw new Error("Backup is not using the coordinated State export contract.");
}
if (!mounts("backup").find((volume) => volume.target === "/data")?.read_only
    || mounts("backup").some((volume) => volume.target === "/state")) {
  throw new Error("Coordinated backup must read Access RO and own no State volume mount.");
}

const migration = JSON.parse(execFileSync("docker", [
  "compose", "-f", "compose.yaml", "--profile", "state-migration",
  "config", "--format", "json",
], { cwd: composeDirectory,encoding: "utf8" }));
const migrator = migration.services["state-migrate"];
const migrationState = migrator.volumes.find((volume) => volume.target === "/state");
const migrationSource = migrator.volumes.find((volume) => volume.target === "/legacy");
if (!migrationState || migrationState.read_only === true || !migrationSource?.read_only) {
  throw new Error("The bounded migrator must own State RW and the legacy source RO.");
}
if (migrator.environment.CANNABEATS_STATE_LOCK_DIRECTORY !== "/state/.locks") {
  throw new Error("Runtime and migration must share the state-volume lock namespace.");
}
if (rendered.services.state.environment.CANNABEATS_STATE_LOCK_DIRECTORY
    !== migrator.environment.CANNABEATS_STATE_LOCK_DIRECTORY) {
  throw new Error("Runtime and migration lock directories differ.");
}

console.log(JSON.stringify({
  stateVolume,
  stateWriter: "state",
  gameDatabaseMounts: mounts("game").filter((volume) => ["/data","/state"].includes(volume.target)),
  historyDatabaseMounts: mounts("history").filter((volume) => ["/data","/state"].includes(volume.target)),
  appHasOperatorAuthority: false,operatorHasBoundedAuthority: true,
  migrationSourceReadOnly: migrationSource.read_only,
}));
