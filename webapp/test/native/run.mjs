#!/usr/bin/env node
// The Android app's player (lib/audio/nativeplayer.js ↔ NativeAudio.kt), driven
// by the real Player.svelte against the real server: the native side is a
// stand-in that answers like NativeAudio.kt does — commands applied in order,
// its state echoed with the last command's number, ticks four times a second,
// a delivery delay on every message — and plays the sound on a hidden <audio>
// of its own, so positions are real. Then: play, pause, seek, skip, a track
// ending into the next, the crossfade (two players at once), the setting
// switched off mid-song (handed back to the page's <audio>), and the Réglages
// card at the widths it lives in.
//
//   npm run build && node test/native/run.mjs [--shots <dir>]
import { writeFileSync, mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPlaywright, startServer, silence, login, checker } from "../harness.mjs";

const { chromium } = await loadPlaywright();
const LEN = 8;
const wavPath = join(mkdtempSync(join(tmpdir(), "nsnative-")), "track.wav");
writeFileSync(wavPath, silence(LEN));
const { base, ids, stop } = await startServer(["--audio", wavPath]);
const { check, state } = checker();
const shotsAt = process.argv.includes("--shots") ? process.argv[process.argv.indexOf("--shots") + 1] : null;
if (shotsAt) mkdirSync(shotsAt, { recursive: true });

const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
const song = (id, k) => ({
  deezer_id: id, title: "Song " + k, duration: LEN,
  artist: { deezer_id: "a1", name: "Band" }, album: { deezer_id: "al1", title: "Album", cover: "" },
});

// NativeAudio.kt, in the page: what the Kotlin side does, message for message.
function fakeApp() {
  const Real = window.Audio;
  const DELAY = 15; // binder + evaluateJavascript
  const slots = new Map();
  let next = 1;
  window.__fake = { cmds: [], made: 0, released: 0, slots };
  const emit = (id, s) => setTimeout(() => window.__nsAudio && window.__nsAudio(id, s), DELAY);
  function slot(id) {
    const el = new Real();
    el.preload = "auto";
    const sl = { id, el, c: 0, item: false, prepared: false, pwr: false, seek: false, ended: false, tick: null };
    const st = () => {
      if (!sl.item) return 1;
      if (sl.ended) return 4;
      return el.readyState >= 3 ? 3 : 2;
    };
    sl.send = (ev) => {
      const s = { c: sl.c, st: st(), p: sl.pwr, t: el.currentTime, b: el.buffered.length ? el.buffered.end(el.buffered.length - 1) : 0, sk: sl.item };
      if (sl.item && isFinite(el.duration) && el.duration > 0) s.d = el.duration;
      if (ev) s.ev = ev;
      emit(id, s);
    };
    let lastSt = 1;
    const onChange = () => {
      const now = st();
      if (now === lastSt) return;
      lastSt = now;
      if (now === 3 && sl.seek) {
        sl.seek = false;
        sl.send("seeked");
      } else sl.send(null);
    };
    for (const e of ["canplay", "canplaythrough", "waiting", "loadedmetadata", "durationchange"]) el.addEventListener(e, onChange);
    el.addEventListener("seeked", () => {
      if (sl.seek && st() === 3) {
        sl.seek = false;
        lastSt = 3;
        sl.send("seeked");
      }
    });
    el.addEventListener("ended", () => {
      sl.ended = true;
      onChange();
    });
    el.addEventListener("playing", () => {
      clearInterval(sl.tick);
      sl.tick = setInterval(() => !el.paused && sl.send("tick"), 250);
    });
    el.addEventListener("pause", () => clearInterval(sl.tick));
    el.addEventListener("error", () => emit(id, { c: sl.c, ev: "error", code: 2, msg: "fake" }));
    return sl;
  }
  // The APK under test: bridge 4 (the player alone) unless the bench says 6.
  const version = () => +(localStorage.getItem("__bridge") || 4);
  // The player itself breaking (the audio output refused, as ExoPlayer reports it).
  window.__fake.fail = () => {
    for (const sl of slots.values()) {
      if (sl.el.paused) continue;
      clearInterval(sl.tick);
      sl.el.pause();
      sl.pwr = false;
      emit(sl.id, { c: sl.c, ev: "error", code: 3, msg: "ERROR_CODE_AUDIO_TRACK_INIT_FAILED" });
    }
  };
  window.NSNative = {
    bridgeVersion: () => version(),
    appVersion: () => "1.6.0",
    naFx() {},
    naAnalysis() {},
    naAnalysisAvailable: () => version() >= 6,
    nativeAudio: () => true,
    naCreate(page) {
      const id = next++;
      window.__fake.made++;
      slots.set(id, slot(id));
      return id;
    },
    naCmd(id, json) {
      const o = JSON.parse(json);
      window.__fake.cmds.push(o.op);
      // Applied on the main looper: after the call returns.
      setTimeout(() => {
        const sl = slots.get(id);
        if (!sl) return;
        const el = sl.el;
        sl.c = Math.max(sl.c, o.c);
        switch (o.op) {
          case "src":
            sl.seek = false;
            sl.ended = false;
            sl.item = true;
            sl.pwr = false;
            el.pause();
            el.src = o.url;
            el.volume = o.v;
            el.playbackRate = o.r;
            el.load();
            sl.send(null);
            break;
          case "clear":
            sl.item = false;
            el.pause();
            el.removeAttribute("src");
            el.load();
            sl.send(null);
            break;
          case "play":
            if (sl.ended) {
              sl.ended = false;
              el.currentTime = 0;
            }
            sl.pwr = true;
            el.play().catch(() => {});
            sl.send(null);
            break;
          case "pause":
            sl.pwr = false;
            el.pause();
            sl.send(null);
            break;
          case "seek":
            sl.ended = false;
            sl.seek = true;
            el.currentTime = o.t;
            sl.send(null);
            break;
          case "volume":
            el.volume = o.v;
            break;
          case "rate":
            el.playbackRate = o.r;
            sl.send(null);
            break;
          case "release":
            clearInterval(sl.tick);
            el.pause();
            el.removeAttribute("src");
            slots.delete(id);
            window.__fake.released++;
            break;
        }
      }, 2);
    },
  };
  // The page's own <audio> elements, counted (what the setting OFF uses).
  window.__pageEls = 0;
  window.Audio = function (...a) {
    window.__pageEls++;
    return new Real(...a);
  };
  window.Audio.prototype = Real.prototype;
}

async function open(ctx, settings, queue) {
  // Deezer's CDN and API are never reached from the bench.
  const offline = (u) => {
    const h = new URL(u).hostname;
    return h === "api.deezer.com" || h === "dzcdn.net" || h.endsWith(".dzcdn.net");
  };
  await ctx.route(offline, (r) => r.abort());
  await ctx.addInitScript(fakeApp);
  await ctx.addInitScript(() => {
    const j = sessionStorage.getItem("__inject");
    if (!j) return;
    const { session, settings } = JSON.parse(j);
    localStorage.setItem("player.session", JSON.stringify(session));
    localStorage.removeItem("player.pos");
    for (const [k, v] of Object.entries(settings)) localStorage.setItem(k, JSON.stringify(v));
    sessionStorage.removeItem("__inject");
  });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("pageerror:", e.message));
  await login(page, base);
  const session = { queue, index: 0, start: 0, currentTime: 0, context: null, shuffle: false, repeat: "off", _orig: null, at: Date.now() };
  await page.evaluate((j) => sessionStorage.setItem("__inject", j), JSON.stringify({ session, settings }));
  await page.reload();
  await page.waitForFunction(() => document.querySelector("footer.player .pp"), null, { timeout: 30000 });
  await page.waitForTimeout(400);
  return page;
}
const where = (page) =>
  page.evaluate(() => {
    const p = window.__nsAudioPath();
    return {
      t: p.t, paused: p.paused, why: p.plan.why,
      title: document.querySelector("footer.player .info .t")?.textContent,
      playing: [...window.__fake.slots.values()].filter((s) => !s.el.paused).length,
      made: window.__fake.made, released: window.__fake.released, pageEls: window.__pageEls,
    };
  });

const queue = ids.ids.slice(0, 3).map((id, k) => song(id, k + 1));

{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await open(ctx, { "audio.native": true }, queue);
  let w = await where(page);
  check(w.why === "native", "the plan says the app's player", w.why);
  check(w.made >= 2 && w.pageEls === 0, "both elements are the app's players, no page <audio>", `${w.made} made, ${w.pageEls} page`);
  await page.locator("footer.player .pp").click();
  await page.waitForTimeout(1500);
  w = await where(page);
  check(!w.paused && w.t > 0.9 && w.playing === 1, "play: one player runs and the position moves", `t ${w.t?.toFixed(2)}, ${w.playing} playing`);
  const a = await where(page);
  await page.waitForTimeout(600);
  const b = await where(page);
  check(Math.abs(b.t - a.t - 0.6) < 0.15, "the page's clock follows the player between ticks", `${(b.t - a.t).toFixed(3)} s in 0.6 s`);
  await page.locator("footer.player .pp").click();
  await page.waitForTimeout(700);
  const p1 = await where(page);
  await page.waitForTimeout(700);
  const p2 = await where(page);
  check(p1.paused && p2.playing === 0 && Math.abs(p2.t - p1.t) < 0.01, "pause: nothing plays, the position holds", `${p1.t.toFixed(2)} → ${p2.t.toFixed(2)}`);
  await page.locator("footer.player .pp").click();
  await page.waitForTimeout(400);
  const nextBtn = page.locator('footer.player button[aria-label="Suivant"]').first();
  await nextBtn.click();
  await page.waitForTimeout(1200);
  w = await where(page);
  check(w.title === "Song 2" && w.t < 1.5 && !w.paused && w.playing === 1, "skip: the next track plays from its start on one player", `${w.title} at ${w.t?.toFixed(2)}, ${w.playing} playing`);
  // Let it run out into track 3.
  await page.waitForTimeout((LEN - w.t + 1.5) * 1000);
  w = await where(page);
  check(w.title === "Song 3" && w.t > 0.2 && w.t < 2.5 && !w.paused, "a track ending moves on to the next by itself", `${w.title} at ${w.t?.toFixed(2)}`);
  // The setting off, mid-song: handed back to a page <audio> at the same place.
  const before = await where(page);
  const tb = Date.now();
  await page.evaluate(() => (location.hash = "#/settings/playback"));
  await page.locator(".native-tg").click();
  await page.waitForTimeout(2500);
  w = await where(page);
  const ran = (Date.now() - tb) / 1000;
  check(w.why !== "native" && w.pageEls >= 1 && w.playing === 0 && !w.paused && Math.abs(w.t - before.t - ran) < 0.8,
    "the setting off mid-song: back on the page's <audio>, same place, no app player left playing",
    `${w.why}, ${w.pageEls} page el, ${w.playing} native playing, t ${before.t.toFixed(2)} → ${w.t?.toFixed(2)}, ${w.released} released`);
  await ctx.close();
}

{
  // The crossfade on the volumes: two players at once, then one.
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await open(ctx, { "audio.native": true, "fade.enabled": true, "fade.seconds": 3 }, queue);
  await page.locator("footer.player .pp").click();
  let both = 0;
  const t0 = Date.now();
  let w;
  while (Date.now() - t0 < (LEN + 0.7) * 1000) {
    await page.waitForTimeout(200);
    w = await where(page);
    if (w.playing === 2) both++;
  }
  check(both >= 5 && w.title === "Song 2" && w.playing === 1, "crossfade: both players heard together, then the next alone",
    `${(both * 0.2).toFixed(1)} s overlap, now ${w.title} on ${w.playing}`);
  await ctx.close();
}

{
  // Lot N6: nobody chose, and the app's player has the effects and the
  // animations (bridge 6): it plays. Then it fails under the song.
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await open(ctx, { __bridge: 6 }, queue);
  let w = await where(page);
  check(w.why === "native" && w.pageEls === 0, "bridge 6, no choice made: the app's player by default", `${w.why}, ${w.pageEls} page el`);
  await page.locator("footer.player .pp").click();
  await page.waitForTimeout(2500);
  const before = await where(page);
  const tb = Date.now();
  await page.evaluate(() => window.__fake.fail());
  await page.waitForTimeout(1500);
  w = await where(page);
  const ran = (Date.now() - tb) / 1000;
  check(w.why !== "native" && w.pageEls >= 1 && !w.paused && w.title === before.title && w.t > before.t - 0.3 && w.t < before.t + ran + 0.3,
    "the app's player fails: the page's carries the same song on from where it was",
    `${w.why}, ${w.pageEls} page el, ${before.title} ${before.t.toFixed(2)} → ${w.title} ${w.t?.toFixed(2)} in ${ran.toFixed(1)} s`);
  await page.waitForTimeout(1000);
  const w2 = await where(page);
  check(w2.t > w.t + 0.7 && w2.playing === 0, "and keeps playing, with no app player left running", `${w.t.toFixed(2)} → ${w2.t.toFixed(2)}, ${w2.playing} native`);
  // Réglages says so, with a way back.
  for (const [name, vp] of [["desktop", { width: 1280, height: 900 }], ["phone", { width: 390, height: 844 }]]) {
    await page.setViewportSize(vp);
    await page.evaluate(() => (location.hash = "#/settings/playback"));
    await page.waitForSelector(".native-fail");
    const card = page.locator("section.card", { has: page.locator(".out-seg") });
    const box = await card.boundingBox();
    const btn = await page.locator(".native-fail .g-retry").boundingBox();
    check(btn && btn.x >= box.x && btn.x + btn.width <= box.x + box.width + 0.5 && btn.height >= 36,
      `${name}: the failure is said under the switch, with its button inside the card`, btn ? `${btn.width.toFixed(0)}×${btn.height.toFixed(0)}` : "missing");
    const on = await page.locator(".native-tg").getAttribute("aria-checked");
    check(on === "true", `${name}: the switch still shows the setting (on)`, on);
    if (shotsAt) await card.screenshot({ path: join(shotsAt, `native-fail-${name}.png`) });
  }
  await page.locator(".native-fail .g-retry").click();
  await page.waitForTimeout(2500);
  w = await where(page);
  check(w.why === "native" && w.playing === 1 && !w.paused, "Réessayer: back on the app's player, still playing", `${w.why}, ${w.playing} native playing`);
  await ctx.close();
}

// The card in Réglages, where it lives.
for (const [name, vp] of [["desktop", { width: 1280, height: 900 }], ["phone", { width: 390, height: 844 }]]) {
  const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: 2 });
  const page = await open(ctx, { "audio.native": true }, queue);
  await page.evaluate(() => (location.hash = "#/settings/playback"));
  await page.waitForSelector(".out-seg");
  const card = page.locator("section.card", { has: page.locator(".out-seg") });
  const box = await card.boundingBox();
  const sw = await page.locator(".native-tg").boundingBox();
  check(sw && box && sw.x >= box.x && sw.x + sw.width <= box.x + box.width + 0.5 && sw.height >= 40,
    `${name}: the switch sits inside its card, a finger's height`, sw ? `${sw.width.toFixed(0)}×${sw.height.toFixed(0)}` : "missing");
  const status = await page.locator(".out-mode").textContent();
  check(status === "Lecteur Android", `${name}: the status names the app's player`, status);
  if (shotsAt) await card.screenshot({ path: join(shotsAt, `native-${name}.png`) });
  await ctx.close();
}

await browser.close();
stop();
console.log(state.failed ? `${state.failed} FAILED` : "all ok");
process.exit(state.failed ? 1 : 0);
