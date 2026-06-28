// A Web Audio analyser tapped off the player's <audio> element, used by the
// immersive visualizer. Streams are same-origin (/api/stream), so the element
// isn't CORS-tainted and the analyser can read its samples.
//
// createMediaElementSource can only run once per element and re-routes its
// output through the AudioContext, so we connect the source straight to the
// destination (audio stays audible) AND to the analyser (a side tap).

let ctx = null;
let analyser = null;
// createMediaElementSource may only run ONCE per element, so track which
// elements are already wired. The player keeps two <audio> elements (for
// gapless quality switching); both feed the same shared analyser, so the
// visualizer keeps working whichever one is currently playing.
const wiredEls = new WeakSet();

// Whichever <audio> element is currently active, and whether any visualizer
// view actually needs the analyser yet.
let currentEl = null;
let analyserWanted = false;

// The player registers the active element here on every play / quality switch,
// but we deliberately DON'T route it through an AudioContext yet: once an
// element feeds a MediaElementSource, all its audio flows through the context,
// and a backgrounded tab suspends that context — which silently CUTS playback
// and wastes battery. So normal (and background) listening keeps a pure audio
// path; we only wire Web Audio in once a visualizer view asks for it.
export function registerSource(el) {
  currentEl = el;
  if (analyserWanted && el) wireAudio(el);
}

// Called by a visualizer view when it mounts: from now on we need the analyser,
// so wire the current element (and future ones) and make sure the context runs.
export function requestAnalyser() {
  analyserWanted = true;
  if (currentEl) wireAudio(currentEl);
  resumeAudio();
}

export function wireAudio(el) {
  if (!el || wiredEls.has(el)) return;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  try {
    if (!ctx) ctx = new AC();
    const source = ctx.createMediaElementSource(el);
    // Restore the audio path FIRST so a later failure can't mute playback.
    source.connect(ctx.destination);
    wiredEls.add(el);
    if (!analyser) {
      const an = ctx.createAnalyser();
      an.fftSize = 512; // 256 bins — finer resolution for the log-spaced bars
      an.smoothingTimeConstant = 0.82;
      analyser = an;
    }
    source.connect(analyser);
  } catch {
    /* keep any analyser we already have */
  }
}

// AudioContexts start suspended until a user gesture; call this on play.
export function resumeAudio() {
  if (ctx && ctx.state === "suspended") ctx.resume().catch(() => {});
}

export function getAnalyser() {
  return analyser;
}

// A self-contained bar renderer. Each consumer (desktop / mobile now-playing)
// calls createVisualizer() once and then draw(canvas) per animation frame, so
// the per-bar smoothing and auto-gain state stay isolated per view.
//
// Tuned for punch over a flat readout. Instead of one global auto-gain (which
// lets loud mids/highs crush the gain and bury the bass), the spectrum is split
// into THREE zones — bass / mid / high — each levelled by its own slow auto-gain
// envelope, so every band keeps its own life. The per-bar gain is interpolated
// across the zone centres so there's no visible seam where zones meet. A gamma
// curve keeps the quiet/loud contrast; a fast-attack / slow-release envelope
// keeps the bars lively instead of parked in the middle.
export function createVisualizer() {
  let freq = null;
  let smoothed = null;
  let agc = [0.15, 0.15, 0.15]; // bass, mid, high

  // Zone gains sit at the centre of each third of the strip; blend linearly
  // between them (and hold flat past the outer centres) for a seamless curve.
  const CENTRES = [1 / 6, 0.5, 5 / 6];
  function gainAt(gain, t) {
    if (t <= CENTRES[0]) return gain[0];
    if (t >= CENTRES[2]) return gain[2];
    const z = t < CENTRES[1] ? 0 : 1;
    const f = (t - CENTRES[z]) / (CENTRES[z + 1] - CENTRES[z]);
    return gain[z] * (1 - f) + gain[z + 1] * f;
  }

  return function draw(canvas) {
    const an = getAnalyser();
    if (!an || !canvas) return;
    const bins = an.frequencyBinCount;
    if (!freq || freq.length !== bins) freq = new Uint8Array(bins);
    an.getByteFrequencyData(freq);

    const cw = canvas.clientWidth,
      ch = canvas.clientHeight;
    if (!cw || !ch) return;
    if (canvas.width !== cw) canvas.width = cw;
    if (canvas.height !== ch) canvas.height = ch;
    const g = canvas.getContext("2d");
    g.clearRect(0, 0, cw, ch);

    const bars = Math.max(24, Math.min(72, Math.floor(cw / 8)));
    if (!smoothed || smoothed.length !== bars) smoothed = new Float32Array(bars);
    const minBin = 2; // skip DC/rumble (kept low so the bass still registers)
    const maxBin = Math.floor(bins * 0.78);

    // Log-spaced band energies (NO perceptual tilt — each zone is levelled by
    // its own AGC below, which is what keeps the low end on screen).
    const raw = new Float32Array(bars);
    const zoneSum = [0, 0, 0];
    const zoneN = [0, 0, 0];
    for (let i = 0; i < bars; i++) {
      const t = i / bars;
      const lo = Math.floor(minBin * Math.pow(maxBin / minBin, t));
      const hi = Math.max(
        lo + 1,
        Math.floor(minBin * Math.pow(maxBin / minBin, (i + 1) / bars))
      );
      let sum = 0,
        n = 0;
      for (let b = lo; b < hi && b < bins; b++) {
        sum += freq[b];
        n++;
      }
      const r = (n ? sum / n : 0) / 255;
      raw[i] = r;
      const z = t < 1 / 3 ? 0 : t < 2 / 3 ? 1 : 2;
      zoneSum[z] += r;
      zoneN[z] += 1;
    }

    // Each zone tracks its own slow level and derives its own gain.
    const gain = [0, 0, 0];
    for (let z = 0; z < 3; z++) {
      const mean = zoneN[z] ? zoneSum[z] / zoneN[z] : 0;
      agc[z] = agc[z] * 0.9 + mean * 0.1;
      gain[z] = 0.62 / Math.max(0.1, agc[z]);
    }

    const bw = cw / bars;
    for (let i = 0; i < bars; i++) {
      const t = i / bars;
      let v = Math.min(1, raw[i] * gainAt(gain, t));
      v = Math.pow(v, 1.7); // gamma -> quiet/loud contrast
      const prev = smoothed[i];
      v = v > prev ? v * 0.7 + prev * 0.3 : v * 0.35 + prev * 0.65; // fast up, slow down
      smoothed[i] = v;
      const bh = Math.max(2, v * ch);
      g.fillStyle = `rgba(255,255,255,${0.1 + 0.75 * v})`;
      g.fillRect(i * bw + bw * 0.18, (ch - bh) / 2, bw * 0.64, bh);
    }
  };
}
