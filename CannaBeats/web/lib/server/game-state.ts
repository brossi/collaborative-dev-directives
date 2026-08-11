import type { DatabaseSync } from "node:sqlite";

type PersistedGameState = {
  code: string;
  revision: number;
  [key: string]: unknown;
};

export class StaleGameStateError extends Error {
  constructor() {
    super("The game changed before this state could be saved.");
    this.name = "StaleGameStateError";
  }
}

export class GameStateBusyError extends Error {
  constructor() {
    super("The game database is busy.");
    this.name = "GameStateBusyError";
  }
}

export function isDatabaseBusy(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; errcode?: unknown; message?: unknown };
  return candidate.errcode === 5
    || (candidate.code === "ERR_SQLITE_ERROR" && /busy|locked/i.test(String(candidate.message ?? "")));
}

export function saveGameRunState<T extends PersistedGameState>(db: DatabaseSync, state: T) {
  const ownsTransaction = !db.isTransaction;
  const expectedRevision = state.revision;
  try {
    if (ownsTransaction) db.exec("BEGIN IMMEDIATE");
    const saved = db.prepare(`
      UPDATE game_runs SET state = ?, updated_at = ?
      WHERE id = (SELECT active_run_id FROM game_sessions WHERE code = ?)
        AND revision = ?
    `).run(JSON.stringify(state), Date.now(), state.code, expectedRevision);
    if (saved.changes !== 1) throw new StaleGameStateError();
    const row = db.prepare(`
      SELECT revision FROM game_runs
      WHERE id = (SELECT active_run_id FROM game_sessions WHERE code = ?)
    `).get(state.code) as { revision: number } | undefined;
    if (!row) throw new StaleGameStateError();
    state.revision = row.revision;
    if (ownsTransaction) db.exec("COMMIT");
    return state.revision;
  } catch (error) {
    if (ownsTransaction && db.isTransaction) db.exec("ROLLBACK");
    if (isDatabaseBusy(error)) throw new GameStateBusyError();
    throw error;
  }
}
