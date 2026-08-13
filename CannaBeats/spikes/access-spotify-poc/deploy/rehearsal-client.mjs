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
const browserHeaders = {
  cookie,
  origin: expectedOrigin,
  "content-type": "application/json",
  "x-cannabeats-client-contract": "2",
};
const createGame = async () => {
  const idempotencyKey = randomUUID();
  const created = await json(`${accessOrigin}/api/game-sessions`,{
    method: "POST",headers: { ...browserHeaders,"idempotency-key": idempotencyKey },
    body: JSON.stringify({ commandId: idempotencyKey }),
  });
  const context = { code: created.session.code,room: null };
  const prepared = await json(`${gameOrigin}/game/api/game`,{
    method: "POST",headers: browserHeaders,
    body: JSON.stringify({ action: "prepare",actionId: randomUUID(),code: context.code }),
  });
  context.room = prepared.room;
  return context;
};
const act = async (context,action,extra = {}) => {
  const result = await json(`${gameOrigin}/game/api/game`,{
    method: "POST",headers: browserHeaders,body: JSON.stringify({
      action,actionId: randomUUID(),code: context.code,expectedRunId: context.room.runId,
      expectedRunGeneration: context.room.runGeneration,
      expectedRevision: context.room.revision,...extra,
    }),
  });
  context.room = result.room;
  return result;
};
const gameA = await createGame();
await act(gameA,"addPlayer",{ name: "Docker Player" });
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
await act(gameA,"audioAcquire");
await act(gameA,"start");
await act(gameA,"begin");
const work = await source({ action: "poll" });
if (!work.command) throw new Error("Managed source did not receive the round command.");
const claimGeneration = randomUUID();
const claimRequest = {
  action: "claim",requestId: randomUUID(),commandId: work.command.id,claimGeneration,
};
await source(claimRequest);
const replayedClaim = await source(claimRequest);
if (replayedClaim.replayed !== true || replayedClaim.status !== "claimed") {
  throw new Error("Managed source claim did not survive an ambiguous acknowledgement retry.");
}
await source({
  action: "begin",requestId: randomUUID(),commandId: work.command.id,claimGeneration,
});
await source({
  action: "complete",requestId: randomUUID(),commandId: work.command.id,claimGeneration,
  ok: true,playbackStatus: "playing",
});

const gameB = await createGame();
await act(gameA,"audioRelease");
let blockedStatus = null;
try {
  await act(gameB,"audioAcquire");
} catch (error) {
  blockedStatus = /409/.test(error.message) && /source_recovery_required/.test(error.message)
    ? "recovery_required" : null;
}
if (blockedStatus !== "recovery_required") {
  throw new Error("A second lobby acquired the source before the handoff stop completed.");
}
const handoffWork = await source({ action: "poll" });
if (handoffWork.lease !== null || handoffWork.command?.kind !== "pause"
    || handoffWork.command?.handoff !== true) {
  throw new Error("Managed source did not receive its lease-less handoff stop.");
}
const stopGeneration = randomUUID();
for (const action of ["claim","begin"]) {
  await source({
    action,requestId: randomUUID(),commandId: handoffWork.command.id,
    claimGeneration: stopGeneration,
  });
}
await source({
  action: "complete",requestId: randomUUID(),commandId: handoffWork.command.id,
  claimGeneration: stopGeneration,ok: true,playbackStatus: "paused",
});
const handoffReport = await json(`${stateOrigin}/v1/admin/report`,{
  headers: { authorization: `Bearer ${operatorToken}` },
});
const completedHandoff = handoffReport.sourceHandoffs?.find((entry) =>
  entry.stopCommandId === handoffWork.command.id && entry.state === "safe");
if (!completedHandoff || completedHandoff.commandState !== "completed"
    || completedHandoff.playbackStatus !== "paused") {
  throw new Error("The source handoff was not proven safe by its exact pause completion.");
}
await act(gameB,"audioAcquire");
await act(gameB,"audioRelease");

await act(gameA,"abandon");
const history = await json(`${gameOrigin}/game/api/game?runId=${encodeURIComponent(gameA.room.runId)}`,{
  headers: browserHeaders,
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
  code: gameA.code,secondCode: gameB.code,runId: gameA.room.runId,
  revision: gameA.room.revision,sourceId,
  commandId: work.command.id,terminalOutcome: projectedHistory.current.terminalOutcome,
  historyLifecycle: projectedHistory.retention.lifecycle,
  sourceHandoff: completedHandoff.state,handoffCommandId: handoffWork.command.id,
  handoffCommandState: completedHandoff.commandState,
  handoffPlaybackStatus: completedHandoff.playbackStatus,secondLobbyAcquired: true,
  eventTypes: [...eventTypes].sort(),
  reportAuthority: report.authority?.status,
}));
