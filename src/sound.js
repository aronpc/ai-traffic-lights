// sound.js — sons do alerta vermelho: presets sintéticos (Web Audio) + arquivo
// próprio do usuário. Os PARÂMETROS dos presets são dados puros (testáveis em
// node); o playback (playPreset/playBuffer) usa a Web Audio API e só roda no
// renderer. Carregado via <script src> no overlay e nas Preferências (expõe
// globais), e via require() por settings.js (só os dados/validação).

// Cada preset é uma sequência de tons: onda + [{ f: Hz, t: início(s), d: duração(s) }].
// Ajuste livre de timbre/gosto — só mantenha as chaves em sincronia (SOUND_TYPES
// deriva daqui, e a UI lista estas chaves).
const SOUND_PRESETS = {
  beep:   { wave: 'sine',     tones: [{ f: 880, t: 0, d: 0.35 }] },                               // o alerta clássico
  double: { wave: 'sine',     tones: [{ f: 880, t: 0, d: 0.12 }, { f: 880, t: 0.18, d: 0.12 }] }, // dois toques curtos
  chime:  { wave: 'triangle', tones: [{ f: 660, t: 0, d: 0.5 },  { f: 990, t: 0.09, d: 0.5 }] },   // sino (dois tons)
  low:    { wave: 'sine',     tones: [{ f: 440, t: 0, d: 0.3 }] },                                 // grave, discreto
};

// Tipos válidos para settings.soundType: os presets + 'custom' (arquivo do usuário).
const SOUND_TYPES = [...Object.keys(SOUND_PRESETS), 'custom'];

// Volume seguro em [0,1]; fallback no volume padrão do beep original (0.18).
function clampVolume(v) {
  return (typeof v === 'number' && Number.isFinite(v)) ? Math.max(0, Math.min(1, v)) : 0.18;
}

// Toca um preset sintético (oscilador). Cada tom tem seu envelope curto de
// ataque/decay. Nunca deve lançar em uso normal (o chamador ainda envolve em try).
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

// Toca um arquivo já decodificado (AudioBuffer) no volume dado.
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
