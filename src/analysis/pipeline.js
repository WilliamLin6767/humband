// The full listening pipeline: audio in, quantized melody out.
//
//   resample to 16 kHz -> YIN pitch track -> voicing + tuning -> note segmentation
//   -> (free mode only) tempo and downbeat -> quantize to 16ths

import { resample } from './dsp.js';
import { ANALYSIS_RATE, trackPitch } from './pitch.js';
import { computeVoicing, estimateTuning, quantizeNotes, segmentNotes } from './notes.js';
import { estimateTempo } from './tempo.js';

export function analyzeHum(samples, sampleRate, options = {}) {
  const signal = resample(samples, sampleRate, ANALYSIS_RATE);
  const { frames, hop } = trackPitch(signal, ANALYSIS_RATE);
  const voicing = computeVoicing(frames);
  const tuning = estimateTuning(frames, voicing);
  const notes = segmentNotes(frames, { hop, voicing, tuning });
  const mode = options.mode || 'metronome';
  return { frames, voicing, tuning, notes, hop, mode, ...placeOnGrid(notes, { ...options, mode }) };
}

// Kept separate so the app can re-run it when the user halves or doubles the detected tempo.
export function placeOnGrid(
  notes,
  { mode = 'metronome', bpm = 100, bars = 4, origin = 0, forceBpm = null, beatShift = 0 } = {},
) {
  const grid = mode === 'free' ? estimateTempo(notes, { forcedBpm: forceBpm, beatShift }) : { bpm, bars, origin };
  const { notes: melody, shift } = quantizeNotes(notes, grid);
  return { bpm: grid.bpm, bars: grid.bars, origin: grid.origin, shift, melody };
}
