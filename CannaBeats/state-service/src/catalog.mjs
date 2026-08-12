import { readFileSync } from "node:fs";

const ERA_BUCKETS = [
  { id: "early", min: 1920, max: 1949 },
  { id: "midcentury", min: 1950, max: 1969 },
  { id: "classics", min: 1970, max: 1989 },
  { id: "millennial", min: 1990, max: 2009 },
  { id: "current", min: 2010, max: 2026 },
];
const STAGE_AND_SCREEN = new Set([
  "film-soundtracks", "oscar-songs", "tony-musicals", "tv-soundtracks",
]);

function validSong(song) {
  return song && typeof song === "object" && typeof song.title === "string"
    && typeof song.artist === "string" && Number.isSafeInteger(song.year)
    && song.year >= 1920 && song.year <= 2026
    && typeof song.uri === "string" && song.uri.startsWith("spotify:track:");
}

function drawIndex(length, random) {
  const draw = random();
  if (!Number.isFinite(draw) || draw < 0 || draw >= 1) {
    throw new Error("The state-service random source returned an invalid draw.");
  }
  return Math.floor(draw * length);
}

export function createCatalogGameServices(catalog, { random = Math.random } = {}) {
  if (!Array.isArray(catalog) || !catalog.length || !catalog.every(validSong)) {
    throw new Error("The state-service catalog is invalid.");
  }
  const songs = structuredClone(catalog);
  return {
    selectStartingPlayer(playerCount) {
      if (!Number.isSafeInteger(playerCount) || playerCount < 1) {
        throw new Error("The player count is invalid.");
      }
      return drawIndex(playerCount, random);
    },
    selectSong(state) {
      const available = songs.filter((song) => !state.usedUris.includes(song.uri)
        && song.year >= state.rules.minYear && song.year <= state.rules.maxYear
        && (state.rules.catalogScope === "all"
          || song.themes?.some((theme) => STAGE_AND_SCREEN.has(theme))));
      if (!available.length) throw new Error("The playable catalogue is exhausted.");
      const weighted = ERA_BUCKETS.map((era) => ({
        songs: available.filter((song) => song.year >= era.min && song.year <= era.max),
        weight: state.rules.eraWeights[era.id],
      })).filter((bucket) => bucket.songs.length && bucket.weight > 0);
      let candidates = available;
      const totalWeight = weighted.reduce((sum, bucket) => sum + bucket.weight, 0);
      if (totalWeight > 0) {
        let draw = random() * totalWeight;
        if (!Number.isFinite(draw) || draw < 0 || draw >= totalWeight) {
          throw new Error("The state-service random source returned an invalid draw.");
        }
        candidates = (weighted.find((bucket) => {
          draw -= bucket.weight;
          return draw < 0;
        }) ?? weighted.at(-1)).songs;
      }
      return structuredClone(candidates[drawIndex(candidates.length, random)]);
    },
  };
}

export function loadCatalogGameServices(path, options) {
  return createCatalogGameServices(JSON.parse(readFileSync(path, "utf8")), options);
}
