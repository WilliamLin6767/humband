// Standard MIDI File (type 1) export, so the arrangement can be opened in any DAW.

import { usesFlats } from '../music/theory.js';
import { STYLES } from '../music/styles.js';

const PPQ = 480;
const TICKS_PER_STEP = PPQ / 4;

// General MIDI programs (zero-based) closest to each built-in instrument
const GM_PROGRAM = {
  synth: 81, piano: 0, flute: 73, pluck: 12,
  ep: 4, pad: 89, stab: 16, power: 29,
  bass: 38, 808: 38,
};
const GM_DRUM = { kick: 36, rim: 37, snare: 38, clap: 39, hatC: 42, tomL: 45, hatO: 46, tomM: 47, crash: 49, tomH: 50, ride: 51 };

function vlq(n) {
  const bytes = [n & 0x7f];
  let v = n >> 7;
  while (v > 0) {
    bytes.unshift((v & 0x7f) | 0x80);
    v >>= 7;
  }
  return bytes;
}
const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const u16 = (n) => [(n >> 8) & 255, n & 255];
const text = (type, s) => {
  const bytes = [...new TextEncoder().encode(s)];
  return [0xff, type, ...vlq(bytes.length), ...bytes];
};

function chunk(events) {
  // note-offs (order 1) before note-ons (order 2) on the same tick
  events.sort((a, b) => a.tick - b.tick || a.order - b.order);
  const body = [];
  let last = 0;
  for (const e of events) {
    body.push(...vlq(e.tick - last), ...e.data);
    last = e.tick;
  }
  body.push(0x00, 0xff, 0x2f, 0x00);
  return [0x4d, 0x54, 0x72, 0x6b, ...u32(body.length), ...body];
}

function keySignature(key) {
  const majorTonic = key.mode === 'major' ? key.tonic : (key.tonic + 3) % 12;
  let sf = (majorTonic * 7) % 12;
  if (sf > 6 || (sf === 6 && usesFlats(key))) sf -= 12;
  return [0xff, 0x59, 0x02, sf & 0xff, key.mode === 'minor' ? 1 : 0];
}

function noteTrack(name, channel, program, notes) {
  const ev = [
    { tick: 0, order: 0, data: text(0x03, name) },
    { tick: 0, order: 0, data: [0xc0 | channel, program] },
  ];
  for (const n of notes) {
    const vel = Math.max(1, Math.min(127, Math.round(n.vel * 110 + 10)));
    const on = n.step * TICKS_PER_STEP;
    const off = (n.step + n.dur) * TICKS_PER_STEP;
    for (const p of n.pitches) {
      ev.push({ tick: on, order: 2, data: [0x90 | channel, p, vel] });
      ev.push({ tick: off, order: 1, data: [0x80 | channel, p, 0] });
    }
  }
  return chunk(ev);
}

export function songToMidi(song, { lead = 'synth', leadOctave = 0 } = {}) {
  const st = STYLES[song.style];
  const conductor = chunk([
    { tick: 0, order: 0, data: text(0x03, 'HumBand') },
    { tick: 0, order: 0, data: [0xff, 0x51, 0x03, ...u32(Math.round(60000000 / song.bpm)).slice(1)] },
    { tick: 0, order: 0, data: [0xff, 0x58, 0x04, 0x04, 0x02, 0x18, 0x08] },
    { tick: 0, order: 0, data: keySignature(song.key) },
  ]);
  const melody = noteTrack(
    'Melody', 0, GM_PROGRAM[lead] ?? 0,
    song.melody.map((n) => ({ ...n, pitches: [n.pitch + 12 * leadOctave] })),
  );
  const keys = noteTrack('Chords', 1, GM_PROGRAM[st.keys.instrument] ?? 0, song.keys);
  const bass = noteTrack('Bass', 2, GM_PROGRAM[st.bass.instrument] ?? 38, song.bass.map((n) => ({ ...n, pitches: [n.pitch] })));
  const drums = noteTrack(
    'Drums', 9, 0,
    song.drums.map((h) => ({ step: h.step, dur: 1, vel: h.vel, pitches: [GM_DRUM[h.voice] ?? 38] })),
  );
  const tracks = [conductor, melody, keys, bass, drums];
  const header = [0x4d, 0x54, 0x68, 0x64, ...u32(6), ...u16(1), ...u16(tracks.length), ...u16(PPQ)];
  return new Uint8Array([...header, ...tracks.flat()]);
}
