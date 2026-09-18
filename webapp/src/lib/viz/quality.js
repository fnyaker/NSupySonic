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

const PRESETS = {
  low: { dpr: 1, particles: 24, bars: 40, glow: 0.45, trail: 0.34, blur: 0, layers: 2 },
  medium: { dpr: 1.5, particles: 64, bars: 56, glow: 0.7, trail: 0.24, blur: 0, layers: 3 },
  high: { dpr: 2, particles: 130, bars: 72, glow: 1, trail: 0.17, blur: 1, layers: 4 },
  ultra: { dpr: 2, particles: 240, bars: 96, glow: 1.25, trail: 0.12, blur: 1, layers: 5 },
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
