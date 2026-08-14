const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const MAX_STAGED_PCM_BYTES = 1024 * 1024;
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

  rotateInstance(instanceId) {
    if (!canonicalUuid(instanceId) || instanceId === this.instanceId) fail('instance_invalid');
    this.instanceId = instanceId;
    this.nextSequence = 0;
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
    pushBounded(this.transitions, {
      instanceId: this.instanceId,
      sequence: this.nextSequence,
      monotonicStartMs: this.#time(),
      connectionAttemptSequence: this.attemptSequence,
      type,
      ...detail,
    }, MAX_TRANSITIONS);
    this.nextSequence += 1;
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

export const E5_LIMITS = frozen({
  MAX_STAGED_PCM_BYTES, MAX_TRANSITIONS, MAX_LOCAL_RECORDS,
});
