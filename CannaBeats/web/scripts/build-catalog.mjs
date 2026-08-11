import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const catalogRoot = resolve(argument("catalog-root", resolve(projectRoot, "../catalog")));
const outputDirectory = resolve(argument("output-directory", resolve(projectRoot, "data")));
const outputFile = resolve(outputDirectory, "catalog.json");
const manifestFile = resolve(outputDirectory, "catalog-manifest.json");
const checkOnly = process.argv.includes("--check");
let overrideContent = "{}";
try {
  overrideContent = await readFile(resolve(catalogRoot, "release-overrides.json"), "utf8");
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
const releaseOverrides = JSON.parse(overrideContent);

// years/ before themes/ on purpose: both may hold the same recording, and the
// year in years/ is the hand-verified chart year. Theme modules date a song to
// the work that carries it (an Oscar ceremony, a Broadway opening), which is a
// different — and for a timeline game, wrong — answer for the same audio.
const sourceDirectories = ["years", "themes"];
const playableUri = /^spotify:track:[0-9A-Za-z]{22}$/;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizedText(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function normalizedArtist(value) {
  return normalizedText(value).split(" ")
    .filter((token) => !["and", "with", "feat", "featuring"].includes(token))
    .join(" ");
}

function sameRecording(left, right) {
  return normalizedText(left.title) === normalizedText(right.title)
    && normalizedArtist(left.artist) === normalizedArtist(right.artist);
}

function acceptedArtistVariant(uri, left, right) {
  const override = releaseOverrides.acceptedArtistVariants?.[uri];
  if (!override || normalizedText(override.title) !== normalizedText(left.title)
      || normalizedText(left.title) !== normalizedText(right.title)
      || !Array.isArray(override.artists) || !override.reason) return false;
  const accepted = new Set(override.artists.map(normalizedArtist));
  return accepted.has(normalizedArtist(left.artist)) && accepted.has(normalizedArtist(right.artist));
}

function rejectedMapping(song) {
  return (releaseOverrides.rejectedMappings ?? []).find((rejected) =>
    rejected.uri === song.uri
    && normalizedText(rejected.title) === normalizedText(song.title)
    && normalizedArtist(rejected.artist) === normalizedArtist(song.artist)
    && rejected.year === song.year);
}

async function modulesIn(directoryName) {
  const directory = resolve(catalogRoot, directoryName);
  const files = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();
  return Promise.all(files.map(async (file) => {
    const content = await readFile(resolve(directory, file), "utf8");
    return {
      label: `${directoryName}/${file}`,
      directoryName,
      file,
      theme: directoryName === "themes" ? file.replace(/\.json$/, "") : null,
      content,
      catalogModule: JSON.parse(content),
    };
  }));
}

const modules = [];
for (const directoryName of sourceDirectories) modules.push(...await modulesIn(directoryName));

const failures = [];
const acceptedDifferences = [];
const byUri = new Map();
const byIdentity = new Map();
const coverage = {
  years: { sourceEntries: 0, playableEntries: 0 },
  themes: { sourceEntries: 0, playableEntries: 0 },
};
const sourceHash = createHash("sha256");
sourceHash.update("release-overrides.json").update("\0").update(overrideContent).update("\0");

for (const sourceModule of modules) {
  sourceHash.update(sourceModule.label).update("\0").update(sourceModule.content).update("\0");
  if (!Array.isArray(sourceModule.catalogModule?.songs)) {
    failures.push(`${sourceModule.label}: songs must be an array`);
    continue;
  }
  let playableCount = 0;
  for (const [index, song] of sourceModule.catalogModule.songs.entries()) {
    coverage[sourceModule.directoryName].sourceEntries += 1;
    const location = `${sourceModule.label} songs[${index}]`;
    if (typeof song.title !== "string" || !song.title.trim()) failures.push(`${location}: title is required`);
    if (typeof song.artist !== "string" || !song.artist.trim()) failures.push(`${location}: artist is required`);
    if (!Number.isInteger(song.year) || song.year < 1900 || song.year > 2100) {
      failures.push(`${location}: year must be an integer between 1900 and 2100`);
    }
    if (sourceModule.directoryName === "years" && song.year !== Number(sourceModule.file.replace(/\.json$/, ""))) {
      failures.push(`${location}: year ${song.year} does not match ${sourceModule.file}`);
    }
    if (song.releaseYear !== undefined
        && (!Number.isInteger(song.releaseYear) || song.releaseYear < 1870 || song.releaseYear > 2100)) {
      failures.push(`${location}: releaseYear must be an integer between 1870 and 2100`);
    }
    if (song.uri === null || song.uri === undefined) continue;
    if (typeof song.uri !== "string" || !playableUri.test(song.uri)) {
      failures.push(`${location}: playable URI is invalid`);
      continue;
    }
    const rejected = rejectedMapping(song);
    if (rejected) {
      failures.push(`${location}: known wrong-track mapping ${song.uri} (${rejected.reason})`);
      continue;
    }
    playableCount += 1;
    coverage[sourceModule.directoryName].playableEntries += 1;
    const identity = `${normalizedText(song.title)}|${normalizedArtist(song.artist)}|${song.year}`;
    const identityUri = byIdentity.get(identity);
    if (identityUri && identityUri.uri !== song.uri) {
      failures.push(`${location}: ${song.title} / ${song.artist} (${song.year}) maps to both ${identityUri.uri} and ${song.uri}`);
    } else if (!identityUri) {
      byIdentity.set(identity, { uri: song.uri, label: sourceModule.label });
    }

    const seen = byUri.get(song.uri);
    if (seen) {
      if (sourceModule.theme && !seen.song.themes?.includes(sourceModule.theme)) {
        seen.song.themes = [...(seen.song.themes ?? []), sourceModule.theme];
      }
      const metadataDiffers = seen.song.year !== song.year
        || normalizedText(seen.song.title) !== normalizedText(song.title)
        || normalizedArtist(seen.song.artist) !== normalizedArtist(song.artist);
      if (metadataDiffers) {
        const chartToThemeDifference = seen.directoryName === "years"
          && sourceModule.directoryName === "themes"
          && sameRecording(seen.song, song);
        const reviewedArtistDifference = seen.song.year === song.year
          && acceptedArtistVariant(song.uri, seen.song, song);
        if (chartToThemeDifference || reviewedArtistDifference) {
          acceptedDifferences.push({ uri: song.uri, kept: seen.label, theme: sourceModule.label });
        } else {
          failures.push(
            `${song.uri}: conflicting recording metadata between ${seen.label} `
            + `(${seen.song.title} / ${seen.song.artist} / ${seen.song.year}) and ${sourceModule.label} `
            + `(${song.title} / ${song.artist} / ${song.year})`,
          );
        }
      }
      continue;
    }
    byUri.set(song.uri, {
      label: sourceModule.label,
      directoryName: sourceModule.directoryName,
      song: {
        title: song.title,
        artist: song.artist,
        year: song.year,
        ...(Number.isInteger(song.releaseYear) ? { releaseYear: song.releaseYear } : {}),
        ...(sourceModule.theme ? { themes: [sourceModule.theme] } : {}),
        uri: song.uri,
      },
    });
  }
  if (playableCount === 0) failures.push(`${sourceModule.label}: module has no playable recordings`);
}

if (failures.length) {
  for (const failure of failures) console.error(`CATALOG RELEASE BLOCKED: ${failure}`);
  throw new Error(`Catalog release validation failed with ${failures.length} error(s)`);
}

const songs = [...byUri.values()].map((entry) => entry.song);
const serializedCatalog = `${JSON.stringify(songs)}\n`;
const coverageWithPercent = Object.fromEntries(Object.entries(coverage).map(([group, values]) => [group, {
  ...values,
  percentPlayable: values.sourceEntries
    ? Math.round(values.playableEntries * 10_000 / values.sourceEntries) / 100
    : 0,
}]));
const manifest = {
  schemaVersion: 1,
  catalogVersion: `sha256:${sha256(serializedCatalog)}`,
  sourceVersion: `sha256:${sourceHash.digest("hex")}`,
  songCount: songs.length,
  moduleCount: modules.length,
  acceptedChartThemeDifferences: acceptedDifferences.length,
  rejectedKnownWrongMappings: (releaseOverrides.rejectedMappings ?? []).length,
  coverage: coverageWithPercent,
  sourceDirectories,
};
const serializedManifest = `${JSON.stringify(manifest, null, 2)}\n`;

if (checkOnly) {
  const [deployedCatalog, deployedManifest] = await Promise.all([
    readFile(outputFile, "utf8"),
    readFile(manifestFile, "utf8"),
  ]);
  if (deployedCatalog !== serializedCatalog || deployedManifest !== serializedManifest) {
    throw new Error("Built catalog differs from the checked-in catalog release; run npm run catalog");
  }
  console.log(`Catalog release ${manifest.catalogVersion} is current (${songs.length} playable songs)`);
} else {
  await mkdir(outputDirectory, { recursive: true });
  const catalogCandidate = resolve(outputDirectory, `.catalog.json.${process.pid}.tmp`);
  const manifestCandidate = resolve(outputDirectory, `.catalog-manifest.json.${process.pid}.tmp`);
  await Promise.all([
    writeFile(catalogCandidate, serializedCatalog),
    writeFile(manifestCandidate, serializedManifest),
  ]);
  await Promise.all([
    rename(catalogCandidate, outputFile),
    rename(manifestCandidate, manifestFile),
  ]);
  console.log(`Wrote catalog release ${manifest.catalogVersion} with ${songs.length} playable songs`);
}
