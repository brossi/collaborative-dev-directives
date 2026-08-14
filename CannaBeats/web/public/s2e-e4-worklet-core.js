const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const MAX_PCM_BYTES = 1024 * 1024;
const RING_SECONDS = 12;

function safeAdd(left, right) {
  return Math.min(MAX_SAFE, left + right);
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function exactRecord(value, keys) {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function normalizeRequest(value) {
  if (!value || typeof value !== "object") return null;
  if (value.type === "configure") {
    if (!exactRecord(value, ["type", "requestId", "epoch", "sampleRate", "channels"])
      || !positiveInteger(value.requestId) || !positiveInteger(value.epoch)
      || !Number.isInteger(value.sampleRate) || value.sampleRate < 8000
      || value.sampleRate > 192000 || ![1, 2].includes(value.channels)) return null;
    return {
      type: value.type,
      requestId: value.requestId,
      epoch: value.epoch,
      sampleRate: value.sampleRate,
      channels: value.channels,
    };
  }
  if (["snapshot-and-rotate", "reset-and-rotate", "stop-and-rotate"].includes(value.type)) {
    if (!exactRecord(value, ["type", "requestId", "epoch", "nextEpoch"])
      || !positiveInteger(value.requestId) || !positiveInteger(value.epoch)
      || !positiveInteger(value.nextEpoch)) return null;
    return {
      type: value.type,
      requestId: value.requestId,
      epoch: value.epoch,
      nextEpoch: value.nextEpoch,
    };
  }
  return null;
}

function commandKey(command) {
  if (command.type === "configure") {
    return `${command.type}:${command.requestId}:${command.epoch}:${command.sampleRate}:${command.channels}`;
  }
  return `${command.type}:${command.requestId}:${command.epoch}:${command.nextEpoch}`;
}

function frozen(value) {
  return Object.freeze(value);
}

export class E4PcmCore {
  constructor({ outputSampleRate, postMessage }) {
    if (!Number.isInteger(outputSampleRate) || outputSampleRate < 8000
      || outputSampleRate > 192000 || typeof postMessage !== "function") {
      throw new TypeError("invalid E4 core configuration");
    }
    this.outputSampleRate = outputSampleRate;
    this.postMessage = postMessage;
    this.lifecycle = "unconfigured";
    this.epoch = 0;
    this.requestHighWater = 0;
    this.lastRequestId = 0;
    this.lastCommandKey = "";
    this.lastReply = null;
    this.state = "stopped";
    this.stateOrdinal = 0;
    this.sourceSampleRate = outputSampleRate;
    this.sourceChannels = 2;
    this.capacity = 0;
    this.left = new Float32Array(0);
    this.right = new Float32Array(0);
    this.writeFrame = 0;
    this.readFrame = 0;
    this.primed = false;
    this.hasRenderedPcm = false;
    this.inUnderrun = false;
    this.metrics = this.createMetrics(false, 0);
  }

  createMetrics(windowStartedInUnderrun, resetCount) {
    return {
      receivedFrames: 0,
      renderedFrames: 0,
      silentInputFrames: 0,
      clippedInputFrames: 0,
      bufferSampleCount: 0,
      bufferCurrentFrames: 0,
      bufferMinFrames: 0,
      bufferMaxFrames: 0,
      bufferSumFrames: 0,
      bufferTrendStartFrames: 0,
      bufferTrendEndFrames: 0,
      underrunCount: 0,
      underrunFrames: 0,
      reprimeCount: 0,
      windowStartedInUnderrun,
      overflowCount: 0,
      discardedFrames: 0,
      resetCount,
    };
  }

  receive(message) {
    if (message?.type === "pcm") {
      this.receivePcm(message);
      return;
    }
    const command = normalizeRequest(message);
    if (!command) return;
    const key = commandKey(command);
    if (command.requestId === this.lastRequestId) {
      if (key === this.lastCommandKey && this.lastReply) this.postMessage(this.lastReply);
      else this.postMessage(this.rejection(command, "request_conflict"));
      return;
    }
    if (command.requestId < this.requestHighWater) {
      this.postMessage(this.rejection(command, "request_conflict"));
      return;
    }
    this.requestHighWater = command.requestId;
    const { reply, nextState } = command.type === "configure"
      ? this.configure(command) : this.control(command);
    this.lastRequestId = command.requestId;
    this.lastCommandKey = key;
    this.lastReply = reply;
    this.postMessage(reply);
    if (nextState) this.emitState(nextState);
  }

  rejection(command, code) {
    return frozen({
      type: "command-rejected",
      requestId: command.requestId,
      epoch: this.lifecycle === "unconfigured" ? command.epoch : this.epoch,
      code,
    });
  }

  configure(command) {
    if (this.lifecycle === "configured") {
      return { reply: this.rejection(command, "invalid_state"), nextState: null };
    }
    if (this.lifecycle === "stopped" && command.epoch !== this.epoch + 1) {
      return { reply: this.rejection(command, "stale_epoch"), nextState: null };
    }
    this.sourceSampleRate = command.sampleRate;
    this.sourceChannels = command.channels;
    this.capacity = command.sampleRate * RING_SECONDS;
    this.left = new Float32Array(this.capacity);
    this.right = new Float32Array(this.capacity);
    this.epoch = command.epoch;
    this.lifecycle = "configured";
    this.clearPlayback();
    this.metrics = this.createMetrics(false, 0);
    const reply = frozen({
      type: "configured",
      requestId: command.requestId,
      epoch: this.epoch,
      sampleRate: this.sourceSampleRate,
      channels: this.sourceChannels,
    });
    return { reply, nextState: "buffering" };
  }

  control(command) {
    if (this.lifecycle === "unconfigured") {
      return { reply: this.rejection(command, "not_configured"), nextState: null };
    }
    if (command.epoch !== this.epoch) {
      return { reply: this.rejection(command, "stale_epoch"), nextState: null };
    }
    if (command.nextEpoch !== command.epoch + 1) {
      return { reply: this.rejection(command, "invalid_rotation"), nextState: null };
    }
    if (this.lifecycle === "stopped") {
      return { reply: this.rejection(command, "invalid_state"), nextState: null };
    }
    const snapshot = this.snapshot();
    const previousEpoch = this.epoch;
    this.epoch = command.nextEpoch;
    const operation = command.type.split("-")[0];
    let nextState = null;
    if (operation === "snapshot") {
      this.metrics = this.createMetrics(this.inUnderrun, 0);
    } else {
      this.clearPlayback();
      this.lifecycle = operation === "stop" ? "stopped" : "configured";
      this.metrics = this.createMetrics(false, operation === "reset" ? 1 : 0);
      nextState = operation === "stop" ? "stopped" : "buffering";
    }
    return {
      reply: frozen({
        type: "snapshot-rotated",
        requestId: command.requestId,
        operation,
        previousEpoch,
        epoch: this.epoch,
        snapshot,
      }),
      nextState,
    };
  }

  receivePcm(message) {
    if (this.lifecycle !== "configured"
      || !exactRecord(message, ["type", "epoch", "buffer"])
      || message.epoch !== this.epoch || !positiveInteger(message.epoch)) return;
    let byteLength;
    try {
      if (!(message.buffer instanceof ArrayBuffer)
        || Object.getPrototypeOf(message.buffer) !== ArrayBuffer.prototype) return;
      byteLength = message.buffer.byteLength;
    } catch {
      return;
    }
    const bytesPerFrame = this.sourceChannels * 2;
    if (byteLength < bytesPerFrame || byteLength > MAX_PCM_BYTES
      || byteLength % bytesPerFrame !== 0) return;
    const frameCount = byteLength / bytesPerFrame;
    if (frameCount > this.capacity) return;
    const samples = new Int16Array(message.buffer);
    let silentFrames = 0;
    let clippedFrames = 0;
    for (let frame = 0; frame < frameCount; frame += 1) {
      const sampleIndex = frame * this.sourceChannels;
      const leftInput = samples[sampleIndex];
      const rightInput = this.sourceChannels === 1 ? leftInput : samples[sampleIndex + 1];
      const target = this.writeFrame % this.capacity;
      this.left[target] = leftInput / 32768;
      this.right[target] = rightInput / 32768;
      this.writeFrame += 1;
      if (Math.abs(leftInput) < 64 && Math.abs(rightInput) < 64) silentFrames += 1;
      if (Math.abs(leftInput) >= 32760 || Math.abs(rightInput) >= 32760) clippedFrames += 1;
    }
    this.metrics.receivedFrames = safeAdd(this.metrics.receivedFrames, frameCount);
    this.metrics.silentInputFrames = safeAdd(this.metrics.silentInputFrames, silentFrames);
    this.metrics.clippedInputFrames = safeAdd(this.metrics.clippedInputFrames, clippedFrames);
    const available = this.writeFrame - this.readFrame;
    if (available > this.capacity - 2) {
      const reserve = Math.floor(this.capacity / 2);
      const discarded = Math.floor(available) - reserve;
      this.readFrame += discarded;
      this.metrics.overflowCount = safeAdd(this.metrics.overflowCount, 1);
      this.metrics.discardedFrames = safeAdd(this.metrics.discardedFrames, discarded);
    }
  }

  process(output) {
    const framesNeeded = output[0]?.length ?? 0;
    if (framesNeeded <= 0) return true;
    if (this.lifecycle !== "configured") {
      for (const channel of output) channel.fill(0);
      return true;
    }
    const ratio = this.sourceSampleRate / this.outputSampleRate;
    const available = this.writeFrame - this.readFrame;
    if (!this.primed && available >= this.sourceSampleRate * 0.3) {
      this.primed = true;
      if (this.inUnderrun) {
        this.inUnderrun = false;
        this.metrics.reprimeCount = safeAdd(this.metrics.reprimeCount, 1);
      }
    }
    if (!this.primed || available < framesNeeded * ratio + 2) {
      for (const channel of output) channel.fill(0);
      if (this.hasRenderedPcm) {
        if (!this.inUnderrun) {
          this.inUnderrun = true;
          this.metrics.underrunCount = safeAdd(this.metrics.underrunCount, 1);
        }
        this.metrics.underrunFrames = safeAdd(this.metrics.underrunFrames, framesNeeded);
        this.emitState("underrun");
      } else {
        this.emitState("buffering");
      }
      this.primed = false;
      this.sampleBuffer();
      return true;
    }

    for (let frame = 0; frame < framesNeeded; frame += 1) {
      const base = Math.floor(this.readFrame);
      const fraction = this.readFrame - base;
      const first = base % this.capacity;
      const second = (base + 1) % this.capacity;
      output[0][frame] = this.left[first] + (this.left[second] - this.left[first]) * fraction;
      if (output[1]) {
        output[1][frame] = this.right[first]
          + (this.right[second] - this.right[first]) * fraction;
      }
      this.readFrame += ratio;
    }
    this.hasRenderedPcm = true;
    this.metrics.renderedFrames = safeAdd(this.metrics.renderedFrames, framesNeeded);
    this.emitState("playing");
    this.sampleBuffer();
    return true;
  }

  clearPlayback() {
    this.writeFrame = 0;
    this.readFrame = 0;
    this.primed = false;
    this.hasRenderedPcm = false;
    this.inUnderrun = false;
    if (this.left.length) this.left.fill(0);
    if (this.right.length) this.right.fill(0);
  }

  sampleBuffer() {
    const current = Math.max(0, Math.floor(this.writeFrame - this.readFrame));
    const metrics = this.metrics;
    if (metrics.bufferSampleCount === 0) {
      metrics.bufferMinFrames = current;
      metrics.bufferMaxFrames = current;
      metrics.bufferTrendStartFrames = current;
    } else {
      metrics.bufferMinFrames = Math.min(metrics.bufferMinFrames, current);
      metrics.bufferMaxFrames = Math.max(metrics.bufferMaxFrames, current);
    }
    metrics.bufferSampleCount = safeAdd(metrics.bufferSampleCount, 1);
    metrics.bufferCurrentFrames = current;
    metrics.bufferTrendEndFrames = current;
    metrics.bufferSumFrames = safeAdd(metrics.bufferSumFrames, current);
  }

  snapshot() {
    const metrics = this.metrics;
    return frozen({
      epoch: this.epoch,
      sourceSampleRate: this.sourceSampleRate,
      sourceChannels: this.sourceChannels,
      outputSampleRate: this.outputSampleRate,
      ...metrics,
    });
  }

  emitState(state) {
    if (this.state === state) return;
    this.state = state;
    this.stateOrdinal = safeAdd(this.stateOrdinal, 1);
    this.postMessage(frozen({
      type: "playback-state",
      epoch: this.epoch,
      state,
      ordinal: this.stateOrdinal,
    }));
  }
}

export const E4_LIMITS = frozen({ MAX_PCM_BYTES, RING_SECONDS });
