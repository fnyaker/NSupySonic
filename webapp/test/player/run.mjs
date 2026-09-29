#!/usr/bin/env node
// The sleep timer and the podcast speed, on the audio the browser really plays.
//
//   npm run build && node test/player/run.mjs
//
// Same server as test/queue/run.mjs. The queue is written straight into the
// saved session — two episodes of one show, then two songs — because nothing in
// that library is a podcast, and every stream is answered with silence. The
// page's clock is Playwright's: a sleep timer is minutes long, and the point
// is what the <audio> element does at each moment of it (its volume, whether it
// is paused), read off the element itself, not off what the UI claims.
import { loadPlaywright, startServer, silence, login, checker } from "../harness.mjs";

const { chromium } = await loadPlaywright();
const { base, stop } = await startServer();
const { check, state } = checker();
let wav = silence(60);

const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await ctx.route(/dzcdn\.net|api\.deezer\.com/, (r) => r.abort());
await ctx.route(/\/api\/stream\//, (r) =>
  r.fulfill({ status: 200, body: wav, headers: { "Content-Type": "audio/wav", "Accept-Ranges": "none" } })
);
// Every element the player makes, so its state can be read (they are never in the DOM).
await ctx.addInitScript(() => {
  const Native = window.Audio;
  window.__els = [];
  window.Audio = function (...a) {
    const el = new Native(...a);
    window.__els.push(el);
    return el;
  };
  window.Audio.prototype = Native.prototype;
});
// The player saves its own (empty) state as a page unloads, over anything a test
// wrote before reloading. So a session to start from is handed to the NEXT page
// through sessionStorage, and written by a script that runs before the app boots.
await ctx.addInitScript(() => {
  try {
    const j = sessionStorage.getItem("__inject");
    if (j) {
      localStorage.setItem("player.session", j);
      localStorage.removeItem("player.pos");
      sessionStorage.removeItem("__inject");
    }
  } catch {
    /* no storage */
  }
});
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("pageerror:", e.message));

const ep = (id, extra = {}) => ({
  deezer_id: id, title: "Episode " + id, duration: 60, podcast: true, channel_id: "c1",
  artist: { deezer_id: "c1", name: "Le Show" }, album: { deezer_id: "c1", title: "Le Show", cover: "" }, ...extra,
});
const song = (id) => ({ deezer_id: id, title: "Song " + id, duration: 60, artist: { deezer_id: "a1", name: "Band" }, album: { deezer_id: "al1", title: "Album", cover: "" } });
const session = (index = 0) => ({
  queue: [ep("e1"), ep("e2"), song("s1"), song("s2")], index, start: 0, currentTime: 0,
  context: null, shuffle: false, repeat: "off", _orig: null, at: Date.now(),
});

await login(page, base);
const inject = (s) => page.evaluate((j) => sessionStorage.setItem("__inject", j), JSON.stringify(s));
await inject(session());
await page.clock.install();
await page.reload();
await page.waitForFunction(() => document.querySelector("footer.player .pp"), null, { timeout: 30000 });
await page.waitForTimeout(800);

const live = () => page.evaluate(() => {
  const el = window.__els.find((e) => e.src && !e.paused) || window.__els.find((e) => e.src);
  return el ? { rate: el.playbackRate, volume: el.volume, paused: el.paused, ended: el.ended, t: el.currentTime } : null;
});
const title = () => page.locator("footer.player .info .t").first().textContent();
const play = () => page.locator("footer.player .pp").click();
const flush = () => page.clock.runFor(50);

// -- speed -------------------------------------------------------------------
await play();
await page.waitForFunction(() => window.__els.some((e) => e.src && !e.paused), null, { timeout: 15000 });
check((await title()) === "Episode e1", "the episode is playing");
check((await live()).rate === 1, "at normal speed to begin with");
check((await page.locator("footer.player .sp .trigger").count()) === 1, "the speed chip is there for an episode");

await page.locator("footer.player .sp .trigger").click();
await page.locator('.sp [role="option"]', { hasText: "1,5×" }).click();
await flush();
check((await live()).rate === 1.5, "choosing 1,5× reaches the element", `${(await live()).rate}`);
check((await page.locator("footer.player .sp .trigger").textContent()).trim() === "1,5×", "and the chip says so");

await page.locator("footer.player .next").click();
await page.waitForFunction(() => document.querySelector("footer.player .info .t")?.textContent === "Episode e2");
await page.waitForFunction(() => window.__els.some((e) => e.src && !e.paused));
check((await live()).rate === 1.5, "the next episode of the same show keeps it", `${(await live()).rate}`);

await page.locator("footer.player .next").click();
await page.waitForFunction(() => document.querySelector("footer.player .info .t")?.textContent === "Song s1");
await page.waitForFunction(() => window.__els.some((e) => e.src && !e.paused));
check((await live()).rate === 1, "a song is never sped up", `${(await live()).rate}`);
check((await page.locator("footer.player .sp").count()) === 0, "and has no speed chip");

await page.locator("footer.player .prev").click();
await page.locator("footer.player .prev").click().catch(() => {});
await page.waitForFunction(() => /Episode/.test(document.querySelector("footer.player .info .t")?.textContent || ""));
await page.waitForFunction(() => window.__els.some((e) => e.src && !e.paused));
check((await live()).rate === 1.5, "back on the show: its speed is remembered", `${(await live()).rate}`);

// It survives a reload, per show.
await inject(session(0));
await page.reload();
await page.waitForFunction(() => document.querySelector("footer.player .pp"));
await page.waitForTimeout(600);
await play();
await page.waitForFunction(() => window.__els.some((e) => e.src && !e.paused), null, { timeout: 15000 });
check((await live()).rate === 1.5, "and survives a reload", `${(await live()).rate}`);

// -- sleep timer ---------------------------------------------------------------
await page.locator("footer.player .sl .trigger").click();
await page.locator(".sl").getByRole("menuitem", { name: "5 minutes", exact: true }).click();
await flush();
check((await page.locator("footer.player .sl .badge").textContent()).trim() === "5 min", "the button counts down", await page.locator("footer.player .sl .badge").textContent());
const full = (await live()).volume;
await page.clock.fastForward(4 * 60_000 + 30_000); // 30 s to go: not fading yet
check(Math.abs((await live()).volume - full) < 1e-6 && !(await live()).paused, "half a minute before the end the volume is still the user's");
await page.clock.fastForward(20_000); // 10 s to go
const fading = await live();
check(fading.volume < full * 0.6 && fading.volume > 0 && !fading.paused, "in the last seconds it is going down", `${fading.volume.toFixed(3)}`);
await page.clock.fastForward(11_000);
await flush();
const stopped = await live();
check(stopped.paused, "at the deadline the player is paused");
check((await page.locator("footer.player .sl .badge").count()) === 0, "and the timer is spent");
await page.clock.fastForward(1000);
check(Math.abs((await live()).volume - full) < 1e-6, "the volume is back where the user left it", `${(await live()).volume}`);
check((await title()) === "Episode e1", "the queue did not move");
check((await live()).t > 0, "the position is kept for the next play", `${(await live()).t.toFixed(1)}s`);

// Resuming plays normally and is not re-stopped by anything left over.
await play();
await page.waitForFunction(() => window.__els.some((e) => e.src && !e.paused));
await page.clock.fastForward(10 * 60_000);
check(!(await live()).paused, "nothing is left running after it has fired");

// "À la fin du titre": the next track is lined up, paused.
wav = silence(4);
await inject(session(2));
await page.reload();
await page.waitForFunction(() => document.querySelector("footer.player .pp"));
await page.waitForTimeout(600);
await play();
await page.waitForFunction(() => window.__els.some((e) => e.src && !e.paused), null, { timeout: 15000 });
await page.locator("footer.player .sl .trigger").click();
await page.locator('.sl [role="menuitem"]', { hasText: "À la fin du titre" }).click();
check((await page.locator("footer.player .sl .badge").textContent()).trim() === "fin du titre", "the button says what it is waiting for");
check(!(await live()).paused, "it plays on until the track ends");
// The audio runs in real time whatever the page's clock says: wait for it to end.
await page.waitForFunction(() => document.querySelector("footer.player .info .t")?.textContent === "Song s2", null, { timeout: 15000 }).catch(() => {});
await page.waitForTimeout(500);
check((await title()) === "Song s2", "at the end the next track is lined up", await title());
check((await page.locator("footer.player .pp svg").count()) === 1 && (await page.evaluate(() => window.__els.every((e) => e.paused))), "and nothing is playing");
check((await page.locator("footer.player .sl .badge").count()) === 0, "the timer is spent");

await browser.close();
stop();
process.exit(state.failed ? 1 : 0);
