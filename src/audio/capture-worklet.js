// Runs on the audio thread. Collects mic samples in 2048-sample chunks and posts them to the
// main thread along with the exact audio-clock frame of the first sample, which is what lets us
// line the recording up with the metronome.

class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = 2048;
    this.buf = new Float32Array(this.size);
    this.n = 0;
    this.start = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) {
      for (let i = 0; i < channel.length; i++) {
        if (this.n === 0) this.start = currentFrame + i;
        this.buf[this.n++] = channel[i];
        if (this.n === this.size) {
          this.port.postMessage({ start: this.start, data: this.buf }, [this.buf.buffer]);
          this.buf = new Float32Array(this.size);
          this.n = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('capture-processor', CaptureProcessor);
