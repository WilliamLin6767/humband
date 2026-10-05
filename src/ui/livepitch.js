// Live pitch display while you record: a scrolling trace of your voice and a tuner readout.

import { createPitchDetector } from '../analysis/pitch.js';
import { freqToMidi } from '../analysis/dsp.js';
import { noteName } from '../music/theory.js';

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export class LivePitch {
  constructor(canvas, noteEl, centsEl) {
    this.canvas = canvas;
    this.g = canvas.getContext('2d');
    this.noteEl = noteEl;
    this.centsEl = centsEl;
    this.trace = [];
    this.center = 60;
    this.window = 5; // seconds of history on screen
    this.running = false;
    this.color = css('--c-melody') || '#ffb547';
    new ResizeObserver(() => this.resize()).observe(canvas);
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.round(r.width * dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * dpr));
    this.draw();
  }

  start(sampleRate, clock) {
    // Decimate to roughly 16 kHz so YIN stays cheap enough to run every animation frame
    this.dec = Math.max(1, Math.round(sampleRate / 16000));
    this.det = createPitchDetector({ sampleRate: sampleRate / this.dec, windowSize: 512, minFreq: 70, maxFreq: 1200 });
    this.need = this.det.span * this.dec;
    this.ring = new Float32Array(this.need * 2);
    this.filled = 0;
    this.small = new Float32Array(this.det.span);
    this.clock = clock;
    this.trace = [];
    this.noteEl.textContent = '–';
    this.centsEl.textContent = '';
    this.running = true;
    const loop = () => {
      if (!this.running) return;
      this.analyse();
      this.draw();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  push(data) {
    if (!this.ring) return;
    const N = this.ring.length;
    if (data.length >= N) {
      this.ring.set(data.subarray(data.length - N));
      this.filled = N;
      return;
    }
    if (this.filled + data.length > N) {
      const drop = this.filled + data.length - N;
      this.ring.copyWithin(0, drop, this.filled);
      this.filled -= drop;
    }
    this.ring.set(data, this.filled);
    this.filled += data.length;
  }

  analyse() {
    const now = this.clock();
    let midi = null;
    if (this.filled >= this.need) {
      const src = this.ring.subarray(this.filled - this.need, this.filled);
      for (let i = 0; i < this.det.span; i++) {
        let s = 0;
        for (let k = 0; k < this.dec; k++) s += src[i * this.dec + k];
        this.small[i] = s / this.dec;
      }
      const r = this.det.detect(this.small, 0);
      if (r && r.rms > 0.006 && r.aperiodicity < 0.25 && r.freq > 60) midi = freqToMidi(r.freq);
    }
    this.trace.push({ t: now, midi });
    while (this.trace.length && this.trace[0].t < now - this.window) this.trace.shift();
    if (midi !== null) {
      this.center += (midi - this.center) * 0.08;
      const rounded = Math.round(midi);
      const cents = Math.round((midi - rounded) * 100);
      this.noteEl.textContent = noteName(rounded);
      this.centsEl.textContent = `${cents >= 0 ? '+' : '−'}${Math.abs(cents)} cents`;
    }
  }

  draw() {
    const { g, canvas } = this;
    const W = canvas.width;
    const H = canvas.height;
    const d = window.devicePixelRatio || 1;
    g.clearRect(0, 0, W, H);
    const span = 18;
    const lo = this.center - span / 2;
    const yOf = (m) => H - ((m - lo) / span) * H;

    g.font = `${10 * d}px Archivo, system-ui, sans-serif`;
    g.textBaseline = 'middle';
    for (let m = Math.ceil(lo); m <= lo + span; m++) {
      const y = Math.round(yOf(m));
      g.fillStyle = m % 12 === 0 ? 'rgba(243,232,218,0.18)' : 'rgba(243,232,218,0.05)';
      g.fillRect(0, y, W, 1);
      if (m % 12 === 0) {
        g.fillStyle = 'rgba(243,232,218,0.45)';
        g.fillText(noteName(m), 8 * d, y - 8 * d);
      }
    }
    if (!this.trace.length || !this.clock) return;

    const now = this.clock();
    g.strokeStyle = this.color;
    g.lineWidth = 2.5 * d;
    g.lineJoin = 'round';
    g.lineCap = 'round';
    g.beginPath();
    let pen = false;
    for (const p of this.trace) {
      if (p.midi === null) {
        pen = false;
        continue;
      }
      const x = W - ((now - p.t) / this.window) * W;
      const y = yOf(p.midi);
      if (pen) g.lineTo(x, y);
      else g.moveTo(x, y);
      pen = true;
    }
    g.stroke();
    const last = this.trace[this.trace.length - 1];
    if (this.running && last.midi !== null) {
      g.fillStyle = this.color;
      g.beginPath();
      g.arc(W - 4 * d, yOf(last.midi), 5 * d, 0, Math.PI * 2);
      g.fill();
    }
  }
}
