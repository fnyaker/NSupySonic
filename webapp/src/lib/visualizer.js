// A Web Audio analyser tapped off the player's <audio> element, used by the
// immersive visualizer. Streams are same-origin (/api/stream), so the element
// isn't CORS-tainted and the analyser can read its samples.
//
// createMediaElementSource can only run once per element and re-routes its
// output through the AudioContext, so we connect the source straight to the
// destination (audio stays audible) AND to the analyser (a side tap).

let ctx = null;
let analyser = null;
let wired = false;

export function wireAudio(el) {
  if (wired || !el) return;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  try {
    ctx = new AC();
    const source = ctx.createMediaElementSource(el);
    // Restore the audio path FIRST so a later failure can't mute playback.
    source.connect(ctx.destination);
    wired = true;
    const an = ctx.createAnalyser();
    an.fftSize = 512; // 256 bins — finer resolution for the log-spaced bars
    an.smoothingTimeConstant = 0.82;
    source.connect(an);
    analyser = an; // only expose it once the tap is fully connected
  } catch {
    analyser = null;
  }
}

// AudioContexts start suspended until a user gesture; call this on play.
export function resumeAudio() {
  if (ctx && ctx.state === "suspended") ctx.resume().catch(() => {});
}

export function getAnalyser() {
  return analyser;
}
