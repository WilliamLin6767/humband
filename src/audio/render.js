// Offline render to WAV: the same instruments and events, played into an OfflineAudioContext.

import { Engine, TRACKS } from './instruments.js';
import { compileEvents, triggerEvent } from './player.js';
import { encodeWav } from '../io/wav.js';

export async function renderSongToWav(song, settings, mixer, humData, { loops = 2, sampleRate = 44100 } = {}) {
  const { events, loopDur } = compileEvents(song, settings);
  const length = Math.ceil((loops * loopDur + 2.5) * sampleRate);
  const octx = new OfflineAudioContext(2, length, sampleRate);
  const engine = new Engine(octx);
  for (const t of TRACKS) engine.setChannel(t, mixer[t].volume, mixer[t].muted, true);
  const session = engine.createSession();

  let hum = null;
  if (humData && !mixer.hum.muted) {
    hum = octx.createBuffer(1, humData.samples.length, humData.sampleRate);
    hum.copyToChannel(humData.samples, 0);
  }
  for (let loop = 0; loop < loops; loop++) {
    const base = 0.05 + loop * loopDur;
    if (hum) {
      const src = octx.createBufferSource();
      src.buffer = hum;
      src.connect(session.bus.hum);
      src.start(base, 0, Math.min(hum.duration, loopDur));
    }
    for (const ev of events) triggerEvent(engine, session, ev, base + ev.time, song, settings);
  }
  return encodeWav(await octx.startRendering());
}
