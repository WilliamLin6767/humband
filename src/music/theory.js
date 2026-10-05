// Music theory helpers: note names, scales, key detection and the diatonic chord vocabulary.

export const PC_SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const PC_FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const FLAT_MAJOR = new Set([5, 10, 3, 8, 1, 6]); // F Bb Eb Ab Db Gb
const FLAT_MINOR = new Set([2, 7, 0, 5, 10, 3]); // D G C F Bb Eb

export const pitchClass = (p) => ((Math.round(p) % 12) + 12) % 12;

export function usesFlats(key) {
  return !!key && (key.mode === 'major' ? FLAT_MAJOR : FLAT_MINOR).has(key.tonic);
}

export function pcName(p, key) {
  return (usesFlats(key) ? PC_FLAT : PC_SHARP)[pitchClass(p)];
}

export function noteName(midi, key) {
  return pcName(midi, key) + (Math.floor(Math.round(midi) / 12) - 1);
}

export function keyName(key) {
  return `${pcName(key.tonic, key)} ${key.mode}`;
}

export const ALL_KEYS = [];
for (const mode of ['major', 'minor']) for (let tonic = 0; tonic < 12; tonic++) ALL_KEYS.push({ tonic, mode });

export const SCALES = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
};

export function scalePcs(key) {
  return new Set(SCALES[key.mode].map((i) => (i + key.tonic) % 12));
}

// Round a hummed pitch to the nearest note of the key. In a diatonic scale every
// out-of-key note sits between two in-key notes, so we just pick the closer neighbour.
export function snapToKey(pitch, key) {
  const pcs = scalePcs(key);
  const r = Math.round(pitch);
  if (pcs.has(pitchClass(r))) return r;
  const upIn = pcs.has(pitchClass(r + 1));
  const downIn = pcs.has(pitchClass(r - 1));
  if (upIn && downIn) return Math.abs(pitch - (r + 1)) < Math.abs(pitch - (r - 1)) ? r + 1 : r - 1;
  if (upIn) return r + 1;
  if (downIn) return r - 1;
  return r;
}

// Krumhansl-Kessler key profiles: how strongly each scale degree implies a key.
const KK_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KK_MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function pearson(x, y) {
  const n = x.length;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += x[i];
    my += y[i];
  }
  mx /= n;
  my /= n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - mx;
    const dy = y[i] - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : 0;
}

// Correlate the melody's duration-weighted pitch-class histogram against all 24 key profiles.
export function detectKey(notes) {
  const hist = new Array(12).fill(0);
  let last = null;
  for (const n of notes) {
    hist[pitchClass(n.pitch)] += n.dur * (n.vel ?? 1);
    if (!last || n.step > last.step) last = n;
  }
  if (hist.every((v) => v === 0)) return { tonic: 0, mode: 'major', confidence: 0 };

  const ranking = [];
  for (let tonic = 0; tonic < 12; tonic++) {
    for (const mode of ['major', 'minor']) {
      const profile = mode === 'major' ? KK_MAJOR : KK_MINOR;
      const rotated = profile.map((_, i) => profile[(i - tonic + 12) % 12]);
      let score = pearson(hist, rotated);
      if (last && pitchClass(last.pitch) === tonic) score += 0.1; // melodies like to end on the tonic
      ranking.push({ tonic, mode, score });
    }
  }
  ranking.sort((a, b) => b.score - a.score);
  return { tonic: ranking[0].tonic, mode: ranking[0].mode, confidence: ranking[0].score - ranking[1].score };
}

export const QUALITIES = {
  maj: { tones: [0, 4, 7], suffix: '' },
  min: { tones: [0, 3, 7], suffix: 'm' },
  maj7: { tones: [0, 4, 7, 11], suffix: 'maj7' },
  min7: { tones: [0, 3, 7, 10], suffix: 'm7' },
  dom7: { tones: [0, 4, 7, 10], suffix: '7' },
};

// Diminished chords are left out on purpose: they rarely suit a hummed pop melody.
const DEGREES = {
  major: [
    { roman: 'I', interval: 0, quality: 'maj', seventh: 'maj7' },
    { roman: 'ii', interval: 2, quality: 'min', seventh: 'min7' },
    { roman: 'iii', interval: 4, quality: 'min', seventh: 'min7' },
    { roman: 'IV', interval: 5, quality: 'maj', seventh: 'maj7' },
    { roman: 'V', interval: 7, quality: 'maj', seventh: 'dom7' },
    { roman: 'vi', interval: 9, quality: 'min', seventh: 'min7' },
  ],
  minor: [
    { roman: 'i', interval: 0, quality: 'min', seventh: 'min7' },
    { roman: 'III', interval: 3, quality: 'maj', seventh: 'maj7' },
    { roman: 'iv', interval: 5, quality: 'min', seventh: 'min7' },
    { roman: 'v', interval: 7, quality: 'min', seventh: 'min7' },
    { roman: 'V', interval: 7, quality: 'maj', seventh: 'dom7' },
    { roman: 'VI', interval: 8, quality: 'maj', seventh: 'maj7' },
    { roman: 'VII', interval: 10, quality: 'maj', seventh: 'dom7' },
  ],
};

export function diatonicChords(key) {
  return DEGREES[key.mode].map((d) => ({ ...d, root: (key.tonic + d.interval) % 12 }));
}

export function chordSymbol(root, quality, key) {
  return pcName(root, key) + QUALITIES[quality].suffix;
}

export function chordTones(root, quality) {
  return QUALITIES[quality].tones.map((t) => (root + t) % 12);
}
