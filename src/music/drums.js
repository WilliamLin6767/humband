// Built-in drum generator. It starts from the style's template, rolls the optional hits, and
// leans on the hummed rhythm: an optional kick is much more likely on a step where you started
// a note, so the groove locks to your melody instead of ignoring it.

import { STYLES } from './styles.js';

export const DRUM_VOICES = ['kick', 'snare', 'clap', 'rim', 'hatC', 'hatO', 'tomL', 'tomM', 'tomH', 'crash', 'ride'];
const TEMPLATE_VOICES = ['kick', 'snare', 'clap', 'rim', 'hatC', 'hatO'];

export function accentFor(voice, step, optional = false) {
  const s = step % 16;
  switch (voice) {
    case 'kick':
      return s === 0 ? 1 : 0.86;
    case 'snare':
      return optional ? 0.3 : 0.92; // optional snares are ghost notes
    case 'clap':
      return 0.62;
    case 'rim':
      return 0.5;
    case 'hatC':
      return s % 4 === 0 ? 0.6 : s % 2 === 0 ? 0.46 : 0.3;
    case 'hatO':
      return 0.48;
    default:
      return 0.75;
  }
}

// How strongly the melody starts a note on each step (0 to 1).
export function onsetProfile(melody, totalSteps) {
  const o = new Float32Array(totalSteps);
  for (const n of melody) {
    if (n.step < 0 || n.step >= totalSteps) continue;
    o[n.step] = Math.max(o[n.step], Math.min(1, 0.5 + n.dur / 8) * (n.vel ?? 1));
  }
  return o;
}

export function generateDrums({ bars, style, melody, creativity = 0.5, rng }) {
  const st = STYLES[style].drums;
  const total = bars * 16;
  const onset = onsetProfile(melody, total);
  const density = Math.min(1, melody.length / Math.max(1, bars * 8));
  const variation = 0.5 + creativity;
  let hits = [];
  const add = (step, voice, vel) => hits.push({ step, voice, vel: Math.min(1, Math.max(0.05, vel)) });

  for (let b = 0; b < bars; b++) {
    for (let s = 0; s < 16; s++) {
      const step = b * 16 + s;
      for (const voice of TEMPLATE_VOICES) {
        const tpl = st[voice];
        if (!tpl) continue;
        let p = tpl[s];
        // Busier melodies get busier hats
        if (voice === 'hatC' && s % 2 === 1 && st.ghostHats) p = Math.max(p, st.ghostHats * (0.4 + density));
        if (p <= 0) continue;
        const optional = p < 1;
        if (optional) {
          p = Math.min(0.95, p * variation);
          if (voice === 'kick') p += (1 - p) * st.follow * onset[step];
        }
        if (rng() < p) add(step, voice, accentFor(voice, s, optional) * (0.9 + 0.2 * rng()));
      }
    }
  }

  // An open hat chokes the closed hat on the same step.
  const open = new Set(hits.filter((h) => h.voice === 'hatO').map((h) => h.step));
  hits = hits.filter((h) => !(h.voice === 'hatC' && open.has(h.step)));

  if (st.crash && rng() < 0.85) {
    hits = hits.filter((h) => !(h.step === 0 && (h.voice === 'hatC' || h.voice === 'hatO')));
    add(0, 'crash', 0.75);
  }

  if (bars >= 2 && rng() < st.fill * (0.6 + 0.6 * creativity)) hits = addFill(hits, (bars - 1) * 16, rng);
  return hits.sort((a, b) => a.step - b.step);
}

// Replace the last beat of the loop with a short fill that leads back to the top.
function addFill(hits, barStart, rng) {
  const from = barStart + 12;
  const kept = hits.filter(
    (h) => h.step < from || h.step >= barStart + 16 || (h.voice === 'kick' && h.step === from),
  );
  const fill = [];
  const type = Math.floor(rng() * 3);
  if (type === 0) {
    for (let k = 0; k < 4; k++) fill.push({ step: from + k, voice: 'snare', vel: 0.45 + 0.15 * k });
  } else if (type === 1) {
    fill.push(
      { step: from, voice: 'tomH', vel: 0.8 },
      { step: from + 1, voice: 'tomH', vel: 0.65 },
      { step: from + 2, voice: 'tomM', vel: 0.8 },
      { step: from + 3, voice: 'tomL', vel: 0.9 },
    );
  } else {
    fill.push(
      { step: from, voice: 'snare', vel: 0.85 },
      { step: from + 2, voice: 'tomM', vel: 0.75 },
      { step: from + 3, voice: 'tomL', vel: 0.85 },
    );
  }
  return kept.concat(fill);
}
