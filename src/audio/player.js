// Transport. Uses the "lookahead" pattern: a timer wakes up every 25 ms and schedules every
// note that falls in the next 120 ms on the precise audio clock, so timing never depends on
// how busy the main thread is.

import { midiToFreq } from '../analysis/dsp.js';
import { STYLES } from '../music/styles.js';
import { BASS_INSTRUMENTS, KEYS_INSTRUMENTS, LEAD_INSTRUMENTS, playDrum } from './instruments.js';

const LOOKAHEAD = 0.12;

// Swing delays every second 16th note. 0.5 is straight, 0.6 is a lazy lo-fi shuffle.
export function stepTime(step, stepDur, swing) {
  const s = Math.floor(step + 1e-6);
  return (step + (s % 2 === 1 ? (swing - 0.5) * 2 : 0)) * stepDur;
}

export function compileEvents(song, { leadOctave = 0 } = {}) {
  const stepDur = 60 / song.bpm / 4;
  const at = (step) => stepTime(step, stepDur, song.swing);
  const events = [];
  for (const n of song.melody) {
    events.push({ time: at(n.step), dur: n.dur * stepDur, kind: 'lead', pitch: n.pitch + 12 * leadOctave, vel: n.vel });
  }
  for (const k of song.keys) events.push({ time: at(k.step), dur: k.dur * stepDur, kind: 'keys', pitches: k.pitches, vel: k.vel });
  for (const n of song.bass) events.push({ time: at(n.step), dur: n.dur * stepDur, kind: 'bass', pitch: n.pitch, vel: n.vel });
  for (const d of song.drums) events.push({ time: at(d.step), kind: 'drum', voice: d.voice, vel: d.vel });
  events.sort((a, b) => a.time - b.time);
  return { events, loopDur: song.steps * stepDur, stepDur };
}

export function triggerEvent(engine, session, ev, t, song, settings) {
  const ctx = engine.ctx;
  const style = STYLES[song.style];
  if (ev.kind === 'lead') {
    const inst = LEAD_INSTRUMENTS[settings.lead] || LEAD_INSTRUMENTS.synth;
    inst.play(ctx, session.bus.melody, { freq: midiToFreq(ev.pitch), t, dur: ev.dur, vel: ev.vel, engine });
  } else if (ev.kind === 'keys') {
    const play = KEYS_INSTRUMENTS[style.keys.instrument];
    for (const p of ev.pitches) play(ctx, session.bus.chords, { freq: midiToFreq(p), t, dur: ev.dur, vel: ev.vel, engine });
  } else if (ev.kind === 'bass') {
    BASS_INSTRUMENTS[style.bass.instrument](ctx, session.bus.bass, { freq: midiToFreq(ev.pitch), t, dur: ev.dur, vel: ev.vel, engine });
  } else if (ev.kind === 'drum') {
    playDrum(ctx, session.bus.drums, ev.voice, t, ev.vel, engine, style.drums.kit);
  }
}

export class Player {
  constructor(engine) {
    this.engine = engine;
    this.ctx = engine.ctx;
    this.playing = false;
    this.compiled = null;
  }

  load(song, settings, humBuffer) {
    const restart = this.playing && this.song && (song.bpm !== this.song.bpm || song.steps !== this.song.steps);
    this.song = song;
    this.settings = settings;
    this.humBuffer = humBuffer;
    this.compiled = compileEvents(song, settings);
    if (restart) {
      this.stop();
      this.start();
    }
  }

  start() {
    if (!this.compiled || this.playing) return;
    this.session = this.engine.createSession();
    this.startTime = this.ctx.currentTime + 0.06;
    this.scheduledUntil = this.startTime;
    this.playing = true;
    this.tick();
    this.timer = setInterval(() => this.tick(), 25);
  }

  stop() {
    if (!this.playing) return;
    clearInterval(this.timer);
    this.playing = false;
    this.session.close();
    this.session = null;
  }

  tick() {
    const { events, loopDur } = this.compiled;
    // If the tab was in the background we may be late: skip what we missed instead of piling it up
    const from = Math.max(this.scheduledUntil, this.ctx.currentTime - 0.01);
    const horizon = this.ctx.currentTime + LOOKAHEAD;
    if (horizon <= from) return;
    const first = Math.max(0, Math.floor((from - this.startTime) / loopDur));
    const last = Math.floor((horizon - this.startTime) / loopDur);
    for (let loop = first; loop <= last; loop++) {
      const base = this.startTime + loop * loopDur;
      if (this.humBuffer && base >= from && base < horizon) {
        const src = this.ctx.createBufferSource();
        src.buffer = this.humBuffer;
        src.connect(this.session.bus.hum);
        src.start(base, 0, Math.min(this.humBuffer.duration, loopDur));
      }
      for (const ev of events) {
        const t = base + ev.time;
        if (t >= from && t < horizon) triggerEvent(this.engine, this.session, ev, t, this.song, this.settings);
      }
    }
    this.scheduledUntil = horizon;
  }

  // Current playhead in steps, corrected for output latency so it lines up with what you hear
  get position() {
    if (!this.playing) return null;
    const elapsed = this.ctx.currentTime - (this.ctx.outputLatency || 0) - this.startTime;
    if (elapsed < 0) return 0;
    return (elapsed % this.compiled.loopDur) / this.compiled.stepDur;
  }
}
