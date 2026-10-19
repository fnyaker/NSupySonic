// The user's accounts on other streaming services, for exporting playlists to
// them (supysonic/webui/services.py). One store, so the settings and the export
// sheet agree on what is linked the moment either one changes it.
import { writable, get } from "svelte/store";
import { api } from "./api.js";

export const services = writable(null); // { services: [...], formats: [...] }

let inflight = null;
export function loadServices(force = false) {
  if (!force && get(services)) return Promise.resolve(get(services));
  if (inflight) return inflight;
  inflight = api
    .services()
    .then((r) => {
      services.set(r);
      return r;
    })
    .catch(() => get(services))
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

// Spotify's consent page is a NAVIGATION: the browser leaves the app and comes
// back through the server's callback (to the settings when this browser is
// signed in, to a short "done" page when it is not — the system browser the
// Android app hands the page to). Coming back re-reads what is linked.
export async function linkSpotify() {
  const { url } = await api.spotifyAuthorize();
  window.location.href = url;
}

export async function linkYoutube(headers) {
  const r = await api.connectYoutube(headers);
  await loadServices(true);
  return r;
}

export async function unlink(id) {
  await api.disconnectService(id);
  await loadServices(true);
}

// Back from another app or browser tab (the Spotify consent, the YouTube
// headers copied from a desktop tab): what is linked may have changed.
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && get(services)) loadServices(true);
  });
}

// What a finished job says, in one line.
export function jobSummary(job) {
  if (!job) return "";
  if (job.error) return job.error;
  const n = job.matched;
  const base = `${n} titre${n > 1 ? "s" : ""} sur ${job.total} exporté${n > 1 ? "s" : ""}`;
  return job.missing_count ? `${base}, ${job.missing_count} introuvable${job.missing_count > 1 ? "s" : ""}` : base;
}
