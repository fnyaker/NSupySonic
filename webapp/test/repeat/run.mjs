#!/usr/bin/env node
// Repeat, on the <audio> element the browser really plays: a 4-second track,
// left to run for several of its lengths, must come round again and again —
// and never move on — whatever the settings around it (the trimmed ending, the
// crossfade, a queue of one or of two, a stream that cannot seek).
//
//   npm run build && node test/repeat/run.mjs
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPlaywright, startServer, silence, login, checker } from "../harness.mjs";

const { chromium } = await loadPlaywright();
const LEN = 4;
const wav = silence(LEN);
// An ARCHIVED track is served by the real server from a real file (send_file:
// byte ranges, seekable) — the common case, and the one the route below cannot
// imitate (a fulfilled body is cached whole by the media stack). A track heard
// for the first time is a live stream with no ranges, which the route stands in for.
const wavPath = join(mkdtempSync(join(tmpdir(), "nsrepeat-")), "track.wav");
writeFileSync(wavPath, wav);
const { base, ids, stop } = await startServer(["--audio", wavPath]);
const { check, state } = checker();
const ONLY = process.argv.find((a) => a.startsWith("--only="))?.slice(7);

const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });

const song = (id) => ({ deezer_id: id, title: "Song " + id, duration: LEN, artist: { deezer_id: "a1", name: "Band" }, album: { deezer_id: "al1", title: "Album", cover: "" } });

async function scenario(name, { queue = ["s1"], index = 0, repeat = "one", settings = {}, edges = null, ranges = true, watch = 15 }) {
  if (ONLY && !name.includes(ONLY)) return;
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.route(/dzcdn\.net|api\.deezer\.com/, (r) => r.abort());
  let streams = 0;
  await ctx.route(/\/api\/stream\//, (r) => {
    streams++;
    if (ranges) return r.continue();
    return r.fulfill({ status: 200, body: wav, headers: { "Content-Type": "audio/wav", "Accept-Ranges": "none" } });
  });
  await ctx.route(/\/api\/audio\/edges\//, (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(edges ? { ready: true, duration: LEN, ...edges } : { ready: false, duration: LEN }) })
  );
  await ctx.addInitScript(() => {
    const Native = window.Audio;
    window.__els = [];
    window.Audio = function (...a) {
      const el = new Native(...a);
      window.__els.push(el);
      const k = window.__els.length;
      if (localStorage.getItem("__trace"))
        for (const ev of ["play", "playing", "pause", "seeking", "seeked", "ended", "emptied", "loadstart", "loadedmetadata", "canplay", "waiting", "error"])
          el.addEventListener(ev, () => console.log("EV", k, ev, el.currentTime.toFixed(3), el.paused ? "paused" : "", (el.src || "").slice(-30)));
      return el;
    };
    window.Audio.prototype = Native.prototype;
  });
  await ctx.addInitScript(() => {
    try {
      const j = sessionStorage.getItem("__inject");
      if (j) {
        const { session, settings } = JSON.parse(j);
        localStorage.setItem("player.session", JSON.stringify(session));
        localStorage.setItem("player.repeat", JSON.stringify(session.repeat));
        localStorage.removeItem("player.pos");
        for (const [k, v] of Object.entries(settings)) localStorage.setItem(k, JSON.stringify(v));
        sessionStorage.removeItem("__inject");
      }
    } catch {
      /* no storage */
    }
  });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("pageerror:", e.message));
  if (process.env.TRACE) page.on("console", (m) => m.text().startsWith("EV") && console.log(m.text()));
  await login(page, base);
  // Archived: the server's own tracks; live: ids only the route answers.
  const tracks = queue.map((q, k) => song(ranges ? ids.ids[k] : q));
  const session = { queue: tracks, index, start: 0, currentTime: 0, context: null, shuffle: false, repeat, _orig: null, at: Date.now() };
  await page.evaluate((j) => sessionStorage.setItem("__inject", j), JSON.stringify({ session, settings }));
  if (process.env.TRACE) await page.evaluate(() => localStorage.setItem("__trace", "1"));
  await page.reload();
  await page.waitForFunction(() => document.querySelector("footer.player .pp"), null, { timeout: 30000 });
  await page.waitForTimeout(500);
  await page.locator("footer.player .pp").click();
  // Read the playing element every 100 ms: each time it comes back round to
  // its start, from where did it leave? A pass has to have reached its end (the
  // trimmed one when the silence is cut) — a jump back from the middle, or an
  // element sitting on its end, is exactly the fault this exists for.
  const end = edges?.end ?? LEN;
  const t0 = Date.now();
  let loops = 0, early = [], last = null, idle = 0, titles = new Set();
  while (Date.now() - t0 < watch * 1000) {
    await page.waitForTimeout(100);
    const s = await page.evaluate(() => {
      const el = window.__els.find((e) => e.src && !e.paused && !e.ended);
      return { t: el ? el.currentTime : null, title: document.querySelector("footer.player .info .t")?.textContent };
    });
    if (process.env.TRACE) console.log((Date.now() - t0) / 1000, s.t);
    titles.add(s.title);
    // Nothing advancing: no element playing, or one parked on the same spot.
    if (s.t == null || (last != null && Math.abs(s.t - last) < 0.01)) idle++;
    if (last != null && s.t != null && s.t < last - 0.5) {
      if (last >= end - 0.45) loops++;
      else early.push(last.toFixed(2));
    }
    if (s.t != null) last = s.t;
  }
  const loopsBack = repeat === "one" || queue.length === 1;
  const want = loopsBack ? Math.floor(watch / end) - 1 : 0;
  const detail = `${loops} pass(es) in ${watch} s of a ${end} s track, ${(idle / 10).toFixed(1)} s standing still, ${streams} stream request(s)`;
  check(loops >= want && loops <= Math.ceil(watch / end), `${name}: comes round again at its end`, detail);
  check(early.length === 0, `${name}: never jumps back from the middle`, early.join(", ") || "none");
  // The first second is the load; anything past it is a gap between passes.
  check(idle <= 12, `${name}: no dead air between passes`, `${(idle / 10).toFixed(1)} s`);
  if (repeat === "one") check(titles.size === 1, `${name}: and stays on its track`, [...titles].join(", "));
  await ctx.close();
}

const XF = { "fade.enabled": true, "fade.seconds": 2 };
await scenario("repeat one, a queue of one", {});
await scenario("repeat one, the next track waiting", { queue: ["s1", "s2"] });
await scenario("repeat one, a live stream (first play)", { ranges: false });
await scenario("repeat one, a live stream, the next track waiting", { queue: ["s1", "s2"], ranges: false });
await scenario("repeat one, the silence trimmed off the end", { edges: { start: 0, end: 3.0 } });
await scenario("repeat one, crossfade on", { queue: ["s1", "s2"], settings: XF });
await scenario("repeat one, crossfade on and the ending trimmed", { queue: ["s1", "s2"], edges: { start: 0, end: 3.0 }, settings: XF });
await scenario("repeat all, a queue of one", { repeat: "all" });
await scenario("repeat all, a queue of one, crossfade on", { repeat: "all", settings: XF });
await scenario("repeat all, a live stream, a queue of one", { repeat: "all", ranges: false });

await browser.close();
stop();
process.exit(state.failed ? 1 : 0);
