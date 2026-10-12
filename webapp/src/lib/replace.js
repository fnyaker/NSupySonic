// Replacing and auditioning stand-ins for dead tracks.
//
// Shared by the replacement sheet and the library's "Indisponibles" list, whose
// rows offer the safest matches inline: ONE audition element for both (a chip
// previewed in the list stops when the sheet starts another), and one commit
// path, so a swap made in one click is reported exactly like one made from the
// sheet.
import { get, writable } from "svelte/store";
import { api } from "./api.js";
import {
  toasts,
  clearUnavailable,
  unavailableChanged,
  quality,
  normalization,
} from "./stores.js";
import { invalidatePlaylists, loadFavorites } from "./actions.js";

// -- preview -----------------------------------------------------------------
// Same pipeline as the player: the /api/stream URL at the quality you listen
// at, and the same loudness normalization, so what you audition is what you
// will get. Deliberately its OWN element — auditioning a replacement must not
// hijack (or be hijacked by) whatever is playing.

/** The deezer_id being auditioned, or null. */
export const previewing = writable(null);
let previewEl = null;

export function stopPreview() {
  if (previewEl) {
    try {
      previewEl.pause();
      previewEl.removeAttribute("src");
      previewEl.load();
    } catch {
      /* ignore */
    }
  }
  previewEl = null;
  previewing.set(null);
}

export function togglePreview(track) {
  if (get(previewing) === track.deezer_id) {
    stopPreview();
    return;
  }
  stopPreview();
  const el = new Audio();
  el.src = api.streamUrl(track.deezer_id, get(quality));
  el.preload = "auto";
  // Match the player's static normalization so a candidate doesn't merely
  // sound louder than the rest of your library and win on that.
  el.volume = 1;
  if (get(normalization) !== "off" && typeof track.gain === "number")
    el.volume = Math.max(0, Math.min(1, Math.pow(10, track.gain / 20)));
  const fail = () => {
    if (previewEl !== el) return;
    toasts.push("Lecture impossible pour ce titre", "error");
    stopPreview();
  };
  el.addEventListener("ended", () => previewEl === el && stopPreview());
  el.addEventListener("error", fail);
  el.play().catch(fail);
  previewEl = el;
  previewing.set(track.deezer_id);
}

// -- committing --------------------------------------------------------------

/** Swap `target` for `candidate` everywhere. Resolves true once accepted. */
export async function applyReplacement(target, candidate) {
  stopPreview();
  try {
    const r = await api.replaceTrack(target.deezer_id, candidate.deezer_id);
    // The dead track is gone from your library, so drop its badge; the
    // stand-in is playable, so make sure it doesn't inherit one.
    clearUnavailable(target.deezer_id);
    invalidatePlaylists();
    loadFavorites(true);
    toasts.push(
      candidate.title === target.title && candidate.album?.title
        ? `« ${target.title} » remplacé par la version de « ${candidate.album.title} »`
        : `« ${candidate.title} » remplace « ${target.title} »`
    );
    if (r?.job) watchJob(r.job);
    return true;
  } catch (e) {
    toasts.push(e?.message || "Le remplacement a échoué", "error");
    return false;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll a replace/delete job until it ends; resolves its final status (or null). */
export async function pollJob(job, onProgress, { every = 1000, max = 600 } = {}) {
  for (let i = 0; i < max; i++) {
    await sleep(every);
    let s;
    try {
      s = await api.replaceStatus(job);
    } catch {
      return null;
    }
    if (!s.running) return s;
    onProgress?.(s);
  }
  return null;
}

// The rewrite runs server-side; poll just long enough to report the outcome.
export async function watchJob(job, failure = "Le remplacement a échoué côté serveur") {
  const s = await pollJob(job, null, { max: 40 });
  if (!s) return;
  if (s.ok) {
    // Only NOW is the database actually in its new state — the swap runs in
    // a worker thread. Anything showing the unavailable list re-reads it.
    unavailableChanged();
    const bits = [];
    if (s.playlists) bits.push(`${s.playlists} playlist${s.playlists > 1 ? "s" : ""}`);
    if (s.favorites) bits.push("favoris");
    if (bits.length) toasts.push("Mis à jour dans " + bits.join(" et "));
    invalidatePlaylists();
  } else {
    toasts.push(failure, "error");
  }
}
