// Repro + non-regression for the blurred backdrop of the full-screen player
// (webapp/src/lib/backdrop.js, used by Mobile/DesktopNowPlaying).
//
//   node docs/repro/backdrop_staleness.mjs
//
// No browser, no server: `Image` is stubbed so every load is resolved by hand
// and the races below are deterministic instead of timing-dependent.
//
// The three symptoms this pins down were all "le fond flou ne se met pas
// toujours à jour", and all came from the same root cause — the old code
// returned early on "already showing that art" / "already preloading it"
// WITHOUT cancelling the preload or retry it had started for the track the
// user just left:
//
//   1. skip forward then straight back  -> the abandoned preload lands and
//      paints the track you are NOT on, permanently;
//   2. same through the 1.5 s error retry;
//   3. an image request that hangs (fires neither load nor error, which no
//      timeout covered) -> the backdrop never leaves the previous track.

const pending = [];
globalThis.Image = class {
  constructor() {
    this.onload = null;
    this.onerror = null;
    this.complete = false;
    this.naturalWidth = 0;
    pending.push(this);
  }
  set src(v) {
    this._src = v;
  }
  get src() {
    return this._src;
  }
  removeAttribute() {
    this._src = null;
    this.aborted = true;
  }
  finish() {
    this.complete = true;
    this.naturalWidth = 500;
    this.onload && this.onload();
  }
  fail() {
    this.onerror && this.onerror();
  }
};

const { createBackdrop } = await import("../../webapp/src/lib/backdrop.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(name, got, want) {
  const ok = got === want;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  got=${got} want=${want}`}`);
}
const topOf = (layers) => (layers.length ? layers[layers.length - 1].url : null);

// -- 1. skip forward, then back before the preload lands ---------------------
{
  pending.length = 0;
  const bg = createBackdrop({ fadeMs: 10, timeoutMs: 50 });
  let layers = [];
  bg.subscribe((l) => (layers = l));

  bg.set("A");
  pending.pop().finish();
  await sleep(20);
  check("A is on screen", topOf(layers), "A");

  bg.set("B"); // B starts preloading
  const bImg = pending.pop();
  bg.set("A"); // user goes back before B decoded
  check("B's preload was aborted", bImg.aborted, true);
  bImg.finish(); // ...and even if it lands anyway
  await sleep(20);
  check("backdrop stayed on A", topOf(layers), "A");
  bg.destroy();
}

// -- 2. same, through the error retry ----------------------------------------
{
  pending.length = 0;
  const bg = createBackdrop({ fadeMs: 10, timeoutMs: 500 });
  let layers = [];
  bg.subscribe((l) => (layers = l));

  bg.set("A");
  pending.pop().finish();
  await sleep(20);

  bg.set("B");
  pending.pop().fail(); // B errors -> retry scheduled
  bg.set("A"); // back to A while the retry is pending
  await sleep(1500);
  check("no retry landed for the abandoned cover", topOf(layers), "A");
  check("no image was created for the retry", pending.length, 0);
  bg.destroy();
}

// -- 3. an image request that hangs ------------------------------------------
{
  pending.length = 0;
  const bg = createBackdrop({ fadeMs: 10, timeoutMs: 60 });
  let layers = [];
  bg.subscribe((l) => (layers = l));

  bg.set("A");
  pending.pop().finish();
  await sleep(20);

  bg.set("B");
  pending.pop(); // B hangs: never load, never error
  // Poll for the retry: it gets its own watchdog, so waiting a fixed time
  // would catch it already timed out again.
  let retry = null;
  for (let i = 0; i < 200 && !retry; i++) {
    await sleep(10);
    retry = pending.pop() || null;
  }
  check("the watchdog scheduled a retry", !!retry, true);
  check("the retry is cache-busted", /\?r=1$/.test(retry.src), true);
  retry.finish();
  await sleep(20);
  check("backdrop caught up to B", topOf(layers), "B");
  bg.destroy();
}

// -- 4. rapid skipping keeps the layer stack bounded -------------------------
// A dozen live `blur(60px)` full-screen layers is enough on its own to drag
// the view to a crawl, so the cap matters as much as the correctness.
{
  pending.length = 0;
  const bg = createBackdrop({ fadeMs: 10000, timeoutMs: 500 });
  let layers = [];
  bg.subscribe((l) => (layers = l));
  for (const u of ["A", "B", "C", "D", "E"]) {
    bg.set(u);
    pending.pop().finish();
  }
  check("layer stack stays bounded", layers.length <= 2, true);
  check("newest cover is on top", topOf(layers), "E");
  bg.destroy();
}

// -- 5. a track with no art keeps the previous backdrop ----------------------
{
  pending.length = 0;
  const bg = createBackdrop({ fadeMs: 10, timeoutMs: 500 });
  let layers = [];
  bg.subscribe((l) => (layers = l));
  bg.set("A");
  pending.pop().finish();
  await sleep(20);
  bg.set(null);
  await sleep(20);
  check("backdrop kept on an artless track", topOf(layers), "A");
  bg.set("B");
  pending.pop().finish();
  await sleep(20);
  check("art after an artless track paints", topOf(layers), "B");
  bg.destroy();
}

// -- 6. destroy() stops everything -------------------------------------------
{
  pending.length = 0;
  const bg = createBackdrop({ fadeMs: 10, timeoutMs: 30 });
  let layers = [];
  bg.subscribe((l) => (layers = l));
  bg.set("A");
  const img = pending.pop();
  bg.destroy();
  check("destroy aborted the preload", img.aborted, true);
  img.finish();
  await sleep(80);
  check("nothing painted after destroy", layers.length, 0);
}

console.log(failures ? `\n${failures} FAILURE(S)` : "\nall green");
process.exit(failures ? 1 : 0);
