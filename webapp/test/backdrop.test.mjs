// The full-screen backdrop (lib/backdrop.js) on a cover that fails to load.
//
// A CDN image that fails is worth retrying: the Deezer image CDN drops
// requests. A blob: that fails is not — its bytes are already in the page, so
// whatever refused it (a page policy, a revoked URL) refuses it again, and the
// two retries cost 1.2 s + 2.4 s of the PREVIOUS track's backdrop. That was
// every track change on the Android app while the CSP refused blob: images.
import test from "node:test";
import assert from "node:assert/strict";

globalThis.window = { addEventListener() {}, location: { href: "http://x/" } };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };

// An <img> preloader that refuses blob: URLs and anything named "dead".
const requested = [];
globalThis.Image = class {
  constructor() {
    this.onload = this.onerror = null;
    this.complete = false;
    this.naturalWidth = 0;
  }
  removeAttribute() {}
  set src(u) {
    requested.push(u);
    setTimeout(() => {
      const ok = !u.startsWith("blob:") && !u.includes("dead");
      this.complete = true;
      this.naturalWidth = ok ? 500 : 0;
      (ok ? this.onload : this.onerror)?.();
    }, 1);
  }
};

const { createBackdrop } = await import("../src/lib/backdrop.js");
const { get } = await import("svelte/store");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test("a refused blob: goes straight to the same-origin copy", async () => {
  const bg = createBackdrop({ fadeMs: 5 });
  requested.length = 0;
  bg.set("blob:http://x/1f11969a", "/api/cover/689582032");
  await wait(50);
  assert.deepEqual(requested, ["blob:http://x/1f11969a", "/api/cover/689582032"]);
  const top = get(bg).at(-1);
  assert.equal(top.src, "/api/cover/689582032");
  assert.equal(top.url, "blob:http://x/1f11969a", "painted on behalf of the cover the track wants");
  bg.destroy();
});

test("a failing CDN image is still retried before falling back", async () => {
  const bg = createBackdrop({ fadeMs: 5 });
  requested.length = 0;
  bg.set("https://cdn/dead/500x500.jpg", "/api/cover/1");
  await wait(50);
  assert.deepEqual(requested, ["https://cdn/dead/500x500.jpg"], "the retry waits its back-off");
  bg.destroy();
});
