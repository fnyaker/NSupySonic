// What every modern visualizer has and this one did not: a post pass.
//
// The scenes were drawing flat additive strokes straight onto the output, and
// that is exactly the look the critique named — hairlines on black, hard edges,
// visible banding. None of it is any one scene's fault and none of it is
// fixable eighteen times over inside them: what separates a 1998 canvas demo
// from something that reads as lit is the pass that runs AFTER the drawing, on
// the whole frame at once.
//
//   BLOOM — bright areas bleed into their surroundings, which is what makes a
//   stroke read as light rather than as ink: a 2 px filament with a halo is a
//   laser, the same filament without one is a pen line. Done the way every
//   engine does it — isolate the highlights, shrink the frame, blur it small,
//   put it back big.
//
//   FRINGE — the wide halo goes down twice more, pulled a little to each side
//   and rotated in hue. Real glass does this; it is why a bright light
//   photographs with coloured edges.
//
//   GRAIN — sparse noise over everything, at a couple of levels out of 255.
//   Banding first, mood second: an 8-bit canvas cannot hold a smooth dark
//   gradient, and this project already knew that (the countable ring trails in
//   CLAUDE.md are the same problem from the other side). Noise below the eye's
//   integration threshold is a dither.
//
// NOT a vignette, deliberately. Darkening the edges is the other half of the
// stock recipe and it would undo what this engine was explicitly rebuilt for —
// filling a beamer instead of sitting in an inscribed circle. A frame that
// fades out at its border is a frame that does not fill the screen.
//
// ---------------------------------------------------------------------------
// WHY THE BLOOM IS A SEPARATE ELEMENT AND NOT A COMPOSITE ONTO THE CANVAS
//
// The obvious build — render the scene to an offscreen buffer, then copy it to
// the visible canvas and add the bloom on top — was measured at 45-52 ms a
// frame against 0.26 ms for the scene itself. Bisected, the cost was not the
// blur (0.21 ms, it is a 260x150 buffer) but the FULL-FRAME TRAFFIC: reading
// the scene canvas cost 27 ms and the full-size upscale another 14 ms. Three
// full-frame canvas-to-canvas operations per frame is the whole bill, and the
// tier made almost no difference because none of it was in the extras.
//
// So the scene keeps drawing straight onto the visible canvas exactly as it
// always did — no copy, no offscreen, and the trail it washes over is its own
// as before. The bloom is a SECOND, SMALL canvas laid over it, stretched to fit
// and blended by CSS. That leaves one full-frame read (the downsample, which is
// irreducible — a bloom has to see the frame) instead of three, and hands the
// upscale and the blend to the compositor, which does them on the GPU for free
// and is the one piece of the browser guaranteed to be good at scaling a layer.
//
// It also removes the feedback trap for nothing: the bloom never lands in the
// canvas the next frame's wash reads back, so it cannot compound. Composited
// onto the scene it would have gone to white in about a second.
//
// ---------------------------------------------------------------------------
// AND IT MEASURES ITSELF, because the numbers above cannot be trusted to
// transfer. Every operation here is a canvas-to-canvas blit, which on a GPU is
// a texture read and on a software rasteriser is a memcpy of several megabytes
// — the same code is free on one and hopeless on the other, and which one a
// user has is not knowable from here. `hardwareConcurrency` does not say
// whether the compositor is accelerated.
//
// So `run` times itself over its first frames and, if it is eating the budget,
// steps DOWN a level and measures again — ultra to high to medium to nothing.
// A device that cannot afford a fifth-size bloom with a fringe on it may well
// afford an eighth-size one with neither, and going straight to off throws that
// away. That check has a property worth stating: timing
// canvas calls normally measures only how long they took to QUEUE, because the
// work is deferred — so on an accelerated device this reads ~0 and never trips,
// which is right. It only reads true when something forces the pipeline to
// synchronise, and that is exactly the case where the pass is too expensive.
// The measurement is honest precisely where it has to be.

// Per tier: how far down the bright pass shrinks the frame, how hard it blurs,
// how much comes back, and what else runs. `low` is null — a device that is
// already struggling gets the scene and nothing on top of it.
export const POST = {
  low: null,
  medium: { div: 8, blur: 2.6, tight: 0.24, wide: 0, grain: 0, fringe: 0 },
  high: { div: 6, blur: 3, tight: 0.26, wide: 0.14, grain: 0.55, fringe: 0 },
  ultra: { div: 5, blur: 3.4, tight: 0.28, wide: 0.16, grain: 0.7, fringe: 0.5 },
};

// The bright pass. Contrast is what isolates the highlights without a per-pixel
// loop: it pushes the dark two thirds of the range to black and leaves what was
// already bright — the threshold a shader would apply, in one filter string.
// Lower brightness and HIGHER contrast than the obvious settings, because the
// scenes underneath are already calibrated to a frame mean of 0.05-0.20: a
// bloom that picks up the mid-tones does not add a highlight, it adds a second
// copy of the whole picture. Measured, the first cut at these numbers took
// techno from 0.12 to 0.39 with 9% of the frame clipped.
const BRIGHT = 0.95;
const CONTRAST = 2.7;
// And NO saturation boost. Pushing it here was what collapsed every world to
// the same magenta: the bright pass runs on a frame that the palette has
// already coloured, so saturating it again only ever pulls toward whichever
// primary is nearest.
const BRIGHT_SAT = 1;
// The glow is graded away from the thing that cast it — warm on the tight halo,
// cool on the wide one. A halo in exactly the source's hue reads as a blur; one
// that has drifted reads as light that went through something.
const TIGHT_HUE = 8;
const WIDE_HUE = -14;
const FRINGE_HUE = 34;

export const GRAIN_TILE = 96;

// HOW MUCH LIGHT THE SCENE GIVES UP when the bloom is putting some of it back.
//
// Every world was calibrated against a target frame mean of 0.05-0.20 with
// almost nothing clipped, and it was calibrated with no bloom in the picture.
// Switching one on does not redistribute that light, it ADDS to it — measured,
// techno went from 0.113 to 0.292 and clipped four per cent of the frame. So
// the scene's own `glow` comes down by the same order the halo puts back, and
// the total stays where two hundred and twenty-seven skins were tuned to sit.
// The picture changes (a hard stroke becomes a core with a halo) and the
// exposure does not, which is the whole point.
export const SCENE_GAIN = { low: 1, medium: 0.86, high: 0.76, ultra: 0.7 };

/** A tier's preset, dimmed by whatever its post level will hand back. */
export function withPostGain(preset, tier) {
  const k = SCENE_GAIN[tier] ?? 1;
  return k === 1 ? preset : { ...preset, glow: preset.glow * k };
}

// How much of a frame the whole pass may have. A 60 Hz frame is 16.7 ms and the
// scene has to fit in it too; past this the effect is costing more than it is
// worth and the scene is better off without it.
export const BUDGET_MS = 5;
// What each level falls back to when it does not fit. `medium` failing means
// the device has no cheap path left and the pass goes away entirely.
const CHEAPER = { ultra: "high", high: "medium", medium: null };
// Frames to ignore first (the first compile/upload of a buffer is not its
// steady-state cost), then how many to average over.
const WARMUP = 5;
const WINDOW = 20;
// The averaged check needs 25 frames to decide, which on a device where the
// pass costs 25 ms is most of a second of jank before anything is done about
// it. So there is a fast path too: a handful of frames that are each several
// times over budget is not a measurement problem, it is an answer.
const PANIC_FACTOR = 3;
const PANIC_RUN = 5;

/** A tile of sparse noise as a data URI, for the CSS grain layer. */
export function grainDataUrl(make = defaultMake) {
  const c = make(GRAIN_TILE, GRAIN_TILE);
  const g = c.getContext("2d");
  const img = g.createImageData(GRAIN_TILE, GRAIN_TILE);
  const d = img.data;
  // Sparse, and weighted toward nothing. A uniform grey haze over the frame
  // lifts the blacks and costs more contrast than the dither is worth; cubing
  // the random keeps most cells dark and a few bright.
  for (let i = 0; i < d.length; i += 4) {
    const r = Math.random();
    const v = Math.round(r * r * r * 255);
    d[i] = d[i + 1] = d[i + 2] = v;
    d[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return c.toDataURL ? c.toDataURL("image/png") : "";
}

/**
 * `make(w, h)` builds a canvas — injected so this runs under a test as well as
 * in a browser. Everything else is allocated once per size and reused.
 */
export function createPost(make = defaultMake, { autoTune = true, now = null } = {}) {
  let cfg = null;
  let source = null; // the visible scene canvas, read once a frame
  let bloom = null; // the small canvas the CSS layer shows
  let bg = null;
  let scratch = null; // the wide halo, built from the tight one
  let sc = null;
  let w = 0;
  let h = 0;
  let srcW = 0;
  let srcH = 0;
  let level = "";
  let seen = 0;
  let total = 0;
  let bailed = false;
  let panic = 0;
  let onBail = null;
  // Injectable so a test can hand it a slow device without owning one.
  const clock =
    now ||
    (typeof performance !== "undefined" && performance.now
      ? () => performance.now()
      : () => Date.now());

  return {
    /** Called once if the pass turns itself off, so the host can drop the layers. */
    set onDisabled(fn) {
      onBail = fn;
    },
    /** True once the pass has measured itself out of the budget. */
    get disabled() {
      return bailed;
    },
    /** Which level it settled on — the host's tier, or whatever it stepped to. */
    get level() {
      return cfg ? level : "";
    },
    get active() {
      return !!cfg;
    },
    /** What the bloom layer should be scaled from, for the host's styles. */
    get size() {
      return { w, h };
    },

    /**
     * `sceneCanvas` is the visible one the scenes draw on; `bloomCanvas` is the
     * small overlay. Returns whether the pass is running at this tier.
     */
    resize(sceneCanvas, bloomCanvas, widthPx, heightPx, tier) {
      // A tier the host asks for outranks whatever this stepped itself down to:
      // the user moving the quality setting is a decision, not a measurement.
      level = POST[tier] ? tier : "";
      bailed = false;
      cfg = POST[tier] || null;
      source = sceneCanvas;
      bloom = bloomCanvas;
      if (!cfg || !sceneCanvas || !bloomCanvas) {
        cfg = null;
        return false;
      }
      // A new size is a new measurement: a window that was affordable on a
      // phone-sized canvas says nothing about the same scene on a beamer.
      seen = 0;
      total = 0;
      panic = 0;
      srcW = widthPx;
      srcH = heightPx;
      w = Math.max(2, Math.round(widthPx / cfg.div));
      h = Math.max(2, Math.round(heightPx / cfg.div));
      if (bloom.width !== w || bloom.height !== h) {
        bloom.width = w;
        bloom.height = h;
      }
      bg = bloom.getContext("2d", { alpha: true });
      scratch = make(w, h);
      sc = scratch.getContext("2d", { alpha: true });
      return true;
    },

    clear() {
      bg?.clearRect(0, 0, w, h);
    },

    /**
     * One read of the frame, then everything else at a fifth of the size.
     * `intensity` scales the result so the bloom winds down with the fade.
     */
    run(intensity = 1) {
      if (!cfg || !source || !bg) return;
      // A separate flag, not the timestamp: `clock()` may legitimately return
      // 0 (performance.now() is milliseconds since the page loaded, and an
      // injected clock starts wherever it likes), and testing the reading for
      // truthiness silently skipped the measurement when it did.
      const timing = autoTune && seen < WARMUP + WINDOW;
      const t0 = timing ? clock() : 0;

      // The bright pass AND the downsample in one operation: the only time all
      // frame's pixels are touched.
      bg.globalCompositeOperation = "copy";
      bg.globalAlpha = 1;
      bg.filter = `brightness(${BRIGHT}) contrast(${CONTRAST}) saturate(${BRIGHT_SAT})`;
      bg.drawImage(source, 0, 0, w, h);

      // The tight halo, graded warm inside the same filter chain — a separate
      // grade would be a separate pass for nothing.
      sc.globalCompositeOperation = "copy";
      sc.globalAlpha = 1;
      sc.filter = `blur(${cfg.blur}px) hue-rotate(${TIGHT_HUE}deg) saturate(1.1)`;
      sc.drawImage(bloom, 0, 0);
      sc.filter = "none";

      bg.filter = "none";
      bg.globalAlpha = cfg.tight * intensity;
      bg.drawImage(scratch, 0, 0);

      if (cfg.wide) {
        // The wide halo is the tight one blurred again rather than a second
        // pass over the source: it is already small, so this is nearly free,
        // and two radii together give a falloff one cannot.
        sc.globalCompositeOperation = "copy";
        sc.filter = `blur(${cfg.blur * 2.2}px) hue-rotate(${WIDE_HUE}deg) saturate(1.2)`;
        sc.drawImage(scratch, 0, 0);
        sc.filter = "none";
        bg.globalCompositeOperation = "lighter";
        bg.globalAlpha = cfg.wide * intensity;
        bg.drawImage(scratch, 0, 0);

        if (cfg.fringe) {
          // Subtle on purpose: fringing you can name is a filter, fringing you
          // cannot is a lens. Offset in SMALL pixels, so it costs nothing.
          const dx = Math.max(1, Math.round(w * 0.006));
          bg.globalAlpha = cfg.wide * cfg.fringe * intensity;
          bg.filter = `hue-rotate(${FRINGE_HUE}deg) saturate(1.6)`;
          bg.drawImage(scratch, -dx, 0);
          bg.filter = `hue-rotate(${-FRINGE_HUE}deg) saturate(1.6)`;
          bg.drawImage(scratch, dx, 0);
          bg.filter = "none";
        }
      }
      bg.globalAlpha = 1;
      bg.globalCompositeOperation = "source-over";

      if (timing) {
        const spent = clock() - t0;
        seen++;
        if (seen > WARMUP) total += spent;
        panic = spent > BUDGET_MS * PANIC_FACTOR ? panic + 1 : 0;
        const over = panic >= PANIC_RUN || (seen === WARMUP + WINDOW && total / WINDOW > BUDGET_MS);
        if (over) {
          // Never a scene tier step: the scene itself is fine and should keep
          // its particles. It is only the effect on top that this device cannot
          // afford, so only the effect gives ground.
          const next = CHEAPER[level] || null;
          seen = 0;
          total = 0;
          panic = 0;
          if (next && POST[next]) {
            level = next;
            cfg = POST[next];
            // The buffers are sized from `div`, so a cheaper level is a resize.
            w = Math.max(2, Math.round(srcW / cfg.div));
            h = Math.max(2, Math.round(srcH / cfg.div));
            bloom.width = w;
            bloom.height = h;
            scratch = make(w, h);
            sc = scratch.getContext("2d", { alpha: true });
          } else {
            bailed = true;
            cfg = null;
            bg.clearRect(0, 0, w, h);
            onBail?.();
          }
        }
      }
    },
  };
}

function defaultMake(wd, ht) {
  const c = document.createElement("canvas");
  c.width = wd;
  c.height = ht;
  return c;
}
