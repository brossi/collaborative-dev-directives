import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceDirectory = resolve(projectRoot, "../catalog/years");
const outputDirectory = resolve(projectRoot, "data");
const outputFile = resolve(outputDirectory, "catalog.json");

const files = (await readdir(sourceDirectory))
  .filter((name) => name.endsWith(".json"))
  .sort();

const songs = [];
for (const file of files) {
  const catalogModule = JSON.parse(await readFile(resolve(sourceDirectory, file), "utf8"));
  for (const song of catalogModule.songs ?? []) {
    if (typeof song.uri !== "string" || !song.uri.startsWith("spotify:track:")) {
      continue;
    }
    songs.push({
      title: song.title,
      artist: song.artist,
      year: song.year,
      uri: song.uri,
    });
  }
}

await mkdir(outputDirectory, { recursive: true });
await writeFile(outputFile, `${JSON.stringify(songs)}\n`);
console.log(`Wrote ${songs.length} playable songs to ${outputFile}`);
