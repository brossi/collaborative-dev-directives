import {
  canonicalMeasurementBytes, classifySignalWindow, validateMeasurementJson,
} from './s2e-e1-contract.mjs';

const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const MAX_STAGED_PCM_BYTES = 1024 * 1024;
const MAX_WINDOWS = 90;
const MAX_TRANSITIONS = 64;
const MAX_LOCAL_RECORDS = 16;

function finiteTime(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    && value <= MAX_SAFE && !Object.is(value, -0);
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function canonicalUuid(value) {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}

function frozen(value) {
  return Object.freeze(value);
}

function jsonBytes(value) {
  return new TextEncoder().encode(JSON.stringify(value));
}

export class E5LifecycleError extends Error {
  constructor(code) {
    super(code);
    this.name = 'E5LifecycleError';
    this.code = code;
  }
}

function fail(code) {
  throw new E5LifecycleError(code);
}

function pushBounded(target, value, maximum) {
  if (target.length === maximum) target.shift();
  target.push(frozen(value));
}

export class E5WorkletPort {
  constructor({ port, scheduleTimeout, cancelTimeout, timeoutMs = 250, onState = () => {} }) {
    if (!port || typeof port.postMessage !== 'function'
      || typeof scheduleTimeout !== 'function' || typeof cancelTimeout !== 'function'
      || !positiveInteger(timeoutMs) || typeof onState !== 'function') fail('port_invalid');
    this.port = port;
    this.scheduleTimeout = scheduleTimeout;
    this.cancelTimeout = cancelTimeout;
    this.timeoutMs = timeoutMs;
    this.onState = onState;
    this.requestId = 1;
    this.epoch = 0;
    this.lifecycle = 'unconfigured';
    this.pending = null;
    this.stagedPcm = null;
    this.closed = false;
    this.port.onmessage = (event) => this.#receive(event?.data);
  }

  configure({ sampleRate, channels }) {
    if (this.lifecycle === 'configured') fail('invalid_state');
    const epoch = this.lifecycle === 'stopped' ? this.epoch + 1 : 1;
    return this.#command({
      type: 'configure', requestId: this.requestId, epoch, sampleRate, channels,
    });
  }

  rotate(operation) {
    if (!['snapshot', 'reset', 'stop'].includes(operation)) fail('operation_invalid');
    if (this.lifecycle !== 'configured') fail('invalid_state');
    return this.#command({
      type: `${operation}-and-rotate`, requestId: this.requestId,
      epoch: this.epoch, nextEpoch: this.epoch + 1,
    });
  }

  sendPcm(buffer) {
    if (this.closed || this.lifecycle !== 'configured') return false;
    let byteLength;
    try {
      if (!(buffer instanceof ArrayBuffer)
        || Object.getPrototypeOf(buffer) !== ArrayBuffer.prototype) return false;
      byteLength = buffer.byteLength;
    } catch {
      return false;
    }
    if (byteLength === 0 || byteLength > MAX_STAGED_PCM_BYTES) return false;
    if (this.pending) {
      if (this.pending.command.type !== 'snapshot-and-rotate') return false;
      if (this.stagedPcm) fail('staging_full');
      this.stagedPcm = buffer;
      return true;
    }
    this.port.postMessage({ type: 'pcm', epoch: this.epoch, buffer }, [buffer]);
    return true;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.pending && this.pending.timer !== null) this.cancelTimeout(this.pending.timer);
    if (this.pending) this.pending.reject(new E5LifecycleError('port_closed'));
    this.pending = null;
    this.stagedPcm = null;
    this.port.onmessage = null;
  }

  #command(command) {
    if (this.closed) fail('port_closed');
    if (this.pending) fail('command_pending');
    return new Promise((resolve, reject) => {
      this.pending = { command: frozen(command), resolve, reject, attempts: 0, timer: null };
      this.#postPending();
    });
  }

  #postPending() {
    const pending = this.pending;
    if (!pending || this.closed) return;
    pending.attempts += 1;
    this.port.postMessage(pending.command);
    pending.timer = this.scheduleTimeout(() => {
      if (this.pending !== pending || this.closed) return;
      if (pending.attempts < 2) this.#postPending();
      else this.#fatal('command_timeout');
    }, this.timeoutMs);
  }

  #receive(message) {
    if (this.closed || !message || typeof message !== 'object') return;
    if (message.type === 'playback-state') {
      if (message.epoch === this.epoch && positiveInteger(message.ordinal)
        && ['buffering', 'playing', 'underrun', 'stopped'].includes(message.state)) {
        this.onState(frozen({ ...message }));
      }
      return;
    }
    const pending = this.pending;
    if (!pending || !positiveInteger(message.requestId)) return;
    if (message.requestId < pending.command.requestId) return;
    if (message.requestId !== pending.command.requestId) {
      this.#fatal('reply_mismatch');
      return;
    }
    if (message.type === 'command-rejected') {
      if (!['request_conflict', 'invalid_state', 'stale_epoch', 'invalid_rotation', 'not_configured'].includes(message.code)
        || message.epoch !== pending.command.epoch) {
        this.#fatal('reply_invalid');
        return;
      }
      this.#fatal(message.code);
      return;
    }
    if (pending.command.type === 'configure') {
      if (message.type !== 'configured' || message.epoch !== pending.command.epoch
        || message.sampleRate !== pending.command.sampleRate
        || message.channels !== pending.command.channels) {
        this.#fatal('reply_invalid');
        return;
      }
      this.epoch = message.epoch;
      this.lifecycle = 'configured';
    } else {
      const operation = pending.command.type.split('-')[0];
      if (message.type !== 'snapshot-rotated' || message.operation !== operation
        || message.previousEpoch !== pending.command.epoch
        || message.epoch !== pending.command.nextEpoch || !message.snapshot) {
        this.#fatal('reply_invalid');
        return;
      }
      this.epoch = message.epoch;
      if (operation === 'stop') this.lifecycle = 'stopped';
    }
    this.#settleSuccess(message);
  }

  #settleSuccess(message) {
    const pending = this.pending;
    this.cancelTimeout(pending.timer);
    this.pending = null;
    this.requestId += 1;
    const staged = this.stagedPcm;
    this.stagedPcm = null;
    pending.resolve(frozen(message));
    if (staged && this.lifecycle === 'configured') {
      this.port.postMessage({ type: 'pcm', epoch: this.epoch, buffer: staged }, [staged]);
    }
  }

  #fatal(code) {
    const pending = this.pending;
    if (pending?.timer !== null) this.cancelTimeout(pending.timer);
    this.pending = null;
    this.stagedPcm = null;
    this.closed = true;
    this.port.onmessage = null;
    pending?.reject(new E5LifecycleError(code));
  }
}

const MILESTONE_ORDER = [
  'request_started', 'response_headers', 'first_pcm_bytes',
  'buffer_primed', 'first_rendered_quantum',
];

export class E5ListenerLifecycle {
  constructor({ instanceId, now }) {
    if (!canonicalUuid(instanceId) || typeof now !== 'function' || !finiteTime(now())) {
      fail('lifecycle_invalid');
    }
    this.instanceId = instanceId;
    this.now = now;
    this.attemptSequence = -1;
    this.attempt = null;
    this.windows = [];
    this.transitions = [];
    this.localRecords = [];
    this.nextSequence = 0;
    this.everDeliveredPcm = false;
    this.playbackStateValue = 'stopped';
    this.contextStateValue = 'unknown';
  }

  beginAttempt() {
    if (this.attempt?.terminalCategory === 'open') fail('attempt_open');
    this.attemptSequence += 1;
    const reconnect = this.everDeliveredPcm;
    this.attempt = {
      sequence: this.attemptSequence,
      startedAtMs: this.#time(),
      terminalCategory: 'open',
      milestones: new Set(),
      deliveredPcm: false,
      lastChunkMs: null,
    };
    this.#milestone('request_started');
    if (reconnect) this.#transition('reconnect', { category: 'observed' });
    return this.attemptSequence;
  }

  responseHeaders() {
    this.#requireOpen();
    this.#milestone('response_headers');
  }

  pcmDelivered({ bytes, frames }) {
    this.#requireOpen();
    if (!positiveInteger(bytes) || !positiveInteger(frames)) fail('delivery_invalid');
    this.attempt.deliveredPcm = true;
    this.everDeliveredPcm = true;
    this.attempt.lastChunkMs = this.#time();
    this.#milestone('first_pcm_bytes');
  }

  playbackState(state) {
    this.#requireOpen();
    if (state === this.playbackStateValue) return;
    this.playbackStateValue = state;
    if (state === 'playing') {
      this.#milestone('buffer_primed');
      this.#milestone('first_rendered_quantum');
    } else if (state === 'underrun') {
      this.#transition('underrun', { category: 'observed' });
    } else if (state !== 'buffering') fail('state_invalid');
  }

  contextState(state) {
    this.#requireOpen();
    if (!['running', 'suspended'].includes(state)) fail('state_invalid');
    const prior = this.contextStateValue;
    if (prior === state) return;
    this.contextStateValue = state;
    if (prior === 'running' && state === 'suspended') {
      this.#transition('context_suspended', { category: 'observed' });
    } else if (prior === 'suspended' && state === 'running') {
      this.#transition('context_resumed', { category: 'observed' });
    }
  }

  endAttempt(category) {
    this.#requireOpen();
    if (!['no_response', 'rejected', 'unsupported_format', 'stream_error', 'stream_ended', 'aborted'].includes(category)) {
      fail('terminal_invalid');
    }
    this.attempt.terminalCategory = category;
    if (category === 'stream_ended') {
      this.#transition('stream_ended', { category: 'observed', reason: 'eof' });
    } else if (category !== 'aborted') {
      this.#transition('stream_failed', { category: 'error', reason: category });
    }
  }

  stopListener(reason) {
    if (!['requested', 'page_teardown', 'run_changed', 'unknown'].includes(reason)) {
      fail('stop_invalid');
    }
    if (this.attempt?.terminalCategory === 'open') this.attempt.terminalCategory = 'aborted';
    if (this.attempt) {
      this.#transition('listener_stopped', {
        category: reason === 'unknown' ? 'unknown' : 'observed', reason,
      });
    }
  }

  rotateInstance(instanceId) {
    if (!canonicalUuid(instanceId) || instanceId === this.instanceId) fail('instance_invalid');
    this.instanceId = instanceId;
    this.nextSequence = 0;
    this.windows.length = 0;
    this.transitions.length = 0;
    this.localRecords.length = 0;
  }

  recordGap(reason, durationMs) {
    if (!['timer_delayed', 'boundary_ambiguous', 'projection_invalid'].includes(reason)
      || !finiteTime(durationMs)) fail('gap_invalid');
    pushBounded(this.localRecords, {
      type: 'coverage_gap', reason, durationMs, occurredAtMs: this.#time(),
    }, MAX_LOCAL_RECORDS);
  }

  appendWindow(report) {
    try {
      canonicalMeasurementBytes(report);
    } catch {
      fail('projection_invalid');
    }
    if (report.kind !== 'listener_window' || report.instanceId !== this.instanceId) {
      fail('projection_invalid');
    }
    pushBounded(this.windows, report, MAX_WINDOWS);
  }

  allocateSequence() {
    const sequence = this.nextSequence;
    if (sequence >= MAX_SAFE) fail('sequence_exhausted');
    this.nextSequence += 1;
    return sequence;
  }

  #milestone(type) {
    const index = MILESTONE_ORDER.indexOf(type);
    if (index < 0 || this.attempt.milestones.has(type)) return;
    for (let prior = 0; prior < index; prior += 1) {
      if (!this.attempt.milestones.has(MILESTONE_ORDER[prior])) fail('milestone_order');
    }
    this.attempt.milestones.add(type);
    const elapsedMs = type === 'request_started' ? 0 : this.#time() - this.attempt.startedAtMs;
    this.#transition(type, { category: 'observed', elapsedMs });
  }

  #transition(type, detail) {
    const occurredAtMs = this.#time();
    try {
      const report = validateMeasurementJson(jsonBytes({
        schemaVersion: 1,
        kind: 'listener_transition',
        instanceId: this.instanceId,
        sequence: this.allocateSequence(),
        monotonicStartMs: occurredAtMs,
        durationMs: 0,
        measurements: {
          connectionAttemptSequence: this.attemptSequence,
          type,
          ...detail,
        },
      }));
      pushBounded(this.transitions, report, MAX_TRANSITIONS);
    } catch {
      this.recordGap('projection_invalid', 0);
    }
  }

  #requireOpen() {
    if (!this.attempt || this.attempt.terminalCategory !== 'open') fail('attempt_closed');
  }

  #time() {
    const value = this.now();
    if (!finiteTime(value)) fail('clock_invalid');
    return value;
  }
}

function boundary(value) {
  if (!value || !finiteTime(value.dispatchMs) || !finiteTime(value.replyMs)
    || value.replyMs < value.dispatchMs) fail('boundary_invalid');
  return frozen({
    dispatchMs: value.dispatchMs,
    replyMs: value.replyMs,
    midpointMs: value.dispatchMs + ((value.replyMs - value.dispatchMs) / 2),
    uncertaintyMs: (value.replyMs - value.dispatchMs) / 2,
  });
}

function overlaps(leftStart, leftEnd, rightStart, rightEnd) {
  return leftStart < rightEnd && leftEnd > rightStart;
}

function finiteCounter(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

export class E5PcmChunker {
  constructor(channels) {
    if (![1, 2].includes(channels)) fail('format_invalid');
    this.channels = channels;
    this.bytesPerFrame = channels * 2;
    this.carry = new Uint8Array(0);
  }

  consume(value) {
    if (!(value instanceof Uint8Array)
      || Object.getPrototypeOf(value) !== Uint8Array.prototype) fail('chunk_invalid');
    const combined = new Uint8Array(this.carry.length + value.length);
    combined.set(this.carry);
    combined.set(value, this.carry.length);
    const completeBytes = combined.length - (combined.length % this.bytesPerFrame);
    const pcm = combined.slice(0, completeBytes);
    this.carry = combined.slice(completeBytes);
    return frozen({
      buffer: pcm.buffer,
      receivedBytes: completeBytes,
      receivedFrames: completeBytes / this.bytesPerFrame,
    });
  }

  finish() {
    const complete = this.carry.length === 0;
    this.carry = new Uint8Array(0);
    return complete;
  }
}

export class E5WindowProjector {
  constructor({ lifecycle, format, client, startBoundary }) {
    if (!(lifecycle instanceof E5ListenerLifecycle)) fail('projector_invalid');
    if (!format || !Number.isInteger(format.sourceSampleRate)
      || !Number.isInteger(format.outputSampleRate) || ![1, 2].includes(format.sourceChannels)) {
      fail('format_invalid');
    }
    this.lifecycle = lifecycle;
    this.format = frozen({ ...format });
    this.client = frozen({ ...client });
    this.startBoundary = boundary(startBoundary);
    this.#resetAccumulator();
  }

  recordChunk({ frames, atMs }) {
    if (!positiveInteger(frames) || !finiteTime(atMs)) fail('delivery_invalid');
    this.#observation(atMs);
    const bytes = frames * this.format.sourceChannels * 2;
    if (!Number.isSafeInteger(bytes)) fail('delivery_invalid');
    if (this.chunkCount > 0) {
      const gap = atMs - this.lastChunkMs;
      if (!finiteTime(gap)) fail('delivery_invalid');
      this.chunkGapCount += 1;
      this.chunkGapSumMs += gap;
      this.chunkGapMaxMs = Math.max(this.chunkGapMaxMs, gap);
    }
    this.chunkCount += 1;
    this.receivedFrames += frames;
    this.receivedBytes += bytes;
    this.lastChunkMs = atMs;
  }

  recordReconnect(atMs) {
    this.#observation(atMs);
    this.reconnectCount += 1;
  }

  recordSuspension(atMs) {
    this.#observation(atMs);
    this.suspensionCount += 1;
  }

  setTerminalCategory(category, atMs) {
    this.#observation(atMs);
    this.terminalCategory = category;
  }

  setAudioContextState(state, atMs) {
    this.#observation(atMs);
    this.audioContextState = state;
  }

  setVisibilityState(state, atMs) {
    this.#observation(atMs);
    this.visibilityState = state;
  }

  finalize({ snapshot, endBoundary, longTaskEntries = [] }) {
    const end = boundary(endBoundary);
    const start = this.startBoundary;
    const durationMs = end.midpointMs - start.midpointMs;
    const gap = (reason) => {
      this.lifecycle.recordGap(reason, Math.max(0, durationMs));
      this.startBoundary = end;
      this.#resetAccumulator();
      return frozen({ status: 'gap', reason });
    };
    if (!(durationMs > 0 && durationMs <= 10000)) return gap('timer_delayed');
    if (!Array.isArray(longTaskEntries)) return gap('projection_invalid');
    if ((this.firstObservationMs !== null && this.firstObservationMs < start.replyMs)
      || (this.lastObservationMs !== null && this.lastObservationMs >= end.dispatchMs)) {
      return gap('boundary_ambiguous');
    }

    let longTaskCount = 0;
    let longTaskMaxMs = 0;
    for (const entry of longTaskEntries) {
      if (!entry || !finiteTime(entry.startTime) || !finiteTime(entry.duration)) {
        return gap('projection_invalid');
      }
      const entryEnd = entry.startTime + entry.duration;
      if (!finiteTime(entryEnd)) return gap('projection_invalid');
      if (overlaps(entry.startTime, entryEnd, start.dispatchMs, start.replyMs)
        || overlaps(entry.startTime, entryEnd, end.dispatchMs, end.replyMs)) {
        return gap('boundary_ambiguous');
      }
      if (entry.startTime >= start.replyMs && entryEnd <= end.dispatchMs) {
        longTaskCount += 1;
        longTaskMaxMs = Math.max(longTaskMaxMs, entry.duration);
      }
    }

    try {
      const counters = [
        'receivedFrames', 'silentInputFrames', 'clippedInputFrames',
        'bufferSampleCount', 'bufferCurrentFrames', 'bufferMinFrames',
        'bufferMaxFrames', 'bufferSumFrames', 'bufferTrendStartFrames',
        'bufferTrendEndFrames', 'underrunCount', 'underrunFrames',
        'reprimeCount', 'overflowCount', 'discardedFrames', 'resetCount',
      ];
      if (!snapshot || counters.some((key) => !finiteCounter(snapshot[key]))
        || snapshot.receivedFrames !== this.receivedFrames
        || snapshot.sourceSampleRate !== this.format.sourceSampleRate
        || snapshot.sourceChannels !== this.format.sourceChannels
        || snapshot.outputSampleRate !== this.format.outputSampleRate
        || typeof snapshot.windowStartedInUnderrun !== 'boolean') {
        return gap('projection_invalid');
      }
      const frameMs = 1000 / snapshot.sourceSampleRate;
      const bufferDepth = snapshot.bufferSampleCount === 0
        ? { status: 'unknown' }
        : {
          status: 'observed',
          sampleCount: snapshot.bufferSampleCount,
          currentMs: snapshot.bufferCurrentFrames * frameMs,
          minMs: snapshot.bufferMinFrames * frameMs,
          maxMs: snapshot.bufferMaxFrames * frameMs,
          meanMs: (snapshot.bufferSumFrames / snapshot.bufferSampleCount) * frameMs,
          trendMsPerSecond: ((snapshot.bufferTrendEndFrames
            - snapshot.bufferTrendStartFrames) * frameMs) / (durationMs / 1000),
        };
      const underrunDurationMs = (snapshot.underrunFrames
        / snapshot.outputSampleRate) * 1000;
      if (snapshot.windowStartedInUnderrun && underrunDurationMs === 0) {
        return gap('projection_invalid');
      }
      const signal = classifySignalWindow(
        snapshot.receivedFrames,
        snapshot.silentInputFrames,
        snapshot.clippedInputFrames,
        snapshot.sourceChannels,
      );
      const chunkGap = this.chunkCount < 2
        ? { status: 'not_applicable' }
        : {
          status: 'observed', count: this.chunkGapCount,
          meanMs: this.chunkGapSumMs / this.chunkGapCount,
          maxMs: this.chunkGapMaxMs,
        };
      const longTasks = this.client.longTaskStatus === 'observed'
        ? { status: 'observed', count: longTaskCount, maxDurationMs: longTaskMaxMs }
        : { status: this.client.longTaskStatus };
      const report = validateMeasurementJson(jsonBytes({
        schemaVersion: 1,
        kind: 'listener_window',
        instanceId: this.lifecycle.instanceId,
        sequence: this.lifecycle.allocateSequence(),
        monotonicStartMs: start.midpointMs,
        durationMs,
        measurements: {
          connectionAttemptSequence: this.lifecycle.attemptSequence,
          receivedBytes: this.receivedBytes,
          receivedFrames: this.receivedFrames,
          chunkCount: this.chunkCount,
          chunkGap,
          reconnectCount: this.reconnectCount,
          terminalCategory: this.terminalCategory,
          bufferDepth,
          underrunCount: snapshot.underrunCount,
          underrunDurationMs,
          reprimeCount: snapshot.reprimeCount,
          windowStartedInUnderrun: snapshot.windowStartedInUnderrun,
          overflowCount: snapshot.overflowCount,
          discardedFrames: snapshot.discardedFrames,
          resetCount: snapshot.resetCount,
          sourceSampleRate: snapshot.sourceSampleRate,
          sourceChannels: snapshot.sourceChannels,
          outputSampleRate: snapshot.outputSampleRate,
          nominalRateRatio: snapshot.sourceSampleRate / snapshot.outputSampleRate,
          audioContextState: this.audioContextState,
          baseLatencyMs: this.client.baseLatencyMs,
          outputLatencyMs: this.client.outputLatencyMs,
          visibilityState: this.visibilityState,
          suspensionCount: this.suspensionCount,
          longTasks,
          ...signal,
          browserFamily: this.client.browserFamily,
          browserMajor: this.client.browserMajor,
          osFamily: this.client.osFamily,
          displayMode: this.client.displayMode,
          implementationVersion: this.client.implementationVersion,
        },
      }));
      this.lifecycle.appendWindow(report);
      const result = frozen({
        status: 'accepted',
        report,
        boundaryUncertaintyMs: start.uncertaintyMs + end.uncertaintyMs,
      });
      this.startBoundary = end;
      this.#resetAccumulator();
      return result;
    } catch {
      return gap('projection_invalid');
    }
  }

  #resetAccumulator() {
    this.receivedBytes = 0;
    this.receivedFrames = 0;
    this.chunkCount = 0;
    this.chunkGapCount = 0;
    this.chunkGapSumMs = 0;
    this.chunkGapMaxMs = 0;
    this.lastChunkMs = null;
    this.reconnectCount = 0;
    this.suspensionCount = 0;
    this.terminalCategory = this.lifecycle.attempt?.terminalCategory ?? 'open';
    this.audioContextState = this.lifecycle.contextStateValue;
    this.visibilityState = 'unknown';
    this.firstObservationMs = null;
    this.lastObservationMs = null;
  }

  #observation(atMs) {
    if (!finiteTime(atMs) || (this.lastObservationMs !== null && atMs < this.lastObservationMs)) {
      fail('observation_invalid');
    }
    if (this.firstObservationMs === null) this.firstObservationMs = atMs;
    this.lastObservationMs = atMs;
  }
}

export const E5_LIMITS = frozen({
  MAX_STAGED_PCM_BYTES, MAX_WINDOWS, MAX_TRANSITIONS, MAX_LOCAL_RECORDS,
});
