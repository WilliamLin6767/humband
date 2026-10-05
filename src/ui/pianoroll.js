// The piano roll. Shows every part on one grid, with your raw hummed pitch drawn over the
// corrected melody notes. Click the grid to add a melody note, click a note to remove it.

import { noteName, scalePcs } from '../music/theory.js';

const LANES = [
  { label: 'Cymbal', voices: ['crash', 'ride'] },
  { label: 'Toms', voices: ['tomH', 'tomM', 'tomL'] },
  { label: 'Hats', voices: ['hatC', 'hatO'] },
  { label: 'Snare', voices: ['snare', 'clap', 'rim'] },
  { label: 'Kick', voices: ['kick'] },
];
const FONT = 'Archivo, system-ui, sans-serif';

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
function rgba(hex, a) {
  const n = parseInt(hex.replace('#', ''), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

export class PianoRoll {
  constructor(canvas, { onEdit } = {}) {
    this.canvas = canvas;
    this.g = canvas.getContext('2d');
    this.layer = document.createElement('canvas');
    this.onEdit = onEdit;
    this.data = null;
    this.position = null;
    this.dpr = 1;
    this.colors = {
      paper: css('--paper') || '#f3e8da',
      dim: css('--paper-dim') || '#bfae9c',
      hum: css('--c-hum') || '#d9c9b5',
      melody: css('--c-melody') || '#ffb547',
      chords: css('--c-chords') || '#6cc3e6',
      bass: css('--c-bass') || '#b59cff',
      drums: css('--c-drums') || '#a8d46f',
    };
    new ResizeObserver(() => this.resize()).observe(canvas);
    canvas.addEventListener('pointerdown', (e) => this.onPointer(e));
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(r.width * this.dpr));
    const h = Math.max(1, Math.round(r.height * this.dpr));
    this.canvas.width = this.layer.width = w;
    this.canvas.height = this.layer.height = h;
    this.renderLayer();
    this.draw();
  }

  setData(data) {
    this.data = data;
    this.range = this.computeRange(data.song);
    this.renderLayer();
    this.draw();
  }

  setPosition(pos) {
    this.position = pos;
    this.draw();
  }

  computeRange(song) {
    const ps = [...song.melody.map((n) => n.pitch), ...song.bass.map((n) => n.pitch), ...song.keys.flatMap((k) => k.pitches)];
    let lo = ps.length ? Math.min(...ps) - 1 : 48;
    let hi = ps.length ? Math.max(...ps) + 1 : 72;
    while (hi - lo < 24) {
      lo--;
      hi++;
    }
    return { lo, hi };
  }

  geometry() {
    const d = this.dpr;
    const W = this.canvas.width;
    const H = this.canvas.height;
    const left = 44 * d;
    const right = 6 * d;
    const top = 26 * d;
    const laneH = 12 * d;
    const lanesTop = H - LANES.length * laneH - 2 * d;
    const rollBottom = lanesTop - 10 * d;
    const steps = this.data.song.steps;
    const colW = (W - left - right) / steps;
    const rowH = (rollBottom - top) / (this.range.hi - this.range.lo + 1);
    return { d, W, H, left, right, top, laneH, lanesTop, rollBottom, steps, colW, rowH };
  }

  rowY(p, G) {
    return G.top + (this.range.hi - p) * G.rowH;
  }

  renderLayer() {
    if (!this.data || !this.range) return;
    const g = this.layer.getContext('2d');
    const G = this.geometry();
    const C = this.colors;
    const { song } = this.data;
    const muted = this.data.muted || {};
    const inKey = scalePcs(song.key);
    const gridW = G.W - G.left - G.right;
    g.clearRect(0, 0, G.W, G.H);

    // Out-of-key rows are shaded darker, like a DAW's scale highlighting
    for (let p = this.range.lo; p <= this.range.hi; p++) {
      const y = this.rowY(p, G);
      if (!inKey.has(((p % 12) + 12) % 12)) {
        g.fillStyle = 'rgba(0,0,0,0.2)';
        g.fillRect(G.left, y, gridW, G.rowH);
      }
      if (p % 12 === 0) {
        g.fillStyle = rgba(C.paper, 0.1);
        g.fillRect(G.left, Math.round(y + G.rowH), gridW, 1);
        g.fillStyle = C.dim;
        g.font = `${10 * G.d}px ${FONT}`;
        g.textBaseline = 'middle';
        g.fillText(noteName(p), 8 * G.d, y + G.rowH / 2);
      }
    }

    // Alternate bar shading, then bar, beat and 16th lines
    for (let s = 16; s < G.steps; s += 32) {
      g.fillStyle = 'rgba(243,232,218,0.025)';
      g.fillRect(G.left + s * G.colW, G.top, 16 * G.colW, G.H - G.top);
    }
    for (let s = 0; s <= G.steps; s++) {
      g.fillStyle = s % 16 === 0 ? rgba(C.paper, 0.24) : s % 4 === 0 ? rgba(C.paper, 0.09) : rgba(C.paper, 0.035);
      g.fillRect(Math.round(G.left + s * G.colW), s % 16 === 0 ? 0 : G.top, 1, G.H);
    }

    // Chord names above each chord
    g.textBaseline = 'middle';
    for (const c of song.chords) {
      const x = G.left + c.step * G.colW + 6 * G.d;
      g.font = `700 ${12 * G.d}px ${FONT}`;
      g.fillStyle = rgba(C.chords, muted.chords ? 0.4 : 1);
      g.fillText(c.symbol, x, 13 * G.d);
      const w = g.measureText(c.symbol).width;
      g.font = `${10 * G.d}px ${FONT}`;
      g.fillStyle = rgba(C.dim, 0.8);
      g.fillText(c.roman, x + w + 5 * G.d, 13 * G.d);
    }

    const block = (step, dur, pitch, color, a, inset = 0.15) => {
      const x = G.left + step * G.colW + 1;
      const y = this.rowY(pitch, G) + G.rowH * inset;
      const w = Math.max(2, dur * G.colW - 2);
      const h = Math.max(2, G.rowH * (1 - 2 * inset));
      g.fillStyle = rgba(color, a);
      g.beginPath();
      g.roundRect(x, y, w, h, Math.min(3 * G.d, h / 2));
      g.fill();
    };

    for (const k of song.keys) for (const p of k.pitches) block(k.step, k.dur, p, C.chords, muted.chords ? 0.14 : 0.42);
    for (const n of song.bass) block(n.step, n.dur, n.pitch, C.bass, muted.bass ? 0.2 : 0.85);
    for (const n of song.melody) block(n.step, n.dur, n.pitch, C.melody, muted.melody ? 0.3 : 1, -0.05);

    // Your raw hum, drawn over the notes it became
    const { frames, voiced, tuning = 0, gridStart = 0, stepDur = 0.15 } = this.data;
    if (frames && voiced) {
      g.save();
      g.beginPath();
      g.rect(G.left, G.top, gridW, G.rollBottom - G.top);
      g.clip();
      g.lineJoin = 'round';
      g.lineCap = 'round';
      g.beginPath();
      let pen = false;
      for (let i = 0; i < frames.length; i++) {
        if (!voiced[i]) {
          pen = false;
          continue;
        }
        const x = G.left + ((frames[i].t - gridStart) / stepDur) * G.colW;
        const y = G.top + (this.range.hi - (frames[i].midi - tuning)) * G.rowH + G.rowH / 2;
        if (pen) g.lineTo(x, y);
        else g.moveTo(x, y);
        pen = true;
      }
      g.strokeStyle = 'rgba(27, 20, 17, 0.85)';
      g.lineWidth = 4 * G.d;
      g.stroke();
      g.strokeStyle = C.hum;
      g.lineWidth = 1.75 * G.d;
      g.stroke();
      g.restore();
    }

    // Drum lanes
    LANES.forEach((lane, i) => {
      const y = G.lanesTop + i * G.laneH;
      g.fillStyle = C.dim;
      g.font = `${9 * G.d}px ${FONT}`;
      g.textBaseline = 'middle';
      g.fillText(lane.label, 8 * G.d, y + G.laneH / 2);
    });
    const size = Math.min(G.laneH, G.colW) * 0.64;
    for (const h of song.drums) {
      const lane = LANES.findIndex((l) => l.voices.includes(h.voice));
      if (lane < 0) continue;
      const cx = G.left + (h.step + 0.5) * G.colW;
      const cy = G.lanesTop + (lane + 0.5) * G.laneH;
      g.fillStyle = rgba(C.drums, (muted.drums ? 0.3 : 1) * (0.35 + 0.65 * h.vel));
      g.beginPath();
      g.roundRect(cx - size / 2, cy - size / 2, size, size, 2 * G.d);
      g.fill();
    }
  }

  draw() {
    const { g, canvas } = this;
    g.clearRect(0, 0, canvas.width, canvas.height);
    if (!this.data || !this.range) return;
    g.drawImage(this.layer, 0, 0);
    if (this.position === null || this.position === undefined) return;
    const G = this.geometry();
    const x = Math.round(G.left + this.position * G.colW);
    g.fillStyle = rgba(this.colors.paper, 0.9);
    g.fillRect(x, 0, 2 * G.d, G.H);
  }

  onPointer(e) {
    if (!this.data || !this.onEdit) return;
    const r = this.canvas.getBoundingClientRect();
    const x = (e.clientX - r.left) * this.dpr;
    const y = (e.clientY - r.top) * this.dpr;
    const G = this.geometry();
    if (x < G.left || y < G.top || y >= G.rollBottom) return;
    const step = Math.floor((x - G.left) / G.colW);
    const pitch = this.range.hi - Math.floor((y - G.top) / G.rowH);
    if (step < 0 || step >= G.steps) return;

    const melody = this.data.song.melody.map((n) => ({ ...n }));
    const hit = melody.findIndex((n) => step >= n.step && step < n.step + n.dur && n.pitch === pitch);
    if (hit >= 0) {
      melody.splice(hit, 1);
    } else {
      // Cut whatever is sounding here, then add an 8th note that stops before the next note
      for (const n of melody) if (n.step < step && n.step + n.dur > step) n.dur = step - n.step;
      const same = melody.findIndex((n) => n.step === step);
      if (same >= 0) melody.splice(same, 1);
      const next = melody.filter((n) => n.step > step).reduce((m, n) => Math.min(m, n.step), G.steps);
      melody.push({ step, dur: Math.max(1, Math.min(2, next - step)), pitch, vel: 0.8 });
      melody.sort((a, b) => a.step - b.step);
    }
    this.onEdit(melody);
  }
}
