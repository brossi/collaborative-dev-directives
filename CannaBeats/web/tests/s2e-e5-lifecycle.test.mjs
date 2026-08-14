import assert from 'node:assert/strict';
import test from 'node:test';

import { E4PcmCore } from '../public/s2e-e4-worklet-core.js';
import {
  E5LifecycleError, E5ListenerLifecycle, E5WorkletPort,
} from '../lib/s2e-e5-lifecycle.mjs';

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
    lifecycle.transitions.map((entry) => entry.type),
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
  assert.deepEqual(lifecycle.transitions.map((entry) => entry.type), ['first_pcm_bytes']);
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
