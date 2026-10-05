// YIN pitch detection (de Cheveigné & Kawahara, 2002).
// For each frame we measure how similar the signal is to a copy of itself shifted by `tau` samples.
// The first strong dip in that difference curve is the period of the note being hummed.

import { freqToMidi } from './dsp.js';

export const ANALYSIS_RATE = 16000;

export function createPitchDetector({
  sampleRate = ANALYSIS_RATE,
  windowSize = 512,
  minFreq = 70,
  maxFreq = 1500,
  threshold = 0.15,
} = {}) {
  const tauMax = Math.floor(sampleRate / minFreq);
  const tauMin = Math.max(2, Math.floor(sampleRate / maxFreq));
  const span = windowSize + tauMax; // samples needed per frame
  const diff = new Float64Array(tauMax + 1);
  const cmnd = new Float64Array(tauMax + 1);

  function detect(buf, offset = 0) {
    if (offset + span > buf.length) return null;
    const W = windowSize;

    let energy = 0;
    for (let j = 0; j < W; j++) {
      const v = buf[offset + j];
      energy += v * v;
    }
    const rms = Math.sqrt(energy / W);
    if (rms < 1e-5) return { freq: 0, aperiodicity: 1, rms };

    // Step 1: difference function d(tau)
    for (let tau = 1; tau <= tauMax; tau++) {
      let s = 0;
      const o2 = offset + tau;
      for (let j = 0; j < W; j++) {
        const d = buf[offset + j] - buf[o2 + j];
        s += d * d;
      }
      diff[tau] = s;
    }

    // Step 2: cumulative mean normalized difference, which removes the bias toward tau = 0
    cmnd[0] = 1;
    let running = 0;
    for (let tau = 1; tau <= tauMax; tau++) {
      running += diff[tau];
      cmnd[tau] = running > 0 ? (diff[tau] * tau) / running : 1;
    }

    // Step 3: first dip under the threshold, walked down to its local minimum
    let tau = -1;
    for (let t = tauMin; t <= tauMax; t++) {
      if (cmnd[t] < threshold) {
        while (t + 1 <= tauMax && cmnd[t + 1] < cmnd[t]) t++;
        tau = t;
        break;
      }
    }
    // Nothing under the threshold: fall back to the global minimum and let the caller judge confidence
    if (tau < 0) {
      tau = tauMin;
      for (let t = tauMin + 1; t <= tauMax; t++) if (cmnd[t] < cmnd[tau]) tau = t;
    }

    // Step 4: parabolic interpolation for sub-sample accuracy
    let refined = tau;
    if (tau > tauMin && tau < tauMax) {
      const a = cmnd[tau - 1];
      const b = cmnd[tau];
      const c = cmnd[tau + 1];
      const den = a + c - 2 * b;
      if (den > 1e-12) refined = tau + (0.5 * (a - c)) / den;
    }

    return { freq: sampleRate / refined, aperiodicity: cmnd[tau], rms };
  }

  return { detect, span, windowSize, sampleRate, tauMin, tauMax };
}

// Run the detector across a whole recording. One frame every 10 ms.
export function trackPitch(signal, sampleRate = ANALYSIS_RATE, { hopSeconds = 0.01, ...options } = {}) {
  const det = createPitchDetector({ sampleRate, ...options });
  const hop = Math.round(sampleRate * hopSeconds);
  const half = det.windowSize / 2;
  const frames = [];
  for (let off = 0; off + det.span <= signal.length; off += hop) {
    const r = det.detect(signal, off);
    frames.push({
      t: (off + half) / sampleRate,
      freq: r.freq,
      midi: r.freq > 0 ? freqToMidi(r.freq) : NaN,
      ap: r.aperiodicity,
      rms: r.rms,
    });
  }
  return { frames, hop: hop / sampleRate };
}
