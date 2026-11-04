// accel.js — keydown → Electron accelerator. PURE logic (only reads event
// properties), loaded by the Preferences <script> and requirable from tests.
//
// The key comes from e.code (physical POSITION), not e.key (the generated
// character): on macOS Option is a composition modifier, so Option+H arrives
// as "˙", e.key stopped matching [A-Z0-9] and capture returned null — no
// shortcut using Alt could be configured on the Mac. e.code is also
// layout-independent, which keeps the same physical key valid with a keyboard
// shared across machines. e.key stays as a fallback for events without a code
// (IME, virtual keyboard). The accepted subset mirrors KEY in settings.js.

const MODNAME = { ctrlKey: 'Control', altKey: 'Alt', shiftKey: 'Shift', metaKey: 'Super' };
const KEYNAME = { ' ': 'Space', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right' };

// e.code → accelerator key: KeyH→H, Digit1→1, ArrowUp→Up. Outside the subset, null.
function keyFromCode(code) {
  const m = /^(?:Key([A-Z])|Digit([0-9])|(F[1-9]|F1[0-2])|(Space)|Arrow(Up|Down|Left|Right))$/.exec(code || '');
  return m ? (m[1] || m[2] || m[3] || m[4] || m[5]) : null;
}

// Same subset from the character — only when there is no usable e.code.
function keyFromChar(key) {
  if (KEYNAME[key]) return KEYNAME[key];
  if (/^[a-z0-9]$/i.test(key || '')) return key.toUpperCase();
  if (/^F([1-9]|1[0-2])$/i.test(key || '')) return key.toUpperCase();
  return null;
}

// keydown → "Mod+...+Key" accelerator. Returns null if only modifiers so far.
function accelFromEvent(e) {
  const mods = [];
  for (const [prop, name] of Object.entries(MODNAME)) if (e[prop]) mods.push(name);
  // e.key ONLY without a code: a code outside the subset (Numpad5, Backquote)
  // must be rejected, never rescued by its character — the accelerator would
  // then name a different physical key than the one pressed.
  const key = e.code ? keyFromCode(e.code) : keyFromChar(e.key);
  if (!key) return null;            // lone modifier / unsupported key
  return [...mods, key].join('+');
}

if (typeof module !== 'undefined') module.exports = { accelFromEvent, keyFromCode, keyFromChar };
