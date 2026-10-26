#!/usr/bin/env node
// What a CLICK costs before the screen answers it, in a real browser.
//
//   npm run build && node test/clicks/run.mjs          # 4x CPU throttle, 5 rounds
//   THROTTLE=1 N=9 PHONE=1 node test/clicks/run.mjs
//
// Each action is measured with the Event Timing API: from the input to the
// next frame painted after its handlers ran (what Chrome calls INP), plus the
// long tasks (> 50 ms) in the second after it. Median of the rounds.
import { loadPlaywright, startServer, login, silence } from "../harness.mjs";

const { chromium } = await loadPlaywright();
const THROTTLE = +(process.env.THROTTLE || 4);
const N = +(process.env.N || 5);
const PHONE = process.env.PHONE === "1";
const { base, stop } = await startServer();
const browser = await chromium.launch({
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--autoplay-policy=no-user-gesture-required"],
});
const ctx = await browser.newContext(
  PHONE
    ? { viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }
    : { viewport: { width: 1440, height: 900 } }
);
// Deezer's CDN and public API are never reached by a bench: matched on the HOSTNAME, not the URL text.
const deezerHost = (u) => u.hostname === "api.deezer.com" || u.hostname.endsWith(".dzcdn.net");
await ctx.route(deezerHost, (r) => r.abort());
const wav = silence(120);
await ctx.route(/\/api\/stream\//, (r) =>
  r.fulfill({ status: 200, body: wav, headers: { "Content-Type": "audio/wav", "Content-Length": String(wav.length) } })
);
await ctx.addInitScript(() => {
  window.__ev = [];
  window.__long = [];
  // When the screen last CHANGED: a screen that paints at once and then fills
  // in from a cache is a click that is not finished.
  window.__mut = 0;
  // The routed screen and the full-screen player, not the player bar's clock.
  const mo = new MutationObserver((list) => {
    for (const m of list) {
      const n = m.target.nodeType === 1 ? m.target : m.target.parentElement;
      if (n && n.closest && n.closest("main, .d, .m, .sheet")) {
        window.__mut = performance.now();
        return;
      }
    }
  });
  addEventListener("DOMContentLoaded", () =>
    mo.observe(document.body, { childList: true, subtree: true, characterData: true })
  );
  try {
    new PerformanceObserver((l) =>
      l.getEntries().forEach((e) => window.__ev.push({ name: e.name, at: e.startTime, d: e.duration, p: e.processingEnd - e.processingStart }))
    ).observe({ type: "event", durationThreshold: 16, buffered: true });
    new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__long.push({ at: e.startTime, d: e.duration }))).observe({
      entryTypes: ["longtask"],
    });
  } catch {
    /* no observer */
  }
});
// The page saves its own (empty) session as it unloads, so a queue is put in
// BEFORE the app starts.
await ctx.addInitScript(() => {
  const j = sessionStorage.getItem("__inject");
  if (j) {
    localStorage.setItem("player.session", j);
    localStorage.removeItem("player.pos");
    sessionStorage.removeItem("__inject");
  }
});
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("pageerror:", e.message));
await login(page, base);
await page.goto(base + "/app/#/");
// A queue, so the full-screen player has a track to show.
await page.evaluate(() => {
  const song = (id) => ({
    deezer_id: id, title: "Song " + id, duration: 120,
    artist: { deezer_id: "a1", name: "Band" }, album: { deezer_id: "al1", title: "Album", cover: "" },
  });
  sessionStorage.setItem("__inject", JSON.stringify({
    queue: [song("s1"), song("s2"), song("s3")], index: 0, start: 0, currentTime: 0, context: null,
    shuffle: false, repeat: "off", _orig: null, at: Date.now(),
  }));
});
await page.reload();
await page.waitForTimeout(2500);
// Playing, as when the reports were made: the full-screen player's animation runs.
await page.locator("footer.player .pp, .mini .pp, button.pp").first().click();
await page.waitForTimeout(1500);
const cdp = await ctx.newCDPSession(page);
await cdp.send("Emulation.setCPUThrottlingRate", { rate: THROTTLE });

// PROFILE="<label>": the CPU profile of that action (first round), its
// heaviest functions by self time — where the time goes, not just how much.
const PROFILE = process.env.PROFILE || "";
// ONLY="<label prefix>": measure just those actions (the others still run).
const ONLY = process.env.ONLY || "";
async function measure(label, act, settle = 1000) {
  const prof = PROFILE && label.startsWith(PROFILE) && !results[label];
  if (prof) {
    await cdp.send("Profiler.enable");
    await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
    await cdp.send("Profiler.start");
  }
  const t0 = await page.evaluate(() => performance.now());
  await act();
  await page.waitForTimeout(settle);
  if (prof) {
    const { profile } = await cdp.send("Profiler.stop");
    const dt = profile.timeDeltas;
    const self = new Map();
    const byId = new Map(profile.nodes.map((n) => [n.id, n]));
    for (let i = 0; i < profile.samples.length; i++) {
      const n = byId.get(profile.samples[i]);
      const cf = n.callFrame;
      if (cf.functionName === "(idle)" || cf.functionName === "(program)") continue;
      const key = `${cf.functionName || "(anon)"} ${cf.url.split("/").pop()}:${cf.lineNumber + 1}`;
      self.set(key, (self.get(key) || 0) + (dt[i + 1] || 0) / 1000);
    }
    console.log(`\nprofile of "${label}" (self ms, throttled):`);
    for (const [k, v] of [...self].sort((a, b) => b[1] - a[1]).slice(0, 30)) console.log(`  ${v.toFixed(1).padStart(7)}  ${k}`);
    // Who forces a layout: the callers of the browser's layout reads.
    const parent = new Map();
    for (const n of profile.nodes) for (const c of n.children || []) parent.set(c, n.id);
    const callers = new Map();
    for (let i = 0; i < profile.samples.length; i++) {
      const n = byId.get(profile.samples[i]);
      if (!/getBoundingClientRect|offsetHeight|clientHeight|scrollHeight|getComputedStyle/.test(n.callFrame.functionName)) continue;
      const chain = [];
      for (let id = parent.get(n.id); id && chain.length < 4; id = parent.get(id)) {
        const f = byId.get(id).callFrame;
        chain.push(`${f.functionName || "(anon)"}:${f.lineNumber + 1}`);
      }
      const key = chain.join(" < ");
      callers.set(key, (callers.get(key) || 0) + (dt[i + 1] || 0) / 1000);
    }
    // Inclusive time per function of the app (what a call and everything under it cost).
    const incl = new Map();
    for (let i = 0; i < profile.samples.length; i++) {
      const seen = new Set();
      for (let id = profile.samples[i]; id; id = parent.get(id)) {
        const f = byId.get(id).callFrame;
        if (!f.url.includes("/assets/")) continue;
        const key = `${f.functionName || "(anon)"} ${f.url.split("/").pop()}:${f.lineNumber + 1}`;
        if (seen.has(key)) continue;
        seen.add(key);
        incl.set(key, (incl.get(key) || 0) + (dt[i + 1] || 0) / 1000);
      }
    }
    if (process.env.INCL)
      for (const [k, v] of [...incl].sort((a, b) => b[1] - a[1]).slice(0, 40)) console.log(`  incl ${v.toFixed(1).padStart(7)}  ${k}`);
    for (const [k, v] of [...callers].sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`  layout ${v.toFixed(1).padStart(6)}  ${k}`);
  }
  const r = await page.evaluate((t0) => {
    const ev = window.__ev.filter((e) => e.at >= t0 && /click|pointerup|pointerdown|keydown/.test(e.name));
    const inp = ev.reduce((m, e) => Math.max(m, e.d), 0);
    const long = window.__long.filter((e) => e.at >= t0).reduce((s, e) => s + e.d, 0);
    const done = window.__mut > t0 ? window.__mut - t0 : 0;
    return { inp, long, done };
  }, t0);
  if (!ONLY || label.startsWith(ONLY)) (results[label] ||= []).push(r);
}
const results = {};
const nav = (href) => () => page.locator(`${PHONE ? "nav.mobilenav" : "nav.sidebar"} a[href="#${href}"]`).first().click();
const med = (xs) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];

for (let round = 0; round < N; round++) {
  await measure("nav: Accueil", nav("/"));
  await measure("nav: Rechercher", nav("/search"));
  await measure("nav: Bibliothèque", nav("/library"));
  const chip = (name) => () => page.getByRole("tab", { name, exact: true }).first().click();
  await measure("biblio: Artistes", chip("Artistes"));
  await measure("biblio: Albums", chip("Albums"));
  await measure("biblio: Podcasts", chip("Podcasts"));
  await measure("nav: Réglages", nav("/settings"));
  await measure("nav: Accueil (2)", nav("/"));
  const open = PHONE ? ".mini .now, footer.player .now" : "footer.player button.max";
  await measure("plein écran: ouvrir", () => page.locator(open).first().click(), 1500);
  // SHOTS=<dir>: the full-screen player as each opening leaves it (the second
  // one runs on the canvas the first handed back).
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/fullscreen-${round + 1}.png` });
  await measure("plein écran: fermer", () => page.locator('button[aria-label="Réduire"]').first().click(), 1500);
}
console.log(`\n${PHONE ? "phone" : "desktop"}, ${THROTTLE}x throttle, median of ${N}:`);
for (const [k, rs] of Object.entries(results))
  console.log(`  ${k.padEnd(24)} click→paint ${String(Math.round(med(rs.map((r) => r.inp)))).padStart(5)} ms   settled ${String(Math.round(med(rs.map((r) => r.done)))).padStart(5)} ms   long tasks ${String(Math.round(med(rs.map((r) => r.long)))).padStart(5)} ms`);
await browser.close();
stop();
