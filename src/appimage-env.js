// appimage-env.js — PURE env scrub for children spawned from inside the
// AppImage (devpit integration: open a session's pane in the devpit desktop
// app). Node-only (required by src/ipc/devpit.js — no <script> in index.html),
// but pure like focus.js: no I/O, no Electron; the decision is testable in
// test/devpit.test.js.
//
// An AppImage mounts itself at $APPDIR and exports APPIMAGE/APPDIR/ARGV0/OWD
// plus PATH/LD_LIBRARY_PATH/XDG_DATA_DIRS entries pointing INTO that mount.
// A child launched with the inherited env resolves binaries/libs against the
// overlay's transient mount (which dies with the overlay). cleanEnv hands the
// child an env as if ATL ran unpacked: the 4 AppImage vars gone and every
// path entry UNDER $APPDIR filtered out.

// Keeps only the entries of a ":"-separated path var that do NOT live under
// the AppImage mount. "Under" = the entry IS appdir or starts with appdir +
// '/' — a plain startsWith(appdir) would also kill /opt/appdir-foo, which is
// a different directory that happens to share the prefix.
function stripAppdirEntries(value, appdir) {
  return value.split(':')
    .filter((entry) => entry !== appdir && !entry.startsWith(appdir + '/'))
    .join(':');
}

const APPIMAGE_VARS = ['APPIMAGE', 'APPDIR', 'ARGV0', 'OWD'];
const PATH_VARS = ['PATH', 'LD_LIBRARY_PATH', 'XDG_DATA_DIRS'];

// Copy of `env` without the AppImage fingerprint. Never mutates the input.
// A path var left EMPTY by the filter is REMOVED, not kept as "" — an empty
// LD_LIBRARY_PATH is still an override of the loader's default, and an empty
// PATH resolves nothing. Without APPDIR (dev via npm start, unpacked install)
// there is nothing to filter: only the 4 vars go.
function cleanEnv(env) {
  const src = env || {};
  const appdir = typeof src.APPDIR === 'string' ? src.APPDIR : null;
  const out = {};
  for (const [k, v] of Object.entries(src)) out[k] = v;
  for (const k of APPIMAGE_VARS) delete out[k];
  for (const k of PATH_VARS) {
    if (!appdir || typeof out[k] !== 'string') continue;
    const filtered = stripAppdirEntries(out[k], appdir);
    if (filtered) out[k] = filtered;
    else delete out[k];
  }
  return out;
}

if (typeof module !== 'undefined') module.exports = { cleanEnv };
