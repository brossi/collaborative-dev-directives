#!/usr/bin/env node
import { createHash,randomUUID } from "node:crypto";

const accessOrigin = process.env.CANNABEATS_REHEARSAL_ACCESS_ORIGIN;
const gameOrigin = process.env.CANNABEATS_REHEARSAL_GAME_ORIGIN;
const stateOrigin = process.env.CANNABEATS_REHEARSAL_STATE_ORIGIN;
const browserSession = process.env.CANNABEATS_REHEARSAL_BROWSER_SESSION;
const operatorToken = process.env.CANNABEATS_REHEARSAL_OPERATOR_TOKEN;
const sourceToken = process.env.CANNABEATS_REHEARSAL_SOURCE_TOKEN;
const expectedOrigin = process.env.CANNABEATS_REHEARSAL_EXPECTED_ORIGIN;
for (const [name,value] of Object.entries({
  accessOrigin,gameOrigin,stateOrigin,browserSession,operatorToken,sourceToken,expectedOrigin,
})) if (!value) throw new Error(`${name} is required`);

async function json(url,options = {}) {
  const response = await fetch(url,options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${options.method ?? "GET"} ${url} failed ${response.status}: ${JSON.stringify(body)}`);
  return body;
}
const cookie = `cb_session=${browserSession}`;
const browserHeaders = { cookie,origin: expectedOrigin,"content-type": "application/json" };
const accessHeaders = { ...browserHeaders,"idempotency-key": randomUUID() };
const created = await json(`${accessOrigin}/api/game-sessions`,{
  method: "POST",headers: accessHeaders,body: JSON.stringify({ commandId: accessHeaders["idempotency-key"] }),
});
const code = created.session.code;
let prepared = await json(`${gameOrigin}/game/api/game`,{
  method: "POST",headers: browserHeaders,
  body: JSON.stringify({ action: "prepare",actionId: randomUUID(),code }),
});
let room = prepared.room;
const act = async (action,extra = {}) => {
  const result = await json(`${gameOrigin}/game/api/game`,{
    method: "POST",headers: browserHeaders,body: JSON.stringify({
      action,actionId: randomUUID(),code,expectedRunId: room.runId,
      expectedRunGeneration: room.runGeneration,expectedRevision: room.revision,...extra,
    }),
  });
  room = result.room;
  return result;
};
await act("addPlayer",{ name: "Docker Player" });
const sourceId = randomUUID();
await json(`${stateOrigin}/v1/admin/managed-sources`,{
  method: "POST",headers: { authorization: `Bearer ${operatorToken}`,"content-type": "application/json" },
  body: JSON.stringify({
    commandId: randomUUID(),sourceId,displayName: "Docker Source",
    tokenHash: createHash("sha256").update(sourceToken).digest("hex"),
  }),
});
const source = async (body) => json(`${gameOrigin}/game/api/audio-source`,{
  method: "POST",headers: { authorization: `Bearer ${sourceToken}`,"content-type": "application/json" },
  body: JSON.stringify(body),
});
await source({ action: "poll" });
await act("audioAcquire");
await act("start");
await act("begin");
const work = await source({ action: "poll" });
if (!work.command) throw new Error("Managed source did not receive the round command.");
const claimGeneration = randomUUID();
await source({
  action: "claim",requestId: randomUUID(),commandId: work.command.id,claimGeneration,
});
await source({
  action: "begin",requestId: randomUUID(),commandId: work.command.id,claimGeneration,
});
await source({
  action: "complete",requestId: randomUUID(),commandId: work.command.id,claimGeneration,
  ok: true,playbackStatus: "playing",
});
await act("abandon");
const history = await json(`${gameOrigin}/game/api/game?runId=${encodeURIComponent(room.runId)}`,{
  headers: { cookie },
});
const projectedHistory = history.history;
const requiredEvents = [
  "player_joined","game_started","track_requested","audio_lease_acquired",
  "audio_command_requested","audio_command_delivered","audio_command_completed","game_abandoned",
];
const eventTypes = new Set(projectedHistory?.events?.map((event) => event.type));
if (projectedHistory?.current?.terminalOutcome !== "abandoned"
    || projectedHistory.coverage?.complete !== true
    || requiredEvents.some((event) => !eventTypes.has(event))
    || !projectedHistory.events?.some((event) =>
      event.type === "game_abandoned" && event.outcome === "abandoned")) {
  throw new Error("Post-cutover abandoned game history was not reconstructable.");
}
const report = await json(`${stateOrigin}/v1/admin/report`,{
  headers: { authorization: `Bearer ${operatorToken}` },
});
console.log(JSON.stringify({
  code,runId: room.runId,revision: room.revision,sourceId,
  commandId: work.command.id,terminalOutcome: projectedHistory.current.terminalOutcome,
  historyLifecycle: projectedHistory.retention.lifecycle,
  eventTypes: [...eventTypes].sort(),
  reportAuthority: report.authority?.status,
}));
