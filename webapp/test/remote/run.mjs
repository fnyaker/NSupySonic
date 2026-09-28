#!/usr/bin/env node
// Remote control end to end: the REAL app on both sides.
//
//   node test/remote/run.mjs
//
// A real server (server.py: a throwaway database, an owner, a friend, four WAV
// tracks), the web app from the Vite dev server, and two browser contexts in
// headless Chromium: the OWNER's, whose player plays, and the FRIEND's, which
// opens the owner's link. Every step is driven the way a person would — the
// buttons of the player bar, the remote sheet, the chip's "Couper" — and
// scored on what the OWNER's player actually does, read from its own store
// (the same module instance the app runs on, imported through Vite).
//
// What it checks, in order: making a link in the sheet; claiming it from a
// browser logged into another account; the controller showing the owner's
// track; pause, next, seek, volume and a jump from the controller landing on
// the owner's player; the owner's "controlled by" chip; a network cut on the
// controller and its automatic recovery (a track change made meanwhile shows
// up on its own); a reload of the OWNER's page, after which the controller
// drives it again; the owner's cut ending the controller's session, which then
// gets its own account back. Each latency is printed.
//
// Like the other benches it needs a browser, so it is not part of `npm test`.

import { spawn, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const webapp = resolve(here, "../..");
const repo = resolve(webapp, "..");

async function loadPlaywright() {
  for (const spec of ["playwright", "playwright-core"]) {
    try {
      return await import(spec);
    } catch {
      /* try the next */
    }
  }
  const root = execSync("npm root -g", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  for (const name of ["playwright", "playwright-core"]) {
    const p = join(root, name, "index.mjs");
    if (existsSync(p)) return import(pathToFileURL(p).href);
  }
  throw new Error("Playwright is not installed (npm i -g playwright).");
}

function startServer() {
  const py = existsSync(join(repo, ".venv/bin/python")) ? join(repo, ".venv/bin/python") : "python3";
  const proc = spawn(py, [join(here, "server.py")], { cwd: repo, stdio: ["pipe", "pipe", "pipe"] });
  proc.stderr.on("data", (d) => {
    for (const line of String(d).split("\n"))
      if (line && !/"(GET|POST|DELETE|PUT|PATCH) \//.test(line)) process.stderr.write(line + "\n");
  });
  return new Promise((ok, fail) => {
    let buf = "";
    proc.stdout.on("data", (d) => {
      buf += d;
      const m = buf.match(/READY (\d+) (.*)\n/);
      if (m) ok({ proc, port: +m[1], tracks: JSON.parse(m[2]) });
    });
    proc.on("exit", (code) => fail(new Error(`server exited ${code}`)));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --shots <dir>: photograph each screen on the way (--phone: a phone's viewport).
function arg(name, dflt = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return dflt;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : true;
}
const shotsDir = arg("shots", null);
const viewport = arg("phone") ? { width: 390, height: 844 } : { width: 1280, height: 820 };
async function shot(page, name) {
  if (!shotsDir) return;
  await sleep(350); // let the transitions land
  await page.screenshot({ path: join(shotsDir, `${name}.png`) });
}
const results = [];
let failed = 0;
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failed += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  — " + detail : ""}`);
}

async function until(fn, { timeout = 8000, every = 50 } = {}) {
  const t0 = Date.now();
  for (;;) {
    let v;
    try {
      v = await fn();
    } catch {
      v = null;
    }
    if (v) return { value: v, ms: Date.now() - t0 };
    if (Date.now() - t0 > timeout) return { value: null, ms: Date.now() - t0 };
    await sleep(every);
  }
}

const server = await startServer();
const { createServer } = await import("vite");
const vite = await createServer({
  root: webapp,
  configFile: resolve(webapp, "vite.config.js"),
  logLevel: "error",
  server: {
    port: 0,
    host: "127.0.0.1",
    hmr: false,
    watch: null,
    proxy: { "/api": `http://127.0.0.1:${server.port}` },
  },
});
await vite.listen();
// The app is served under its production base (vite.config.js: /app/), which
// is what the dev server's URL already carries.
const app = vite.resolvedUrls.local[0];
const url = new URL(app).origin;
const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
const errors = [];

async function openApp(user, password) {
  const context = await browser.newContext({ viewport, isMobile: viewport.width < 500, hasTouch: viewport.width < 500 });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(`${user}: ${e}`));
  await page.goto(app);
  const ok = await page.evaluate(
    async ({ user, password }) =>
      (
        await fetch("/api/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username: user, password }),
        })
      ).ok,
    { user, password }
  );
  if (!ok) throw new Error(`login ${user} refused`);
  await page.reload();
  await page.waitForSelector("footer.player", { timeout: 30000 });
  return { context, page };
}

// The owner's player store, read from the very module instance the app runs on.
const ownerState = (page) =>
  page.evaluate(async () => {
    const { player } = await import("/app/src/lib/stores.js");
    let s;
    player.subscribe((v) => (s = v))();
    const t = s.queue[s.index];
    return { index: s.index, playing: s.playing, title: t && t.title, t: s.currentTime, volume: s.volume };
  });

let code = 0;
try {
  const { page: owner } = await openApp("owner", "Owner1");
  // Play the library, the way tapping the first row of "Mes fichiers" does.
  await owner.evaluate(async () => {
    const { api } = await import("/app/src/lib/api.js");
    const { player } = await import("/app/src/lib/stores.js");
    const r = await api.get("/me/local");
    player.playQueue(r.tracks, 0);
  });
  const started = await until(async () => {
    const s = await ownerState(owner);
    return s.playing && s.t > 0.5 && s;
  });
  check("the owner's player plays", !!started.value, started.value ? started.value.title : "");

  // -- the sheet ---------------------------------------------------------------
  await owner.click("footer.player button.rb");
  await owner.waitForSelector('[role="dialog"][aria-label="Contrôle à distance"]');
  await shot(owner, "1-owner-sheet");
  await owner.click('button.level:has-text("Lecture seule")');
  await owner.click('button.primary:has-text("Créer le lien")');
  await owner.waitForSelector(".invite .url");
  const link = (await owner.textContent(".invite .url")).trim();
  const token = (link.match(/\/rc\/([A-Za-z0-9_.-]+)$/) || [])[1];
  check("the sheet makes a read-only link with a QR code", !!token && !!(await owner.$(".invite .qr svg")), link);
  // The server's short link (/rc/<token>, a page that forwards into the app).
  check("the link is the server's short one", new URL("http://" + link).pathname === `/rc/${token}`, link);
  await shot(owner, "2-owner-invite");
  await owner.click('button.ghost:has-text("Terminé")');
  await shot(owner, "3-owner-links");
  await owner.keyboard.press("Escape");

  // -- the friend opens it ------------------------------------------------------
  const { page: friend, context: friendCtx } = await openApp("friend", "Friend1");
  // No <audio> on a controller, so nothing reports "this track can play" —
  // which is what the lyrics wait for (lib/ladder.js).
  const lyricAsks = [];
  friend.on("request", (q) => /\/api\/lyrics\//.test(q.url()) && lyricAsks.push(q.url()));
  await friend.goto(`${app}#/rc/${token}`);
  const claimed = await until(async () => (await friend.textContent(".pill .l1")) || null, { timeout: 15000 });
  check("the friend's app reloads as a remote control", !!claimed.value, claimed.value || "");
  const shows = await until(async () => {
    const t = await friend.textContent("footer.player .now .t");
    return t === started.value.title && t;
  });
  check("the controller shows the owner's track", !!shows.value, `${shows.value} after ${shows.ms} ms`);
  check("a read-only controller has no heart to press", (await friend.$$("footer.player .fav")).length === 0);
  const asked = await until(async () => lyricAsks.length > 0, { timeout: 6000 });
  check("…and reads the lyrics of the track it shows", !!asked.value, `${asked.ms} ms`);
  const chip = await until(async () => (await owner.textContent(".chip .l1")) || null, { timeout: 6000 });
  check("the owner sees who is driving, and the cut button", !!chip.value && !!(await owner.$(".chip .cut")), chip.value || "");
  await shot(owner, "4-owner-chip");
  await shot(friend, "5-friend-remote");

  // -- driving -------------------------------------------------------------------
  let t0 = Date.now();
  await friend.click("footer.player button.pp");
  let r = await until(async () => !(await ownerState(owner)).playing);
  check("pause on the controller pauses the owner's player", !!r.value, `${r.ms} ms`);
  await friend.click("footer.player button.pp");
  r = await until(async () => (await ownerState(owner)).playing);
  check("…and play plays it again", !!r.value, `${r.ms} ms`);

  await friend.click("footer.player button.next");
  r = await until(async () => {
    const s = await ownerState(owner);
    return s.index === 1 && s;
  });
  check("next on the controller moves the owner's player", !!r.value, `${r.value && r.value.title}, ${r.ms} ms`);
  const back = await until(async () => (await friend.textContent("footer.player .now .t")) === "Bravo");
  check("…and the controller keeps showing it (no flicker back)", !!back.value, `${back.ms} ms`);

  await friend.evaluate(async () => {
    const { seekTo } = await import("/app/src/lib/stores.js");
    seekTo.set(25);
  });
  r = await until(async () => {
    const s = await ownerState(owner);
    return Math.abs(s.t - 25) < 1.5 && s;
  });
  check("a seek on the controller lands on the owner's player", !!r.value, r.value ? `at ${r.value.t.toFixed(1)} s, ${r.ms} ms` : "");

  await friend.$eval("footer.player input.vol", (el) => {
    el.value = "0.3";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  r = await until(async () => Math.abs((await ownerState(owner)).volume - 0.3) < 0.01);
  check("the volume slider drives the owner's volume", !!r.value, `${r.ms} ms`);

  await friend.evaluate(async () => {
    const { player } = await import("/app/src/lib/stores.js");
    player.jump(3);
  });
  r = await until(async () => (await ownerState(owner)).index === 3);
  check("a jump in the queue lands on the owner's player", !!r.value, `${r.ms} ms`);

  // -- the network drops on the controller ------------------------------------------
  await friendCtx.setOffline(true);
  const down = await until(async () => /Reconnexion/.test((await friend.textContent(".pill .l2")) || ""), { timeout: 12000 });
  check("a dropped network says so", !!down.value, `${down.ms} ms`);
  await shot(friend, "6-friend-reconnecting");
  // Meanwhile the owner changes track themself.
  await owner.evaluate(async () => {
    const { player } = await import("/app/src/lib/stores.js");
    player.jump(0);
  });
  await sleep(1500);
  t0 = Date.now();
  await friendCtx.setOffline(false);
  r = await until(async () => (await friend.textContent("footer.player .now .t")) === "Alpha", { timeout: 15000 });
  check("the controller resumes on its own, with what changed meanwhile", !!r.value, `${Date.now() - t0} ms after the network came back`);
  const live = await until(async () => /En direct/.test((await friend.textContent(".pill .l2")) || ""));
  check("…and says it is live again", !!live.value);

  // -- the owner reloads --------------------------------------------------------------
  await owner.reload();
  await owner.waitForSelector("footer.player", { timeout: 30000 });
  await sleep(1500);
  await friend.click("footer.player button.next");
  r = await until(async () => (await ownerState(owner)).index === 1, { timeout: 10000 });
  check("after a reload of the owner's page the controller drives it again", !!r.value, `${r.ms} ms`);

  // -- the cut ------------------------------------------------------------------------
  const chipBack = await until(async () => !!(await owner.$(".chip .cut")), { timeout: 8000 });
  check("the chip is back after the reload", !!chipBack.value);
  t0 = Date.now();
  await owner.click(".chip .cut");
  r = await until(async () => !!(await friend.$('[role="alertdialog"]')), { timeout: 8000 });
  check("the owner's cut ends the controller's session", !!r.value, `${Date.now() - t0} ms`);
  await shot(friend, "7-friend-ended");
  const offer = r.value ? await friend.textContent('[role="alertdialog"] button') : "";
  check("…and offers the friend's own account back", /friend/.test(offer || ""), (offer || "").trim());
  await friend.click('[role="alertdialog"] button');
  await friend.waitForSelector("footer.player", { timeout: 30000 });
  const me = await friend.evaluate(async () => (await (await fetch("/api/me")).json()));
  check("the friend is themself again, with no grant", me.user && me.user.name === "friend" && !me.remote, JSON.stringify(me));
  const ownerAfter = await ownerState(owner);
  check("the owner's player never stopped being theirs", ownerAfter.index === 1, `on ${ownerAfter.title}`);

  // -- the "queue" level: the player and its queue, nothing else -----------------
  // Through the sheet again, the way it is done: the default level, a name.
  await owner.click("footer.player button.rb");
  await owner.waitForSelector('[role="dialog"][aria-label="Contrôle à distance"]');
  check("the sheet offers the queue level first", /File d'attente/.test((await owner.textContent("button.level.sel")) || ""));
  await owner.fill('input[type="text"]', "Salon");
  await owner.click('button.primary:has-text("Créer le lien")');
  await owner.waitForSelector(".invite .url");
  const made = { token: ((await owner.textContent(".invite .url")).match(/\/rc\/([A-Za-z0-9_.-]+)$/) || [])[1] };
  await owner.keyboard.press("Escape");
  const guestCtx = await browser.newContext({ viewport, isMobile: viewport.width < 500, hasTouch: viewport.width < 500 });
  const guest = await guestCtx.newPage();
  guest.on("pageerror", (e) => errors.push(`guest: ${e}`));
  const guestDenied = [];
  guest.on("response", (q) => q.status() === 403 && guestDenied.push(new URL(q.url()).pathname));
  await guest.goto(`${app}#/rc/${made.token}`);
  // The full-screen view is DesktopNowPlaying (div.d) or, on a phone,
  // MobileNowPlaying (div.m): the same view either way.
  const NP = viewport.width < 641 ? "div.m" : "div.d";
  const full = await until(async () => !!(await guest.$(NP)), { timeout: 20000 });
  check("a queue-only controller opens straight onto the full-screen player", !!full.value, `${full.ms} ms`);
  check("…with nothing behind it (no sidebar, no library)", !(await guest.$("nav.sidebar")));
  check("…and no way out of it but Quitter", !(await guest.$(`${NP} button[aria-label="Réduire"]`)));
  await shot(guest, "8-queue-only");
  check("…whose own screens never ask for what the link does not lend", guestDenied.length === 0, guestDenied.join(", "));
  const q403 = await guest.evaluate(async () => (await fetch("/api/search?q=a")).status);
  check("the server refuses it a search", q403 === 403, String(q403));
  await guest.click(`${NP} button[aria-label="Suivant"]`);
  r = await until(async () => (await ownerState(owner)).index === 2);
  check("next from the queue-only controller moves the owner's player", !!r.value, `${r.ms} ms`);
  const named = await until(async () => /Salon/.test((await owner.textContent(".chip .l1")) || ""), { timeout: 6000 });
  check("the owner's chip names the link it was made for", !!named.value, named.value ? "Salon" : "");
  await owner.click(".chip .cut");
  r = await until(async () => !!(await guest.$('[role="alertdialog"]')), { timeout: 8000 });
  check("…and its cut ends that session too", !!r.value, `${r.ms} ms`);
  const noLinks = await owner.evaluate(async () => {
    const { api } = await import("/app/src/lib/api.js");
    return (await api.remoteLinks()).links.length;
  });
  check("nothing is left lent", noLinks === 0, String(noLinks));
} catch (e) {
  console.error(e);
  code = 1;
} finally {
  for (const e of errors) console.log("page error:", e);
  await browser.close();
  await vite.close();
  server.proc.stdin.end();
  server.proc.kill();
}
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(code || (failed ? 1 : 0));
