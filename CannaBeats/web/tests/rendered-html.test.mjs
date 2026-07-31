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
  assert.match(page, /joinUrl\.pathname = `\/join\/\$\{room\.code\}`/);
});

test("QR players get a focused name entry page", async () => {
  const join = await readFile(new URL("../app/join/[code]/join-room.tsx", import.meta.url), "utf8");

  assert.match(join, /What should we call you\?/);
  assert.match(join, /action: "join"/);
  assert.match(join, /sessionStorage\.setItem\(SESSION_KEY/);
  assert.match(join, /window\.location\.replace\("\/"\)/);
  assert.doesNotMatch(join, /Host a game/);
});

test("player names persist locally but remain editable", async () => {
  const [join, session, page] = await Promise.all([
    readFile(new URL("../app/join/[code]/join-room.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/session.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(session, /PLAYER_NAME_KEY = "cannabeats-player-name"/);
  assert.match(join, /localStorage\.getItem\(PLAYER_NAME_KEY\)/);
  assert.match(join, /localStorage\.setItem\(PLAYER_NAME_KEY, chosenName\)/);
  assert.match(join, /onChange=\{\(event\) => setName\(event\.target\.value\)\}/);
  assert.match(page, /localStorage\.getItem\(PLAYER_NAME_KEY\)/);
  assert.match(page, /localStorage\.setItem\(PLAYER_NAME_KEY, chosenName\)/);
});

test("room sessions survive reloads and transient connection gaps", async () => {
  const [page, playLan] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../scripts/play-lan.mjs", import.meta.url), "utf8"),
  ]);

  assert.match(page, /setSession\(restored\)/);
  assert.match(page, /Rejoining the room…/);
  assert.match(page, /Your place is saved\. We’ll reconnect automatically\./);
  assert.match(page, /temporarily unavailable\. Retrying…/);
  assert.doesNotMatch(page, /refresh\(restored\)\.catch\(\(\) => sessionStorage\.removeItem/);
  assert.match(playLan, /const persistentState = resolve\(projectRoot, "\.wrangler\/state"\)/);
  assert.match(playLan, /"--persist-to", persistentState/);
});

test("the player game view prioritizes the timeline", async () => {
  const [page, styles] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(page, /className="player-header"/);
  assert.match(page, /Place the mystery song/);
  assert.match(page, /Earlier than \$\{player\.timeline\[0\]\.year\}/);
  assert.match(page, /Later than \$\{player\.timeline\[index - 1\]\.year\}/);
  assert.match(page, /Between \$\{player\.timeline\[index - 1\]\.year\} and \$\{player\.timeline\[index\]\.year\}/);
  assert.doesNotMatch(page, /\+ Place here/);
  assert.match(styles, /\.timeline-gap \{[^}]*color: var\(--green\)/);
  assert.doesNotMatch(styles, /\.timeline-gap \{[^}]*color: transparent/);
  assert.match(page, /Room \$\{room\.code\} · Leave/);
  assert.doesNotMatch(page, /<p className="step-label">Your timeline<\/p>/);
  assert.doesNotMatch(page, /Listen closely — you’re up later/);
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

test("either side of a matching year is accepted", async () => {
  const route = await readFile(new URL("../app/api/game/route.ts", import.meta.url), "utf8");

  assert.match(route, /previous\.year <= state\.currentSong\.year/);
  assert.match(route, /state\.currentSong\.year <= next\.year/);
});

test("a locked placement is shown and can be retracted once", async () => {
  const [page, styles, route, game] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../app/api/game/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/game.ts", import.meta.url), "utf8"),
  ]);

  assert.match(game, /retractionUsed: boolean/);
  assert.match(page, /Mystery song locked here/);
  assert.match(page, /Retract placement/);
  assert.match(page, /className="host-timeline"/);
  assert.match(page, /\{activePlayer\.name\}’s timeline/);
  assert.match(page, /locked=\{room\.placement\}/);
  assert.match(styles, /\.host-timeline/);
  assert.match(page, /action: "retract"/);
  assert.match(route, /if \(state\.retractionUsed\)/);
  assert.match(route, /state\.retractionUsed = true/);
  assert.match(route, /state\.retractionUsed = false/);
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
  assert.match(player, /\/v1\/me\/player\/pause\?device_id=/);
  assert.match(player, /keepalive: true/);
  assert.match(player, /addEventListener\("pagehide", handlePageExit\)/);
  assert.match(page, /if \(room\?\.isHost\) void spotify\.stop\(\)/);
});
