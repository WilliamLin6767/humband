// HumBand app wiring: recording flow, arrangement controls, mixer, export.

import { analyzeHum, placeOnGrid } from './analysis/pipeline.js';
import { autoLeadOctave, buildArrangement } from './music/arrange.js';
import { STYLE_ORDER, STYLES } from './music/styles.js';
import { ALL_KEYS, keyName } from './music/theory.js';
import { mulberry32, newSeed } from './music/random.js';
import { generateDrums } from './music/drums.js';
import { Engine, KEYS_LABELS, LEAD_INSTRUMENTS, TRACKS, playClick } from './audio/instruments.js';
import { Player } from './audio/player.js';
import { Recorder } from './audio/recorder.js';
import { renderSongToWav } from './audio/render.js';
import { songToMidi } from './io/midi.js';
import { PianoRoll } from './ui/pianoroll.js';
import { LivePitch } from './ui/livepitch.js';
import { DEMO_TUNE, synthesizeHum } from './demo-hum.js';
import { generateNeuralDrums } from './ai/neural-drums.js';

const $ = (sel) => document.querySelector(sel);

const TRACK_NAMES = { hum: 'Your hum', melody: 'Melody', chords: 'Chords', bass: 'Bass', drums: 'Drums' };

const prefs = loadPrefs();
const state = {
  phase: 'idle',
  metronome: prefs.metronome ?? true,
  bpm: prefs.bpm ?? 100,
  bars: prefs.bars ?? 4,
  style: STYLES[prefs.style] ? prefs.style : 'pop',
  lead: LEAD_INSTRUMENTS[prefs.lead] ? prefs.lead : 'synth',
  creativity: 0.45,
  snap: true,
  chordsPerBar: 1,
  keyOverride: null,
  leadOctave: 0,
  beatShift: 0,
  neural: false,
  neuralHits: null,
  analysis: null,
  melodyEdits: null,
  humData: null,
  seeds: { chords: newSeed(), drums: newSeed(), bass: newSeed() },
  mixer: {
    hum: { volume: 0.8, muted: true },
    melody: { volume: 1, muted: false },
    chords: { volume: 0.7, muted: false },
    bass: { volume: 0.85, muted: false },
    drums: { volume: 0.85, muted: false },
  },
  song: null,
};
window.humband = state; // handy for poking around in the console

let ctx = null;
let engine = null;
let player = null;
let recorder = null;
let humBuffer = null;
let take = null;
let finishTimer = null;

const livePitch = new LivePitch($('#live-canvas'), $('#live-note'), $('#live-cents'));
const roll = new PianoRoll($('#roll'), {
  onEdit: (melody) => {
    state.melodyEdits = melody;
    rebuild();
  },
});

// ---------- Audio ----------

function ensureAudio() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    ctx = new AC({ latencyHint: 'interactive' });
    engine = new Engine(ctx);
    player = new Player(engine);
    for (const t of TRACKS) engine.setChannel(t, state.mixer[t].volume, state.mixer[t].muted, true);
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

// ---------- Recording ----------

const idleText = () =>
  state.metronome
    ? 'Press record. After four clicks, hum along with the beat.'
    : "Press record and hum. Press stop when you're done.";

function setPhase(phase) {
  state.phase = phase;
  document.body.dataset.phase = phase;
  const busy = phase === 'counting' || phase === 'recording';
  $('#rec-btn').setAttribute('aria-label', busy ? 'Stop recording' : 'Start recording');
  $('#rec-label').textContent = busy ? 'Stop' : phase === 'analyzing' ? 'Listening' : 'Record';
  $('#rec-btn').disabled = phase === 'analyzing';
  $('#demo-btn').disabled = phase !== 'idle' && phase !== 'ready';
}

function setStatus(text) {
  $('#rec-status').textContent = text;
}

async function startRecording() {
  ensureAudio();
  stopPlayback();
  try {
    recorder = new Recorder(ctx);
    await recorder.open();
  } catch (err) {
    recorder?.close();
    recorder = null;
    toast(micError(err));
    return;
  }
  const beat = 60 / state.bpm;
  livePitch.start(ctx.sampleRate, () => ctx.currentTime);
  recorder.onChunk = (data) => livePitch.push(data);
  recorder.start();

  if (state.metronome) {
    const t0 = ctx.currentTime + 0.3;
    const startAt = t0 + 4 * beat;
    const endAt = startAt + state.bars * 4 * beat;
    const clicks = [];
    for (let i = 0; i < 4 + state.bars * 4; i++) clicks.push(playClick(ctx, t0 + i * beat, i % 4 === 0));
    take = { mode: 'metronome', t0, startAt, endAt, beat, bars: state.bars, bpm: state.bpm, clicks };
    setPhase('counting');
    scheduleFinish();
  } else {
    take = { mode: 'free', startAt: ctx.currentTime };
    setPhase('recording');
    finishTimer = setTimeout(finishRecording, 30000);
  }
  requestAnimationFrame(updateRecordingStatus);
}

function scheduleFinish() {
  clearTimeout(finishTimer);
  const wait = take.endAt + recorder.latency() + 0.4 - ctx.currentTime;
  finishTimer = setTimeout(finishRecording, Math.max(0, wait * 1000));
}

function updateRecordingStatus() {
  if (!take) return;
  const now = ctx.currentTime;
  if (take.mode === 'metronome') {
    if (now < take.startAt) {
      const left = Math.min(4, Math.ceil((take.startAt - now) / take.beat));
      setStatus(now < take.t0 ? 'Get ready' : `Start humming in ${left}`);
    } else if (now < take.endAt) {
      if (state.phase !== 'recording') setPhase('recording');
      const bar = Math.floor((now - take.startAt) / (4 * take.beat)) + 1;
      setStatus(`Recording bar ${bar} of ${take.bars}`);
    } else {
      setStatus('Wrapping up');
    }
  } else {
    setStatus(`Recording, ${Math.floor(now - take.startAt)} seconds. Press stop when you're done.`);
  }
  requestAnimationFrame(updateRecordingStatus);
}

function stopRecording() {
  if (!take) return;
  if (take.mode === 'metronome') {
    const now = ctx.currentTime;
    if (now < take.startAt + take.beat) {
      cancelRecording();
      return;
    }
    // Keep the bars you started and stop the clicks
    take.bars = Math.max(1, Math.min(take.bars, Math.ceil((now - take.startAt) / (4 * take.beat))));
    take.endAt = take.startAt + take.bars * 4 * take.beat;
    for (const c of take.clicks) {
      try {
        c.stop();
      } catch {
        // already finished
      }
    }
    scheduleFinish();
    setStatus('Wrapping up');
    return;
  }
  finishRecording();
}

function cancelRecording() {
  clearTimeout(finishTimer);
  for (const c of take?.clicks || []) {
    try {
      c.stop();
    } catch {
      // already finished
    }
  }
  take = null;
  livePitch.stop();
  recorder?.close();
  recorder = null;
  setPhase(state.analysis ? 'ready' : 'idle');
  setStatus('Recording cancelled. ' + idleText());
}

async function finishRecording() {
  if (!take || !recorder) return;
  const t = take;
  take = null;
  clearTimeout(finishTimer);
  livePitch.stop();
  recorder.stop();
  const sr = ctx.sampleRate;
  const latency = recorder.latency();
  let samples;
  let opts;
  if (t.mode === 'metronome') {
    // Keep one beat before bar one so pickup notes survive
    const pre = t.beat;
    samples = recorder.extract(t.startAt + latency - pre, t.endAt + latency + 0.3);
    opts = { mode: 'metronome', bpm: t.bpm, bars: t.bars, origin: pre };
  } else {
    samples = recorder.extractAll();
    opts = { mode: 'free' };
  }
  recorder.close();
  recorder = null;
  await analyzeAndBuild(samples, sr, opts);
}

async function analyzeAndBuild(samples, sampleRate, opts) {
  setPhase('analyzing');
  setStatus('Listening back to your take');
  await new Promise((r) => setTimeout(r, 40)); // let the status paint before the heavy lifting
  let result;
  try {
    result = analyzeHum(samples, sampleRate, opts);
  } catch (err) {
    console.error(err);
    toast('Something went wrong analyzing that take. Try recording it again.');
    setPhase(state.analysis ? 'ready' : 'idle');
    setStatus(idleText());
    return;
  }
  if (result.melody.length < 2) {
    setPhase(state.analysis ? 'ready' : 'idle');
    setStatus(idleText());
    toast('No notes came through. Hum a little louder or closer to the mic and try again.');
    return;
  }
  state.analysis = { ...result, samples, sampleRate };
  state.melodyEdits = null;
  state.keyOverride = null;
  state.neuralHits = null;
  state.beatShift = 0;
  state.seeds = { chords: newSeed(), drums: newSeed(), bass: newSeed() };
  state.leadOctave = autoLeadOctave(result.melody);
  buildHumBuffer();
  rebuild();
  setPhase('ready');
  setStatus(idleText());
  $('#session').hidden = false;
  $('#session').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  startPlayback();
  if (state.neural) runNeural();
}

// Slice the raw take so it starts exactly on bar one, for the "Your hum" track
function buildHumBuffer() {
  const a = state.analysis;
  const from = Math.max(0, Math.round((a.origin - a.shift) * a.sampleRate));
  const len = Math.min(a.samples.length - from, Math.round(a.bars * 4 * (60 / a.bpm) * a.sampleRate));
  if (len <= 0) {
    humBuffer = null;
    state.humData = null;
    return;
  }
  const slice = a.samples.slice(from, from + len);
  humBuffer = ctx.createBuffer(1, len, a.sampleRate);
  humBuffer.copyToChannel(slice, 0);
  state.humData = { samples: slice, sampleRate: a.sampleRate };
}

function micError(err) {
  const name = err?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return "Microphone access is blocked. Allow it in your browser's site settings, or try the sample hum.";
  }
  if (name === 'NotFoundError') return 'No microphone found. Plug one in, or try the sample hum.';
  if (name === 'InsecureContextError') return 'Recording needs a secure page. Open HumBand over https or on localhost.';
  return `The microphone didn't start (${err?.message || err}). Try the sample hum instead.`;
}

// ---------- Arrangement ----------

const playSettings = () => ({ lead: state.lead, leadOctave: state.leadOctave });

function rebuild() {
  const a = state.analysis;
  if (!a) return;
  state.song = buildArrangement(
    { melody: state.melodyEdits || a.melody, bpm: a.bpm, bars: a.bars },
    {
      style: state.style,
      creativity: state.creativity,
      key: state.keyOverride,
      snap: state.snap && !state.melodyEdits,
      chordsPerBar: state.chordsPerBar,
      seeds: state.seeds,
      drums: state.neuralHits,
    },
  );
  player.load(state.song, playSettings(), humBuffer);
  renderSession();
}

function regrid({ bpm, beatShift }) {
  const a = state.analysis;
  if (!a || a.mode !== 'free') return;
  Object.assign(a, placeOnGrid(a.notes, { mode: 'free', forceBpm: bpm ?? a.bpm, beatShift: beatShift ?? state.beatShift }));
  state.beatShift = beatShift ?? state.beatShift;
  state.melodyEdits = null;
  state.neuralHits = null;
  buildHumBuffer();
  rebuild();
  if (state.neural) runNeural();
}

let neuralToken = 0;
let neuralLoadedOnce = false;
async function runNeural() {
  const token = ++neuralToken;
  const a = state.analysis;
  if (!a || !state.song) return;
  setStripBusy('drums', true);
  if (!neuralLoadedOnce) toast('Loading the neural drum model. The first time takes a few seconds.');
  try {
    const seedHits = generateDrums({
      bars: a.bars,
      style: state.style,
      melody: state.song.melody,
      creativity: state.creativity,
      rng: mulberry32(state.seeds.drums),
    });
    const hits = await generateNeuralDrums({ seedHits, bars: a.bars, melody: state.song.melody, creativity: state.creativity });
    if (token !== neuralToken || !state.neural) return;
    neuralLoadedOnce = true;
    state.neuralHits = hits;
    rebuild();
  } catch (err) {
    if (token !== neuralToken) return;
    console.warn(err);
    state.neural = false;
    state.neuralHits = null;
    rebuild();
    toast("The neural drum model couldn't load, so the built-in drums are playing.");
  } finally {
    if (token === neuralToken) setStripBusy('drums', false);
  }
}

function regenerate(part) {
  if (part === 'all') state.seeds = { chords: newSeed(), drums: newSeed(), bass: newSeed() };
  else state.seeds[part] = newSeed();
  if (part === 'drums' || part === 'all') state.neuralHits = null;
  rebuild();
  if (state.neural && (part === 'drums' || part === 'all')) runNeural();
}

// ---------- Playback ----------

function startPlayback() {
  if (!state.song) return;
  ensureAudio();
  player.start();
  updatePlayButton();
  requestAnimationFrame(animatePlayhead);
}

function stopPlayback() {
  if (!player) return;
  player.stop();
  roll.setPosition(null);
  updatePlayButton();
}

function animatePlayhead() {
  if (!player?.playing) return;
  roll.setPosition(player.position);
  requestAnimationFrame(animatePlayhead);
}

function updatePlayButton() {
  const playing = !!player?.playing;
  $('#play-btn').setAttribute('aria-pressed', String(playing));
  $('#play-label').textContent = playing ? 'Stop' : 'Play';
}

// ---------- Rendering the session panel ----------

function renderSession() {
  const a = state.analysis;
  const song = state.song;
  if (!a || !song) return;

  $('#readout').textContent = `${keyName(song.key)}, ${Math.round(a.bpm)} BPM, ${a.bars} ${a.bars === 1 ? 'bar' : 'bars'}`;
  $('#tuning').textContent = tuningText(a.tuning);
  $('#tempo-tools').hidden = a.mode !== 'free';

  const keySel = $('#key-select');
  keySel.options[0].textContent = `Auto (${keyName(song.detectedKey)})`;
  keySel.value = state.keyOverride ? `${state.keyOverride.tonic}:${state.keyOverride.mode}` : 'auto';

  for (const b of document.querySelectorAll('#style-seg button')) b.setAttribute('aria-checked', String(b.dataset.style === state.style));
  for (const b of document.querySelectorAll('#rate-seg button')) b.setAttribute('aria-checked', String(Number(b.dataset.rate) === state.chordsPerBar));
  $('#snap').checked = state.snap;
  $('#snap').disabled = !!state.melodyEdits;
  $('#creativity').value = String(Math.round(state.creativity * 100));

  $('#lead-select').value = state.lead;
  $('#octave-value').textContent = state.leadOctave === 0 ? 'As hummed' : `${state.leadOctave > 0 ? '+' : '−'}${Math.abs(state.leadOctave)} oct`;
  $('#keys-label').textContent = KEYS_LABELS[STYLES[state.style].keys.instrument];
  $('#chords-list').textContent = song.chords.map((c) => c.symbol).join('  ');
  $('#neural').checked = state.neural;
  $('#undo-edits').hidden = !state.melodyEdits;

  for (const t of TRACKS) {
    const strip = document.querySelector(`.strip[data-track="${t}"]`);
    strip.classList.toggle('is-muted', state.mixer[t].muted);
    strip.querySelector('.mute').setAttribute('aria-pressed', String(state.mixer[t].muted));
    strip.querySelector('input[type="range"]').value = String(Math.round(state.mixer[t].volume * 100));
  }

  roll.setData({
    song,
    frames: a.frames,
    voiced: a.voicing.voiced,
    tuning: a.tuning,
    gridStart: a.origin - a.shift,
    stepDur: 60 / a.bpm / 4,
    muted: Object.fromEntries(TRACKS.map((t) => [t, state.mixer[t].muted])),
  });
}

function tuningText(t) {
  const cents = Math.round(t * 100);
  if (Math.abs(cents) < 8) return 'You hummed right in tune.';
  return `You hummed ${Math.abs(cents)} cents ${cents < 0 ? 'flat' : 'sharp'}, so everything was nudged ${cents < 0 ? 'up' : 'down'} to match.`;
}

function setStripBusy(track, busy) {
  document.querySelector(`.strip[data-track="${track}"]`)?.classList.toggle('is-busy', busy);
}

// ---------- Building the controls ----------

function buildControls() {
  $('#bpm').value = String(state.bpm);
  $('#metronome').checked = state.metronome;
  for (const b of document.querySelectorAll('#bars-seg button')) b.setAttribute('aria-checked', String(Number(b.dataset.bars) === state.bars));
  syncRecordControls();

  // Style buttons
  const styleSeg = $('#style-seg');
  for (const id of STYLE_ORDER) {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.dataset.style = id;
    b.textContent = STYLES[id].label;
    styleSeg.appendChild(b);
  }

  // Key options
  const keySel = $('#key-select');
  keySel.add(new Option('Auto', 'auto'));
  for (const k of ALL_KEYS) keySel.add(new Option(keyName(k), `${k.tonic}:${k.mode}`));

  // Lead instrument options
  const leadSel = $('#lead-select');
  for (const [id, inst] of Object.entries(LEAD_INSTRUMENTS)) leadSel.add(new Option(inst.label, id));

  // Channel strips
  for (const t of TRACKS) {
    const strip = document.querySelector(`.strip[data-track="${t}"]`);
    strip.querySelector('input[type="range"]').setAttribute('aria-label', `${TRACK_NAMES[t]} volume`);
    strip.querySelector('.mute').setAttribute('aria-label', `Mute ${TRACK_NAMES[t]}`);
  }
}

function syncRecordControls() {
  $('#tempo-field').classList.toggle('is-off', !state.metronome);
  $('#bars-field').classList.toggle('is-off', !state.metronome);
  $('#bpm').disabled = !state.metronome;
  if (state.phase === 'idle' || state.phase === 'ready') setStatus(idleText());
}

function bindEvents() {
  $('#rec-btn').addEventListener('click', () => {
    if (state.phase === 'counting' || state.phase === 'recording') stopRecording();
    else if (state.phase !== 'analyzing') startRecording();
  });

  $('#demo-btn').addEventListener('click', async () => {
    if (state.phase !== 'idle' && state.phase !== 'ready') return;
    ensureAudio();
    stopPlayback();
    const leadIn = 0.6;
    const samples = synthesizeHum({ sampleRate: ctx.sampleRate, leadIn, seed: 1 + Math.floor(Math.random() * 1000) });
    await analyzeAndBuild(samples, ctx.sampleRate, { mode: 'metronome', bpm: DEMO_TUNE.bpm, bars: DEMO_TUNE.bars, origin: leadIn });
    toast('That was a synthesized sample hum. Unmute "Your hum" to hear it.');
  });

  $('#metronome').addEventListener('change', (e) => {
    state.metronome = e.target.checked;
    syncRecordControls();
    savePrefs();
  });
  const setBpm = (v) => {
    state.bpm = Math.max(60, Math.min(180, Math.round(Number(v) || 100)));
    $('#bpm').value = String(state.bpm);
    savePrefs();
  };
  $('#bpm').addEventListener('change', (e) => setBpm(e.target.value));
  for (const b of document.querySelectorAll('[data-bpm-step]')) {
    b.addEventListener('click', () => setBpm(state.bpm + Number(b.dataset.bpmStep)));
  }
  $('#bars-seg').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    state.bars = Number(b.dataset.bars);
    for (const x of document.querySelectorAll('#bars-seg button')) x.setAttribute('aria-checked', String(x === b));
    savePrefs();
  });

  $('#play-btn').addEventListener('click', () => (player?.playing ? stopPlayback() : startPlayback()));
  $('#shuffle-btn').addEventListener('click', () => regenerate('all'));
  $('#half-time').addEventListener('click', () => state.analysis && state.analysis.bpm / 2 >= 40 && regrid({ bpm: state.analysis.bpm / 2 }));
  $('#double-time').addEventListener('click', () => state.analysis && state.analysis.bpm * 2 <= 240 && regrid({ bpm: state.analysis.bpm * 2 }));
  $('#shift-beat').addEventListener('click', () => regrid({ beatShift: (state.beatShift + 1) % 4 }));
  $('#undo-edits').addEventListener('click', () => {
    state.melodyEdits = null;
    rebuild();
  });

  $('#style-seg').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    state.style = b.dataset.style;
    state.neuralHits = null;
    savePrefs();
    rebuild();
    if (state.neural) runNeural();
  });
  $('#rate-seg').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    state.chordsPerBar = Number(b.dataset.rate);
    rebuild();
  });
  let creativityTimer = null;
  $('#creativity').addEventListener('input', (e) => {
    state.creativity = Number(e.target.value) / 100;
    clearTimeout(creativityTimer);
    creativityTimer = setTimeout(() => {
      state.neuralHits = null;
      rebuild();
      if (state.neural) runNeural();
    }, 180);
  });
  $('#key-select').addEventListener('change', (e) => {
    const v = e.target.value;
    state.keyOverride = v === 'auto' ? null : { tonic: Number(v.split(':')[0]), mode: v.split(':')[1] };
    rebuild();
  });
  $('#snap').addEventListener('change', (e) => {
    state.snap = e.target.checked;
    rebuild();
  });

  $('#lead-select').addEventListener('change', (e) => {
    state.lead = e.target.value;
    savePrefs();
    rebuild();
  });
  for (const b of document.querySelectorAll('[data-octave]')) {
    b.addEventListener('click', () => {
      state.leadOctave = Math.max(-2, Math.min(2, state.leadOctave + Number(b.dataset.octave)));
      rebuild();
    });
  }
  for (const b of document.querySelectorAll('[data-regen]')) b.addEventListener('click', () => regenerate(b.dataset.regen));
  $('#neural').addEventListener('change', (e) => {
    state.neural = e.target.checked;
    if (state.neural) runNeural();
    else {
      neuralToken++;
      setStripBusy('drums', false);
      state.neuralHits = null;
      rebuild();
    }
  });

  for (const t of TRACKS) {
    const strip = document.querySelector(`.strip[data-track="${t}"]`);
    strip.querySelector('input[type="range"]').addEventListener('input', (e) => {
      state.mixer[t].volume = Number(e.target.value) / 100;
      engine?.setChannel(t, state.mixer[t].volume, state.mixer[t].muted);
    });
    strip.querySelector('.mute').addEventListener('click', () => toggleMute(t));
  }

  $('#midi-btn').addEventListener('click', () => {
    if (!state.song) return;
    download(new Blob([songToMidi(state.song, playSettings())], { type: 'audio/midi' }), `${fileBase()}.mid`);
    toast('MIDI file downloaded.');
  });
  $('#wav-btn').addEventListener('click', async () => {
    if (!state.song) return;
    const btn = $('#wav-btn');
    btn.disabled = true;
    btn.textContent = 'Rendering WAV…';
    try {
      const blob = await renderSongToWav(state.song, playSettings(), state.mixer, state.humData, { loops: 2 });
      download(blob, `${fileBase()}.wav`);
      toast('WAV file downloaded.');
    } catch (err) {
      console.error(err);
      toast(`The WAV didn't render (${err.message}).`);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Download WAV';
    }
  });
  $('#again-btn').addEventListener('click', () => {
    stopPlayback();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    $('#rec-btn').focus({ preventScroll: true });
  });

  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, select, textarea, button') || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.code === 'Space' && state.song) {
      e.preventDefault();
      if (player?.playing) stopPlayback();
      else startPlayback();
    } else if (e.key === 'r' || e.key === 'R') {
      $('#rec-btn').click();
    } else if (/^[1-5]$/.test(e.key) && state.song) {
      toggleMute(TRACKS[Number(e.key) - 1]);
    }
  });
}

function toggleMute(t) {
  state.mixer[t].muted = !state.mixer[t].muted;
  engine?.setChannel(t, state.mixer[t].volume, state.mixer[t].muted);
  renderSession();
}

// ---------- Small helpers ----------

function fileBase() {
  const k = keyName(state.song.key).replace(/\s+/g, '-').replace('#', 'sharp').toLowerCase();
  return `humband-${k}-${Math.round(state.analysis.bpm)}bpm`;
}

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

let toastTimer = null;
function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 4500);
}

function loadPrefs() {
  try {
    return JSON.parse(localStorage.getItem('humband-prefs') || '{}');
  } catch {
    return {};
  }
}

function savePrefs() {
  try {
    const { metronome, bpm, bars, style, lead } = state;
    localStorage.setItem('humband-prefs', JSON.stringify({ metronome, bpm, bars, style, lead }));
  } catch {
    // storage can be unavailable (private mode); preferences just won't persist
  }
}

buildControls();
bindEvents();
setPhase('idle');
setStatus(idleText());
