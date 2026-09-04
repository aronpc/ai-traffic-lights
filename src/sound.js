// sound.js — red alert sounds: synthetic presets (Web Audio) + the user's
// own file. The preset PARAMETERS are pure data (testable in node); the
// playback (playPreset/playBuffer) uses the Web Audio API and only runs in the
// renderer. Loaded via <script src> in the overlay and Preferences (exposes
// globals), and via require() by settings.js (data/validation only).

// Each preset is a sequence of tones: wave + [{ f: Hz, t: start(s), d: duration(s) }].
// Free to tweak timbre/taste — just keep the keys in sync (SOUND_TYPES derives
// from here, and the UI lists these keys).
const SOUND_PRESETS = {
  beep:   { wave: 'sine',     tones: [{ f: 880, t: 0, d: 0.35 }] },                               // the classic alert
  double: { wave: 'sine',     tones: [{ f: 880, t: 0, d: 0.12 }, { f: 880, t: 0.18, d: 0.12 }] }, // two short beeps
  chime:  { wave: 'triangle', tones: [{ f: 660, t: 0, d: 0.5 },  { f: 990, t: 0.09, d: 0.5 }] },   // bell (two tones)
  low:    { wave: 'sine',     tones: [{ f: 440, t: 0, d: 0.3 }] },                                 // low-pitched, discreet
};

// Valid types for settings.soundType: the presets + 'custom' (user file).
const SOUND_TYPES = [...Object.keys(SOUND_PRESETS), 'custom'];

// Safe volume in [0,1]; fallback to the original beep's default volume (0.18).
function clampVolume(v) {
  return (typeof v === 'number' && Number.isFinite(v)) ? Math.max(0, Math.min(1, v)) : 0.18;
}

// Plays a synthetic preset (oscillator). Each tone has its own short
// attack/decay envelope. Should never throw in normal use (the caller still wraps in try).
function playPreset(audioCtx, name, volume) {
  const preset = SOUND_PRESETS[name] || SOUND_PRESETS.beep;
  const vol = clampVolume(volume);
  const t0 = audioCtx.currentTime;
  for (const tone of preset.tones) {
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.connect(g); g.connect(audioCtx.destination);
    o.type = preset.wave;
    o.frequency.value = tone.f;
    const start = t0 + tone.t;
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol), start + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, start + tone.d);
    o.start(start);
    o.stop(start + tone.d);
  }
}

// Plays an already-decoded file (AudioBuffer) at the given volume.
function playBuffer(audioCtx, audioBuffer, volume) {
  const src = audioCtx.createBufferSource();
  const g = audioCtx.createGain();
  src.buffer = audioBuffer;
  src.connect(g); g.connect(audioCtx.destination);
  g.gain.value = clampVolume(volume);
  src.start();
}

if (typeof module !== 'undefined') {
  module.exports = { SOUND_PRESETS, SOUND_TYPES, clampVolume, playPreset, playBuffer };
}
