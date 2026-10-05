// Run with `npm test` (Node 18+). Everything here runs without a browser.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { analyzeHum, placeOnGrid } from '../src/analysis/pipeline.js';
import { ANALYSIS_RATE, createPitchDetector } from '../src/analysis/pitch.js';
import { freqToMidi } from '../src/analysis/dsp.js';
import { DEMO_TUNE, synthesizeHum } from '../src/demo-hum.js';
import { detectKey, scalePcs } from '../src/music/theory.js';
import { buildArrangement } from '../src/music/arrange.js';
import { STYLE_ORDER } from '../src/music/styles.js';
import { songToMidi } from '../src/io/midi.js';

const SR = 48000;

// A second tune: A minor, starts with a pickup, has repeated notes and a low ending.
const MINOR_TUNE = {
  notes: [
    [-2, 2, 64],
    [0, 2, 69], [2, 2, 69], [4, 2, 72], [6, 2, 71], [8, 4, 69], [12, 2, 67], [14, 2, 64],
    [16, 6, 65], [22, 2, 64], [24, 2, 62], [26, 2, 64], [28, 4, 60],
    [32, 2, 62], [34, 2, 62], [36, 2, 65], [38, 2, 64], [40, 4, 62], [44, 2, 60], [46, 2, 59],
    [48, 8, 57],
  ],
};

function matchRate(melody, truth, { transpose = 0, total = 64 } = {}) {
  let hits = 0;
  for (const [step, , pitch] of truth) {
    const s = (step + total) % total;
    if (melody.some((n) => n.step === s && Math.round(n.pitch) === pitch + transpose)) hits++;
  }
  return hits / truth.length;
}

test('YIN finds the pitch of harmonic tones across the vocal range', () => {
  const det = createPitchDetector({ sampleRate: ANALYSIS_RATE });
  for (const f of [82.4, 110, 196, 261.63, 440, 880]) {
    const x = new Float32Array(ANALYSIS_RATE * 0.2);
    for (let i = 0; i < x.length; i++) {
      const t = i / ANALYSIS_RATE;
      x[i] = 0.5 * Math.sin(2 * Math.PI * f * t) + 0.3 * Math.sin(4 * Math.PI * f * t) + 0.1 * Math.sin(6 * Math.PI * f * t);
    }
    const r = det.detect(x, 200);
    assert.ok(Math.abs(freqToMidi(r.freq) - freqToMidi(f)) < 0.1, `expected ${f} Hz, got ${r.freq.toFixed(1)} Hz`);
    assert.ok(r.aperiodicity < 0.1);
  }
});

test('YIN calls white noise unpitched', () => {
  const det = createPitchDetector({ sampleRate: ANALYSIS_RATE });
  const x = new Float32Array(ANALYSIS_RATE * 0.2).map(() => Math.random() * 2 - 1);
  assert.ok(det.detect(x, 0).aperiodicity > 0.3);
});

test('sample hum transcribes back to the tune with a metronome', () => {
  const audio = synthesizeHum({ sampleRate: SR, leadIn: 0.6 });
  const res = analyzeHum(audio, SR, { mode: 'metronome', bpm: DEMO_TUNE.bpm, bars: DEMO_TUNE.bars, origin: 0.6 });
  assert.equal(matchRate(res.melody, DEMO_TUNE.notes), 1);
  assert.ok(Math.abs(res.tuning + 0.22) < 0.08, `tuning offset ${res.tuning}`);
});

test('a low (one octave down) hum transcribes in the right octave', () => {
  const audio = synthesizeHum({ sampleRate: SR, leadIn: 0.6, transpose: -12, seed: 3 });
  const res = analyzeHum(audio, SR, { mode: 'metronome', bpm: 100, bars: 4, origin: 0.6 });
  assert.ok(matchRate(res.melody, DEMO_TUNE.notes, { transpose: -12 }) >= 0.95);
});

test('free mode finds tempo and downbeat without a metronome', () => {
  // Double/half time is a real ambiguity (the app offers 1/2x and 2x buttons), so an octave
  // error counts as recoverable as long as forcing the right tempo fixes the melody.
  let exact = 0;
  for (const bpm of [76, 88, 104, 120, 136]) {
    const audio = synthesizeHum({ sampleRate: SR, leadIn: 0.9, bpm, seed: bpm });
    let res = analyzeHum(audio, SR, { mode: 'free' });
    const ratio = res.bpm / bpm;
    if (Math.abs(ratio - 1) < 0.03) exact++;
    else {
      assert.ok(Math.abs(ratio - 2) < 0.06 || Math.abs(ratio - 0.5) < 0.015, `wanted ${bpm} BPM, got ${res.bpm}`);
      res = { ...res, ...placeOnGrid(res.notes, { mode: 'free', forceBpm: res.bpm / ratio }) };
    }
    assert.equal(res.bars, 4, `bars at ${bpm} BPM`);
    assert.ok(matchRate(res.melody, DEMO_TUNE.notes) >= 0.9, `melody at ${bpm} BPM`);
  }
  assert.ok(exact >= 4, `only ${exact} of 5 tempos were exact`);
});

test('pickup notes wrap to the end of the loop', () => {
  const audio = synthesizeHum({ notes: MINOR_TUNE.notes, bpm: 96, sampleRate: SR, leadIn: 1.0, seed: 21 });
  const origin = 1.0;
  const res = analyzeHum(audio, SR, { mode: 'metronome', bpm: 96, bars: 4, origin });
  assert.ok(matchRate(res.melody, MINOR_TUNE.notes) >= 0.9, 'metronome minor tune');
  assert.ok(res.melody.some((n) => n.step === 62 && Math.round(n.pitch) === 64), 'pickup wrapped to step 62');
});

test('copes with sloppy timing, a noisy room and legato repeated notes', () => {
  const audio = synthesizeHum({
    notes: MINOR_TUNE.notes, bpm: 90, sampleRate: SR, leadIn: 1.0, seed: 5, jitter: 0.03, noise: 0.02, tuning: 0.31,
  });
  const res = analyzeHum(audio, SR, { mode: 'metronome', bpm: 90, bars: 4, origin: 1.0 });
  assert.ok(matchRate(res.melody, MINOR_TUNE.notes) >= 0.85, `got ${matchRate(res.melody, MINOR_TUNE.notes)}`);
});

test('key detection reads the two tunes correctly', () => {
  const asNotes = (tune) => tune.notes.map(([step, dur, pitch]) => ({ step, dur, pitch, vel: 1 }));
  assert.deepEqual(
    (({ tonic, mode }) => ({ tonic, mode }))(detectKey(asNotes(DEMO_TUNE))),
    { tonic: 0, mode: 'major' },
  );
  assert.deepEqual(
    (({ tonic, mode }) => ({ tonic, mode }))(detectKey(asNotes(MINOR_TUNE))),
    { tonic: 9, mode: 'minor' },
  );
});

test('every style produces a sane, in-key arrangement', () => {
  const melody = DEMO_TUNE.notes.map(([step, dur, pitch]) => ({ step, dur, pitch: pitch + 0.1, vel: 0.8 }));
  for (const style of STYLE_ORDER) {
    const song = buildArrangement({ melody, bpm: 100, bars: 4 }, { style, creativity: 0.6, seeds: { chords: 4, drums: 5, bass: 6 } });
    const pcs = scalePcs(song.key);
    assert.equal(song.chords.length, 4, style);
    assert.ok(song.chords.every((c) => pcs.has(c.root)), `${style} chords stay diatonic`);
    assert.ok(song.drums.length > 20, `${style} has drums`);
    assert.ok(song.drums.every((d) => d.step >= 0 && d.step < song.steps));
    assert.ok(song.bass.length >= 4 && song.bass.every((n) => n.pitch >= 28 && n.pitch <= 64), `${style} bass range`);
    assert.ok(song.bass.every((n) => n.dur >= 1 && n.step + n.dur <= song.steps + 2));
    assert.ok(song.keys.every((k) => k.pitches.length >= 3));
  }
});

test('chords are deterministic at zero creativity and vary when regenerated', () => {
  const melody = DEMO_TUNE.notes.map(([step, dur, pitch]) => ({ step, dur, pitch, vel: 0.8 }));
  const a = buildArrangement({ melody, bpm: 100, bars: 4 }, { creativity: 0, seeds: { chords: 1, drums: 1, bass: 1 } });
  const b = buildArrangement({ melody, bpm: 100, bars: 4 }, { creativity: 0, seeds: { chords: 99, drums: 1, bass: 1 } });
  assert.deepEqual(a.chords.map((c) => c.symbol), b.chords.map((c) => c.symbol));
  assert.equal(a.chords[0].symbol, 'C');

  const progressions = new Set();
  const grooves = new Set();
  for (let seed = 1; seed <= 12; seed++) {
    const s = buildArrangement({ melody, bpm: 100, bars: 4 }, { creativity: 1, seeds: { chords: seed, drums: seed, bass: seed } });
    progressions.add(s.chords.map((c) => c.symbol).join(' '));
    grooves.add(s.drums.map((d) => `${d.step}${d.voice}`).join(','));
  }
  assert.ok(progressions.size >= 3, `only ${progressions.size} progressions`);
  assert.ok(grooves.size >= 10);
});

test('MIDI export is a valid type-1 file with every note', () => {
  const melody = DEMO_TUNE.notes.map(([step, dur, pitch]) => ({ step, dur, pitch, vel: 0.8 }));
  const song = buildArrangement({ melody, bpm: 100, bars: 4 }, { style: 'lofi' });
  const bytes = songToMidi(song, { lead: 'synth', leadOctave: 1 });
  const str = (o, n) => String.fromCharCode(...bytes.slice(o, o + n));
  assert.equal(str(0, 4), 'MThd');
  const view = new DataView(bytes.buffer);
  assert.equal(view.getUint16(8), 1);
  assert.equal(view.getUint16(10), 5);

  // Walk the tracks and count note-ons per track
  let o = 14;
  const noteOns = [];
  while (o < bytes.length) {
    assert.equal(str(o, 4), 'MTrk');
    const len = view.getUint32(o + 4);
    const end = o + 8 + len;
    let p = o + 8;
    let count = 0;
    let status = 0;
    while (p < end) {
      while (bytes[p] & 0x80) p++; // delta time
      p++;
      if (bytes[p] === 0xff) {
        p += 2;
        let l = 0;
        while (bytes[p] & 0x80) l = (l << 7) | (bytes[p++] & 0x7f);
        l = (l << 7) | bytes[p++];
        p += l;
        continue;
      }
      status = bytes[p++];
      const type = status & 0xf0;
      if (type === 0x90 && bytes[p + 1] > 0) count++;
      p += type === 0xc0 || type === 0xd0 ? 1 : 2;
    }
    assert.equal(p, end, 'track length matches its contents');
    noteOns.push(count);
    o = end;
  }
  assert.equal(noteOns[1], song.melody.length);
  assert.equal(noteOns[2], song.keys.reduce((s, k) => s + k.pitches.length, 0));
  assert.equal(noteOns[3], song.bass.length);
  assert.equal(noteOns[4], song.drums.length);
});
