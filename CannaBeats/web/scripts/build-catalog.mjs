import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const catalogRoot = resolve(projectRoot, "../catalog");
const outputDirectory = resolve(projectRoot, "data");
const outputFile = resolve(outputDirectory, "catalog.json");

// years/ before themes/ on purpose: both may hold the same recording, and the
// year in years/ is the hand-verified chart year. Theme modules date a song to
// the work that carries it (an Oscar ceremony, a Broadway opening), which is a
// different — and for a timeline game, wrong — answer for the same audio.
const sourceDirectories = ["years", "themes"];

async function modulesIn(directoryName) {
  const directory = resolve(catalogRoot, directoryName);
  const files = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();
  return Promise.all(files.map(async (file) => ({
    label: `${directoryName}/${file}`,
    theme: directoryName === "themes" ? file.replace(/\.json$/, "") : null,
    catalogModule: JSON.parse(await readFile(resolve(directory, file), "utf8")),
  })));
}

// One entry per URI. A repeat is the same recording reached by a second route,
// and emitting it twice would weight the draw toward whatever the theme
// modules happen to cover.
const byUri = new Map();
const conflicts = [];

for (const directoryName of sourceDirectories) {
  for (const { label, theme, catalogModule } of await modulesIn(directoryName)) {
    for (const song of catalogModule.songs ?? []) {
      if (typeof song.uri !== "string" || !song.uri.startsWith("spotify:track:")) {
        continue;
      }
      const seen = byUri.get(song.uri);
      if (seen) {
        if (theme && !seen.song.themes?.includes(theme)) {
          seen.song.themes = [...(seen.song.themes ?? []), theme];
        }
        // A URI carrying two different years is either a theme module dating
        // the same recording differently, or a genuinely wrong URI on one of
        // the rows. Keeping the first is safe; staying silent is not.
        if (seen.song.year !== song.year || seen.song.title !== song.title) {
          conflicts.push({ kept: seen, dropped: { label, song } });
        }
        continue;
      }
      byUri.set(song.uri, {
        label,
        song: {
          title: song.title,
          artist: song.artist,
          year: song.year,
          // Only present where a source could establish it, so it is omitted
          // rather than nulled — `year` is the answer a card asks for, and
          // this is the second question the same audio can be asked.
          ...(Number.isInteger(song.releaseYear) ? { releaseYear: song.releaseYear } : {}),
          ...(theme ? { themes: [theme] } : {}),
          uri: song.uri,
        },
      });
    }
  }
}

const songs = [...byUri.values()].map((entry) => entry.song);

await mkdir(outputDirectory, { recursive: true });
await writeFile(outputFile, `${JSON.stringify(songs)}\n`);

for (const { kept, dropped } of conflicts) {
  console.warn(
    `WARNING: ${kept.song.uri} kept as "${kept.song.title}" / ${kept.song.artist} `
    + `(${kept.song.year}, ${kept.label}); dropped "${dropped.song.title}" / `
    + `${dropped.song.artist} (${dropped.song.year}, ${dropped.label})`,
  );
}
console.log(`Wrote ${songs.length} playable songs to ${outputFile}`);
