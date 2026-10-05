// Chord generation as a hidden Markov model.
//
// Hidden states: the diatonic chords of the key. Observations: the melody notes in each bar
// (or half bar). Emission scores reward melody notes that are chord tones, especially on strong
// beats, and punish clashes. Transition probabilities encode common pop/functional harmony
// moves (V -> I, IV -> V, vi -> IV, and so on).
//
// Because the result plays as a loop, the last chord also has to lead back into the first.
// We solve that exactly by running Viterbi once per possible first chord and adding the
// wrap-around transition at the end.
//
// For variety ("regenerate"), Gumbel noise is added to the emission scores before decoding
// (perturb-and-MAP), which samples a different but still musically likely progression.

import { chordSymbol, chordTones, diatonicChords, QUALITIES } from './theory.js';
import { gumbel } from './random.js';

const TRANSITIONS = {
  major: {
    I: { I: 0.1, ii: 0.1, iii: 0.05, IV: 0.27, V: 0.26, vi: 0.22 },
    ii: { I: 0.12, ii: 0.06, iii: 0.06, IV: 0.14, V: 0.5, vi: 0.12 },
    iii: { I: 0.08, ii: 0.08, iii: 0.05, IV: 0.32, V: 0.1, vi: 0.37 },
    IV: { I: 0.3, ii: 0.1, iii: 0.05, IV: 0.08, V: 0.32, vi: 0.15 },
    V: { I: 0.45, ii: 0.04, iii: 0.05, IV: 0.16, V: 0.08, vi: 0.22 },
    vi: { I: 0.1, ii: 0.15, iii: 0.08, IV: 0.37, V: 0.2, vi: 0.1 },
  },
  minor: {
    i: { i: 0.1, III: 0.12, iv: 0.22, v: 0.08, V: 0.1, VI: 0.22, VII: 0.16 },
    III: { i: 0.12, III: 0.05, iv: 0.15, v: 0.06, V: 0.05, VI: 0.27, VII: 0.3 },
    iv: { i: 0.28, III: 0.08, iv: 0.06, v: 0.12, V: 0.16, VI: 0.12, VII: 0.18 },
    v: { i: 0.35, III: 0.08, iv: 0.15, v: 0.05, V: 0.02, VI: 0.25, VII: 0.1 },
    V: { i: 0.6, III: 0.04, iv: 0.06, v: 0.02, V: 0.05, VI: 0.18, VII: 0.05 },
    VI: { i: 0.15, III: 0.2, iv: 0.17, v: 0.1, V: 0.08, VI: 0.06, VII: 0.24 },
    VII: { i: 0.3, III: 0.3, iv: 0.1, v: 0.05, V: 0.03, VI: 0.17, VII: 0.05 },
  },
};

const START = {
  major: { I: 0.45, ii: 0.07, iii: 0.03, IV: 0.2, V: 0.07, vi: 0.18 },
  minor: { i: 0.5, III: 0.08, iv: 0.12, v: 0.03, V: 0.02, VI: 0.17, VII: 0.08 },
};

// How well does a melody note (interval above the chord root) sit over a chord?
export function toneFit(interval, quality) {
  const tones = QUALITIES[quality].tones;
  if (interval === 0) return 1;
  if (interval === tones[1]) return 0.9;
  if (interval === tones[2]) return 0.8;
  const minor = tones[1] === 3;
  switch (interval) {
    case 2:
      return 0.25; // 9th
    case 9:
      return 0.2; // 6th
    case 10:
      return minor ? 0.4 : 0.05; // minor 7th
    case 11:
      return minor ? -0.5 : 0.35; // major 7th
    case 5:
      return minor ? 0.15 : -0.35; // 4th: fine over minor, an avoid note over major
    default:
      return -0.7; // clashes
  }
}

function metricWeight(step) {
  const pos = step % 16;
  if (pos === 0) return 1.6;
  if (pos === 8) return 1.3;
  if (pos % 4 === 0) return 1.1;
  if (pos % 2 === 0) return 0.9;
  return 0.75;
}

// Duration- and beat-weighted pitch-class profile of the melody between two steps.
function segmentProfile(melody, s0, s1) {
  const w = new Float64Array(12);
  let total = 0;
  for (const n of melody) {
    const a = Math.max(n.step, s0);
    const b = Math.min(n.step + n.dur, s1);
    if (b <= a) continue;
    const metric = n.step >= s0 ? metricWeight(n.step) : 0.7; // notes held over from before count a bit less
    const weight = (b - a) * metric * (n.vel ?? 1);
    w[((n.pitch % 12) + 12) % 12] += weight;
    total += weight;
  }
  return { w, total };
}

export function generateChords(
  melody,
  { key, bars, chordsPerBar = 1, creativity = 0, rng = Math.random, sevenths = false, emission = 4 },
) {
  const vocab = diatonicChords(key);
  const K = vocab.length;
  const segLen = 16 / chordsPerBar;
  const N = bars * chordsPerBar;
  const T = TRANSITIONS[key.mode];
  const S = START[key.mode];
  const logT = vocab.map((a) => vocab.map((b) => Math.log(T[a.roman][b.roman])));
  const logS = vocab.map((c) => Math.log(S[c.roman]));
  const beta = creativity * 1.4;

  const E = [];
  for (let s = 0; s < N; s++) {
    const { w, total } = segmentProfile(melody, s * segLen, (s + 1) * segLen);
    E.push(
      vocab.map((c) => {
        let score = 0;
        if (total > 0) {
          for (let p = 0; p < 12; p++) if (w[p]) score += w[p] * toneFit((p - c.root + 12) % 12, c.quality);
          score /= total;
        }
        return emission * score + (beta > 0 ? beta * gumbel(rng) : 0);
      }),
    );
  }

  let best = { score: -Infinity, path: [0] };
  for (let first = 0; first < K; first++) {
    let dp = vocab.map((_, c) => (c === first ? logS[c] + E[0][c] : -Infinity));
    const back = [];
    for (let s = 1; s < N; s++) {
      const next = new Array(K).fill(-Infinity);
      const ptr = new Array(K).fill(0);
      for (let c = 0; c < K; c++) {
        for (let p = 0; p < K; p++) {
          const v = dp[p] + logT[p][c];
          if (v > next[c]) {
            next[c] = v;
            ptr[c] = p;
          }
        }
        next[c] += E[s][c];
      }
      dp = next;
      back.push(ptr);
    }
    for (let c = 0; c < K; c++) {
      const total = dp[c] + (N > 1 ? 0.6 * logT[c][first] : 0);
      if (total > best.score) {
        const path = [c];
        for (let s = N - 2; s >= 0; s--) path.unshift(back[s][path[0]]);
        best = { score: total, path };
      }
    }
  }

  return best.path.map((ci, s) => {
    const c = vocab[ci];
    const quality = sevenths ? c.seventh : c.quality;
    return {
      step: s * segLen,
      dur: segLen,
      root: c.root,
      quality,
      roman: c.roman,
      symbol: chordSymbol(c.root, quality, key),
      tones: chordTones(c.root, quality),
    };
  });
}
