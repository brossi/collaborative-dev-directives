export const CATALOG_YEAR_MIN = 1920;
export const CATALOG_YEAR_MAX = 2026;

export const ERA_BUCKETS = [
  { id: "early", label: "1920–1949", min: 1920, max: 1949 },
  { id: "midcentury", label: "1950–1969", min: 1950, max: 1969 },
  { id: "classics", label: "1970–1989", min: 1970, max: 1989 },
  { id: "millennial", label: "1990–2009", min: 1990, max: 2009 },
  { id: "current", label: "2010–present", min: 2010, max: CATALOG_YEAR_MAX },
] as const;

export type EraId = typeof ERA_BUCKETS[number]["id"];
export type CatalogScope = "all" | "broadway-tv-movies";
export type RulesPreset = "family" | "all-eras" | "modern" | "younger" | "broadway-tv-movies" | "custom";

export type GameRules = {
  preset: RulesPreset;
  minYear: number;
  maxYear: number;
  eraWeights: Record<EraId, number>;
  targetScore: number;
  allowRetraction: boolean;
  catalogScope: CatalogScope;
};

const PRESETS: Record<Exclude<RulesPreset, "custom">, Omit<GameRules, "preset">> = {
  family: {
    minYear: CATALOG_YEAR_MIN,
    maxYear: CATALOG_YEAR_MAX,
    eraWeights: { early: 5, midcentury: 10, classics: 25, millennial: 30, current: 30 },
    targetScore: 10,
    allowRetraction: true,
    catalogScope: "all",
  },
  "all-eras": {
    minYear: CATALOG_YEAR_MIN,
    maxYear: CATALOG_YEAR_MAX,
    eraWeights: { early: 20, midcentury: 20, classics: 20, millennial: 20, current: 20 },
    targetScore: 10,
    allowRetraction: true,
    catalogScope: "all",
  },
  modern: {
    minYear: CATALOG_YEAR_MIN,
    maxYear: CATALOG_YEAR_MAX,
    eraWeights: { early: 2, midcentury: 5, classics: 18, millennial: 30, current: 45 },
    targetScore: 10,
    allowRetraction: true,
    catalogScope: "all",
  },
  younger: {
    minYear: 1970,
    maxYear: CATALOG_YEAR_MAX,
    eraWeights: { early: 0, midcentury: 0, classics: 10, millennial: 35, current: 55 },
    targetScore: 7,
    allowRetraction: true,
    catalogScope: "all",
  },
  "broadway-tv-movies": {
    minYear: CATALOG_YEAR_MIN,
    maxYear: CATALOG_YEAR_MAX,
    eraWeights: { early: 20, midcentury: 20, classics: 20, millennial: 20, current: 20 },
    targetScore: 10,
    allowRetraction: true,
    catalogScope: "broadway-tv-movies",
  },
};

export const RULE_PRESET_OPTIONS = [
  { id: "family", name: "Family Mix", description: "Every era, weighted toward familiar decades" },
  { id: "all-eras", name: "All Eras", description: "Each era gets an equal chance" },
  { id: "modern", name: "Modern Mix", description: "More music from 1980 onward" },
  { id: "younger", name: "Younger Players", description: "1970 onward, first to seven" },
  { id: "broadway-tv-movies", name: "Broadway, TV, and Movies", description: "Songs from stage and screen" },
] as const;

export function rulesForPreset(preset: Exclude<RulesPreset, "custom">): GameRules {
  const rules = PRESETS[preset];
  return { ...rules, preset, eraWeights: { ...rules.eraWeights } };
}

export const DEFAULT_GAME_RULES = rulesForPreset("family");

function boundedNumber(value: unknown, fallback: number, min: number, max: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.round(parsed))) : fallback;
}

export function normalizeRules(value: unknown): GameRules {
  const candidate = value && typeof value === "object" ? value as Partial<GameRules> : {};
  const minYear = boundedNumber(candidate.minYear, DEFAULT_GAME_RULES.minYear, CATALOG_YEAR_MIN, CATALOG_YEAR_MAX);
  const maxYear = boundedNumber(candidate.maxYear, DEFAULT_GAME_RULES.maxYear, minYear, CATALOG_YEAR_MAX);
  const candidateWeights: Partial<Record<EraId, unknown>> = candidate.eraWeights
    && typeof candidate.eraWeights === "object"
    ? candidate.eraWeights
    : {};
  const eraWeights = Object.fromEntries(ERA_BUCKETS.map(({ id }) => [
    id,
    boundedNumber(candidateWeights[id], DEFAULT_GAME_RULES.eraWeights[id], 0, 100),
  ])) as Record<EraId, number>;
  const preset = candidate.preset && ["family", "all-eras", "modern", "younger", "broadway-tv-movies", "custom"].includes(candidate.preset)
    ? candidate.preset
    : "custom";
  return {
    preset,
    minYear,
    maxYear,
    eraWeights,
    targetScore: boundedNumber(candidate.targetScore, DEFAULT_GAME_RULES.targetScore, 3, 20),
    allowRetraction: candidate.allowRetraction !== false,
    catalogScope: candidate.catalogScope === "broadway-tv-movies" ? "broadway-tv-movies" : "all",
  };
}
