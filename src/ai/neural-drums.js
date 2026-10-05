// Optional neural drums using Google Magenta's DrumsRNN (an LSTM trained on thousands of real
// drum performances). It loads on demand, so the app stays light until you switch it on.
//
// DrumsRNN continues a drum pattern but knows nothing about your melody. So we:
//   1. seed it with the first bar of the built-in groove (which already follows your rhythm),
//   2. ask for a few different continuations,
//   3. keep the one that lines up best with where your hummed notes start.

import { accentFor, onsetProfile } from '../music/drums.js';

const MAGENTA_URL = 'https://cdn.jsdelivr.net/npm/@magenta/music@1.23.1';
const CHECKPOINT = 'https://storage.googleapis.com/magentadata/js/checkpoints/music_rnn/drum_kit_rnn';

// Our kit voices to and from the General MIDI drum notes DrumsRNN uses
const TO_GM = { kick: 36, snare: 38, clap: 38, rim: 38, hatC: 42, hatO: 46, tomL: 45, tomM: 48, tomH: 50, crash: 49, ride: 51 };
const FROM_GM = {
  35: 'kick', 36: 'kick', 37: 'rim', 38: 'snare', 39: 'clap', 40: 'snare',
  42: 'hatC', 44: 'hatC', 46: 'hatO', 41: 'tomL', 43: 'tomL', 45: 'tomL',
  47: 'tomM', 48: 'tomM', 50: 'tomH', 49: 'crash', 52: 'crash', 55: 'crash', 57: 'crash', 51: 'ride', 53: 'ride', 59: 'ride',
};

let modelPromise = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`Could not load ${src}`));
    document.head.appendChild(s);
  });
}

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]);
}

export function loadDrumModel() {
  if (!modelPromise) {
    modelPromise = (async () => {
      if (!window.mm) await loadScript(MAGENTA_URL);
      if (!window.mm?.MusicRNN) throw new Error('Magenta did not load');
      const model = new window.mm.MusicRNN(CHECKPOINT);
      await model.initialize();
      return model;
    })();
    modelPromise.catch(() => {
      modelPromise = null; // allow a retry later
    });
  }
  return withTimeout(modelPromise, 40000, 'Timed out loading the drum model');
}

function toHits(sequence, offset, totalSteps) {
  const notes = sequence?.notes || [];
  // The continuation normally starts counting at 0; handle absolute step numbers too
  const absolute = notes.length > 0 && notes.every((n) => (n.quantizedStartStep || 0) >= offset);
  const hits = [];
  for (const n of notes) {
    const voice = FROM_GM[n.pitch];
    const step = (n.quantizedStartStep || 0) + (absolute ? 0 : offset);
    if (!voice || step < offset || step >= totalSteps) continue;
    hits.push({ step, voice, vel: accentFor(voice, step) * (voice === 'snare' && step % 8 !== 4 ? 0.5 : 1) });
  }
  return hits;
}

// Rewards kicks and snares that land where the melody starts notes, a backbeat in every bar,
// and a sensible amount of activity.
function grooveFit(hits, onset, bars) {
  let score = 0;
  for (const h of hits) {
    if ((h.voice === 'kick' || h.voice === 'snare') && onset[h.step] > 0) score += onset[h.step];
  }
  for (let b = 1; b < bars; b++) {
    const bar = hits.filter((h) => h.step >= b * 16 && h.step < (b + 1) * 16);
    if (bar.some((h) => h.voice === 'snare' && (h.step % 16 === 4 || h.step % 16 === 12))) score += 1;
    if (bar.some((h) => h.voice === 'kick' && h.step % 16 === 0)) score += 1;
    if (bar.length > 28 || bar.length < 6) score -= 2;
  }
  return score;
}

export async function generateNeuralDrums({ seedHits, bars, melody, creativity = 0.5, candidates = 3 }) {
  const model = await loadDrumModel();
  const total = bars * 16;
  const seedSteps = bars === 1 ? 8 : 16;
  const seed = seedHits.filter((h) => h.step < seedSteps);
  const sequence = {
    notes: seed.map((h) => ({
      pitch: TO_GM[h.voice] ?? 38,
      quantizedStartStep: h.step,
      quantizedEndStep: h.step + 1,
      isDrum: true,
      velocity: Math.round(h.vel * 127),
    })),
    quantizationInfo: { stepsPerQuarter: 4 },
    totalQuantizedSteps: seedSteps,
  };
  const temperature = 0.85 + 0.6 * creativity;
  const onset = onsetProfile(melody, total);

  let best = null;
  for (let i = 0; i < candidates; i++) {
    const out = await model.continueSequence(sequence, total - seedSteps, temperature);
    const hits = toHits(out, seedSteps, total);
    const score = grooveFit(hits, onset, bars);
    if (!best || score > best.score) best = { hits, score };
  }
  if (!best || best.hits.length === 0) throw new Error('The drum model returned an empty pattern');
  return [...seed, ...best.hits].sort((a, b) => a.step - b.step);
}
