import { readFileSync } from 'node:fs';

import { CATALOG_VERSION_PATTERN, canonicalJson, sha256 } from './canonical.mjs';

const SPOTIFY_URI = /^spotify:track:[0-9A-Za-z]{22}$/u;

export function finiteCatalogSong(song) {
  const keys = song && typeof song === 'object' && !Array.isArray(song)
    ? Object.keys(song).sort() : [];
  const allowed = new Set(['artist', 'releaseYear', 'themes', 'title', 'uri', 'year']);
  return song && typeof song === 'object' && !Array.isArray(song)
    && keys.every((key) => allowed.has(key))
    && typeof song.title === 'string' && song.title.length > 0 && song.title.length <= 200
    && typeof song.artist === 'string' && song.artist.length > 0 && song.artist.length <= 200
    && Number.isSafeInteger(song.year) && song.year >= 1900 && song.year <= 2100
    && SPOTIFY_URI.test(song.uri)
    && (song.releaseYear === undefined
      || (Number.isSafeInteger(song.releaseYear) && song.releaseYear >= 1870
        && song.releaseYear <= 2100))
    && (song.themes === undefined
      || (Array.isArray(song.themes) && new Set(song.themes).size === song.themes.length
        && song.themes.every((theme) =>
          typeof theme === 'string' && theme.length > 0 && theme.length <= 100)));
}

export function validateCatalogArtifacts(catalogText, manifestText) {
  let catalog;
  let manifest;
  try {
    catalog = JSON.parse(catalogText);
    manifest = JSON.parse(manifestText);
  } catch {
    throw new Error('catalog_incompatible');
  }
  if (!Array.isArray(catalog) || catalog.length === 0 || !catalog.every(finiteCatalogSong)) {
    throw new Error('catalog_incompatible');
  }
  const identities = new Set(catalog.map(({ uri }) => uri));
  if (identities.size !== catalog.length
      || !manifest || typeof manifest !== 'object' || Array.isArray(manifest)
      || manifest.schemaVersion !== 1
      || !CATALOG_VERSION_PATTERN.test(manifest.catalogVersion)
      || manifest.catalogVersion !== `sha256:${sha256(catalogText)}`
      || !CATALOG_VERSION_PATTERN.test(manifest.sourceVersion)
      || manifest.songCount !== catalog.length
      || !Number.isSafeInteger(manifest.moduleCount) || manifest.moduleCount <= 0) {
    throw new Error('catalog_incompatible');
  }
  const songs = Object.freeze(catalog.map((song) => Object.freeze(structuredClone(song))));
  return Object.freeze({
    version: manifest.catalogVersion,
    artifactDigest: sha256(catalogText),
    sourceVersion: manifest.sourceVersion,
    songCount: catalog.length,
    manifest: canonicalJson(manifest),
    entriesDigest: sha256(canonicalJson(songs.toSorted((left, right) =>
      left.uri < right.uri ? -1 : left.uri > right.uri ? 1 : 0))),
    songs,
  });
}

export function loadCatalogArtifacts({ catalogPath, manifestPath, read = readFileSync }) {
  let catalogText;
  let manifestText;
  try {
    catalogText = read(/* turbopackIgnore: true */ catalogPath, 'utf8');
    manifestText = read(/* turbopackIgnore: true */ manifestPath, 'utf8');
  } catch {
    throw new Error('catalog_incompatible');
  }
  return validateCatalogArtifacts(catalogText, manifestText);
}
