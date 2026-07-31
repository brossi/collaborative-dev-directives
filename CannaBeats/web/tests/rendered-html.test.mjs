import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

async function textFilesWithin(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return textFilesWithin(path);
    return /\.(?:html|js|json|rsc)$/.test(entry.name) ? [path] : [];
  }));
  return nested.flat();
}

test("entry screen contains the host and player paths", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(page, /CannaBeats/);
  assert.match(page, /Host a game/);
  assert.match(page, /Join a game/);
  assert.match(page, /Lock placement/);
  assert.match(page, /Scan to join/);
  assert.match(page, /searchParams\.set\("room", room\.code\)/);
});

test("starter preview metadata and UI are gone", async () => {
  const [page, layout] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(page, /SkeletonPreview/);
  assert.doesNotMatch(layout, /codex-preview/);
});

test("the song catalogue remains in the server bundle", async () => {
  const clientDirectory = fileURLToPath(new URL("../dist/client/", import.meta.url));
  const clientFiles = await textFilesWithin(clientDirectory);
  const clientBundle = (await Promise.all(clientFiles.map((file) => readFile(file, "utf8")))).join("\n");

  assert.equal(clientFiles.some((file) => basename(file) === "catalog.json"), false);
  assert.doesNotMatch(clientBundle, /spotify:track:/);
  assert.doesNotMatch(clientBundle, /The playable catalogue is exhausted/);

  const serverBundle = await readFile(new URL("../dist/server/index.js", import.meta.url), "utf8");
  assert.match(serverBundle, /spotify:track:/);
  assert.match(serverBundle, /The playable catalogue is exhausted/);
});

test("blind song data is removed from player room views", async () => {
  const route = await readFile(new URL("../app/api/game/route.ts", import.meta.url), "utf8");

  assert.match(route, /const \{ usedUris: _usedUris, \.\.\.view \} = state/);
  assert.match(route, /const mayRevealSong = isHost \|\| state\.phase === "revealed" \|\| state\.phase === "finished"/);
  assert.match(route, /currentSong: mayRevealSong \? state\.currentSong : null/);
});

test("the host uses blind in-browser Spotify playback", async () => {
  const [page, player] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/use-spotify-player.ts", import.meta.url), "utf8"),
  ]);

  assert.doesNotMatch(page, /Open in Spotify/);
  assert.match(page, /Pause mystery song/);
  assert.match(page, /spotify\.play\(payload\.room\.currentSong\.uri\)/);
  assert.match(player, /https:\/\/sdk\.scdn\.co\/spotify-player\.js/);
  assert.match(player, /enableMediaSession: false/);
  assert.match(player, /\/v1\/me\/player\/play\?device_id=/);
});
