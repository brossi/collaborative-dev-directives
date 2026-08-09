import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);

const SCRIPT = fileFrom("../scripts/build-catalog.mjs");
const OUTPUT = fileFrom("../data/catalog.json");
const SOURCE_ROOT = new URL("../../catalog/", import.meta.url);

function fileFrom(relative) {
  return new URL(relative, import.meta.url).pathname;
}

/** Every playable song in a source directory, in the order the build sees it. */
async function playableIn(directoryName) {
  const directory = new URL(`${directoryName}/`, SOURCE_ROOT);
  const files = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();
  const songs = [];
  for (const file of files) {
    const catalogModule = JSON.parse(await readFile(new URL(file, directory), "utf8"));
    for (const song of catalogModule.songs ?? []) {
      if (typeof song.uri === "string" && song.uri.startsWith("spotify:track:")) {
        songs.push(song);
      }
    }
  }
  return songs;
}

async function build() {
  await run(process.execPath, [SCRIPT]);
  return JSON.parse(await readFile(OUTPUT, "utf8"));
}

test("the built catalogue includes songs that exist only in catalog/themes", async () => {
  const built = await build();
  const yearUris = new Set((await playableIn("years")).map((song) => song.uri));
  const themeOnly = (await playableIn("themes"))
    .filter((song) => !yearUris.has(song.uri))
    .map((song) => song.uri);

  // Guard the guard: if this is ever empty the assertion below passes vacuously.
  assert.ok(themeOnly.length > 0, "no theme-only songs in source — test proves nothing");

  const builtUris = new Set(built.map((song) => song.uri));
  const missing = themeOnly.filter((uri) => !builtUris.has(uri));
  assert.deepEqual(missing, [], `${missing.length} theme-only songs missing from the build`);
});

test("the built catalogue holds each playable URI exactly once", async () => {
  const built = await build();
  const counts = new Map();
  for (const song of built) counts.set(song.uri, (counts.get(song.uri) ?? 0) + 1);
  const repeated = [...counts.entries()].filter(([, n]) => n > 1);
  assert.deepEqual(repeated, [], "duplicate URIs skew draw probability");

  const expected = new Set([
    ...(await playableIn("years")).map((song) => song.uri),
    ...(await playableIn("themes")).map((song) => song.uri),
  ]);
  assert.equal(built.length, expected.size);
});

test("catalog/years wins the year when a URI appears in both directories", async () => {
  const built = await build();
  const byUri = new Map(built.map((song) => [song.uri, song]));
  const yearRows = await playableIn("years");
  const yearByUri = new Map();
  for (const song of yearRows) if (!yearByUri.has(song.uri)) yearByUri.set(song.uri, song);

  const themeRows = await playableIn("themes");
  const contested = themeRows.filter(
    (song) => yearByUri.has(song.uri) && yearByUri.get(song.uri).year !== song.year,
  );
  assert.ok(contested.length > 0, "no contested years in source — test proves nothing");

  for (const themeSong of contested) {
    assert.equal(
      byUri.get(themeSong.uri).year,
      yearByUri.get(themeSong.uri).year,
      `${themeSong.title}: chart year from catalog/years must win over the theme module`,
    );
  }
});

test("every built entry carries the four fields the game reads", async () => {
  const built = await build();
  assert.ok(built.length > 0);
  for (const song of built) {
    assert.equal(typeof song.title, "string", `bad title on ${song.uri}`);
    assert.equal(typeof song.artist, "string", `bad artist on ${song.uri}`);
    assert.equal(Number.isInteger(song.year), true, `bad year on ${song.uri}`);
    assert.match(song.uri, /^spotify:track:[0-9A-Za-z]{22}$/);
  }
});
