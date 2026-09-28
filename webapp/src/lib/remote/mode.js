// Is this page a REMOTE CONTROL — the app driving somebody else's player?
//
// Decided once, at load, before any store is built, because it changes what
// the stores ARE: a remote control keeps its settings apart from this
// device's own (so driving a friend's player never rewrites yours), restores
// no session of its own, keeps no offline copy of the owner's library, and
// mounts no audio engine at all. The server is the authority — the session
// cookie carries the grant and /api/me reports it — and this is its local
// echo, written when a link is claimed and dropped when the grant ends. App
// reconciles the two at boot and reloads when they disagree.
//
// The four levels, each a superset of the one before (supysonic/webui/remote.py):
// queue (transport + the queue), read (the whole app, read-only), full
// (everything but administration), admin.

export const LEVELS = ["queue", "read", "full", "admin"];
const KEY = "remote.session";

function read() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || "null");
    return v && LEVELS.includes(v.level) ? v : null;
  } catch {
    return null;
  }
}

/** The grant this page runs under — `{level, owner, device, label}` — or null. */
export const REMOTE = typeof localStorage === "undefined" ? null : read();

/** True when this page may do what `level` allows (always, on one's own app). */
export function atLeast(level) {
  if (!REMOTE) return true;
  return LEVELS.indexOf(REMOTE.level) >= LEVELS.indexOf(level);
}

export function rememberRemote(info) {
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        level: info.level,
        owner: info.owner || "",
        device: info.device || "",
        label: info.label || "",
        at: Date.now(),
      })
    );
  } catch {
    /* private mode: the page still reloads into remote mode from /api/me */
  }
}

export function forgetRemote() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

/** The token of a link being opened (`#/rc/<token>`), or null. */
export function claimToken(hash = typeof location === "undefined" ? "" : location.hash) {
  const m = /^#\/rc\/([A-Za-z0-9_-]{16,24}\.[A-Za-z0-9_-]{24})$/.exec(hash || "");
  return m ? m[1] : null;
}

export const LEVEL_INFO = {
  queue: {
    icon: "queue",
    name: "File d'attente",
    short: "File",
    blurb: "Lecture, pause, titre suivant, position, volume — et se promener dans la file.",
  },
  read: {
    icon: "eye",
    name: "Lecture seule",
    short: "Lecture seule",
    blurb: "Toute l'app sans rien modifier : chercher, ajouter à la file, choisir les animations.",
  },
  full: {
    icon: "sliders",
    name: "Complet",
    short: "Complet",
    blurb: "Tout sauf l'administration : playlists, favoris, réglages du lecteur, étiquetage.",
  },
  admin: {
    icon: "shield",
    name: "Administrateur",
    short: "Admin",
    blurb: "Tout, administration comprise. Réservé à quelqu'un de confiance.",
  },
};

// Fixed for the life of the page (a grant's level never changes under it).
// On one's own app all three are true.
/** May change what is kept: playlists, favourites, the player's settings, tags. */
export const CAN_KEEP = atLeast("full");
/** May administer: server settings, library jobs, the genre studio. */
export const CAN_ADMIN = atLeast("admin");
/** May do more than drive the transport and the queue: the whole app, read. */
export const CAN_BROWSE = atLeast("read");

/** Reload the app on its home screen (after claiming, leaving or losing a grant). */
export function reloadHome() {
  try {
    history.replaceState(null, "", location.pathname + location.search + "#/");
  } catch {
    location.hash = "#/";
  }
  location.reload();
}
