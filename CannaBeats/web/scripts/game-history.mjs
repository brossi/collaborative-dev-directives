import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 2;
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function supportsHistory(databasePath) {
  let candidate;
  try {
    candidate = new DatabaseSync(databasePath, { readOnly: true });
    const ledgerExists = candidate.prepare(`
      SELECT 1 FROM sqlite_schema
      WHERE type = 'table' AND name = 'cannabeats_feature_migrations'
    `).get();
    if (!ledgerExists) return false;
    const required = new Set([
      "game_events_canonical_v2",
      "history_lifecycle_v4",
      "managed_audio_protocol_v4",
    ]);
    for (const row of candidate.prepare(`
      SELECT name FROM cannabeats_feature_migrations
    `).all()) required.delete(row.name);
    return required.size === 0;
  } catch {
    return false;
  } finally {
    candidate?.close();
  }
}

const configuredPath = process.env.CANNABEATS_DATABASE_PATH?.trim();
if (!configuredPath) {
  fail("CANNABEATS_DATABASE_PATH must name the existing database explicitly.");
} else {
  const databasePath = resolve(configuredPath);
  if (!existsSync(databasePath)) {
    fail(`Database was not found: ${databasePath}`);
  } else if (!supportsHistory(databasePath)) {
    process.stdout.write(`${JSON.stringify({
      command: process.argv[2] ?? null,
      status: "unsupported_schema",
      reason: "history_feature_unavailable",
    })}\n`);
  } else {
    const command = process.argv[2];
    try {
      const { deleteGameHistory, purgeExpiredGameHistory } = await import("../lib/server/game-events.ts");
      if (command === "delete") {
        const runId = option("--run-id");
        if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(runId ?? "")) {
          throw new Error("delete requires --run-id UUID.");
        }
        const result = deleteGameHistory(runId);
        process.stdout.write(`${JSON.stringify({ command, runId, ...result })}\n`);
      } else if (command === "purge") {
        const retention = option("--retention-days");
        const retentionDays = retention === undefined ? 90 : Number(retention);
        const result = purgeExpiredGameHistory({ retentionDays });
        process.stdout.write(`${JSON.stringify({ command, retentionDays, ...result })}\n`);
      } else {
        throw new Error("Usage: game-history.mjs delete --run-id UUID | purge [--retention-days 1..365]");
      }
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }
}
