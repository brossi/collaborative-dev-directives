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
  assert.match(page, /lockedPlacement=\{room\.phase === "placed" \? room\.placement : null\}/);
  assert.match(page, /host-mystery-card/);
  assert.match(styles, /\.host-mystery-card/);
  assert.match(page, /action: "retract"/);
  assert.match(route, /if \(state\.retractionUsed\)/);
  assert.match(route, /if \(!state\.rules\.allowRetraction\)/);
  assert.match(route, /state\.retractionUsed = true/);
  assert.match(route, /state\.retractionUsed = false/);
});

test("host game setup retains persisted presets and uses weighted era selection", async () => {
  const [page, route, game, rules, session, styles] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/game/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/game.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/rules.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/session.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(game, /rules: GameRules/);
  assert.match(rules, /family: \{/);
  assert.match(rules, /early: 5, midcentury: 10, classics: 25, millennial: 30, current: 30/);
  assert.match(rules, /"all-eras"/);
  assert.match(rules, /modern:/);
  assert.match(rules, /younger:/);
  assert.match(page, /function GameSetup/);
  assert.match(page, /Advanced settings/);
  assert.match(page, /Relative era weighting/);
  assert.match(page, /Apply custom rules/);
  assert.match(session, /HOST_RULES_KEY = "cannabeats-host-rules"/);
  assert.match(page, /localStorage\.setItem\(HOST_RULES_KEY, hostRules\)/);
  assert.match(page, /gameRequest\(\{ action: "create", rules: rememberedHostRules\(\) \}\)/);
  assert.match(styles, /\.preset-grid/);
  assert.match(route, /rules: normalizeRules\(payload\.rules \?\? DEFAULT_GAME_RULES\)/);
  assert.match(route, /action === "rules"/);
  assert.match(route, /Rules are locked after the game starts/);
  assert.match(route, /song\.year >= state\.rules\.minYear/);
  assert.match(route, /state\.rules\.eraWeights\[era\.id\]/);
  assert.match(route, /Math\.random\(\) \* totalWeight/);
  assert.match(route, /player\.timeline\.length >= state\.rules\.targetScore/);
});

test("a random player starts each game", async () => {
  const route = await readFile(new URL("../app/api/game/route.ts", import.meta.url), "utf8");

  assert.match(route, /state\.activePlayerIndex = Math\.floor\(Math\.random\(\) \* state\.players\.length\)/);
  assert.match(route, /state\.activePlayerId = state\.players\[state\.activePlayerIndex\]\.id/);
  assert.doesNotMatch(route, /state\.activePlayerIndex = 0/);
});

test("the first round waits for the host before playback", async () => {
  const [page, route, game] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/game/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/game.ts", import.meta.url), "utf8"),
  ]);

  assert.match(game, /"lobby" \| "ready" \| "playing"/);
  assert.match(route, /if \(action === "start"\)[\s\S]*state\.phase = "ready"/);
  assert.match(route, /if \(action === "begin"\)[\s\S]*state\.phase = "playing"/);
  assert.match(page, /Set up game/);
  assert.match(page, /Start first song/);
  assert.match(page, /action: "start", hostToken: session\.hostToken \}\)/);
  assert.match(page, /action: "begin", hostToken: session\.hostToken \}, true/);
  assert.match(page, /goes first/);
});

test("every game supports phone and host-controlled players", async () => {
  const [page, route, game, styles] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/game/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/game.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(game, /export type PlayerControl = "phone" \| "host"/);
  assert.match(game, /control: PlayerControl/);
  assert.doesNotMatch(game, /export type InputMode/);
  assert.doesNotMatch(game, /inputMode: InputMode/);
  assert.match(route, /player\.control = normalizePlayerControl\(player\.control, state\.inputMode\)/);
  assert.match(route, /delete state\.inputMode/);
  assert.doesNotMatch(route, /inputMode: normalizeInputMode\(payload\.inputMode\)/);
  assert.match(route, /action === "addPlayer"/);
  assert.match(route, /action === "removePlayer"/);
  assert.match(route, /control: "phone" as const/);
  assert.match(route, /control: "host" as const/);
  assert.match(route, /const hostIsPlacing = player\?\.control === "host"/);
  assert.match(route, /const activePlayerIsPlacing = player\?\.control === "phone"/);
  assert.match(route, /const hostIsRetracting = player\?\.control === "host"/);
  assert.match(route, /if \(action === "skip"\)[\s\S]*state\.round \+= 1/);
  assert.match(page, /Create game/);
  assert.doesNotMatch(page, /Mix phones \+ this screen/);
  assert.doesNotMatch(page, /room\.inputMode/);
  assert.match(page, /className="host-player-form"/);
  assert.match(page, /className="join-invite"/);
  assert.match(page, /player-control-badge/);
  assert.match(page, /hostControlsActivePlayer/);
  assert.match(page, /className=\{`host-placement-gap/);
  assert.match(page, /action: "place", hostToken: session\.hostToken/);
  assert.match(page, /Change placement/);
  assert.match(styles, /\.host-placement-gap/);
  assert.match(page, /className="host-row-lock"/);
  assert.match(styles, /\.host-row-lock/);
  assert.doesNotMatch(page, /host-placement-controls/);
  assert.doesNotMatch(styles, /\.host-placement-controls/);
});

test("the host scoreboard shows chronological Spotify timeline rows", async () => {
  const [page, styles, spotify] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../lib/use-spotify-player.ts", import.meta.url), "utf8"),
  ]);

  assert.match(page, /function HostScoreboard/);
  assert.match(page, /players\.map\(\(player\)/);
  assert.doesNotMatch(page, /Earlier <span aria-hidden="true">→<\/span> Later/);
  assert.match(page, /<span>Round \{round\}<\/span>/);
  assert.match(page, /className="host-round-bar"/);
  assert.match(page, /className="host-brand-icon"/);
  assert.match(page, /activeTrackRef/);
  assert.match(page, /track\.scrollTo/);
  assert.doesNotMatch(page, /Spotify ↗/);
  assert.match(page, /artwork\.imageUrl/);
  assert.match(page, /\{song\.title\}/);
  assert.match(page, /\{song\.artist\}/);
  assert.match(page, /\{song\.year\}/);
  assert.match(styles, /\.host-timeline-track \{[^}]*display: flex/);
  assert.match(styles, /\.host-round-bar \{[^}]*grid-template-columns: 104px/);
  assert.match(styles, /\.host-round-bar \{[^}]*position: sticky/);
  assert.match(styles, /\.host-song-card \{[^}]*scroll-snap-align: center/);
  assert.match(styles, /\.host-song-art img \{[^}]*object-fit: contain/);
  assert.match(spotify, /https:\/\/api\.spotify\.com\/v1\/tracks\/\$\{encodeURIComponent\(trackId\)\}/);
  assert.doesNotMatch(spotify, /\/v1\/tracks\?ids=/);
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
