// Turns a frame-by-frame pitch track into notes, then snaps those notes onto a 16th-note grid.

import { clamp, median, percentile } from './dsp.js';

const PITCH_JUMP = 0.75; // semitones away from the current note before we consider a new one
const PITCH_HOLD = 4; // frames (about 40 ms) the new pitch has to hold
const DIP_DB = 6; // energy dip that counts as re-attacking the same note
const MIN_NOTE = 0.07; // seconds

// Which frames contain humming? Loud enough, periodic enough, and in a human range.
export function computeVoicing(frames) {
  const n = frames.length;
  const rms = frames.map((f) => f.rms);
  const peak = percentile(rms, 0.98);
  const floor = percentile(rms, 0.1);
  const gate = Math.min(Math.max(0.003, floor * 2.5, peak * 0.06), peak * 0.25);
  const voiced = new Uint8Array(n);
  const pitch = new Float64Array(n).fill(NaN);

  for (let i = 0; i < n; i++) {
    const f = frames[i];
    if (f.rms > gate && f.ap < 0.3 && f.midi >= 33 && f.midi <= 96) {
      voiced[i] = 1;
      pitch[i] = f.midi;
    }
  }

  // Bridge dropouts of one or two frames inside a held note.
  for (let i = 1; i < n; i++) {
    if (voiced[i] || !voiced[i - 1]) continue;
    let j = i;
    while (j < n && !voiced[j] && j - i < 3) j++;
    if (j < n && voiced[j] && j - i <= 2 && Math.abs(pitch[j] - pitch[i - 1]) < 1.5) {
      for (let k = i; k < j; k++) {
        voiced[k] = 1;
        pitch[k] = pitch[i - 1] + ((pitch[j] - pitch[i - 1]) * (k - i + 1)) / (j - i + 1);
      }
    }
  }

  // Drop voiced islands shorter than 50 ms (clicks and breaths that slipped through).
  for (let i = 0; i < n; ) {
    if (!voiced[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < n && voiced[j + 1]) j++;
    if (j - i + 1 < 5) {
      for (let k = i; k <= j; k++) {
        voiced[k] = 0;
        pitch[k] = NaN;
      }
    }
    i = j + 1;
  }

  return { voiced, pitch, gate, peak };
}

// Most people hum a little sharp or flat overall. Treat pitch as an angle around the
// semitone circle and take the energy-weighted circular mean to find that global offset.
export function estimateTuning(frames, voicing) {
  let s = 0;
  let c = 0;
  for (let i = 0; i < frames.length; i++) {
    if (!voicing.voiced[i]) continue;
    const w = frames[i].rms;
    const a = 2 * Math.PI * voicing.pitch[i];
    s += w * Math.sin(a);
    c += w * Math.cos(a);
  }
  return s === 0 && c === 0 ? 0 : Math.atan2(s, c) / (2 * Math.PI);
}

export function segmentNotes(
  frames,
  { hop = 0.01, voicing = computeVoicing(frames), tuning = estimateTuning(frames, voicing) } = {},
) {
  const n = frames.length;
  const raw = [];
  for (let i = 0; i < n; ) {
    if (!voicing.voiced[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < n && voicing.voiced[j + 1]) j++;
    raw.push(...splitRun(frames, voicing.pitch, i, j, tuning, hop));
    i = j + 1;
  }
  const ref = voicing.peak > 0 ? voicing.peak : 1;
  return cleanup(raw).map((nt) => ({
    start: nt.start,
    end: nt.end,
    pitch: nt.pitch,
    vel: clamp(0.45 + 0.55 * (nt.rms / ref), 0.3, 1),
  }));
}

// Split one continuous stretch of humming into notes, using pitch jumps and energy re-attacks.
function splitRun(frames, pitch, a, b, tuning, hop) {
  const len = b - a + 1;
  const tuned = new Float64Array(len);
  for (let i = 0; i < len; i++) tuned[i] = pitch[a + i] - tuning;
  const p = new Float64Array(len);
  for (let i = 0; i < len; i++) p[i] = median(tuned.subarray(Math.max(0, i - 2), Math.min(len, i + 3)));

  const cuts = new Map([[0, 'voice']]);

  // Pitch changes that hold for a few frames start a new note.
  let start = 0;
  let ref = p[0];
  let devStart = -1;
  let dev = 0;
  for (let i = 1; i < len; i++) {
    if (Math.abs(p[i] - ref) > PITCH_JUMP) {
      if (dev === 0) devStart = i;
      dev++;
      if (dev >= PITCH_HOLD) {
        cuts.set(devStart, 'pitch');
        start = devStart;
        dev = 0;
        ref = median(p.subarray(start, i + 1));
      }
    } else {
      dev = 0;
      ref = median(p.subarray(Math.max(start, i - 20), i + 1));
    }
  }

  // A clear dip in loudness followed by a rise means the same pitch was hummed again.
  const db = new Float64Array(len);
  for (let i = 0; i < len; i++) db[i] = 20 * Math.log10(frames[a + i].rms + 1e-9);
  const sm = new Float64Array(len);
  for (let i = 0; i < len; i++) {
    let s = 0;
    let c = 0;
    for (let k = Math.max(0, i - 1); k <= Math.min(len - 1, i + 1); k++) {
      s += db[k];
      c++;
    }
    sm[i] = s / c;
  }
  for (let i = 4; i < len - 4; i++) {
    if (sm[i] > sm[i - 1] || sm[i] > sm[i + 1]) continue;
    let lmax = -Infinity;
    let rmax = -Infinity;
    for (let k = Math.max(0, i - 15); k < i; k++) lmax = Math.max(lmax, sm[k]);
    for (let k = i + 1; k <= Math.min(len - 1, i + 15); k++) rmax = Math.max(rmax, sm[k]);
    if (lmax - sm[i] < DIP_DB || rmax - sm[i] < DIP_DB) continue;
    const near = [...cuts.keys()].some((c) => Math.abs(c - i) < 6);
    if (!near) cuts.set(i + 1, 'energy');
  }

  const order = [...cuts.keys()].sort((x, y) => x - y);
  const out = [];
  for (let k = 0; k < order.length; k++) {
    const s = order[k];
    const e = (k + 1 < order.length ? order[k + 1] : len) - 1;
    if (e < s) continue;
    const segLen = e - s + 1;
    // Ignore the scoop at the start and the fall-off at the end when picking the pitch.
    const core =
      segLen >= 6
        ? p.subarray(s + Math.floor(segLen * 0.25), e - Math.floor(segLen * 0.1) + 1)
        : p.subarray(s, e + 1);
    let rms = 0;
    for (let i = s; i <= e; i++) rms = Math.max(rms, frames[a + i].rms);
    const third = Math.max(1, Math.floor(segLen / 3));
    out.push({
      start: frames[a + s].t,
      end: frames[a + e].t + hop,
      pitch: median(core),
      rms,
      attack: cuts.get(s),
      slope: median(p.subarray(e - third + 1, e + 1)) - median(p.subarray(s, s + third)),
    });
  }
  return out;
}

function cleanup(input) {
  const notes = input.slice().sort((x, y) => x.start - y.start);
  const touching = (x, y) => y.start - x.end < 0.03;

  // Fold glides between notes and tiny blips into their neighbours.
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < notes.length; i++) {
      const nt = notes[i];
      const dur = nt.end - nt.start;
      const glide = dur < 0.14 && Math.abs(nt.slope) > 0.7;
      if (dur >= MIN_NOTE && !glide) continue;
      const prev = notes[i - 1];
      const next = notes[i + 1];
      const joinsPrev = prev && touching(prev, nt);
      const joinsNext = next && touching(nt, next);
      if (joinsPrev && joinsNext) {
        const mid = (nt.start + nt.end) / 2;
        prev.end = mid;
        next.start = mid;
      } else if (joinsNext) {
        next.start = nt.start;
        next.attack = nt.attack;
      } else if (joinsPrev) {
        prev.end = nt.end;
      } else if (dur >= MIN_NOTE) {
        continue; // an isolated slide that is long enough is probably a real note
      }
      notes.splice(i, 1);
      changed = true;
      break;
    }
  }

  // Re-join halves of one note that pitch wobble split apart.
  const merged = [];
  for (const nt of notes) {
    const last = merged[merged.length - 1];
    if (last && touching(last, nt) && nt.attack === 'pitch' && Math.abs(last.pitch - nt.pitch) < 0.5) {
      const w1 = last.end - last.start;
      const w2 = nt.end - nt.start;
      last.pitch = (last.pitch * w1 + nt.pitch * w2) / (w1 + w2);
      last.end = nt.end;
      last.rms = Math.max(last.rms, nt.rms);
    } else {
      merged.push({ ...nt });
    }
  }
  return merged;
}

// Latency estimates are never perfect, so search a small window for the shift that lands
// the onsets closest to the grid.
function bestShift(onsets, weights, stepDur, maxShift) {
  if (!onsets.length || maxShift <= 0) return 0;
  const total = weights.reduce((s, w) => s + w, 0);
  let best = 0;
  let bestCost = Infinity;
  for (let d = -maxShift; d <= maxShift + 1e-9; d += 0.0025) {
    let cost = 0;
    for (let i = 0; i < onsets.length; i++) {
      const x = (onsets[i] + d) / stepDur;
      const r = x - Math.round(x);
      cost += weights[i] * r * r;
    }
    cost += 0.02 * total * (d / maxShift) ** 2; // mild preference for no shift
    if (cost < bestCost) {
      bestCost = cost;
      best = d;
    }
  }
  return best;
}

// Place notes on a 16th grid. `origin` is the time (in seconds) of the first downbeat.
// Notes that start just before the downbeat are pickups and wrap around to the end of the loop.
export function quantizeNotes(notes, { bpm, bars, origin = 0, maxShift = 0.045 }) {
  const stepDur = 60 / bpm / 4;
  const total = bars * 16;
  const rel = notes.map((n) => ({ ...n, start: n.start - origin, end: n.end - origin }));
  const weights = rel.map((n) => clamp((n.end - n.start) / stepDur, 0.5, 4));
  const shift = bestShift(
    rel.map((n) => n.start),
    weights,
    stepDur,
    maxShift,
  );

  const main = [];
  const pickups = [];
  for (const n of rel) {
    const s = Math.round((n.start + shift) / stepDur);
    const e = Math.round((n.end + shift) / stepDur);
    const q = { step: s, dur: Math.max(1, e - s), pitch: n.pitch, vel: n.vel };
    if (s < 0) {
      if (s >= -16) pickups.push(q);
    } else if (s < total) {
      main.push(q);
    }
  }

  main.sort((x, y) => x.step - y.step || y.dur * y.vel - x.dur * x.vel);
  const out = main.filter((n, i) => i === 0 || n.step !== main[i - 1].step);

  for (const p of pickups) {
    const step = p.step + total;
    const dur = Math.min(p.dur, -p.step);
    const busy = out.some((n) => n.step < step + dur && n.step + n.dur > step);
    if (!busy && step >= 0) out.push({ ...p, step, dur });
  }

  out.sort((x, y) => x.step - y.step);
  for (let i = 0; i < out.length; i++) {
    const limit = i + 1 < out.length ? out[i + 1].step : total;
    const end = out[i].step + out[i].dur;
    if (end > limit) out[i].dur = limit - out[i].step;
    else if (limit - end === 1 && i + 1 < out.length) out[i].dur += 1; // close tiny gaps so lines sound legato
  }
  return { notes: out.filter((n) => n.dur > 0), shift };
}
