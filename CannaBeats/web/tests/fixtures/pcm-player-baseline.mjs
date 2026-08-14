// Retained test-only behavior from the pre-E4 PCM worklet. It intentionally has
// no diagnostics and is used only to prove that E4 does not change PCM output.
export class PcmPlayerBaseline {
  constructor(outputSampleRate) {
    this.outputSampleRate = outputSampleRate;
    this.capacity = outputSampleRate * 12;
    this.left = new Float32Array(this.capacity);
    this.right = new Float32Array(this.capacity);
    this.writeFrame = 0;
    this.readFrame = 0;
    this.sourceRate = outputSampleRate;
    this.sourceChannels = 2;
    this.primed = false;
  }

  configure(sampleRate, channels) {
    this.sourceRate = sampleRate;
    this.sourceChannels = channels;
    this.writeFrame = 0;
    this.readFrame = 0;
    this.primed = false;
  }

  receive(buffer) {
    const samples = new Int16Array(buffer);
    const frameCount = Math.floor(samples.length / this.sourceChannels);
    for (let frame = 0; frame < frameCount; frame += 1) {
      const target = this.writeFrame % this.capacity;
      const left = samples[frame * this.sourceChannels] / 32768;
      const right = this.sourceChannels === 1
        ? left : samples[frame * this.sourceChannels + 1] / 32768;
      this.left[target] = left;
      this.right[target] = right;
      this.writeFrame += 1;
    }
    if (this.writeFrame - this.readFrame > this.capacity - 2) {
      this.readFrame = this.writeFrame - Math.floor(this.capacity / 2);
    }
  }

  process(output) {
    const framesNeeded = output[0].length;
    const ratio = this.sourceRate / this.outputSampleRate;
    const available = this.writeFrame - this.readFrame;
    if (!this.primed && available >= this.sourceRate * 0.3) this.primed = true;
    if (!this.primed || available < framesNeeded * ratio + 2) {
      for (const channel of output) channel.fill(0);
      this.primed = false;
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
    return true;
  }
}
