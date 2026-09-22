// Offline checks for the post pass (lib/viz/post.js).
//
// Two things in there are worth pinning and neither is visible from a
// screenshot. The first is the EXPOSURE contract: every world was calibrated
// against a frame mean with no bloom in the picture, so switching one on has to
// take the same light back out of the scene or the whole catalogue drifts
// bright — measured, that was techno going from 0.113 to 0.292 with four per
// cent of the frame clipped. The second is the SELF-TUNING: these are all
// canvas-to-canvas blits, free on a GPU and hopeless on a software rasteriser,
// and which one a user has cannot be known from here. The pass measures itself
// and steps down, and a step-down that went straight to "off" would throw away
// the cheaper levels that most struggling devices can still afford.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createPost, withPostGain, POST, SCENE_GAIN, BUDGET_MS } from "../src/lib/viz/post.js";

// A canvas that records what was asked of it and draws nothing. Everything the
// pass does is a filter string, an alpha and a drawImage, so this is enough to
// watch it work.
function stubCanvas(w, h, onDraw = null) {
  const calls = [];
  const ctx = {
    filter: "none",
    globalAlpha: 1,
    globalCompositeOperation: "source-over",
    drawImage(src, ...rest) {
      onDraw?.(src);
      calls.push({
        op: "draw",
        from: src && src.__name,
        filter: this.filter,
        alpha: this.globalAlpha,
        gco: this.globalCompositeOperation,
        args: rest,
      });
    },
    clearRect() {
      calls.push({ op: "clear" });
    },
    createImageData(iw, ih) {
      return { data: new Uint8ClampedArray(iw * ih * 4), width: iw, height: ih };
    },
    putImageData() {},
  };
  return {
    width: w,
    height: h,
    __calls: calls,
    getContext: () => ctx,
    toDataURL: () => "data:image/png;base64,stub",
  };
}

function rig({ costMs = 0, tier = "ultra" } = {}) {
  let t = 0;
  const made = [];
  const make = (w, h) => {
    const c = stubCanvas(w, h);
    c.__name = `scratch${made.length}`;
    made.push(c);
    return c;
  };
  // Every run advances the clock by `costMs`, which is what the pass measures.
  const now = () => t;
  const post = createPost(make, { now });
  const scene = stubCanvas(1600, 900);
  scene.__name = "scene";
  // The cost is charged mid-flight, which is the only place the pass can see
  // it: it reads the clock on entry and again on exit. The frame is read
  // exactly once a run, so billing that one draw bills the run.
  const bloom = stubCanvas(1, 1, (src) => {
    if (src && src.__name === "scene") t += costMs;
  });
  bloom.__name = "bloom";
  post.resize(scene, bloom, 1600, 900, tier);
  const frame = () => post.run();
  return { post, scene, bloom, frame, made };
}

test("the scene gives back exactly what the bloom will add", () => {
  // The contract the whole catalogue's calibration rests on. A tier with a post
  // level dims the scene; the one without leaves it alone.
  for (const tier of Object.keys(POST)) {
    const base = { glow: 1, particles: 10 };
    const out = withPostGain(base, tier);
    assert.equal(out.glow, SCENE_GAIN[tier], `${tier} glow`);
    assert.equal(out.particles, 10, `${tier} must not touch anything else`);
    if (SCENE_GAIN[tier] !== 1)
      assert.notEqual(out, base, "a dimmed preset is a copy, never a mutation");
  }
  assert.equal(withPostGain({ glow: 1 }, "low").glow, 1, "no post means no dimming");
  // And the dimming has to be real where there IS a bloom: a gain of 1 on a
  // tier that blooms would be the bug this exists to prevent.
  for (const tier of ["medium", "high", "ultra"])
    assert.ok(SCENE_GAIN[tier] < 1, `${tier} blooms but keeps all its own light`);
});

test("the bloom never writes into the canvas the scene reads back", () => {
  // The feedback trap: a scene keeps its trail by washing over its own previous
  // frame, so anything the pass put there would come back as source material
  // and compound. The scene canvas must only ever be READ.
  const { post, scene, frame } = rig();
  frame();
  frame();
  assert.ok(scene.__calls.length === 0, "the pass drew into the scene canvas");
  assert.ok(post.active);
});

test("one read of the frame, and everything else small", () => {
  // The whole reason the design is a separate layer: full-frame canvas traffic
  // was the entire cost (27 ms a read, measured), so there is exactly one.
  const { bloom, frame } = rig();
  frame();
  const fromScene = bloom.__calls.filter((c) => c.from === "scene");
  assert.equal(fromScene.length, 1, "the frame should be read once per frame");
  // ...and that read is the bright pass and the downsample in one operation.
  assert.match(fromScene[0].filter, /brightness|contrast/);
  assert.deepEqual(fromScene[0].args.slice(2), [bloom.width, bloom.height]);
});

test("a slow device steps down before it gives up", () => {
  // Going straight to "off" throws away the levels a struggling device can
  // still afford — an eighth-size bloom with no fringe is a different
  // proposition from a fifth-size one with two.
  const { post, frame } = rig({ costMs: BUDGET_MS * 10 });
  const seen = [post.level];
  for (let i = 0; i < 400; i++) {
    frame();
    if (post.level !== seen[seen.length - 1]) seen.push(post.level);
    if (post.disabled) break;
  }
  assert.deepEqual(seen, ["ultra", "high", "medium", ""], `stepped: ${seen.join(" -> ")}`);
  assert.ok(post.disabled, "it should have given up at the end");
  assert.equal(post.active, false);
});

test("a fast device is never touched", () => {
  const { post, frame } = rig({ costMs: 0 });
  for (let i = 0; i < 400; i++) frame();
  assert.equal(post.level, "ultra");
  assert.equal(post.disabled, false);
});

test("the user's setting outranks the measurement", () => {
  // A step-down is this file's guess about the device. The quality control is
  // the person's decision, and re-selecting a tier has to start clean rather
  // than land back on whatever the guess settled for.
  const { post, bloom, scene, frame } = rig({ costMs: BUDGET_MS * 10 });
  for (let i = 0; i < 400 && !post.disabled; i++) frame();
  assert.ok(post.disabled);
  post.resize(scene, bloom, 1600, 900, "ultra");
  assert.equal(post.disabled, false);
  assert.equal(post.level, "ultra");
});

test("autoTune off means it never measures itself out", () => {
  // The seam the render harness uses: on a machine with no GPU at all the pass
  // is genuinely too slow, and a screenshot of it disabling itself is not a
  // screenshot of the effect.
  const post = createPost((w, h) => stubCanvas(w, h), { autoTune: false, now: () => 0 });
  const scene = stubCanvas(800, 600);
  const bloom = stubCanvas(1, 1);
  post.resize(scene, bloom, 800, 600, "ultra");
  for (let i = 0; i < 400; i++) post.run();
  assert.equal(post.disabled, false);
  assert.equal(post.level, "ultra");
});

test("every level is cheaper than the one above it", () => {
  // The step-down only helps if the next level down actually asks for less.
  const order = ["medium", "high", "ultra"];
  for (let i = 1; i < order.length; i++) {
    const lo = POST[order[i - 1]];
    const hi = POST[order[i]];
    assert.ok(hi.div <= lo.div, `${order[i]} should not shrink the frame further`);
    assert.ok(
      hi.wide + hi.fringe + hi.grain >= lo.wide + lo.fringe + lo.grain,
      `${order[i]} should not do less work than ${order[i - 1]}`
    );
  }
  assert.equal(POST.low, null, "the bottom tier gets no post at all");
});
