// Small DSP helpers shared by the analysis pipeline.
// Nothing in /analysis or /music touches browser APIs, so all of it runs in Node for tests.

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const freqToMidi = (f) => 69 + 12 * Math.log2(f / 440);
export const midiToFreq = (m) => 440 * Math.pow(2, (m - 69) / 12);

export function median(values) {
  const a = Array.from(values).sort((x, y) => x - y);
  if (a.length === 0) return NaN;
  const mid = a.length >> 1;
  return a.length % 2 ? a[mid] : 0.5 * (a[mid - 1] + a[mid]);
}

export function percentile(values, q) {
  const a = Array.from(values).sort((x, y) => x - y);
  if (a.length === 0) return 0;
  return a[clamp(Math.round(q * (a.length - 1)), 0, a.length - 1)];
}

// Windowed-sinc low-pass kernel (Blackman window). `cutoff` is a fraction of the sample rate, 0 to 0.5.
export function lowpassKernel(cutoff, taps = 63) {
  const h = new Float32Array(taps);
  const mid = (taps - 1) / 2;
  let sum = 0;
  for (let i = 0; i < taps; i++) {
    const n = i - mid;
    const sinc = n === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * n) / (Math.PI * n);
    const w =
      0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (taps - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (taps - 1));
    h[i] = sinc * w;
    sum += h[i];
  }
  for (let i = 0; i < taps; i++) h[i] /= sum;
  return h;
}

// Convolution that keeps the output aligned with the input (kernel is symmetric).
export function convolveSame(x, h) {
  const n = x.length;
  const m = h.length;
  const half = (m - 1) >> 1;
  const y = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const jMin = Math.max(0, i + half - n + 1);
    const jMax = Math.min(m - 1, i + half);
    let acc = 0;
    for (let j = jMin; j <= jMax; j++) acc += h[j] * x[i + half - j];
    y[i] = acc;
  }
  return y;
}

// Anti-aliased resampling. Good enough for pitch tracking, which only needs the low end of the spectrum.
export function resample(input, fromRate, toRate) {
  if (fromRate === toRate) return Float32Array.from(input);
  const ratio = fromRate / toRate;
  const src = ratio > 1 ? convolveSame(input, lowpassKernel(0.45 / ratio)) : input;
  const outLen = Math.floor(input.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const frac = pos - i0;
    const a = src[i0] || 0;
    const b = i0 + 1 < src.length ? src[i0 + 1] : a;
    out[i] = a + (b - a) * frac;
  }
  return out;
}
