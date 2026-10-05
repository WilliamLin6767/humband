// Keys part: voice each chord close to the previous one (smooth voice leading), then play it
// in the style's rhythm.

import { STYLES } from './styles.js';

// Try every inversion in range and keep the one with the least total finger movement.
export function voiceChord(tones, prev, { low = 50, high = 74 } = {}) {
  const n = tones.length;
  const candidates = [];
  for (let inv = 0; inv < n; inv++) {
    const pcs = tones.slice(inv).concat(tones.slice(0, inv));
    for (let base = low; base < low + 24; base++) {
      if (base % 12 !== pcs[0]) continue;
      const v = [base];
      for (let i = 1; i < n; i++) {
        let p = v[i - 1] + 1;
        while (p % 12 !== pcs[i]) p++;
        v.push(p);
      }
      if (v[n - 1] <= high) candidates.push(v);
    }
  }
  if (!candidates.length) {
    const r = low + ((((tones[0] - low) % 12) + 12) % 12);
    return tones.map((t) => r + ((t - tones[0] + 12) % 12));
  }
  const center = (v) => v.reduce((s, p) => s + p, 0) / v.length;
  const cost = (v) => {
    if (!prev) return Math.abs(center(v) - 61);
    let c = 0;
    for (let i = 0; i < v.length; i++) c += Math.abs(v[i] - prev[Math.min(i, prev.length - 1)]);
    return c + 0.15 * Math.abs(center(v) - 61);
  };
  return candidates.reduce((a, b) => (cost(b) < cost(a) ? b : a));
}

export function powerVoicing(rootPc) {
  const r = 40 + ((((rootPc - 40) % 12) + 12) % 12);
  return [r, r + 7, r + 12];
}

export function generateKeys({ chords, style, bars }) {
  const st = STYLES[style].keys;
  let prev = null;
  const voicings = chords.map((c) => {
    const v = st.instrument === 'power' ? powerVoicing(c.root) : voiceChord(c.tones, prev);
    prev = v;
    return v;
  });
  const hits = [];
  for (let b = 0; b < bars; b++) {
    for (const [s, d] of st.pattern) {
      const start = b * 16 + s;
      const end = start + d;
      // Split a hit wherever the chord changes underneath it
      chords.forEach((c, i) => {
        const a = Math.max(start, c.step);
        const z = Math.min(end, c.step + c.dur);
        if (z > a) hits.push({ step: a, dur: z - a, pitches: voicings[i], vel: st.vel * (s === 0 ? 1 : 0.88) });
      });
    }
  }
  return hits;
}
