/* global AudioWorkletProcessor, registerProcessor, sampleRate */

class CannaBeatsPcmPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.capacity = sampleRate * 12;
    this.left = new Float32Array(this.capacity);
    this.right = new Float32Array(this.capacity);
    this.writeFrame = 0;
    this.readFrame = 0;
    this.sourceRate = sampleRate;
    this.sourceChannels = 2;
    this.primed = false;
    this.reportedState = "buffering";
    this.port.onmessage = (event) => this.receive(event.data);
  }

  receive(message) {
    if (message.type === "configure") {
      this.sourceRate = message.sampleRate;
      this.sourceChannels = message.channels;
      this.reset();
      return;
    }
    if (message.type === "reset") {
      this.reset();
      return;
    }
    if (message.type !== "pcm") return;
    const samples = new Int16Array(message.buffer);
    const frameCount = Math.floor(samples.length / this.sourceChannels);
    for (let frame = 0; frame < frameCount; frame += 1) {
      const target = this.writeFrame % this.capacity;
      const left = samples[frame * this.sourceChannels] / 32768;
      const right = this.sourceChannels === 1 ? left : samples[frame * this.sourceChannels + 1] / 32768;
      this.left[target] = left;
      this.right[target] = right;
      this.writeFrame += 1;
    }
    if (this.writeFrame - this.readFrame > this.capacity - 2) {
      this.readFrame = this.writeFrame - Math.floor(this.capacity / 2);
    }
  }

  reset() {
    this.writeFrame = 0;
    this.readFrame = 0;
    this.primed = false;
    this.setState("buffering");
  }

  setState(state) {
    if (this.reportedState === state) return;
    this.reportedState = state;
    this.port.postMessage({ type: state });
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    const framesNeeded = output[0].length;
    const ratio = this.sourceRate / sampleRate;
    const available = this.writeFrame - this.readFrame;
    if (!this.primed && available >= this.sourceRate * 0.3) this.primed = true;

    if (!this.primed || available < framesNeeded * ratio + 2) {
      output.forEach((channel) => channel.fill(0));
      this.primed = false;
      this.setState("buffering");
      return true;
    }

    for (let frame = 0; frame < framesNeeded; frame += 1) {
      const base = Math.floor(this.readFrame);
      const fraction = this.readFrame - base;
      const first = base % this.capacity;
      const second = (base + 1) % this.capacity;
      output[0][frame] = this.left[first] + (this.left[second] - this.left[first]) * fraction;
      if (output[1]) output[1][frame] = this.right[first] + (this.right[second] - this.right[first]) * fraction;
      this.readFrame += ratio;
    }
    this.setState("playing");
    return true;
  }
}

registerProcessor("cannabeats-pcm-player", CannaBeatsPcmPlayer);
