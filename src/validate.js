// validate.js — sanitization at trust boundaries (hook payload, paths).
// Adapters receive JSON from external agents; the state file becomes a file
// path. Without validation, a malicious session_id ("../foo") becomes path traversal.
// PURE functions, tested.

// IDs safe for file names: letters, digits, . _ - (xid/UUID style).
// Rejects '/', '..', spaces and anything else — fallback: the adapter
// ignores the event (does not write) instead of writing outside STATE_DIR.
function validSessionId(s) {
  return typeof s === 'string' && s.length > 0 && s.length <= 256 && /^[A-Za-z0-9._-]+$/.test(s);
}

// Shell-quote a path for use in a hook command (settings.json).
// Wraps in single quotes and escapes inner '. Prevents breakage/interpretation
// if XDG_DATA_HOME or HOME contain spaces or metacharacters.
function shellQuote(s) {
  if (typeof s !== 'string') return "''";
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

// String escape for the Exec field of a .desktop (Desktop Entry Spec).
// Characters that need a backslash: space and `" ` $ \ ; plus other shell ones.
function desktopEscape(s) {
  if (typeof s !== 'string') return '';
  return s.replace(/[\\$" `'*?();<>|&#~]/g, (c) => '\\' + c);
}

if (typeof module !== 'undefined') module.exports = { validSessionId, shellQuote, desktopEscape, boundsOnScreen };

// Does a window's saved position still fall INSIDE some active display?
// Validates against ALL displays (not just the primary): on a multi-monitor
// setup, a window moved to the left/right monitor had its position silently
// discarded on every reopen, defeating the persist (PR-32 #19). Also covers
// the disconnected-monitor case — no display contains the point and the
// caller falls back to the default (center on the primary).
//   bounds:   {x, y}                    (saved position)
//   displays: [{workArea:{x,y,width,height}}]   (screen.getAllDisplays())
function boundsOnScreen(bounds, displays) {
  if (!bounds || typeof bounds.x !== 'number' || typeof bounds.y !== 'number') return false;
  if (!Array.isArray(displays)) return false;
  return displays.some((d) => {
    const a = d && d.workArea;
    if (!a) return false;
    return bounds.x >= a.x && bounds.x < a.x + a.width &&
           bounds.y >= a.y && bounds.y < a.y + a.height;
  });
}
