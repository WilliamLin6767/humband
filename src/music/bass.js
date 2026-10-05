// Bass line generator. Most styles lock the bass to the kick drum (that is what makes a groove
// feel tight), play the chord root on chord changes, and sometimes walk into the next chord
// with a passing note.

import { STYLES } from './styles.js';
import { scalePcs } from './theory.js';

export function generateBass({ bars, chords, drums, style, key, creativity = 0.5, rng }) {
  const st = STYLES[style].bass;
  const total = bars * 16;
  const low = st.pattern === '808' ? 31 : 36;
  const pcs = scalePcs(key);
  const chordAt = (step) => chords.find((c) => step >= c.step && step < c.step + c.dur) || chords[chords.length - 1];
  const rootPitch = (pc) => low + ((((pc - low) % 12) + 12) % 12);
  const kicks = new Set(drums.filter((d) => d.voice === 'kick').map((d) => d.step));
  const notes = [];

  for (let b = 0; b < bars; b++) {
    const base = b * 16;
    let hitSteps;
    if (st.pattern === 'eighths') hitSteps = [0, 2, 4, 6, 8, 10, 12, 14];
    else if (st.pattern === 'offbeat') hitSteps = [2, 6, 10, 14];
    else if (st.pattern === 'lazy') hitSteps = [0, rng() < 0.5 ? 7 : 10];
    else {
      hitSteps = [0];
      for (let s = 1; s < 16; s++) if (kicks.has(base + s)) hitSteps.push(s);
    }
    // Every chord change gets a bass note
    if (st.pattern !== 'offbeat') {
      for (const c of chords) if (c.step > base && c.step < base + 16) hitSteps.push(c.step - base);
    }
    hitSteps = [...new Set(hitSteps)].sort((x, y) => x - y);

    hitSteps.forEach((s, i) => {
      const next = i + 1 < hitSteps.length ? hitSteps[i + 1] : 16;
      const step = base + s;
      const chord = chordAt(step);
      const root = rootPitch(chord.root);
      let pitch = root;
      if (step !== chord.step) {
        const r = rng();
        if (st.pattern === '808') {
          if (r < 0.12 + 0.2 * creativity) pitch = root + 12;
        } else if (r < 0.1 + 0.25 * creativity) {
          pitch = root + 7 <= low + 16 ? root + 7 : root - 5; // the fifth
        } else if (r < 0.18 + 0.35 * creativity) {
          pitch = root + 12; // the octave
        }
      }
      let dur;
      if (st.pattern === 'eighths' || st.pattern === 'offbeat') dur = 2;
      else if (st.pattern === '808') dur = next - s;
      else dur = Math.min(next - s, st.pattern === 'lazy' ? 8 : 4);
      notes.push({ step, dur: Math.max(1, dur), pitch, vel: s === 0 ? 0.95 : s % 4 === 0 ? 0.85 : 0.75 });
    });

    // Walk into the next chord with a passing note on the last 8th of the bar.
    const cur = chordAt(base + 15);
    const nxt = chordAt((base + 16) % total);
    if (st.pattern !== 'offbeat' && nxt.root !== cur.root && rng() < 0.3 + 0.4 * creativity) {
      const target = rootPitch(nxt.root);
      const options = [target - 2, target - 1, target + 1, target + 2].filter((p) => pcs.has(((p % 12) + 12) % 12));
      if (options.length) {
        const from = rootPitch(cur.root);
        const approach = options.reduce((a, p) => (Math.abs(p - from) < Math.abs(a - from) ? p : a));
        for (let i = notes.length - 1; i >= 0; i--) {
          const n = notes[i];
          if (n.step < base) break;
          if (n.step >= base + 14) notes.splice(i, 1);
          else if (n.step + n.dur > base + 14) n.dur = base + 14 - n.step;
        }
        notes.push({ step: base + 14, dur: 2, pitch: approach, vel: 0.72 });
      }
    }
  }
  return notes.sort((a, b) => a.step - b.step);
}
