#!/usr/bin/env node
import { createHash,randomBytes,randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../../spikes/access-spotify-poc/db.mjs";
import { database as openGameDatabase } from "../../web/lib/server/database.ts";
import { initialRoomState } from "../src/game-domain.mjs";

const path = resolve(process.argv[2] ?? "");
if (!path) throw new Error("Usage: create-rehearsal-monolith.mjs PATH");
process.env.CANNABEATS_DATABASE_PATH = path;
openDatabase(path).close();
openGameDatabase();
const db = new DatabaseSync(path);
db.exec("PRAGMA foreign_keys=ON");
const now = Date.parse("2026-08-12T20:00:00Z");
const hostId = randomUUID();
const runId = randomUUID();
const actionId = randomUUID();
const browserSession = randomBytes(32).toString("base64url");
const code = "OLD234";
const song = {
  title: "Migrated rehearsal song",artist: "Rehearsal artist",year: 1990,
  uri: "spotify:track:rehearsal-migrated",
};
const state = initialRoomState({ runId,lobbyCode: code,runGeneration: 1 });
Object.assign(state,{
  revision: 2,phase: "finished",
  players: [{ id: hostId,name: "Rehearsal Host",control: "host",timeline: [song] }],
  activePlayerId: hostId,activePlayerIndex: 0,round: 1,currentSong: song,
  placement: 0,result: { correct: true,index: 0 },winnerId: hostId,usedUris: [song.uri],
});
db.prepare("INSERT INTO users (id,display_name,role,created_at) VALUES (?,?,'host',?)")
  .run(hostId,"Rehearsal Host",now);
db.prepare(`INSERT INTO sessions (token_hash,user_id,created_at,expires_at,last_seen_at)
  VALUES (?,?,?,?,?)`).run(
  createHash("sha256").update(browserSession).digest("hex"),hostId,now,now + 365 * 86_400_000,now,
);
db.prepare(`INSERT INTO game_sessions
  (code,host_user_id,status,active_run_id,run_generation,audio_mode,created_at,updated_at)
  VALUES (?,?,'ended',?,1,'managed',?,?)`).run(code,hostId,runId,now,now);
db.prepare(`INSERT INTO game_session_members (session_code,user_id,joined_at,last_seen_at)
  VALUES (?,?,?,?)`).run(code,hostId,now,now);
db.prepare(`INSERT INTO game_runs
  (id,session_code,state,revision,created_at,updated_at,ended_at,terminal_outcome)
  VALUES (?,?,?,2,?,?,?,'completed')`).run(runId,code,JSON.stringify(state),now,now,now);
db.prepare(`INSERT INTO game_action_receipts
  (run_id,actor_id,action_id,action,request_fingerprint,accepted_at)
  VALUES (?,?,?,'advance',?,?)`).run(
  runId,hostId,actionId,createHash("sha256").update("rehearsal-action").digest("hex"),now,
);
db.prepare(`INSERT INTO game_events
  (run_id,sequence,event_type,outcome,actor_type,actor_ref,action_id,command_ref,
   round,detail_code,detail_value,reason_code,occurred_at)
  VALUES (?,1,'game_completed','completed','system',NULL,NULL,NULL,1,NULL,NULL,NULL,?)`)
  .run(runId,now);
db.prepare(`UPDATE game_event_coverage SET baseline_revision=0,last_recorded_revision=2,
  lifecycle_state='terminal_pending' WHERE run_id=?`).run(runId);
db.prepare("UPDATE game_event_coverage SET lifecycle_state='sealed' WHERE run_id=?").run(runId);
db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
db.close();
console.log(JSON.stringify({ path,hostId,runId,code,browserSession }));
