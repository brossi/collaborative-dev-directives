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

async function releaseSources() {
  return Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/release-game-client.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/server/release/game-journey.mjs", import.meta.url), "utf8"),
    readFile(new URL("../lib/server/release/game-state.mjs", import.meta.url), "utf8"),
  ]);
}

test("the unified entry screen exposes only Host authorization and invitation admission", async () => {
  const [page, client] = await releaseSources();
  assert.match(page, /A family music timeline game/);
  assert.match(page, /Host a game/);
  assert.match(page, /Join the game/);
  assert.match(page, /Open this screen from the CannaBeats Host app/);
  assert.match(page, /new URLSearchParams\(window\.location\.hash\.replace\(\/\^#\/u, ""\)\)/);
  assert.match(page, /url\.hash = new URLSearchParams\(\{ invite: issued\.inviteToken \}\)/);
  assert.match(client, /exchangeHostTicket/);
  assert.match(client, /"\/api\/host\/web-tickets\/exchange"/);
  assert.doesNotMatch(page, /managed source|VNC|Tailscale/i);
});

test("participant identity and unfinished-game recovery survive ordinary browser restarts", async () => {
  const [page, client] = await releaseSources();
  assert.match(page, /localStorage\.getItem\(PLAYER_NAME_KEY\)/);
  assert.match(page, /localStorage\.setItem\(PLAYER_NAME_KEY, name\.trim\(\)\)/);
  assert.match(page, /recoverParticipantGame/);
  assert.match(page, /recoverHostGame/);
  assert.match(client, /"\/api\/games\/participant-recovery"/);
  assert.match(client, /"\/api\/games\/recovery"/);
  assert.doesNotMatch(page, /game timeout|inactive|expires in/i);
});

test("retryable journey commands retain one exact revision-bound action", async () => {
  const [page, client] = await releaseSources();
  assert.match(page, /savePendingReleaseAction\(localStorage, intent\)/);
  assert.match(page, /loadPendingReleaseAction\(localStorage\)/);
  assert.match(page, /reconcile\(pending\)/);
  assert.match(client, /expectedRevision, gameId: session\.gameId, operation, payload/);
  assert.match(client, /body: JSON\.stringify\(\{\s*expectedRevision: intent\.expectedRevision/);
  assert.match(client, /\[RELEASE_GAME_ROLE_HEADER\]: intent\.role/);
  assert.ok(page.indexOf("if (pendingRecovery)")
    < page.indexOf("if (gameId && inviteToken)"));
});

test("the participant journey prioritizes placement and its retained timeline", async () => {
  const [page] = await releaseSources();
  assert.match(page, /Place the mystery song/);
  assert.match(page, /Earlier than \$\{player\.timeline\[0\]/);
  assert.match(page, /Later than \$\{player\.timeline\[index - 1\]/);
  assert.match(page, /Between \$\{player\.timeline\[index - 1\]\.year\} and \$\{player\.timeline\[index\]\.year\}/);
  assert.match(page, /act\("place_song", \{ index: selected \}\)/);
  assert.match(page, /act\("retract_placement"\)/);
  assert.match(page, /session\.role === "participant" && currentPlayer/);
});

test("Host setup and mixed-control lobby use the fixed release journey", async () => {
  const [page, client, journey] = await releaseSources();
  assert.match(page, /Advanced settings/);
  assert.match(page, /className="host-player-form"/);
  assert.match(page, /className="join-invite"/);
  assert.match(page, /add_host_player/);
  assert.match(page, /remove_host_player/);
  assert.match(page, /start_game/);
  assert.match(page, /begin_round/);
  assert.match(page, /skip_track/);
  assert.match(journey, /configure_game/);
  assert.match(journey, /control: 'host'/);
  assert.match(client, /control: "host" \| "phone"/);
  assert.doesNotMatch(page, /room\.inputMode|managedPlaybackActive/);
});

test("answer metadata appears only in reveal-aware UI and projections", async () => {
  const [page, client, journey] = await releaseSources();
  assert.match(page, /state\.phase === "placed"/);
  assert.match(page, /Reveal answer/);
  assert.match(page, /state\.phase === "revealed"/);
  assert.match(page, /state\.currentSong\.year/);
  assert.match(client, /role === "participant"/);
  assert.match(client, /const answerKeys = \["currentSong", "placement", "result"\]/);
  assert.match(journey, /function projectGameState/);
  assert.match(journey, /const revealed = \['revealed', 'finished'\]\.includes\(state\.phase\)/);
});

test("playback authority is honestly assigned to the native Host app", async () => {
  const [page] = await releaseSources();
  assert.match(page, /Spotify playback is performed by the CannaBeats Host app/);
  assert.doesNotMatch(page, /spotify\.play|useSpotifyPlayer|HostDiagnosticsPanel/);
});

test("completion names the winner and creates a fresh game instead of reusing identity", async () => {
  const [page, client] = await releaseSources();
  assert.match(page, /That’s the timeline/);
  assert.match(page, /\{winner\.name\} wins!/);
  assert.match(page, /createGame\(state\.rules\)/);
  assert.match(page, /Play again/);
  assert.match(client, /gameId: uuid\(\), requestId: uuid\(\)/);
});

test("starter preview metadata and UI are absent", async () => {
  const [page, layout] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(page, /SkeletonPreview/);
  assert.doesNotMatch(layout, /codex-preview/);
});

test("the song catalogue remains server-only in the production bundle", async () => {
  const clientDirectory = fileURLToPath(new URL("../.next/static/", import.meta.url));
  const clientFiles = await textFilesWithin(clientDirectory);
  const clientBundle = (await Promise.all(clientFiles.map((file) => readFile(file, "utf8")))).join("\n");
  assert.equal(clientFiles.some((file) => basename(file) === "catalog.json"), false);
  assert.doesNotMatch(clientBundle, /spotify:track:/);
  assert.doesNotMatch(clientBundle, /The playable catalogue is exhausted/);

  const serverDirectory = fileURLToPath(new URL("../.next/server/", import.meta.url));
  const serverFiles = await textFilesWithin(serverDirectory);
  const serverBundle = (await Promise.all(serverFiles.map((file) => readFile(file, "utf8")))).join("\n");
  assert.match(serverBundle, /spotify:track:/);
  assert.match(serverBundle, /The playable catalogue is exhausted/);
});
