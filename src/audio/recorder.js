// Microphone capture through an AudioWorklet. Chunks are stamped with audio-clock frames,
// so any slice of the take can be pulled out by time.

const loadedContexts = new WeakSet();

export class Recorder {
  constructor(ctx) {
    this.ctx = ctx;
    this.chunks = [];
    this.capturing = false;
    this.onChunk = null;
  }

  async open() {
    if (!navigator.mediaDevices?.getUserMedia || !window.isSecureContext) {
      const err = new Error('Recording needs https or localhost');
      err.name = 'InsecureContextError';
      throw err;
    }
    this.stream = await navigator.mediaDevices.getUserMedia({
      // Echo cancellation keeps the metronome out of the take when you're not on headphones
      audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
    });
    if (!loadedContexts.has(this.ctx)) {
      await this.ctx.audioWorklet.addModule(new URL('./capture-worklet.js', import.meta.url));
      loadedContexts.add(this.ctx);
    }
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, 'capture-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      channelCountMode: 'explicit',
    });
    // The worklet has to be connected to the destination to keep running; a silent gain does that.
    this.sink = this.ctx.createGain();
    this.sink.gain.value = 0;
    this.source.connect(this.node).connect(this.sink).connect(this.ctx.destination);
    this.node.port.onmessage = (e) => {
      if (!this.capturing) return;
      this.chunks.push(e.data);
      this.onChunk?.(e.data.data);
    };
  }

  start() {
    this.chunks = [];
    this.capturing = true;
  }

  stop() {
    this.capturing = false;
  }

  // Round-trip latency: how late your voice shows up relative to the click you heard.
  latency() {
    const track = this.stream?.getAudioTracks()[0];
    const input = track?.getSettings?.().latency || 0;
    const output = (this.ctx.baseLatency || 0) + (this.ctx.outputLatency || 0);
    const total = input + output;
    return total > 0 ? Math.min(total, 0.35) : 0.06;
  }

  extract(fromSec, toSec) {
    const sr = this.ctx.sampleRate;
    const f0 = Math.round(fromSec * sr);
    const f1 = Math.round(toSec * sr);
    const out = new Float32Array(Math.max(0, f1 - f0));
    for (const { start, data } of this.chunks) {
      const a = Math.max(start, f0);
      const b = Math.min(start + data.length, f1);
      if (b > a) out.set(data.subarray(a - start, b - start), a - f0);
    }
    return out;
  }

  extractAll() {
    if (!this.chunks.length) return new Float32Array(0);
    const sr = this.ctx.sampleRate;
    const first = this.chunks[0];
    const last = this.chunks[this.chunks.length - 1];
    return this.extract(first.start / sr, (last.start + last.data.length) / sr);
  }

  close() {
    this.capturing = false;
    try {
      this.source?.disconnect();
      this.node?.disconnect();
      this.sink?.disconnect();
    } catch {
      // already disconnected
    }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }
}
