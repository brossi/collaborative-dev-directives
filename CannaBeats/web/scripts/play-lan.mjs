import { readFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const clientIdFile = resolve(projectRoot, "../CannaBeats/Resources/SpotifyClientID.txt");

function lanAddress() {
  const interfaces = networkInterfaces();
  const preferred = interfaces.en0?.find((address) => address.family === "IPv4" && !address.internal);
  if (preferred) return preferred.address;
  for (const addresses of Object.values(interfaces)) {
    const address = addresses?.find((candidate) => candidate.family === "IPv4" && !candidate.internal);
    if (address) return address.address;
  }
  throw new Error("No local network address was found.");
}

const spotifyClientId = (await readFile(clientIdFile, "utf8")).trim();
if (!spotifyClientId) throw new Error("SpotifyClientID.txt is empty.");

const address = lanAddress();
const joinOrigin = `http://${address}:3000`;
const persistentState = resolve(projectRoot, ".wrangler/state");
const environment = {
  ...process.env,
  NEXT_PUBLIC_SPOTIFY_CLIENT_ID: spotifyClientId,
  WRANGLER_LOG_PATH: ".wrangler/wrangler.log",
};

const build = spawnSync("npm", ["run", "build"], {
  cwd: projectRoot,
  env: environment,
  stdio: "inherit",
});
if (build.status !== 0) process.exit(build.status ?? 1);

console.log(`\nHost CannaBeats: http://127.0.0.1:3000`);
console.log(`Player join address: ${joinOrigin}\n`);

const server = spawn("wrangler", [
  "dev",
  "--config", "dist/server/wrangler.json",
  "--ip", "0.0.0.0",
  "--port", "3000",
  "--persist-to", persistentState,
  "--var", `PUBLIC_JOIN_ORIGIN:${joinOrigin}`,
], {
  cwd: projectRoot,
  env: environment,
  stdio: "inherit",
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.kill(signal));
}

server.on("exit", (code) => process.exit(code ?? 0));
