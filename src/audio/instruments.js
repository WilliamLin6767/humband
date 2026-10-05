// Every sound in HumBand is synthesized live with the Web Audio API. There are no samples to load.

export const TRACKS = ['hum', 'melody', 'chords', 'bass', 'drums'];
const REVERB_SEND = { hum: 0.04, melody: 0.3, chords: 0.28, bass: 0, drums: 0.1 };

export class Engine {
  constructor(ctx) {
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0.8;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.knee.value = 8;
    comp.ratio.value = 3.5;
    comp.attack.value = 0.004;
    comp.release.value = 0.2;
    this.master.connect(comp).connect(ctx.destination);

    this.reverb = ctx.createConvolver();
    this.reverb.buffer = makeImpulse(ctx, 2.2, 3);
    const ret = ctx.createGain();
    ret.gain.value = 0.35;
    this.reverb.connect(ret).connect(this.master);

    // One persistent channel per track (volume and mute live here), with a post-fader reverb send
    this.channels = {};
    for (const t of TRACKS) {
      const ch = ctx.createGain();
      ch.connect(this.master);
      const send = ctx.createGain();
      send.gain.value = REVERB_SEND[t];
      ch.connect(send).connect(this.reverb);
      this.channels[t] = ch;
    }

    this.noise = makeNoise(ctx, 2);
    this.drive = makeCurve((x) => Math.tanh(3 * x));
    this.warm = makeCurve((x) => Math.tanh(1.6 * x));
  }

  setChannel(track, volume, muted, immediate = false) {
    const v = muted ? 0 : volume;
    const p = this.channels[track].gain;
    if (immediate) p.value = v;
    else p.setTargetAtTime(v, this.ctx.currentTime, 0.02);
  }

  // A session is one run of the transport. Stopping closes it, which silences any notes that
  // were already scheduled a little way into the future.
  createSession() {
    const bus = {};
    for (const t of TRACKS) {
      bus[t] = this.ctx.createGain();
      bus[t].connect(this.channels[t]);
    }
    const ctx = this.ctx;
    return {
      bus,
      close() {
        for (const t of TRACKS) {
          bus[t].gain.setTargetAtTime(0, ctx.currentTime, 0.015);
          setTimeout(() => bus[t].disconnect(), 150);
        }
      },
    };
  }
}

function makeNoise(ctx, seconds) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const b = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = b.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  return b;
}

function makeImpulse(ctx, seconds, decay) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const b = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = b.getChannelData(c);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
  }
  return b;
}

function makeCurve(fn, n = 1024) {
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) c[i] = fn((i / (n - 1)) * 2 - 1);
  return c;
}

function osc(ctx, type, freq, t, stop, dest, detune = 0) {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.value = freq;
  o.detune.value = detune;
  o.connect(dest);
  o.start(t);
  o.stop(stop);
  return o;
}

// Attack, decay to sustain, release. Returns the time it is safe to stop the oscillators.
function env(param, t, dur, { a = 0.01, d = 0.2, s = 0.7, r = 0.15, peak = 1 }) {
  param.setValueAtTime(0, t);
  param.linearRampToValueAtTime(peak, t + a);
  param.setTargetAtTime(peak * s, t + a, d / 3);
  const end = t + Math.max(dur, a + 0.01);
  param.setTargetAtTime(0, end, r / 3);
  return end + r * 1.6;
}

// ---------- Lead instruments (the melody you hummed) ----------

function synthLead(ctx, out, { freq, t, dur, vel }) {
  const g = ctx.createGain();
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.Q.value = 2.5;
  lp.frequency.setValueAtTime(freq * 1.5, t);
  lp.frequency.linearRampToValueAtTime(Math.min(freq * 9, 11000), t + 0.02);
  lp.frequency.setTargetAtTime(Math.max(freq * 3, 900), t + 0.02, 0.15);
  lp.connect(g).connect(out);
  const stop = env(g.gain, t, dur, { a: 0.012, d: 0.25, s: 0.75, r: 0.12, peak: 0.14 * vel });

  const depth = ctx.createGain(); // delayed vibrato, in cents
  depth.gain.setValueAtTime(0, t);
  depth.gain.setValueAtTime(0, t + 0.25);
  depth.gain.linearRampToValueAtTime(10, t + 0.6);
  osc(ctx, 'sine', 5.2, t, stop, depth);
  for (const det of [-6, 6]) depth.connect(osc(ctx, 'sawtooth', freq, t, stop, lp, det).detune);
  const sub = ctx.createGain();
  sub.gain.value = 0.3;
  sub.connect(lp);
  osc(ctx, 'square', freq / 2, t, stop, sub);
}

function piano(ctx, out, { freq, t, dur, vel }) {
  const g = ctx.createGain();
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = Math.min(9000, freq * 6 + 800);
  g.connect(lp).connect(out);
  const stop = t + dur + 0.5;
  g.gain.setValueAtTime(0.24 * vel, t);
  g.gain.setTargetAtTime(0, t + dur, 0.08);
  [1, 0.45, 0.22, 0.12, 0.06].forEach((amp, i) => {
    const h = i + 1;
    const pg = ctx.createGain();
    pg.gain.setValueAtTime(0, t);
    pg.gain.linearRampToValueAtTime(amp, t + 0.004);
    pg.gain.setTargetAtTime(0, t + 0.004, 1.4 / Math.pow(h, 0.8) / 3); // upper partials die away faster
    pg.connect(g);
    osc(ctx, 'sine', freq * h * (1 + 0.0005 * h * h), t, stop, pg);
  });
}

function flute(ctx, out, { freq, t, dur, vel, engine }) {
  const g = ctx.createGain();
  g.connect(out);
  const stop = env(g.gain, t, dur, { a: 0.05, d: 0.2, s: 0.85, r: 0.12, peak: 0.17 * vel });
  const depth = ctx.createGain();
  depth.gain.setValueAtTime(0, t);
  depth.gain.linearRampToValueAtTime(12, t + 0.5);
  osc(ctx, 'sine', 4.8, t, stop, depth);
  depth.connect(osc(ctx, 'sine', freq, t, stop, g).detune);
  const h2 = ctx.createGain();
  h2.gain.value = 0.12;
  h2.connect(g);
  depth.connect(osc(ctx, 'sine', freq * 2, t, stop, h2).detune);
  const breath = ctx.createBufferSource();
  breath.buffer = engine.noise;
  breath.loop = true;
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = Math.min(freq * 2, 8000);
  bp.Q.value = 2;
  const bg = ctx.createGain();
  bg.gain.value = 0.08;
  breath.connect(bp).connect(bg).connect(g);
  breath.start(t, Math.random());
  breath.stop(stop);
}

function pluck(ctx, out, { freq, t, dur, vel }) {
  const g = ctx.createGain();
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.setValueAtTime(freq * 8, t);
  lp.frequency.setTargetAtTime(freq * 2, t, 0.15);
  lp.connect(g).connect(out);
  const ring = Math.min(dur, 1.5);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.3 * vel, t + 0.003);
  g.gain.setTargetAtTime(0, t + 0.003, 0.22);
  g.gain.setTargetAtTime(0, t + ring, 0.05);
  const stop = t + ring + 0.3;
  osc(ctx, 'triangle', freq, t, stop, lp);
  const bell = ctx.createGain();
  bell.gain.setValueAtTime(0.25, t);
  bell.gain.setTargetAtTime(0, t, 0.03);
  bell.connect(lp);
  osc(ctx, 'sine', freq * 4, t, stop, bell);
}

// ---------- Keys (chords) ----------

function ep(ctx, out, { freq, t, dur, vel }) {
  // Two-operator FM electric piano, plus a short high "tine" for the bark of the attack
  const stop = t + dur + 0.6;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.22 * vel, t + 0.005);
  g.gain.setTargetAtTime(0, t + 0.005, 0.9);
  g.gain.setTargetAtTime(0, t + dur, 0.1);
  g.connect(out);
  const carrier = osc(ctx, 'sine', freq, t, stop, g);
  const index = ctx.createGain();
  index.gain.setValueAtTime(freq * (1 + vel), t);
  index.gain.setTargetAtTime(freq * 0.2, t, 0.3);
  index.connect(carrier.frequency);
  osc(ctx, 'sine', freq, t, stop, index);
  const tine = ctx.createGain();
  tine.gain.setValueAtTime(freq * 0.5 * vel, t);
  tine.gain.setTargetAtTime(0, t, 0.025);
  tine.connect(carrier.frequency);
  osc(ctx, 'sine', freq * 14, t, stop, tine);
}

function pad(ctx, out, { freq, t, dur, vel }) {
  const g = ctx.createGain();
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = Math.min(2400, freq * 4);
  lp.Q.value = 0.5;
  lp.connect(g).connect(out);
  const stop = env(g.gain, t, dur, { a: 0.2, d: 0.4, s: 0.85, r: 0.5, peak: 0.07 * vel });
  osc(ctx, 'sawtooth', freq, t, stop, lp, -8);
  osc(ctx, 'sawtooth', freq, t, stop, lp, 8);
  osc(ctx, 'triangle', freq / 2, t, stop, lp);
}

function stab(ctx, out, { freq, t, dur, vel }) {
  const g = ctx.createGain();
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.setValueAtTime(freq * 8, t);
  lp.frequency.setTargetAtTime(freq * 2.5, t, 0.08);
  lp.connect(g).connect(out);
  const stop = env(g.gain, t, dur, { a: 0.003, d: 0.15, s: 0.4, r: 0.08, peak: 0.3 * vel });
  for (const [h, type, amp] of [[1, 'square', 0.4], [2, 'sine', 0.35], [3, 'sine', 0.2]]) {
    const a = ctx.createGain();
    a.gain.value = amp;
    a.connect(lp);
    osc(ctx, type, freq * h, t, stop, a);
  }
}

function power(ctx, out, { freq, t, dur, vel, engine }) {
  const pre = ctx.createGain();
  pre.gain.value = 2;
  const shaper = ctx.createWaveShaper();
  shaper.curve = engine.drive;
  shaper.oversample = '2x';
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 2400;
  lp.Q.value = 0.7;
  const g = ctx.createGain();
  pre.connect(shaper).connect(lp).connect(g).connect(out);
  const stop = env(g.gain, t, dur, { a: 0.004, d: 0.16, s: 0.45, r: 0.06, peak: 0.12 * vel });
  osc(ctx, 'sawtooth', freq, t, stop, pre, -5);
  osc(ctx, 'sawtooth', freq, t, stop, pre, 5);
}

// ---------- Bass ----------

function synthBass(ctx, out, { freq, t, dur, vel }) {
  const g = ctx.createGain();
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.Q.value = 3;
  lp.frequency.setValueAtTime(freq * 7, t);
  lp.frequency.setTargetAtTime(freq * 2.5, t, 0.07);
  lp.connect(g).connect(out);
  const stop = env(g.gain, t, dur * 0.95, { a: 0.004, d: 0.25, s: 0.7, r: 0.05, peak: 0.17 * vel });
  osc(ctx, 'sawtooth', freq, t, stop, lp);
  const sub = ctx.createGain();
  sub.gain.value = 0.8;
  sub.connect(g);
  osc(ctx, 'sine', freq, t, stop, sub);
}

function bass808(ctx, out, { freq, t, dur, vel, engine }) {
  const g = ctx.createGain();
  const shaper = ctx.createWaveShaper();
  shaper.curve = engine.warm; // saturation adds harmonics so the sub is audible on laptop speakers
  const pre = ctx.createGain();
  pre.gain.value = 1.6;
  pre.connect(shaper).connect(g).connect(out);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.26 * vel, t + 0.004);
  g.gain.setTargetAtTime(0, t + 0.004, 0.45);
  g.gain.setTargetAtTime(0, t + Math.max(dur, 0.02), 0.04);
  const o = osc(ctx, 'sine', freq, t, t + dur + 0.3, pre);
  o.frequency.setValueAtTime(freq * 2, t);
  o.frequency.exponentialRampToValueAtTime(freq, t + 0.05);
}

// ---------- Drums ----------

const KITS = {
  tight: { kick: [160, 48, 0.32], snare: [200, 0.15], hat: 0.04, tone: 1 },
  dusty: { kick: [120, 45, 0.36], snare: [180, 0.18], hat: 0.05, tone: 0.6 },
  boom: { kick: [140, 43, 0.5], snare: [190, 0.2], hat: 0.045, tone: 0.85 },
  room: { kick: [150, 50, 0.36], snare: [210, 0.24], hat: 0.06, tone: 1 },
};

function noiseHit(ctx, out, engine, t, { type = 'highpass', freq = 6000, q = 0.7, decay = 0.05, gain = 0.3, attack = 0.001 }) {
  const src = ctx.createBufferSource();
  src.buffer = engine.noise;
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(Math.max(gain, 0.0002), t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  src.connect(f).connect(g).connect(out);
  src.start(t, Math.random() * (engine.noise.duration - 0.5));
  src.stop(t + attack + decay + 0.05);
}

function drop(ctx, out, t, { from, to, sweep = 0.08, decay = 0.3, gain = 0.8, type = 'sine' }) {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(from, t);
  o.frequency.exponentialRampToValueAtTime(to, t + sweep);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(Math.max(gain, 0.0002), t + 0.003);
  g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
  o.connect(g).connect(out);
  o.start(t);
  o.stop(t + decay + 0.05);
}

export function playDrum(ctx, out, voice, t, vel, engine, kitName = 'tight') {
  const kit = KITS[kitName] || KITS.tight;
  const b = kit.tone;
  switch (voice) {
    case 'kick':
      drop(ctx, out, t, { from: kit.kick[0], to: kit.kick[1], sweep: 0.09, decay: kit.kick[2], gain: 0.9 * vel });
      noiseHit(ctx, out, engine, t, { freq: 2500 * b, decay: 0.006, gain: 0.15 * vel });
      break;
    case 'snare':
      drop(ctx, out, t, { from: kit.snare[0] * 1.4, to: kit.snare[0], sweep: 0.03, decay: 0.1, gain: 0.35 * vel, type: 'triangle' });
      noiseHit(ctx, out, engine, t, { type: 'bandpass', freq: 1800 * b, decay: kit.snare[1], gain: 0.5 * vel });
      noiseHit(ctx, out, engine, t, { freq: 5000 * b, decay: kit.snare[1] * 0.6, gain: 0.22 * vel });
      break;
    case 'clap':
      for (const d of [0, 0.011, 0.022]) {
        noiseHit(ctx, out, engine, t + d, { type: 'bandpass', freq: 1150 * b, q: 1.3, decay: 0.012, gain: 0.45 * vel });
      }
      noiseHit(ctx, out, engine, t + 0.03, { type: 'bandpass', freq: 1150 * b, q: 1.1, decay: 0.15, gain: 0.35 * vel });
      break;
    case 'rim':
      drop(ctx, out, t, { from: 1700, to: 1600, sweep: 0.01, decay: 0.035, gain: 0.3 * vel, type: 'square' });
      break;
    case 'hatC':
      noiseHit(ctx, out, engine, t, { freq: 7500 * b, decay: kit.hat, gain: 0.25 * vel });
      break;
    case 'hatO':
      noiseHit(ctx, out, engine, t, { freq: 7000 * b, decay: 0.3, gain: 0.2 * vel });
      break;
    case 'tomL':
    case 'tomM':
    case 'tomH': {
      const f = { tomL: 98, tomM: 130, tomH: 175 }[voice];
      drop(ctx, out, t, { from: f * 1.6, to: f, sweep: 0.12, decay: 0.35, gain: 0.7 * vel });
      break;
    }
    case 'crash':
      noiseHit(ctx, out, engine, t, { freq: 3500 * b, decay: 1.5, gain: 0.22 * vel, attack: 0.002 });
      noiseHit(ctx, out, engine, t, { type: 'bandpass', freq: 6000 * b, q: 0.8, decay: 0.8, gain: 0.12 * vel });
      break;
    case 'ride':
      noiseHit(ctx, out, engine, t, { type: 'bandpass', freq: 6500 * b, q: 1.5, decay: 0.7, gain: 0.12 * vel });
      break;
    default:
      break;
  }
}

export function playClick(ctx, t, accent) {
  const o = ctx.createOscillator();
  o.type = 'square';
  o.frequency.value = accent ? 1760 : 1320;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(accent ? 0.22 : 0.13, t + 0.002);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
  o.connect(g).connect(ctx.destination);
  o.start(t);
  o.stop(t + 0.06);
  return o;
}

export const LEAD_INSTRUMENTS = {
  synth: { label: 'Synth lead', play: synthLead },
  piano: { label: 'Piano', play: piano },
  flute: { label: 'Flute', play: flute },
  pluck: { label: 'Marimba', play: pluck },
};
export const KEYS_INSTRUMENTS = { piano, ep, pad, stab, power };
export const KEYS_LABELS = { piano: 'Piano', ep: 'Electric piano', pad: 'Warm pad', stab: 'Organ stabs', power: 'Power chords' };
export const BASS_INSTRUMENTS = { bass: synthBass, 808: bass808 };
