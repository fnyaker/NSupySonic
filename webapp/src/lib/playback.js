// Derived views over `playbackStatus` (set by Player.svelte) so every player
// surface can show a discreet, explicit indicator of WHAT is happening when the
// player isn't cleanly playing — instead of a lying pause icon over silence.

import { derived } from "svelte/store";
import { playbackStatus } from "./stores.js";

const LABELS = {
  loading: "Chargement…",
  buffering: "Mise en mémoire tampon…",
  archiving: "Préparation du titre…", // 1st play: server is fetching/transcoding
  "waiting-network": "Hors ligne — reprise à la reconnexion…",
  recovering: "Nouvel essai…",
  error: "Titre indisponible",
};

// Transitional states where a spinner/ring affordance belongs (NOT idle/error).
const BUSY = new Set(["loading", "buffering", "archiving", "waiting-network", "recovering"]);

// Human-readable status text, or "" when idle (render nothing → no visual noise
// during normal playback).
export const playbackLabel = derived(playbackStatus, ($s) => {
  if (!$s || $s.state === "idle") return "";
  if ($s.state === "recovering" && $s.max)
    return `Nouvel essai (${$s.attempt}/${$s.max})…`;
  return LABELS[$s.state] || "";
});

// True while the player is working toward playback (show a spinner ring).
export const playbackBusy = derived(playbackStatus, ($s) => !!$s && BUSY.has($s.state));

// True only when audio is genuinely flowing — the equalizer animation should
// key off THIS, not merely "playing", so it doesn't dance over silence.
export const playbackIdle = derived(playbackStatus, ($s) => !$s || $s.state === "idle");
