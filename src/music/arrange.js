// Puts the generators together: melody in, full arrangement out.

import { detectKey, snapToKey } from './theory.js';
import { generateChords } from './harmony.js';
import { generateDrums } from './drums.js';
import { generateBass } from './bass.js';
import { generateKeys } from './comp.js';
import { STYLES } from './styles.js';
import { mulberry32 } from './random.js';

export function buildArrangement(
  { melody, bpm, bars },
  {
    style = 'pop',
    creativity = 0.45,
    key = null,
    snap = true,
    chordsPerBar = null,
    seeds = { chords: 1, drums: 2, bass: 3 },
    drums = null,
  } = {},
) {
  const st = STYLES[style];
  const detected = detectKey(melody);
  const useKey = key || { tonic: detected.tonic, mode: detected.mode };
  const notes = melody.map((n) => ({
    step: n.step,
    dur: n.dur,
    vel: n.vel ?? 0.8,
    pitch: snap ? snapToKey(n.pitch, useKey) : Math.round(n.pitch),
  }));

  const chords = generateChords(notes, {
    key: useKey,
    bars,
    chordsPerBar: chordsPerBar || st.chordsPerBar,
    creativity,
    rng: mulberry32(seeds.chords),
    sevenths: st.sevenths,
  });
  const drumHits = drums || generateDrums({ bars, style, melody: notes, creativity, rng: mulberry32(seeds.drums) });
  const bass = generateBass({ bars, chords, drums: drumHits, style, key: useKey, creativity, rng: mulberry32(seeds.bass) });
  const keys = generateKeys({ chords, style, bars });

  return {
    bpm,
    bars,
    steps: bars * 16,
    key: useKey,
    detectedKey: { tonic: detected.tonic, mode: detected.mode },
    style,
    swing: st.swing,
    melody: notes,
    chords,
    keys,
    bass,
    drums: drumHits,
  };
}

// Low hums sound muddy on a lead synth, so move the lead up an octave when needed.
export function autoLeadOctave(melody) {
  if (!melody.length) return 0;
  const sorted = melody.map((n) => n.pitch).sort((a, b) => a - b);
  const mid = sorted[sorted.length >> 1];
  if (mid < 57) return 1;
  if (mid > 81) return -1;
  return 0;
}
