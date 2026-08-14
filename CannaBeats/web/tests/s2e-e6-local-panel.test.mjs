import assert from 'node:assert/strict';
import test from 'node:test';

import { validateMeasurementJson } from '../lib/s2e-e1-contract.mjs';
import {
  createE6LocalCopy, E6_COPY_DISCLOSURE, E6PanelController, E6PanelError,
  projectE6LocalPanel,
} from '../lib/s2e-e6-local-panel.mjs';

const INSTANCE = '123e4567-e89b-42d3-a456-426614174000';
const bytes = (value) => Buffer.from(JSON.stringify(value));

function listenerWindow() {
  return validateMeasurementJson(bytes({
    schemaVersion: 1,
    kind: 'listener_window',
    instanceId: INSTANCE,
    sequence: 1,
    monotonicStartMs: 0,
    durationMs: 9000,
    measurements: {
      connectionAttemptSequence: 0,
      receivedBytes: 36000,
      receivedFrames: 9000,
      chunkCount: 1,
      chunkGap: { status: 'not_applicable' },
      reconnectCount: 0,
      terminalCategory: 'open',
      bufferDepth: { status: 'observed', sampleCount: 1, currentMs: 400, minMs: 400, maxMs: 400, meanMs: 400, trendMsPerSecond: 0 },
      underrunCount: 0,
      underrunDurationMs: 0,
      reprimeCount: 0,
      windowStartedInUnderrun: false,
      overflowCount: 0,
      discardedFrames: 0,
      resetCount: 0,
      sourceSampleRate: 48000,
      sourceChannels: 2,
      outputSampleRate: 48000,
      nominalRateRatio: 1,
      audioContextState: 'running',
      baseLatencyMs: { status: 'observed', value: 5 },
      outputLatencyMs: { status: 'unsupported' },
      visibilityState: 'visible',
      suspensionCount: 0,
      longTasks: { status: 'unsupported' },
      signalPresence: 'present',
      clippingSeverity: 'none',
      browserFamily: 'safari',
      browserMajor: { status: 'observed', value: 18 },
      osFamily: 'ios',
      displayMode: 'browser',
      implementationVersion: 1,
    },
  }));
}

function listenerTransition() {
  return validateMeasurementJson(bytes({
    schemaVersion: 1,
    kind: 'listener_transition',
    instanceId: INSTANCE,
    sequence: 0,
    monotonicStartMs: 0,
    durationMs: 0,
    measurements: {
      connectionAttemptSequence: 0,
      type: 'request_started',
      category: 'observed',
      elapsedMs: 0,
    },
  }));
}

function lifecycle(overrides = {}) {
  return {
    instanceId: INSTANCE,
    windows: [listenerWindow()],
    transitions: [listenerTransition()],
    localRecords: [],
    droppedTransitionCount: 0,
    ...overrides,
  };
}

test('panel projection exposes a bounded current-instance local summary', () => {
  const panel = projectE6LocalPanel({ status: 'playing', lifecycle: lifecycle() });
  assert.deepEqual(panel.latestWindow, {
    bufferStatus: 'observed', bufferCurrentMs: 400,
    audioContextState: 'running', signalPresence: 'present',
    clippingSeverity: 'none', underrunCount: 0, overflowCount: 0,
  });
  assert.equal(panel.windowCount, 1);
  assert.equal(panel.transitionCount, 1);
  assert.equal(panel.uploadState, 'disabled');
  assert.equal(panel.disclosure, E6_COPY_DISCLOSURE);
});

test('copy is exactly one E1-validated current-instance local export', () => {
  const copy = createE6LocalCopy({ lifecycle: lifecycle(), generatedAtMonotonicMs: 9000 });
  const parsed = JSON.parse(copy.text);
  assert.equal(copy.summaryCount, 2);
  assert.equal(parsed.status, 'local_only');
  assert.equal(parsed.uploadState, 'disabled');
  assert.equal(parsed.instanceId, INSTANCE);
  assert.deepEqual(parsed.summaries.map((report) => report.sequence), [0, 1]);
  assert.doesNotMatch(copy.text, /room|song|token|principal|spotify|audio:/i);
});

test('empty and mixed-instance rings fail with finite copy outcomes', () => {
  assert.throws(
    () => createE6LocalCopy({ lifecycle: lifecycle({ windows: [], transitions: [] }), generatedAtMonotonicMs: 0 }),
    (error) => error instanceof E6PanelError && error.code === 'copy_unavailable',
  );
  const foreign = { ...listenerTransition(), instanceId: '123e4567-e89b-42d3-a456-426614174001' };
  assert.throws(
    () => projectE6LocalPanel({ status: 'playing', lifecycle: lifecycle({ transitions: [foreign] }) }),
    (error) => error instanceof E6PanelError && error.code === 'panel_invalid',
  );
});

test('malformed ring entries fail before sorting with one finite panel error', () => {
  const malformed = { instanceId: INSTANCE };
  assert.throws(
    () => projectE6LocalPanel({
      status: 'playing', lifecycle: lifecycle({ transitions: [malformed, listenerTransition()] }),
    }),
    (error) => error instanceof E6PanelError && error.code === 'panel_invalid',
  );
});

test('panel controller cancels polling on stop and stays closed after restart', () => {
  let reads = 0;
  let nextTimer = 1;
  const timers = new Map();
  const states = [];
  const controller = new E6PanelController({
    read: () => ({ copyAvailable: true, ordinal: ++reads }),
    copy: async () => {},
    reset: async () => {},
    scheduleInterval(callback, delay) {
      const id = nextTimer++;
      timers.set(id, { callback, delay });
      return id;
    },
    cancelInterval: (id) => timers.delete(id),
    onChange: (state) => states.push(state),
  });
  controller.sync({ enabled: true, generation: 1 });
  controller.setOpen(true);
  assert.equal(timers.size, 1);
  assert.equal(states.at(-1).open, true);
  const staleTick = [...timers.values()][0].callback;
  staleTick();
  assert.equal(reads, 2);

  controller.sync({ enabled: false, generation: 2 });
  assert.equal(timers.size, 0);
  assert.deepEqual(states.at(-1), {
    open: false, diagnostics: null, busy: false, notice: '',
  });
  staleTick();
  assert.equal(reads, 2);

  controller.sync({ enabled: true, generation: 3 });
  assert.equal(states.at(-1).open, false);
  assert.equal(timers.size, 0);
});

test('panel controller serializes actions and ignores a stale reset acknowledgement', async () => {
  let resetCalls = 0;
  let resolveReset;
  const heldReset = new Promise((resolve) => { resolveReset = resolve; });
  const states = [];
  const controller = new E6PanelController({
    read: () => ({ copyAvailable: true }),
    copy: async () => { throw new Error('clipboard detail'); },
    reset: async () => { resetCalls += 1; await heldReset; },
    scheduleInterval: () => 1,
    cancelInterval: () => {},
    onChange: (state) => states.push(state),
  });
  controller.sync({ enabled: true, generation: 1 });
  controller.setOpen(true);
  assert.equal(await controller.copy(), false);
  assert.equal(states.at(-1).notice, 'copy_failed');

  const first = controller.reset();
  assert.equal(await controller.reset(), false);
  assert.equal(resetCalls, 1);
  controller.sync({ enabled: true, generation: 2 });
  resolveReset();
  assert.equal(await first, false);
  assert.equal(states.at(-1).notice, '');
  assert.equal(states.at(-1).open, false);
});

test('copy disclosure names pseudonymous fields and prohibited categories before UI attachment', () => {
  assert.match(E6_COPY_DISCLOSURE, /temporary diagnostic ID/);
  assert.match(E6_COPY_DISCLOSURE, /browser and operating-system family/);
  assert.match(E6_COPY_DISCLOSURE, /local timing/);
  assert.match(E6_COPY_DISCLOSURE, /no name, account, room code, song, audio, token, IP address, or upload/);
});
