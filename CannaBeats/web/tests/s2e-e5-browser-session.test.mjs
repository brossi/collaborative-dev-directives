import assert from 'node:assert/strict';
import test from 'node:test';

import { E4PcmCore } from '../public/s2e-e4-worklet-core.js';
import { E5BrowserSession } from '../lib/s2e-e5-browser-session.mjs';

async function waitFor(predicate, label = 'condition') {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(`Timed out waiting for ${label}`);
}

function timerHarness() {
  let next = 1;
  const timers = new Map();
  return {
    schedule(callback, delay) {
      const id = next++;
      timers.set(id, { callback, delay });
      return id;
    },
    cancel(id) { timers.delete(id); },
    fireDelay(delay) {
      const entry = [...timers.entries()].find(([, value]) => value.delay === delay);
      if (!entry) return false;
      const [id, value] = entry;
      timers.delete(id);
      value.callback();
      return true;
    },
    timers,
  };
}

function eventTarget(initial = {}) {
  const listeners = new Map();
  return {
    ...initial,
    addEventListener(type, callback) { listeners.set(type, callback); },
    removeEventListener(type, callback) {
      if (listeners.get(type) === callback) listeners.delete(type);
    },
    emit(type) { listeners.get(type)?.(); },
    listeners,
  };
}

function workletNode(outputSampleRate = 48000, holdSnapshots = false) {
  let clientHandler = null;
  let heldSnapshot = null;
  let holdingSnapshots = holdSnapshots;
  const core = new E4PcmCore({
    outputSampleRate,
    postMessage(message) {
      if (holdingSnapshots && message.type === 'snapshot-rotated') {
        heldSnapshot = message;
        return;
      }
      queueMicrotask(() => clientHandler?.({ data: message }));
    },
  });
  const node = {
    connected: false,
    disconnected: false,
    port: {
      postMessage(message) { queueMicrotask(() => core.receive(message)); },
      get onmessage() { return clientHandler; },
      set onmessage(value) { clientHandler = value; },
    },
    connect() { node.connected = true; },
    disconnect() { node.disconnected = true; },
  };
  return {
    node,
    core,
    get heldSnapshot() { return heldSnapshot; },
    holdNextSnapshot() { holdingSnapshots = true; },
    releaseSnapshot() {
      const message = heldSnapshot;
      heldSnapshot = null;
      holdingSnapshots = false;
      queueMicrotask(() => clientHandler?.({ data: message }));
    },
  };
}

function pendingReader(chunks) {
  let cancelled = false;
  let releasePending;
  const pending = new Promise((resolve) => { releasePending = resolve; });
  return {
    async read() {
      if (chunks.length) return { done: false, value: chunks.shift() };
      return pending;
    },
    async cancel() {
      cancelled = true;
      releasePending({ done: true, value: undefined });
    },
    get cancelled() { return cancelled; },
  };
}

function finiteReader(chunks) {
  let cancelled = false;
  return {
    async read() {
      if (chunks.length) return { done: false, value: chunks.shift() };
      return { done: true, value: undefined };
    },
    async cancel() { cancelled = true; },
    get cancelled() { return cancelled; },
  };
}

function controlledReader() {
  const requests = [];
  let cancelled = false;
  return {
    read() { return new Promise((resolve) => requests.push(resolve)); },
    async cancel() {
      cancelled = true;
      for (const resolve of requests.splice(0)) resolve({ done: true, value: undefined });
    },
    deliver(value) {
      const resolve = requests.shift();
      assert.ok(resolve, 'a read must be pending');
      resolve({ done: false, value });
    },
    end() {
      const resolve = requests.shift();
      assert.ok(resolve, 'a read must be pending');
      resolve({ done: true, value: undefined });
    },
    get pendingReads() { return requests.length; },
    get cancelled() { return cancelled; },
  };
}

function response({ status = 200, sampleRate = 48000, channels = 2, reader }) {
  const values = new Map([
    ['x-audio-rate', String(sampleRate)],
    ['x-audio-channels', String(channels)],
    ['x-audio-encoding', 's16le'],
  ]);
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => values.get(name) ?? null },
    body: reader ? { getReader: () => reader } : null,
  };
}

function sessionHarness({
  responses, addModuleFails = false, observer = true, observerTakeFails = false,
  holdSnapshots = false, deferContext = false,
} = {}) {
  let now = 0;
  let uuidOrdinal = 1;
  const timers = timerHarness();
  const visibility = eventTarget({ visibilityState: 'visible' });
  const context = eventTarget({
    sampleRate: 48000,
    state: 'running',
    destination: {},
    resumed: false,
    closed: false,
    audioWorklet: {
      async addModule() {
        if (addModuleFails) throw new Error('module detail');
      },
    },
    async resume() { context.resumed = true; },
    async close() { context.closed = true; },
  });
  let resolveContext;
  const contextPending = deferContext
    ? new Promise((resolve) => { resolveContext = () => resolve(context); })
    : null;
  const worklet = workletNode(48000, holdSnapshots);
  const { node, core } = worklet;
  const controllers = [];
  const queue = [...(responses ?? [])];
  const statuses = [];
  const longTaskObserver = observer ? {
    records: [], disconnected: false,
    observe() {},
    takeRecords() {
      if (observerTakeFails) throw new Error('observer detail');
      return longTaskObserver.records.splice(0);
    },
    disconnect() { longTaskObserver.disconnected = true; },
  } : null;
  const dependencies = {
    now: () => now,
    uuid: () => `${String(uuidOrdinal++).padStart(8, '0')}-1111-4111-8111-111111111111`,
    fetch: async () => {
      if (!queue.length) return new Promise(() => {});
      return queue.shift();
    },
    createAbortController() {
      const controller = {
        signal: { aborted: false },
        abort() { controller.signal.aborted = true; },
      };
      controllers.push(controller);
      return controller;
    },
    createAudioContext: async () => (contextPending ? contextPending : context),
    createWorkletNode: () => node,
    scheduleTimeout: (callback, delay) => timers.schedule(callback, delay),
    cancelTimeout: (id) => timers.cancel(id),
    visibilityTarget: visibility,
    ...(observer ? { createLongTaskObserver: () => longTaskObserver } : {}),
  };
  const session = new E5BrowserSession({
    streamUrl: '/api/audio-stream?code=ABC234',
    client: {
      baseLatencyMs: { status: 'observed', value: 5 },
      outputLatencyMs: { status: 'unsupported' },
      browserFamily: 'chromium',
      browserMajor: { status: 'observed', value: 140 },
      osFamily: 'macos',
      displayMode: 'browser',
      implementationVersion: 1,
    },
    dependencies,
    onStatus: (value) => statuses.push(value),
  });
  return {
    session, timers, visibility, context, node, core, controllers, statuses,
    longTaskObserver, worklet,
    resolveContext,
    setNow(value) { now = value; },
  };
}

test('unattached session composes fetch, E4, E1 window rotation, and cleanup', async () => {
  const samples = new Int16Array(20);
  samples.fill(1000);
  const reader = pendingReader([new Uint8Array(samples.buffer)]);
  const harness = sessionHarness({ responses: [response({ reader })] });
  await harness.session.start();
  await waitFor(() => harness.core.metrics.receivedFrames === 10, 'PCM delivery');
  assert.equal(harness.node.connected, true);
  assert.equal(harness.context.resumed, true);
  harness.setNow(9000);
  assert.equal(harness.timers.fireDelay(9000), true);
  await waitFor(() => harness.session.lifecycle.windows.length === 1, 'E1 window');
  assert.equal(harness.session.lifecycle.windows[0].measurements.receivedFrames, 10);
  assert.equal(harness.session.lifecycle.windows[0].measurements.longTasks.status, 'observed');

  const cleanup = await harness.session.stop('requested');
  assert.deepEqual(cleanup, { status: 'closed', cleanupFailures: [] });
  assert.equal(reader.cancelled, true);
  assert.equal(harness.controllers[0].signal.aborted, true);
  assert.equal(harness.node.disconnected, true);
  assert.equal(harness.context.closed, true);
  assert.equal(harness.visibility.listeners.size, 0);
  assert.equal(harness.longTaskObserver.disconnected, true);
  assert.equal(harness.session.status, 'stopped');
});

test('503 ends one attempt and retry starts another without false reconnect', async () => {
  const reader = pendingReader([]);
  const harness = sessionHarness({
    responses: [response({ status: 503 }), response({ reader })],
  });
  await harness.session.start();
  await waitFor(() => harness.session.status === 'waiting', '503 waiting');
  assert.equal(harness.timers.fireDelay(1500), true);
  await waitFor(() => harness.session.lifecycle.attemptSequence === 1, 'retry attempt');
  assert.equal(harness.session.lifecycle.everDeliveredPcm, false);
  assert.equal(
    harness.session.lifecycle.transitions.some(
      (entry) => entry.measurements.type === 'reconnect',
    ),
    false,
  );
  await harness.session.stop();
});

test('unsupported format terminates finitely and releases initialized resources', async () => {
  const reader = pendingReader([]);
  const invalid = response({ reader });
  invalid.headers = { get: (name) => (name === 'x-audio-encoding' ? 'mp3' : '48000') };
  const harness = sessionHarness({ responses: [invalid] });
  await harness.session.start();
  await waitFor(() => harness.session.status === 'error', 'terminal error');
  assert.equal(harness.context.closed, true);
  assert.equal(harness.node.disconnected, true);
  assert.equal(JSON.stringify(harness.session.cleanupResult).includes('mp3'), false);
});

test('initialization failure uses the same complete cleanup path', async () => {
  const harness = sessionHarness({ addModuleFails: true });
  await assert.rejects(() => harness.session.start(), /initialization_failed/);
  assert.equal(harness.context.closed, true);
  assert.equal(harness.session.status, 'error');
  assert.deepEqual(harness.session.cleanupResult, {
    status: 'closed', cleanupFailures: [],
  });
});

test('missing Long Task API remains unsupported in accepted windows', async () => {
  const samples = new Int16Array(20);
  samples.fill(1000);
  const reader = pendingReader([new Uint8Array(samples.buffer)]);
  const harness = sessionHarness({ responses: [response({ reader })], observer: false });
  await harness.session.start();
  await waitFor(() => harness.core.metrics.receivedFrames === 10, 'PCM delivery');
  harness.setNow(9000);
  harness.timers.fireDelay(9000);
  await waitFor(() => harness.session.lifecycle.windows.length === 1, 'E1 window');
  assert.equal(
    harness.session.lifecycle.windows[0].measurements.longTasks.status, 'unsupported',
  );
  await harness.session.stop();
});

test('a chunk delivered during rotation is retagged and its ambiguous window fails closed', async () => {
  const reader = controlledReader();
  const harness = sessionHarness({
    responses: [response({ reader })], holdSnapshots: true,
  });
  await harness.session.start();
  await waitFor(() => reader.pendingReads === 1, 'pending body read');
  harness.setNow(9000);
  assert.equal(harness.timers.fireDelay(9000), true);
  await waitFor(() => harness.worklet.heldSnapshot !== null, 'withheld snapshot reply');

  const samples = new Int16Array(20);
  samples.fill(1000);
  harness.setNow(9001);
  reader.deliver(new Uint8Array(samples.buffer));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.core.metrics.receivedFrames, 0);

  harness.setNow(9002);
  harness.worklet.releaseSnapshot();
  await waitFor(() => harness.core.metrics.receivedFrames === 10, 'retagged new-epoch PCM');
  assert.equal(harness.session.lifecycle.windows.length, 1);
  assert.equal(harness.session.lifecycle.windows[0].measurements.receivedFrames, 0);

  harness.setNow(18000);
  assert.equal(harness.timers.fireDelay(9000), true);
  await waitFor(
    () => harness.session.lifecycle.localRecords.some(
      (entry) => entry.reason === 'boundary_ambiguous',
    ),
    'ambiguous new window gap',
  );
  assert.equal(harness.session.lifecycle.windows.length, 1);
  await harness.session.stop();
});

test('PCM-backed retry emits reconnect only when the later attempt begins', async () => {
  const samples = new Int16Array(20);
  samples.fill(1000);
  const first = finiteReader([new Uint8Array(samples.buffer)]);
  const second = pendingReader([]);
  const harness = sessionHarness({
    responses: [response({ reader: first }), response({ reader: second })],
  });
  await harness.session.start();
  await waitFor(() => harness.session.status === 'waiting', 'EOF retry wait');
  assert.equal(harness.timers.fireDelay(1500), true);
  await waitFor(() => harness.session.lifecycle.attemptSequence === 1, 'second attempt');
  assert.equal(
    harness.session.lifecycle.transitions.filter(
      (entry) => entry.measurements.type === 'reconnect',
    ).length,
    1,
  );
  await harness.session.stop();
});

test('validated format change rotates listener identity before new PCM', async () => {
  const first = finiteReader([new Uint8Array(new Int16Array(20).buffer)]);
  const second = pendingReader([]);
  const harness = sessionHarness({
    responses: [
      response({ reader: first, sampleRate: 48000 }),
      response({ reader: second, sampleRate: 24000 }),
    ],
  });
  await harness.session.start();
  await waitFor(() => harness.session.status === 'waiting', 'first EOF');
  const originalInstance = harness.session.lifecycle.instanceId;
  harness.timers.fireDelay(1500);
  await waitFor(() => harness.session.format?.sourceSampleRate === 24000, 'format rotation');
  assert.notEqual(harness.session.lifecycle.instanceId, originalInstance);
  assert.equal(harness.core.sourceSampleRate, 24000);
  assert.equal(harness.core.metrics.receivedFrames, 0);
  await harness.session.stop();
});

test('context suspension and resume are attributed to the active E1 window', async () => {
  const samples = new Int16Array(20);
  samples.fill(1000);
  const reader = pendingReader([new Uint8Array(samples.buffer)]);
  const harness = sessionHarness({ responses: [response({ reader })] });
  await harness.session.start();
  await waitFor(() => harness.core.metrics.receivedFrames === 10, 'PCM delivery');
  harness.setNow(100);
  harness.context.state = 'suspended';
  harness.context.emit('statechange');
  harness.setNow(200);
  harness.context.state = 'running';
  harness.context.emit('statechange');
  harness.setNow(9000);
  harness.timers.fireDelay(9000);
  await waitFor(() => harness.session.lifecycle.windows.length === 1, 'window');
  const report = harness.session.lifecycle.windows[0];
  assert.equal(report.measurements.suspensionCount, 1);
  assert.equal(report.measurements.audioContextState, 'running');
  assert.deepEqual(
    harness.session.lifecycle.transitions
      .filter((entry) => entry.measurements.type.startsWith('context_'))
      .map((entry) => entry.measurements.type),
    ['context_suspended', 'context_resumed'],
  );
  await harness.session.stop();
});

test('a hung fetch cannot block explicit session cleanup', async () => {
  const harness = sessionHarness({ responses: [] });
  await harness.session.start();
  await waitFor(() => harness.session.status === 'connecting', 'connecting status');
  const result = await harness.session.stop();
  assert.deepEqual(result, { status: 'closed', cleanupFailures: [] });
  assert.equal(harness.controllers[0].signal.aborted, true);
  assert.equal(harness.node.disconnected, true);
  assert.equal(harness.context.closed, true);
  assert.equal(harness.session.status, 'stopped');
});

test('stop during asynchronous initialization closes the late context', async () => {
  const harness = sessionHarness({ deferContext: true });
  const starting = harness.session.start();
  await Promise.resolve();
  assert.deepEqual(await harness.session.stop(), {
    status: 'closed', cleanupFailures: [],
  });
  harness.resolveContext();
  await assert.rejects(starting, /initialization_failed/);
  assert.equal(harness.context.closed, true);
  assert.equal(harness.node.connected, false);
});

test('failed body retirement completes before the next attempt begins', async () => {
  let cancelled = false;
  const failed = {
    async read() { throw new Error('read detail'); },
    async cancel() { cancelled = true; },
  };
  const second = pendingReader([]);
  const harness = sessionHarness({
    responses: [response({ reader: failed }), response({ reader: second })],
  });
  await harness.session.start();
  await waitFor(() => harness.session.status === 'waiting', 'retired failure');
  assert.equal(cancelled, true);
  assert.equal(harness.controllers[0].signal.aborted, true);
  assert.equal(harness.timers.fireDelay(1500), true);
  await waitFor(() => harness.session.lifecycle.attemptSequence === 1, 'retry');
  await harness.session.stop();
});

test('a playing reconnect emits fresh attempt milestones exactly once', async () => {
  const first = controlledReader();
  const second = controlledReader();
  const harness = sessionHarness({
    responses: [response({ reader: first }), response({ reader: second })],
  });
  await harness.session.start();
  await waitFor(() => first.pendingReads === 1, 'first read');
  const pcm = new Int16Array(15000 * 2);
  pcm.fill(1000);
  first.deliver(new Uint8Array(pcm.buffer));
  await waitFor(() => harness.core.metrics.receivedFrames === 15000, 'first PCM');
  harness.core.process([new Float32Array(128), new Float32Array(128)]);
  await new Promise((resolve) => setImmediate(resolve));
  first.end();
  await waitFor(() => harness.session.status === 'waiting', 'first EOF');
  harness.timers.fireDelay(1500);
  await waitFor(() => second.pendingReads === 1, 'second read');
  second.deliver(new Uint8Array(pcm.buffer.slice(0)));
  await waitFor(() => harness.core.metrics.receivedFrames === 15000, 'second PCM');
  harness.core.process([new Float32Array(128), new Float32Array(128)]);
  await new Promise((resolve) => setImmediate(resolve));
  const milestones = harness.session.lifecycle.transitions.filter(
    (entry) => ['buffer_primed', 'first_rendered_quantum'].includes(entry.measurements.type),
  );
  assert.deepEqual(
    milestones.map((entry) => [
      entry.measurements.connectionAttemptSequence, entry.measurements.type,
    ]),
    [
      [0, 'buffer_primed'], [0, 'first_rendered_quantum'],
      [1, 'buffer_primed'], [1, 'first_rendered_quantum'],
    ],
  );
  await harness.session.stop();
});

test('context point state remains current during retry backoff', async () => {
  const first = finiteReader([new Uint8Array(new Int16Array(20).buffer)]);
  const second = pendingReader([]);
  const harness = sessionHarness({
    responses: [response({ reader: first }), response({ reader: second })],
  });
  await harness.session.start();
  await waitFor(() => harness.session.status === 'waiting', 'retry backoff');
  harness.setNow(100);
  harness.context.state = 'suspended';
  harness.context.emit('statechange');
  assert.equal(harness.session.lifecycle.contextStateValue, 'suspended');
  assert.equal(harness.session.projector.audioContextState, 'suspended');
  assert.equal(harness.session.projector.suspensionCount, 1);
  await harness.session.stop();
});

test('Long Task observer failure degrades evidence without stopping audio', async () => {
  const samples = new Int16Array(20);
  samples.fill(1000);
  const reader = pendingReader([new Uint8Array(samples.buffer)]);
  const harness = sessionHarness({
    responses: [response({ reader })], observerTakeFails: true,
  });
  await harness.session.start();
  await waitFor(() => harness.core.metrics.receivedFrames === 10, 'PCM');
  harness.setNow(9000);
  harness.timers.fireDelay(9000);
  await waitFor(() => harness.session.lifecycle.windows.length === 1, 'window');
  assert.equal(
    harness.session.lifecycle.windows[0].measurements.longTasks.status, 'unknown',
  );
  assert.equal(harness.session.active, true);
  await harness.session.stop();
});

test('diagnostic reset rotates identity only after a playback-preserving acknowledgement', async () => {
  const samples = new Int16Array(200);
  samples.fill(1000);
  const reader = pendingReader([new Uint8Array(samples.buffer)]);
  const harness = sessionHarness({ responses: [response({ reader })] });
  await harness.session.start();
  await waitFor(() => harness.core.metrics.receivedFrames === 100, 'PCM');
  const priorInstance = harness.session.lifecycle.instanceId;
  const priorWriteFrame = harness.core.writeFrame;
  const attempt = harness.session.lifecycle.attemptSequence;
  const result = await harness.session.resetDiagnostics();
  assert.equal(result.status, 'reset');
  assert.notEqual(result.instanceId, priorInstance);
  assert.equal(harness.core.writeFrame, priorWriteFrame);
  assert.equal(harness.session.lifecycle.attemptSequence, attempt);
  assert.equal(harness.session.lifecycle.windows.length, 0);
  assert.equal(harness.session.lifecycle.transitions.length, 0);
  await harness.session.stop();
});

test('lost snapshot replies terminate the uncertain worklet after one exact retry', async () => {
  const reader = pendingReader([]);
  const harness = sessionHarness({
    responses: [response({ reader })], holdSnapshots: true,
  });
  await harness.session.start();
  await waitFor(() => harness.session.projector !== null, 'configured projector');
  harness.setNow(9000);
  harness.timers.fireDelay(9000);
  await waitFor(() => harness.worklet.heldSnapshot !== null, 'held snapshot');
  assert.equal(harness.timers.fireDelay(250), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.timers.fireDelay(250), true);
  await waitFor(() => harness.session.status === 'error', 'finite timeout');
  assert.equal(harness.node.disconnected, true);
  assert.equal(harness.context.closed, true);
});

test('a delayed foreground timer rotates counters but records only a bounded gap', async () => {
  const samples = new Int16Array(20);
  samples.fill(1000);
  const reader = pendingReader([new Uint8Array(samples.buffer)]);
  const harness = sessionHarness({ responses: [response({ reader })] });
  await harness.session.start();
  await waitFor(() => harness.core.metrics.receivedFrames === 10, 'PCM');
  harness.setNow(11000);
  harness.timers.fireDelay(9000);
  await waitFor(
    () => harness.session.lifecycle.localRecords.some(
      (entry) => entry.reason === 'timer_delayed' && entry.durationMs === 11000,
    ),
    'timer gap',
  );
  assert.equal(harness.session.lifecycle.windows.length, 0);
  assert.equal(harness.core.metrics.receivedFrames, 0);
  assert.equal(harness.session.active, true);
  await harness.session.stop();
});

test('session teardown is idempotent after resources are released', async () => {
  const harness = sessionHarness({ responses: [] });
  await harness.session.start();
  const first = harness.session.stop();
  const second = harness.session.stop();
  assert.equal(first, second);
  assert.deepEqual(await first, { status: 'closed', cleanupFailures: [] });
});

test('periodic and concurrent diagnostic rotations remain strictly serialized', async () => {
  const reader = pendingReader([]);
  const harness = sessionHarness({
    responses: [response({ reader })], holdSnapshots: true,
  });
  await harness.session.start();
  await waitFor(() => harness.session.projector !== null, 'configured projector');
  harness.setNow(100);
  harness.timers.fireDelay(9000);
  await waitFor(() => harness.worklet.heldSnapshot !== null, 'periodic snapshot');
  const firstReset = harness.session.resetDiagnostics();
  const secondReset = harness.session.resetDiagnostics();
  harness.setNow(101);
  harness.worklet.releaseSnapshot();
  const [first, second] = await Promise.all([firstReset, secondReset]);
  assert.notEqual(first.instanceId, second.instanceId);
  assert.equal(harness.session.lifecycle.instanceId, second.instanceId);
  assert.equal(harness.core.epoch, 4);
  assert.equal(harness.session.active, true);
  await harness.session.stop();
});

test('lost diagnostic-reset acknowledgement retires the uncertain session', async () => {
  const reader = pendingReader([]);
  const harness = sessionHarness({
    responses: [response({ reader })], holdSnapshots: true,
  });
  await harness.session.start();
  await waitFor(() => harness.session.projector !== null, 'configured projector');
  const resetting = harness.session.resetDiagnostics();
  await waitFor(() => harness.worklet.heldSnapshot !== null, 'reset snapshot');
  assert.equal(harness.timers.fireDelay(250), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.timers.fireDelay(250), true);
  await assert.rejects(resetting, /command_timeout/);
  assert.equal(harness.session.status, 'error');
  assert.equal(harness.session.active, false);
  assert.equal(harness.node.disconnected, true);
  assert.equal(harness.context.closed, true);
});

test('body-reader acquisition failure retains the finite stream outcome', async () => {
  const broken = response({ reader: pendingReader([]) });
  broken.body = { getReader() { throw new Error('reader detail'); } };
  const harness = sessionHarness({ responses: [broken] });
  await harness.session.start();
  await waitFor(() => harness.session.status === 'error', 'reader failure');
  const failure = harness.session.lifecycle.transitions.find(
    (entry) => entry.measurements.type === 'stream_failed',
  );
  assert.equal(failure.measurements.reason, 'stream_error');
  assert.equal(JSON.stringify(harness.session.cleanupResult).includes('reader detail'), false);
});

test('format change and diagnostic reset serialize as complete control transactions', async () => {
  const first = finiteReader([new Uint8Array(new Int16Array(20).buffer)]);
  const second = pendingReader([]);
  const harness = sessionHarness({
    responses: [
      response({ reader: first, sampleRate: 48000 }),
      response({ reader: second, sampleRate: 24000 }),
    ],
  });
  await harness.session.start();
  await waitFor(() => harness.session.status === 'waiting', 'first EOF');
  harness.worklet.holdNextSnapshot();
  harness.timers.fireDelay(1500);
  await waitFor(() => harness.worklet.heldSnapshot !== null, 'held format stop');
  const resetting = harness.session.resetDiagnostics();
  harness.worklet.releaseSnapshot();
  const reset = await resetting;
  await waitFor(() => harness.session.format?.sourceSampleRate === 24000, 'new format');
  assert.equal(harness.core.sourceSampleRate, 24000);
  assert.equal(harness.core.lifecycle, 'configured');
  assert.equal(harness.session.lifecycle.instanceId, reset.instanceId);
  assert.equal(harness.session.active, true);
  await harness.session.stop();
});
