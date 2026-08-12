#!/usr/bin/env node
import { migrateMonolith } from "../src/migrate-monolith.mjs";

const option = (name) => {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? undefined : process.argv[index + 1];
};

try {
  const sourcePath = option("source");
  const destinationPath = option("destination");
  if (!sourcePath || !destinationPath) {
    throw new Error("Usage: migrate-monolith.mjs --source PATH --destination PATH");
  }
  process.stdout.write(`${JSON.stringify(migrateMonolith({
    sourcePath, destinationPath,
    lockDirectory: process.env.CANNABEATS_STATE_LOCK_DIRECTORY,
  }))}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
}
