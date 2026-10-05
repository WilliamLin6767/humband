// Tempo estimation for "free" recordings with no metronome.
//
// Idea: for a candidate tempo, map every note onset to an angle on a circle whose
// circumference is one grid step. If the onsets really sit on that grid, the angles pile up
// and their mean vector is long. If they don't, the angles scatter and it is short.
// That length (the resultant) is a clean, scale-free measure of how well a grid fits.

function resultant(times, weights, period) {
  let s = 0;
  let c = 0;
  let w = 0;
  for (let i = 0; i < times.length; i++) {
    const a = (2 * Math.PI * times[i]) / period;
    s += weights[i] * Math.sin(a);
    c += weights[i] * Math.cos(a);
    w += weights[i];
  }
  if (w === 0) return { R: 0, phase: 0 };
  return { R: Math.hypot(s, c) / w, phase: (Math.atan2(s, c) / (2 * Math.PI)) * period };
}

function circDist(a, b, period) {
  const d = (((a - b) % period) + period) % period;
  return Math.min(d, period - d);
}

const ALLOWED_BARS = [1, 2, 4, 8];

export function estimateTempo(notes, { forcedBpm = null, beatShift = 0, minBpm = 60, maxBpm = 180 } = {}) {
  if (notes.length === 0) return { bpm: forcedBpm || 100, origin: 0, bars: 1 };

  const onsets = notes.map((n) => n.start);
  const durW = notes.map((n) => Math.min(1.2, n.end - n.start) * n.vel);
  const velW = notes.map((n) => n.vel);

  let bpm = forcedBpm;
  if (!bpm) {
    if (notes.length < 3) {
      bpm = 100;
    } else {
      let best = -Infinity;
      for (let b = minBpm; b <= maxBpm; b += 0.5) {
        const beat = 60 / b;
        // 16th and 8th fits catch the rhythm, the quarter-note fit (weighted by note length)
        // catches the pulse. The 16th term rules out odd ratios like 2/3 of the real tempo.
        const fit =
          0.2 * resultant(onsets, velW, beat / 4).R +
          0.5 * resultant(onsets, velW, beat / 2).R +
          0.3 * resultant(onsets, durW, beat).R;
        // Prior toward everyday tempos. Double/half time stays genuinely ambiguous,
        // which is why the app has 1/2x and 2x buttons.
        const prior = Math.exp(-0.5 * (Math.log2(b / 100) / 0.4) ** 2);
        const score = fit * (0.3 + 0.7 * prior);
        if (score > best) {
          best = score;
          bpm = b;
        }
      }
    }
  }

  const beat = 60 / bpm;
  const eighth = beat / 2;
  const bar = beat * 4;

  // Beats sit on the 8th grid. Pick the half of it that agrees with the quarter-note fit.
  const p8 = resultant(onsets, velW, eighth).phase;
  const p4 = resultant(onsets, durW, beat).phase;
  const beatPhase = [p8, p8 + eighth].reduce((a, c) => (circDist(c, p4, beat) < circDist(a, p4, beat) ? c : a));

  // Downbeat: try each beat as "one". People nearly always start humming on the one, so the
  // first note carries a lot of weight. Long notes landing on bar lines break ties, which also
  // handles pickups (a first note that falls between beats gets no bonus anywhere).
  const near = (t, phase) => {
    const d = circDist(t, phase, bar) / beat;
    return Math.exp(-(d * d) / (2 * 0.12 * 0.12));
  };
  const mass = durW.reduce((s, w) => s + w, 0);
  let bestOffset = 0;
  let bestScore = -Infinity;
  for (let k = 0; k < 4; k++) {
    const phase = beatPhase + k * beat;
    let score = 0.35 * mass * near(onsets[0], phase);
    notes.forEach((n, i) => {
      score += durW[i] * near(n.start, phase);
    });
    if (score > bestScore) {
      bestScore = score;
      bestOffset = k;
    }
  }
  // `beatShift` lets the user move the bar line by hand if we guessed wrong
  const barPhase = beatPhase + (bestOffset + beatShift) * beat;

  // First bar line at (or a hair before) the first note. Anything earlier is a pickup.
  const origin = barPhase + Math.ceil((onsets[0] - 0.3 * beat - barPhase) / bar) * bar;
  const end = Math.max(...notes.map((n) => n.end));
  const needed = Math.max(1, Math.ceil((end - origin) / bar - 0.12));
  const bars = ALLOWED_BARS.find((b) => b >= needed) || 8;

  return { bpm, origin, bars };
}
