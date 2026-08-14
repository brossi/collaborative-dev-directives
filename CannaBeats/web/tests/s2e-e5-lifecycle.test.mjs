import assert from 'node:assert/strict';
import test from 'node:test';

import { E4PcmCore } from '../public/s2e-e4-worklet-core.js';
import {
  E5LifecycleError, E5ListenerLifecycle, E5PcmChunker, E5WindowProjector,
  E5WorkletPort,
} from '../lib/s2e-e5-lifecycle.mjs';
import {
  canonicalMeasurementBytes, validateMeasurementSeries,
} from '../lib/s2e-e1-contract.mjs';

function timerHarness() {
  let next = 1;
  const timers = new Map();
  return {
    schedule(callback) {
      const id = next++;
      timers.set(id, callback);
      return id;
    },
    cancel(id) { timers.delete(id); },
    fire() {
      const entries = [...timers.entries()];
      timers.clear();
      for (const [, callback] of entries) callback();
    },
  };
}

function connectedPort({ dropFirstRequest = false } = {}) {
  const timers = timerHarness();
  let clientHandler = null;
  let dropped = dropFirstRequest;
  const posted = [];
  const core = new E4PcmCore({
    outputSampleRate: 48000,
    postMessage(message) {
      queueMicrotask(() => clientHandler?.({ data: message }));
    },
  });
  const port = {
    postMessage(message) {
      posted.push(message);
      if (dropped && message.type !== 'pcm') {
        dropped = false;
        return;
      }
      queueMicrotask(() => core.receive(message));
    },
    get onmessage() { return clientHandler; },
    set onmessage(value) { clientHandler = value; },
  };
  const adapter = new E5WorkletPort({
    port,
    scheduleTimeout: (callback) => timers.schedule(callback),
    cancelTimeout: (id) => timers.cancel(id),
    timeoutMs: 10,
  });
  return { adapter, core, posted, timers, port };
}

test('E5 port retries the exact configure after response loss', async () => {
  const { adapter, core, posted, timers } = connectedPort({ dropFirstRequest: true });
  const configured = adapter.configure({ sampleRate: 48000, channels: 2 });
  timers.fire();
  const reply = await configured;
  assert.equal(reply.type, 'configured');
  assert.equal(core.epoch, 1);
  assert.equal(posted.length, 2);
  assert.equal(posted[0], posted[1]);
});

test('E5 port stages one PCM chunk across rotation and retags after acknowledgement', async () => {
  const { adapter, core, posted } = connectedPort();
  await adapter.configure({ sampleRate: 48000, channels: 2 });
  const rotation = adapter.rotate('snapshot');
  const buffer = new Int16Array([100, 100, 200, 200]).buffer;
  assert.equal(adapter.sendPcm(buffer), true);
  await rotation;
  await new Promise((resolve) => queueMicrotask(resolve));
  const pcm = posted.findLast((message) => message.type === 'pcm');
  assert.equal(pcm.epoch, 2);
  assert.equal(core.metrics.receivedFrames, 2);
});

test('E5 port rejects a second staged chunk and closes idempotently', async () => {
  const { adapter } = connectedPort();
  await adapter.configure({ sampleRate: 48000, channels: 2 });
  const rotation = adapter.rotate('snapshot');
  assert.equal(adapter.sendPcm(new ArrayBuffer(4)), true);
  assert.throws(() => adapter.sendPcm(new ArrayBuffer(4)), (error) => (
    error instanceof E5LifecycleError && error.code === 'staging_full'
  ));
  await rotation;
  adapter.close();
  adapter.close();
  assert.equal(adapter.sendPcm(new ArrayBuffer(4)), false);
});

test('E5 port never accepts PCM while reset or stop is pending', async () => {
  const { adapter } = connectedPort();
  await adapter.configure({ sampleRate: 48000, channels: 2 });
  const reset = adapter.rotate('reset');
  assert.equal(adapter.sendPcm(new ArrayBuffer(4)), false);
  await reset;
  const stop = adapter.rotate('stop');
  assert.equal(adapter.sendPcm(new ArrayBuffer(4)), false);
  await stop;
});

test('attempt milestones are once-only and reconnect begins only on a later attempt', () => {
  let now = 100;
  const lifecycle = new E5ListenerLifecycle({
    instanceId: '11111111-1111-4111-8111-111111111111',
    now: () => now,
  });
  lifecycle.beginAttempt();
  now += 5;
  lifecycle.responseHeaders();
  now += 5;
  lifecycle.pcmDelivered({ bytes: 4, frames: 1 });
  lifecycle.playbackState('playing');
  lifecycle.playbackState('playing');
  lifecycle.endAttempt('stream_ended');
  lifecycle.beginAttempt();

  assert.deepEqual(
    lifecycle.transitions.map((entry) => entry.measurements.type),
    ['request_started', 'response_headers', 'first_pcm_bytes', 'buffer_primed',
      'first_rendered_quantum', 'stream_ended', 'request_started', 'reconnect'],
  );
});

test('instance rotation preserves the current attempt without duplicating milestones', () => {
  let now = 0;
  const lifecycle = new E5ListenerLifecycle({
    instanceId: '11111111-1111-4111-8111-111111111111', now: () => now,
  });
  lifecycle.beginAttempt();
  now = 1;
  lifecycle.responseHeaders();
  lifecycle.rotateInstance('22222222-2222-4222-8222-222222222222');
  lifecycle.responseHeaders();
  lifecycle.pcmDelivered({ bytes: 4, frames: 1 });
  assert.deepEqual(
    lifecycle.transitions.map((entry) => entry.measurements.type), ['first_pcm_bytes'],
  );
  assert.equal(lifecycle.attemptSequence, 0);
  assert.equal(lifecycle.transitions[0].sequence, 0);
});

test('local coverage gaps and transition retention are bounded', () => {
  let now = 0;
  const lifecycle = new E5ListenerLifecycle({
    instanceId: '11111111-1111-4111-8111-111111111111', now: () => now,
  });
  lifecycle.beginAttempt();
  for (let index = 0; index < 80; index += 1) {
    now += 1;
    lifecycle.playbackState('buffering');
    lifecycle.playbackState('underrun');
  }
  for (let index = 0; index < 20; index += 1) {
    lifecycle.recordGap('timer_delayed', index);
  }
  assert.equal(lifecycle.transitions.length, 64);
  assert.equal(lifecycle.localRecords.length, 16);
  assert.equal(lifecycle.localRecords[0].durationMs, 4);
});

test('partial PCM chunks preserve every complete frame and expose terminal carry', () => {
  const chunker = new E5PcmChunker(2);
  const first = chunker.consume(new Uint8Array([1, 2, 3]));
  assert.equal(first.receivedFrames, 0);
  const second = chunker.consume(new Uint8Array([4, 5, 6, 7, 8, 9]));
  assert.equal(second.receivedFrames, 2);
  assert.deepEqual([...new Uint8Array(second.buffer)], [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(chunker.finish(), false);
});

function windowHarness(clientOverrides = {}) {
  let now = 0;
  const lifecycle = new E5ListenerLifecycle({
    instanceId: '11111111-1111-4111-8111-111111111111', now: () => now,
  });
  lifecycle.beginAttempt();
  const projector = new E5WindowProjector({
    lifecycle,
    format: { sourceSampleRate: 48000, sourceChannels: 2, outputSampleRate: 48000 },
    client: {
      longTaskStatus: 'observed',
      baseLatencyMs: { status: 'observed', value: 5 },
      outputLatencyMs: { status: 'unsupported' },
      browserFamily: 'chromium',
      browserMajor: { status: 'observed', value: 140 },
      osFamily: 'macos',
      displayMode: 'browser',
      implementationVersion: 1,
      ...clientOverrides,
    },
    startBoundary: { dispatchMs: 0, replyMs: 2 },
  });
  return {
    lifecycle,
    projector,
    setNow(value) { now = value; },
  };
}

function snapshot(overrides = {}) {
  return {
    epoch: 1,
    sourceSampleRate: 48000,
    sourceChannels: 2,
    outputSampleRate: 48000,
    receivedFrames: 10,
    renderedFrames: 128,
    silentInputFrames: 2,
    clippedInputFrames: 1,
    bufferSampleCount: 2,
    bufferCurrentFrames: 480,
    bufferMinFrames: 240,
    bufferMaxFrames: 480,
    bufferSumFrames: 720,
    bufferTrendStartFrames: 240,
    bufferTrendEndFrames: 480,
    underrunCount: 0,
    underrunFrames: 0,
    reprimeCount: 0,
    windowStartedInUnderrun: false,
    overflowCount: 0,
    discardedFrames: 0,
    resetCount: 0,
    ...overrides,
  };
}

test('acknowledged E4 metrics become one exact validated E1 listener window', () => {
  const { lifecycle, projector } = windowHarness();
  projector.recordChunk({ frames: 4, atMs: 100 });
  projector.recordChunk({ frames: 6, atMs: 160 });
  projector.setAudioContextState('running', 8990);
  projector.setVisibilityState('visible', 8991);
  const result = projector.finalize({
    snapshot: snapshot(),
    endBoundary: { dispatchMs: 9000, replyMs: 9002 },
    longTaskEntries: [{ startTime: 1000, duration: 50 }],
  });
  assert.equal(result.status, 'accepted');
  assert.equal(result.boundaryUncertaintyMs, 2);
  assert.equal(result.report.measurements.receivedBytes, 40);
  assert.deepEqual({ ...result.report.measurements.chunkGap }, {
    status: 'observed', count: 1, meanMs: 60, maxMs: 60,
  });
  assert.equal(result.report.measurements.bufferDepth.meanMs, 7.5);
  assert.equal(result.report.measurements.signalPresence, 'present');
  assert.equal(result.report.measurements.clippingSeverity, 'sustained');
  assert.equal(result.report.measurements.longTasks.count, 1);
  assert.doesNotThrow(() => canonicalMeasurementBytes(result.report));
  assert.equal(lifecycle.windows.length, 1);
  assert.doesNotThrow(() => validateMeasurementSeries([
    ...lifecycle.transitions, ...lifecycle.windows,
  ].sort((left, right) => left.sequence - right.sequence)));
});

test('ambiguous, delayed, contradictory, and carried-zero windows become local gaps', () => {
  const ambiguous = windowHarness();
  ambiguous.projector.recordChunk({ frames: 10, atMs: 100 });
  assert.deepEqual(ambiguous.projector.finalize({
    snapshot: snapshot(),
    endBoundary: { dispatchMs: 9000, replyMs: 9010 },
    longTaskEntries: [{ startTime: 8999, duration: 5 }],
  }), { status: 'gap', reason: 'boundary_ambiguous' });
  assert.equal(ambiguous.lifecycle.windows.length, 0);

  const delayed = windowHarness();
  assert.deepEqual(delayed.projector.finalize({
    snapshot: snapshot({ receivedFrames: 0, silentInputFrames: 0, clippedInputFrames: 0 }),
    endBoundary: { dispatchMs: 11000, replyMs: 11002 },
  }), { status: 'gap', reason: 'timer_delayed' });

  const mismatch = windowHarness();
  mismatch.projector.recordChunk({ frames: 9, atMs: 100 });
  assert.equal(mismatch.projector.finalize({
    snapshot: snapshot(), endBoundary: { dispatchMs: 9000, replyMs: 9002 },
  }).reason, 'projection_invalid');

  const carried = windowHarness();
  carried.projector.recordChunk({ frames: 10, atMs: 100 });
  assert.equal(carried.projector.finalize({
    snapshot: snapshot({ windowStartedInUnderrun: true }),
    endBoundary: { dispatchMs: 9000, replyMs: 9002 },
  }).reason, 'projection_invalid');
});

test('unsupported browser APIs remain explicit rather than observed healthy zero', () => {
  const { projector } = windowHarness({
    longTaskStatus: 'unsupported',
    baseLatencyMs: { status: 'unsupported' },
    outputLatencyMs: { status: 'unknown' },
  });
  projector.recordChunk({ frames: 10, atMs: 100 });
  const result = projector.finalize({
    snapshot: snapshot(), endBoundary: { dispatchMs: 9000, replyMs: 9002 },
  });
  assert.equal(result.status, 'accepted');
  assert.deepEqual({ ...result.report.measurements.longTasks }, { status: 'unsupported' });
  assert.deepEqual({ ...result.report.measurements.baseLatencyMs }, { status: 'unsupported' });
  assert.deepEqual({ ...result.report.measurements.outputLatencyMs }, { status: 'unknown' });
});
