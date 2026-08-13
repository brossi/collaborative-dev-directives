import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";

const originalOrigin = process.env.CANNABEATS_STATE_SERVICE_ORIGIN;
const originalFetch = globalThis.fetch;
process.env.CANNABEATS_STATE_SERVICE_ORIGIN = "http://state:3010";
const { postStateAudioSource } = await import("../lib/server/state-audio-source.mjs");

after(() => {
  globalThis.fetch = originalFetch;
  if (originalOrigin === undefined) delete process.env.CANNABEATS_STATE_SERVICE_ORIGIN;
  else process.env.CANNABEATS_STATE_SERVICE_ORIGIN = originalOrigin;
});

test("managed source adapter preserves source authority and durable transition identity", async () => {
  const commandId = randomUUID();
  const generation = randomUUID();
  const requestId = randomUUID();
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url),options });
    if (String(url).endsWith("/v1/source/work")) {
      return Response.json({
        protocolVersion: 4,lease: { id: randomUUID(),lobbyCode: "ABC234" },
        command: { id: commandId,kind: "play",trackUri: "spotify:track:test" },
      });
    }
    return Response.json({ state: "claimed",replayed: false });
  };
  const poll = await postStateAudioSource(new Request("https://game.test/game/api/audio-source", {
    method: "POST",headers: { authorization: "Bearer source-secret","content-type": "application/json" },
    body: JSON.stringify({ action: "poll" }),
  }), { fetchImpl: globalThis.fetch });
  assert.equal((await poll.json()).protocolVersion,4);
  assert.equal(calls[0].options.headers.authorization,"Bearer source-secret");
  const claim = await postStateAudioSource(new Request("https://game.test/game/api/audio-source", {
    method: "POST",headers: { authorization: "Bearer source-secret","content-type": "application/json" },
    body: JSON.stringify({ action: "claim",commandId,claimGeneration: generation,requestId }),
  }), { fetchImpl: globalThis.fetch });
  assert.deepEqual(await claim.json(),{ accepted: true,status: "claimed",replayed: false });
  const forwarded = JSON.parse(calls[1].options.body);
  assert.deepEqual(forwarded,{
    requestId,claimGeneration: generation,action: "claim",outcomeFingerprint: null,reasonCode: null,
  });
});

test("managed source adapter preserves a lease-less handoff stop", async () => {
  const commandId = randomUUID();
  const handoffId = randomUUID();
  globalThis.fetch = async () => Response.json({
    protocolVersion: 4,lease: null,
    handoff: { id: handoffId,state: "stop_required",priorLobbyCode: "OLD234" },
    command: { id: commandId,kind: "pause",trackUri: null,handoff: true },
  });
  const poll = await postStateAudioSource(new Request("https://game.test/game/api/audio-source", {
    method: "POST",headers: { authorization: "Bearer source-secret","content-type": "application/json" },
    body: JSON.stringify({ action: "poll" }),
  }), { fetchImpl: globalThis.fetch });
  assert.deepEqual(await poll.json(),{
    protocolVersion: 4,lease: null,
    handoff: { id: handoffId,state: "stop_required",priorLobbyCode: "OLD234" },
    command: { id: commandId,kind: "pause",trackUri: null,handoff: true },
  });
});
