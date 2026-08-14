import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { E4PcmCore } from "../public/s2e-e4-worklet-core.js";
import { PcmPlayerBaseline } from "./fixtures/pcm-player-baseline.mjs";

function harness(outputSampleRate = 48000) {
  const messages = [];
  const core = new E4PcmCore({
    outputSampleRate,
    postMessage: (message) => messages.push(message),
  });
  return { core, messages };
}

function output(frames = 128) {
  return [new Float32Array(frames), new Float32Array(frames)];
}

function pcm(frames, channels, sampleAt = (frame, channel) => (
  ((frame * 97) + (channel * 193)) % 24000
)) {
  const samples = new Int16Array(frames * channels);
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      samples[(frame * channels) + channel] = sampleAt(frame, channel);
    }
  }
  return samples.buffer;
}

function configure(core, requestId = 1, epoch = 1, sampleRate = 48000, channels = 2) {
  core.receive({ type: "configure", requestId, epoch, sampleRate, channels });
}

function rotate(core, type, requestId, epoch, nextEpoch) {
  core.receive({ type, requestId, epoch, nextEpoch });
}

test("request receipts replay exactly and reject conflicting or stale reuse", () => {
  const { core, messages } = harness();
  core.receive({ type: "configure", requestId: 1, epoch: 1, sampleRate: 48000 });
  assert.equal(messages.length, 0);

  configure(core);
  assert.deepEqual(messages.map((value) => value.type), ["configured", "playback-state"]);
  const configured = messages[0];
  configure(core);
  assert.equal(messages.at(-1), configured);

  core.receive({ type: "configure", requestId: 1, epoch: 1, sampleRate: 44100, channels: 2 });
  assert.equal(messages.at(-1).code, "request_conflict");

  rotate(core, "snapshot-and-rotate", 3, 1, 2);
  const snapshotReply = messages.at(-1);
  rotate(core, "snapshot-and-rotate", 3, 1, 2);
  assert.equal(messages.at(-1), snapshotReply);
  rotate(core, "snapshot-and-rotate", 2, 2, 3);
  assert.equal(messages.at(-1).code, "request_conflict");
  assert.equal(core.epoch, 2);
});

test("stop reply is replayable and stopped configure advances exactly one epoch", () => {
  const { core, messages } = harness();
  configure(core);
  messages.length = 0;
  rotate(core, "stop-and-rotate", 2, 1, 2);
  assert.deepEqual(messages.map((value) => value.type), ["snapshot-rotated", "playback-state"]);
  assert.equal(messages[0].operation, "stop");
  const stopReply = messages[0];
  rotate(core, "stop-and-rotate", 2, 1, 2);
  assert.equal(messages.at(-1), stopReply);

  configure(core, 3, 2);
  assert.equal(messages.at(-1).code, "stale_epoch");
  configure(core, 4, 3);
  assert.equal(messages.at(-2).type, "configured");
  assert.equal(core.epoch, 3);
});

test("snapshot and rotate assigns PCM to exactly one diagnostic epoch", () => {
  const { core, messages } = harness();
  configure(core);
  core.receive({ type: "pcm", epoch: 1, buffer: pcm(1000, 2) });
  rotate(core, "snapshot-and-rotate", 2, 1, 2);
  const first = messages.find((value) => value.type === "snapshot-rotated");
  assert.equal(first.snapshot.receivedFrames, 1000);

  core.receive({ type: "pcm", epoch: 1, buffer: pcm(500, 2) });
  core.receive({ type: "pcm", epoch: 2, buffer: pcm(700, 2) });
  rotate(core, "snapshot-and-rotate", 3, 2, 3);
  const second = messages.filter((value) => value.type === "snapshot-rotated").at(-1);
  assert.equal(second.snapshot.receivedFrames, 700);
  assert.equal(second.snapshot.epoch, 2);
});

function compareBaseline({ sourceRate, channels }) {
  const { core } = harness(48000);
  const baseline = new PcmPlayerBaseline(48000);
  configure(core, 1, 1, sourceRate, channels);
  baseline.configure(sourceRate, channels);
  const buffer = pcm(Math.ceil(sourceRate * 0.35), channels);
  core.receive({ type: "pcm", epoch: 1, buffer: buffer.slice(0) });
  baseline.receive(buffer.slice(0));
  for (let iteration = 0; iteration < 8; iteration += 1) {
    const actual = output();
    const expected = output();
    core.process(actual);
    baseline.process(expected);
    assert.deepEqual([...actual[0]], [...expected[0]]);
    assert.deepEqual([...actual[1]], [...expected[1]]);
  }
}

test("instrumentation preserves stereo unity-rate and mono resampled PCM", () => {
  compareBaseline({ sourceRate: 48000, channels: 2 });
  compareBaseline({ sourceRate: 24000, channels: 1 });
});

test("pre-prime buffering, carried underrun, and re-prime stay epoch coherent", () => {
  const { core, messages } = harness(48000);
  configure(core, 1, 1, 8000, 1);
  core.process(output());
  assert.equal(core.metrics.underrunCount, 0);
  core.receive({ type: "pcm", epoch: 1, buffer: pcm(2500, 1) });
  let guard = 0;
  while (!core.inUnderrun && guard < 200) {
    core.process(output());
    guard += 1;
  }
  assert.equal(core.inUnderrun, true);
  assert.equal(core.metrics.underrunCount, 1);

  rotate(core, "snapshot-and-rotate", 2, 1, 2);
  assert.equal(core.metrics.windowStartedInUnderrun, true);
  assert.equal(core.metrics.underrunCount, 0);
  assert.equal(core.metrics.underrunFrames, 0);
  core.process(output());
  assert.equal(core.metrics.underrunFrames, 128);

  core.receive({ type: "pcm", epoch: 2, buffer: pcm(3000, 1) });
  core.process(output());
  assert.equal(core.inUnderrun, false);
  assert.equal(core.metrics.reprimeCount, 1);
  assert.equal(messages.some((value) => value.state === "underrun"), true);
});

test("reset and stop reply before state and clear playback deterministically", () => {
  const { core, messages } = harness();
  configure(core);
  core.receive({ type: "pcm", epoch: 1, buffer: pcm(16000, 2) });
  core.process(output());
  messages.length = 0;

  rotate(core, "reset-and-rotate", 2, 1, 2);
  assert.deepEqual(messages.map((value) => value.type), ["snapshot-rotated", "playback-state"]);
  assert.equal(messages[0].operation, "reset");
  assert.equal(core.metrics.resetCount, 1);
  assert.equal(core.writeFrame, 0);

  messages.length = 0;
  rotate(core, "stop-and-rotate", 3, 2, 3);
  assert.deepEqual(messages.map((value) => value.type), ["snapshot-rotated", "playback-state"]);
  assert.equal(core.metrics.resetCount, 0);
  const silent = output();
  core.process(silent);
  assert.equal(silent[0].every((value) => value === 0), true);
});

test("overflow preserves phase and signal thresholds match E1", () => {
  const { core } = harness(48000);
  configure(core, 1, 1, 8000, 1);
  core.receive({ type: "pcm", epoch: 1, buffer: pcm(3000, 1) });
  core.process(output());
  const fractionalRead = core.readFrame;
  assert.notEqual(fractionalRead, Math.floor(fractionalRead));
  core.receive({ type: "pcm", epoch: 1, buffer: pcm(core.capacity, 1) });
  const available = core.writeFrame - core.readFrame;
  assert.equal(core.metrics.overflowCount, 1);
  const availableFraction = (1 - (fractionalRead % 1)) % 1;
  assert.equal(available, Math.floor(core.capacity / 2) + availableFraction);

  const signal = harness();
  configure(signal.core, 1, 1, 48000, 1);
  const values = [-63, 63, -64, 64, 32759, 32760, -32768];
  signal.core.receive({
    type: "pcm",
    epoch: 1,
    buffer: pcm(values.length, 1, (frame) => values[frame]),
  });
  assert.equal(signal.core.metrics.silentInputFrames, 2);
  assert.equal(signal.core.metrics.clippedInputFrames, 2);

  const stereo = harness();
  configure(stereo.core);
  stereo.core.receive({
    type: "pcm",
    epoch: 1,
    buffer: pcm(2, 2, (frame, channel) => (
      frame === 0 && channel === 1 ? 32760 : 0
    )),
  });
  assert.equal(stereo.core.metrics.clippedInputFrames, 1);
});

test("counters saturate and buffer samples have fixed render cadence", () => {
  const { core, messages } = harness();
  configure(core);
  core.metrics.receivedFrames = Number.MAX_SAFE_INTEGER - 1;
  core.receive({ type: "pcm", epoch: 1, buffer: pcm(10, 2) });
  assert.equal(core.metrics.receivedFrames, Number.MAX_SAFE_INTEGER);
  assert.equal(core.metrics.bufferSampleCount, 0);
  core.process(output());
  core.process(output());
  assert.equal(core.metrics.bufferSampleCount, 2);
  rotate(core, "snapshot-and-rotate", 2, 1, 2);
  const snapshot = messages.filter((value) => value.type === "snapshot-rotated").at(-1).snapshot;
  assert.equal(snapshot.bufferSampleCount, 2);
  assert.ok(snapshot.bufferMinFrames <= snapshot.bufferCurrentFrames);
  assert.ok(snapshot.bufferCurrentFrames <= snapshot.bufferMaxFrames);
});

test("the actual worklet wrapper speaks the E4 protocol", async () => {
  const registered = new Map();
  class FakePort {
    constructor() {
      this.messages = [];
      this.onmessage = null;
    }

    postMessage(message) {
      this.messages.push(message);
    }

    dispatch(data) {
      this.onmessage?.({ data });
    }
  }
  globalThis.sampleRate = 48000;
  globalThis.AudioWorkletProcessor = class {
    constructor() {
      this.port = new FakePort();
    }
  };
  globalThis.registerProcessor = (name, implementation) => registered.set(name, implementation);
  try {
    await import(`../public/s2e-e4-worklet.js?test=${Date.now()}`);
    const Worklet = registered.get("cannabeats-e4-pcm-player");
    const node = new Worklet();
    node.port.dispatch({
      type: "configure", requestId: 1, epoch: 1, sampleRate: 48000, channels: 2,
    });
    assert.equal(node.port.messages[0].type, "configured");
    node.port.dispatch({ type: "pcm", epoch: 1, buffer: pcm(16000, 2) });
    const rendered = output();
    assert.equal(node.process([], [rendered]), true);
    assert.equal(node.port.messages.some((value) => value.state === "playing"), true);
  } finally {
    delete globalThis.sampleRate;
    delete globalThis.AudioWorkletProcessor;
    delete globalThis.registerProcessor;
  }
});

test("E4 public modules contain only the bounded worklet dependency", async () => {
  const coreSource = await readFile(new URL("../public/s2e-e4-worklet-core.js", import.meta.url), "utf8");
  const wrapperSource = await readFile(new URL("../public/s2e-e4-worklet.js", import.meta.url), "utf8");
  assert.doesNotMatch(coreSource, /\bimport\b|fetch\s*\(|react|sqlite|collector|state-service/i);
  assert.match(wrapperSource, /from "\.\/s2e-e4-worklet-core\.js"/);
  assert.doesNotMatch(wrapperSource, /fetch\s*\(|react|sqlite|collector|state-service/i);
});
