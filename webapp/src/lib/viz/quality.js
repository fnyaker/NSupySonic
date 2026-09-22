// Rendering effort, resolved once per view and then adapted at runtime.
//
// "auto" is the default because the right answer is a property of the device,
// not of the user's taste: the same scene that should run every particle on a
// desktop has to run a tenth of them on a five-year-old phone to stay at 60.
// Guessing from hardwareConcurrency + memory + screen size gets that right most
// of the time, and the adaptive step below catches the rest — a view that
// overruns its frame budget for a second drops a tier and stops overrunning,
// which is always better than a beautiful scene at 22 fps.

export const TIERS = ["low", "medium", "high", "ultra"];

// THE SCOPE'S TIMEBASE IS NOT A QUALITY SETTING. What the oscilloscope shows is
// a fixed slice of time (see scenes/scope.js#WINDOW_MS); what the tier changes
// is how PRECISELY that same slice is drawn. Widening the window at ultra would
// not be more precision, it would be a different picture — eight times as much
// waveform crammed into the same lane, which reads as noise.
//
// So four knobs, each a real step in accuracy rather than a step in effort:
//
//   buffer     the analyser's fftSize, and `search` how much of it (in ms) the
//   search     TRIGGER may hunt back through for a rising edge. This is what
//              keeps the trace STILL, and more of it is strictly more stable:
//              25 ms finds an edge in anything with a pulse, 250 ms still finds
//              one in a half-time passage or under a held pad, where the short
//              search gives up and the trace free-runs. Measured on a steady
//              tone, a triggered trace drifts 0.9 px a frame at low and
//              0.007 px at high against 86.5 px untriggered.
//   points     the ceiling on plotted columns. At 256 a 2000-sample window is
//              decimated eight to one and a hi-hat is a smooth suggestion; at
//              4096 nothing is decimated at all and a 4K beamer gets a column
//              per pixel.
//   exact      per-column MIN/MAX (what a real DSO draws) instead of
//              peak-preserving decimation, so nothing between two vertices is
//              invented.
//   fine       sub-sample trigger interpolation, and the fractional column ends
//              that carry it to the screen. One sample at 48 kHz is ~0.95 px of
//              horizontal jitter on a 1920-wide lane — a shimmer along the whole
//              trace. Measured on a steady tone: 1.03 px a frame at medium
//              against 0.007 px at high, a factor of 158.
//   interp     read the window at FRACTIONAL sample positions, so a lane with
//              more pixels than samples draws a resampled curve instead of a
//              stair-step. Ultra only: it is the last half-pixel of accuracy
//              and it costs a multiply per column.
//   passes     how many strokes build the beam. The core is never the one
//              dropped; what goes at the cheaper tiers is the middle body.
const SCOPE = {
  low: { buffer: 4096, search: 25, points: 256, exact: false, fine: false, interp: false, divisions: 4, passes: 2 },
  medium: { buffer: 4096, search: 40, points: 512, exact: false, fine: false, interp: false, divisions: 6, passes: 2 },
  high: { buffer: 8192, search: 120, points: 2048, exact: true, fine: true, interp: false, divisions: 8, passes: 3 },
  ultra: { buffer: 16384, search: 250, points: 4096, exact: true, fine: true, interp: true, divisions: 10, passes: 3 },
};

const PRESETS = {
  low: { dpr: 1, particles: 24, bars: 40, glow: 0.45, trail: 0.34, blur: 0, layers: 2, scope: SCOPE.low },
  medium: { dpr: 1.5, particles: 64, bars: 56, glow: 0.7, trail: 0.24, blur: 0, layers: 3, scope: SCOPE.medium },
  high: { dpr: 2, particles: 130, bars: 72, glow: 1, trail: 0.17, blur: 1, layers: 4, scope: SCOPE.high },
  ultra: { dpr: 2, particles: 240, bars: 96, glow: 1.25, trail: 0.12, blur: 1, layers: 5, scope: SCOPE.ultra },
};

export function autoTier() {
  if (typeof navigator === "undefined") return "medium";
  const cores = navigator.hardwareConcurrency || 4;
  const mem = navigator.deviceMemory || 4;
  const coarse =
    typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
  const wide = typeof window !== "undefined" && window.innerWidth >= 1100;
  let score = 0;
  score += cores >= 8 ? 2 : cores >= 6 ? 1 : cores >= 4 ? 0 : -1;
  score += mem >= 8 ? 2 : mem >= 4 ? 1 : 0;
  score += coarse ? -1 : 1; // a touch device is a phone often enough
  score += wide ? 1 : 0;
  if (score >= 5) return "ultra";
  if (score >= 3) return "high";
  if (score >= 1) return "medium";
  return "low";
}

export function resolveTier(setting) {
  return setting && setting !== "auto" && PRESETS[setting] ? setting : autoTier();
}

export function tierPreset(tier) {
  return PRESETS[tier] || PRESETS.medium;
}

// Watches frame times and steps the tier down (never up on its own — a scene
// that oscillates between two tiers is worse than one that settled on the lower
// one). `onChange` is called with the new tier.
export function createGovernor(startTier, onChange) {
  let tier = startTier;
  let over = 0;
  let frames = 0;
  return {
    get tier() {
      return tier;
    },
    reset(t) {
      tier = t;
      over = 0;
      frames = 0;
    },
    // `cost` is the milliseconds the last draw took.
    sample(cost, budgetMs) {
      frames++;
      if (frames < 30) return; // ignore the warm-up: first frames compile shaders,
      if (cost > budgetMs) over++; // build gradients and lay out fonts
      else over = Math.max(0, over - 1);
      if (over > 25) {
        const i = TIERS.indexOf(tier);
        if (i > 0) {
          tier = TIERS[i - 1];
          over = 0;
          frames = 0;
          onChange?.(tier);
        } else {
          over = 0;
        }
      }
    },
  };
}
