// appimage-env.js — PURE sanitization of the env handed to EVERY external
// process the overlay spawns. No I/O: takes an env object, returns a copy.
//
// WHY THIS EXISTS. Running as an AppImage, the runtime exports APPIMAGE (the
// absolute path of the .AppImage file), APPDIR (its mount point) and ARGV0.
// Any process spawned from here inherits them — including terminals we focus
// or launch. An app whose updater supports AppImage reads $APPIMAGE to learn
// "which file am I", and writes the new version THERE. When $APPIMAGE still
// points at OUR file, its update lands ON TOP of the overlay's AppImage: the
// desktop entry then starts that other app and ATL never comes up again.
//
// Observed four times on the same machine, always with Warp Terminal (which
// ships an AppImage channel): 2026-08-18, 2026-09-04 and twice on 2026-09-14
// (11:26 and 18:31), the last two while this fix sat uncommitted. On 09-04 the
// Warp process focused via `xdg-open warp://session/<uuid>` still carried
// APPIMAGE=/home/…/AI-Traffic-Lights.AppImage in its environ, and the file was
// overwritten by a Warp build ~1 min after that process started.
//
// The fix is to strip the vars at the boundary rather than to special-case
// Warp: any AppImage-aware updater is the same trap, and a child that really
// needs to know about our AppImage does not exist — nothing we spawn is us.

// Vars the AppImage runtime injects. OWD (original working directory) and
// APPIMAGE_EXTRACT_AND_RUN carry no update semantics, but they are equally
// meaningless to a child and only confuse anything that probes them.
const APPIMAGE_VARS = ['APPIMAGE', 'APPDIR', 'ARGV0', 'OWD', 'APPIMAGE_EXTRACT_AND_RUN'];

// A copy of `base` without the AppImage vars. Always a copy: mutating
// process.env would break the overlay's OWN updater, which legitimately needs
// APPIMAGE to know which file to replace (src/ipc/update.js).
function cleanEnv(base) {
  const env = Object.assign({}, base || process.env);
  for (const k of APPIMAGE_VARS) delete env[k];
  return env;
}

// Did anything leak? Used by the regression test and cheap enough to assert
// on a spawn's options in the future.
function leakedVars(env) {
  return APPIMAGE_VARS.filter((k) => env && Object.prototype.hasOwnProperty.call(env, k));
}

// Wraps a child_process entry point (spawn / execFileSync / promisified
// execFile) so the default env is already sanitized. Wrapping the ENTRY POINT
// rather than each call site is what makes this hold over time: ipc/focus.js
// alone spawns 16 processes, and the one that leaked was a single line among
// them — an opt-in per call would be re-broken by the next line added.
// An explicit `env` in opts still wins: a caller that builds its own env is
// stating intent, and cleanEnv is theirs to apply (ptyEnv does exactly that).
function withCleanEnv(fn) {
  return (file, args, opts) => fn(file, args, { env: cleanEnv(), ...opts });
}

if (typeof module !== 'undefined') module.exports = { APPIMAGE_VARS, cleanEnv, leakedVars, withCleanEnv };
