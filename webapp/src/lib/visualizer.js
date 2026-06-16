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

// A self-contained bar renderer. Each consumer (desktop / mobile now-playing)
// calls createVisualizer() once and then draw(canvas) per animation frame, so
// the per-bar smoothing and auto-gain state stay isolated per view.
//
// Tuned for punch over a flat readout: a perceptual tilt pulls the bass down so
// it doesn't swamp the strip, a steep gamma exaggerates the gap between loud and
// quiet bands (more contrast), and a fast-attack / slow-release envelope keeps
// the bars lively instead of parked in the middle.
export function createVisualizer() {
  let freq = null;
  let smoothed = null;
  let agc = 0.15;

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
    const minBin = 3; // skip DC/rumble
    const maxBin = Math.floor(bins * 0.78);

    const raw = new Float32Array(bars);
    let frameSum = 0;
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
      // perceptual tilt: ~0.45× on the low end, ~1.4× on the high end.
      const r = ((n ? sum / n : 0) / 255) * (0.45 + 0.95 * t);
      raw[i] = r;
      frameSum += r;
    }

    agc = agc * 0.93 + (frameSum / bars) * 0.07;
    const gain = 0.6 / Math.max(0.12, agc);

    const bw = cw / bars;
    for (let i = 0; i < bars; i++) {
      let v = Math.min(1, raw[i] * gain);
      v = Math.pow(v, 1.9); // steep gamma -> strong weak/loud contrast
      const prev = smoothed[i];
      v = v > prev ? v * 0.7 + prev * 0.3 : v * 0.35 + prev * 0.65; // fast up, slow down
      smoothed[i] = v;
      const bh = Math.max(2, v * ch);
      g.fillStyle = `rgba(255,255,255,${0.1 + 0.75 * v})`;
      g.fillRect(i * bw + bw * 0.18, (ch - bh) / 2, bw * 0.64, bh);
    }
  };
}
