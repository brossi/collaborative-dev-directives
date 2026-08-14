/* global AudioWorkletProcessor, registerProcessor, sampleRate */

import { E4PcmCore } from "./s2e-e4-worklet-core.js";

export class CannaBeatsE4PcmPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.core = new E4PcmCore({
      outputSampleRate: sampleRate,
      postMessage: (message) => this.port.postMessage(message),
    });
    this.port.onmessage = (event) => this.core.receive(event.data);
  }

  process(_inputs, outputs) {
    return this.core.process(outputs[0]);
  }
}

registerProcessor("cannabeats-e4-pcm-player", CannaBeatsE4PcmPlayer);
