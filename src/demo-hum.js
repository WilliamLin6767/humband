// A synthetic hum: an original tune sung "badly" on purpose, with the things real hums have
// (scoops into notes, vibrato, drift, a global tuning offset, sloppy timing and room noise).
// It powers the "sample hum" button and doubles as the test input for the pipeline.

import { mulberry32 } from './music/random.js';

export const DEMO_TUNE = {
  bpm: 100,
  bars: 4,
  // [start step, length in 16ths, MIDI pitch]
  notes: [
    [0, 4, 67], [4, 2, 64], [6, 2, 67], [8, 4, 69], [12, 4, 67],
    [16, 4, 64], [20, 2, 62], [22, 2, 60], [24, 8, 62],
    [32, 4, 67], [36, 2, 64], [38, 2, 67], [40, 4, 72], [44, 2, 71], [46, 2, 69],
    [48, 4, 67], [52, 2, 64], [54, 2, 62], [56, 8, 60],
  ],
};

const HARMONICS = [1, 0.55, 0.28, 0.16, 0.09, 0.05];

export function synthesizeHum({
  notes = DEMO_TUNE.notes,
  bpm = DEMO_TUNE.bpm,
  sampleRate = 48000,
  leadIn = 0.5,
  tuning = -0.22,
  transpose = 0,
  seed = 11,
  jitter = 0.012,
  noise = 0.003,
} = {}) {
  const rng = mulberry32(seed);
  const stepDur = 60 / bpm / 4;
  const lastEnd = Math.max(...notes.map(([s, d]) => s + d));
  const out = new Float32Array(Math.ceil((leadIn + lastEnd * stepDur + 0.6) * sampleRate));
  let phase = 0;

  for (const [step, dur, midi] of notes) {
    const on = leadIn + step * stepDur + (rng() * 2 - 1) * jitter;
    const off = leadIn + (step + dur) * stepDur - (0.03 + rng() * 0.05);
    const i0 = Math.max(0, Math.floor(on * sampleRate));
    const i1 = Math.min(out.length, Math.floor(off * sampleRate));
    const len = (i1 - i0) / sampleRate;
    const drift = (rng() * 2 - 1) * 0.08;
    const level = 0.8 + 0.3 * rng();
    for (let i = i0; i < i1; i++) {
      const tn = (i - i0) / sampleRate;
      let m = midi + transpose + tuning + drift;
      if (tn < 0.06) m -= 0.6 * (1 - tn / 0.06); // scoop up into the note
      if (tn > 0.18) m += 0.22 * Math.sin(2 * Math.PI * 5.5 * tn) * Math.min(1, (tn - 0.18) / 0.2); // vibrato
      phase += (2 * Math.PI * 440 * Math.pow(2, (m - 69) / 12)) / sampleRate;
      const env = Math.min(1, tn / 0.03) * Math.min(1, (len - tn) / 0.045) * (0.8 + 0.2 * Math.exp(-tn * 3));
      let v = 0;
      for (let h = 0; h < HARMONICS.length; h++) v += HARMONICS[h] * Math.sin((h + 1) * phase);
      out[i] += 0.18 * level * env * v;
    }
  }
  for (let i = 0; i < out.length; i++) out[i] += noise * (rng() * 2 - 1);
  return out;
}
