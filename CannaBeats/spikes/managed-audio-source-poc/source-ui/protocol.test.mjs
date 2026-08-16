import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyManagedCommandFailure,classifyPlaybackObservation,diagnosticReadinessSnapshot,
  reconcileManagedProviderObservation,
  shouldExecuteManagedControllerCommand,
} from "./protocol.mjs";

test("playback diagnostics retain only the finite playback observation", () => {
  assert.equal(classifyPlaybackObservation({ paused: false,track: { uri: "private" } }),"playing");
  assert.equal(classifyPlaybackObservation({ paused: true,device_id: "private" }),"paused");
  assert.equal(classifyPlaybackObservation(null),"unknown");
  assert.equal(classifyPlaybackObservation({ paused: "false" }),"unknown");
});

test("diagnostic heartbeat expires the event and rejects incoherent playback", () => {
  const ready = { spotifyAuthorization: "authorized",player: "ready",
    playbackObservation: "playing" };
  assert.deepEqual(diagnosticReadinessSnapshot(ready,100,15100),{
    spotifyAuthorization: "authorized",player: "ready",
    playbackObservation: "playing",playbackObservationAgeMs: 15000,
  });
  assert.deepEqual(diagnosticReadinessSnapshot(ready,100,15100.1),{
    spotifyAuthorization: "authorized",player: "ready",
    playbackObservation: "unknown",playbackObservationAgeMs: null,
  });
  assert.deepEqual(diagnosticReadinessSnapshot({ ...ready,player: "not_ready" },100,101),{
    spotifyAuthorization: "authorized",player: "not_ready",
    playbackObservation: "unknown",playbackObservationAgeMs: null,
  });
});

test("provider authorization and execution ambiguity remain fail closed", () => {
  assert.equal(classifyManagedCommandFailure("prepare"),"failed");
  assert.equal(classifyManagedCommandFailure("begin"),"outcome_unknown");
  assert.equal(classifyManagedCommandFailure("provider"),"outcome_unknown");
});

test("unknown effects reconcile only from matching read-only provider evidence", () => {
  assert.equal(reconcileManagedProviderObservation({ kind: "pause" },{ paused: true }),"paused");
  assert.equal(reconcileManagedProviderObservation({ kind: "resume" },{ paused: false }),"playing");
  assert.equal(reconcileManagedProviderObservation(
    { kind: "play",trackUri: "spotify:track:right" },
    { paused: false,trackUri: "spotify:track:right" },
  ),"playing");
  assert.equal(reconcileManagedProviderObservation(
    { kind: "play",trackUri: "spotify:track:right" },
    { paused: false,trackUri: "spotify:track:wrong" },
  ),null);
  assert.equal(reconcileManagedProviderObservation({ kind: "pause" },{ paused: false }),null);
});

test("only a State-issued pause handoff executes without a live lease", () => {
  assert.equal(shouldExecuteManagedControllerCommand({ lease: { id: "lease" } }),true);
  assert.equal(shouldExecuteManagedControllerCommand({ lease: null,command: {
    kind: "pause",handoff: true,
  } }),true);
  assert.equal(shouldExecuteManagedControllerCommand({ lease: null,command: {
    kind: "play",handoff: true,
  } }),false);
  assert.equal(shouldExecuteManagedControllerCommand({ lease: null,command: {
    kind: "pause",handoff: false,
  } }),false);
});
