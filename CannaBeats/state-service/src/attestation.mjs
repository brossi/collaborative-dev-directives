import { createHash } from "node:crypto";

const AUTHORITATIVE_TABLES = [
  ["state_commands", "command_id"],
  ["lobbies", "code"], ["lobby_members", "lobby_code,principal_id"],
  ["game_runs", "id"], ["action_receipts", "run_id,actor_principal_id,action_id"],
  ["history_streams", "run_id"], ["history_transitions", "run_id,sequence"],
  ["game_events", "run_id,sequence"], ["managed_sources", "id"],
  ["managed_leases", "id"], ["managed_command_intents", "id"],
  ["managed_command_payloads", "command_id"],
  ["managed_command_transitions", "command_id,sequence"], ["purge_tombstones", "run_id"],
  ["purge_sanitization", "run_id"],
];

export function candidateAuthorityDigest(db) {
  const projection = Object.fromEntries(AUTHORITATIVE_TABLES.map(([table, order]) => [
    table, db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all().map((row) => ({ ...row })),
  ]));
  return createHash("sha256").update(JSON.stringify(projection)).digest("hex");
}
