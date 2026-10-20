#!/usr/bin/env node
// Downloads kept by the Android app (lib/nativeoffline.js ↔ OfflineStore.kt),
// driven through the real SPA against the real server. The app is a stand-in
// that answers like OfflineStore.kt does — downloads fetched by "the app",
// pieces that must follow each other, `/__nsoffline/<key>` answered from the
// file with byte ranges — and keeps its files across a reload, like the app's
// storage does. Then:
//   1. a download made by an older app (a Blob in IndexedDB), the app updated:
//      moved into the app's storage byte for byte, the Blob gone;
//   2. that download played: from `/__nsoffline/`, never from the server;
//   3. a new download from the track menu goes straight to the app;
//   4. the Réglages list of downloads, at a desktop and a phone width.
//
//   npm run build && node test/offline/run.mjs [--shots <dir>]
import { writeFileSync, mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPlaywright, startServer, silence, login, checker } from "../harness.mjs";

const { chromium } = await loadPlaywright();
const LEN = 30;
const wavPath = join(mkdtempSync(join(tmpdir(), "nsoffline-")), "track.wav");
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

// OfflineStore.kt, in the page. Its files live in localStorage, so they outlive
// a reload the way the app's storage outlives the page.
function fakeApp() {
  const FILES = "__fakeoff";
  const version = +(localStorage.getItem("__bridge") || 5);
  const load = () => JSON.parse(localStorage.getItem(FILES) || "{}");
  const save = (f) => localStorage.setItem(FILES, JSON.stringify(f));
  const parts = new Map();
  const b64 = (u8) => {
    let s = "";
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  };
  window.__fakeOff = { downloads: 0, puts: 0 };
  const emit = (o) => setTimeout(() => window.__nsOffline && window.__nsOffline(o), 15);
  const ok = (key) => /^[A-Za-z0-9:_-]{1,96}$/.test(key);
  window.NSNative = {
    bridgeVersion: () => version,
    nativeAudio: () => false,
    offAvailable: () => version >= 5,
    offDownload(key, url) {
      if (!ok(key) || new URL(url).origin !== location.origin) return false;
      window.__fakeOff.downloads++;
      fetch(url, { headers: { "Accept-Encoding": "identity" } })
        .then(async (r) => {
          if (!r.ok) throw new Error("HTTP " + r.status);
          const type = (r.headers.get("Content-Type") || "audio/flac").split(";")[0];
          const u8 = new Uint8Array(await r.arrayBuffer());
          emit({ id: key, st: "progress", r: u8.length / 2, t: u8.length });
          const f = load();
          f[key] = { type, b64: b64(u8), size: u8.length };
          save(f);
          emit({ id: key, st: "done", size: u8.length, type });
        })
        .catch((e) => emit({ id: key, st: "error", msg: e.message }));
      return true;
    },
    offCancel() {},
    offPut(key, offset, data) {
      window.__fakeOff.puts++;
      if (!ok(key)) return false;
      const prev = offset === 0 ? "" : parts.get(key);
      if (prev == null || atob(prev).length !== offset) return false;
      parts.set(key, btoa(atob(prev) + atob(data)));
      return true;
    },
    offCommit(key, type) {
      const p = parts.get(key);
      if (!p) return -1;
      const size = atob(p).length;
      const f = load();
      f[key] = { type: type.split(";")[0] || "audio/flac", b64: p, size };
      save(f);
      parts.delete(key);
      return size;
    },
    offRemove(key) {
      const f = load();
      delete f[key];
      save(f);
    },
    offClear: () => save({}),
    offList: () => JSON.stringify(Object.entries(load()).map(([id, v]) => ({ id, type: v.type, size: v.size }))),
    offFree: () => 64e9,
  };
}

const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await ctx.route((u) => {
  const h = new URL(u).hostname;
  return h === "api.deezer.com" || h === "dzcdn.net" || h.endsWith(".dzcdn.net");
}, (r) => r.abort());
const seen = { stream: [], offline: [] };
let page;
// The WebView's intercept: `/__nsoffline/<key>` answered from the app's file.
await ctx.route("**/__nsoffline/**", async (route) => {
  const key = decodeURIComponent(new URL(route.request().url()).pathname.split("/").pop());
  const range = route.request().headers()["range"] || null;
  seen.offline.push(range || "full");
  const f = await page.evaluate((k) => JSON.parse(localStorage.getItem("__fakeoff") || "{}")[k] || null, key);
  if (!f) return route.fulfill({ status: 404, body: "Not downloaded" });
  const body = Buffer.from(f.b64, "base64");
  const headers = { "Content-Type": f.type, "Accept-Ranges": "bytes", "Cache-Control": "no-store" };
  const m = range && /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!m) return route.fulfill({ status: 200, headers, body });
  const start = m[1] === "" ? Math.max(0, body.length - +m[2]) : +m[1];
  const end = m[1] !== "" && m[2] !== "" ? Math.min(+m[2], body.length - 1) : body.length - 1;
  if (start >= body.length) return route.fulfill({ status: 416, headers: { ...headers, "Content-Range": `bytes */${body.length}` } });
  return route.fulfill({
    status: 206, headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${body.length}` }, body: body.subarray(start, end + 1),
  });
});
ctx.on("response", (r) => {
  if (process.env.DEBUG && r.url().includes("/api/stream/"))
    console.log("stream", r.status(), r.headers()["content-type"], r.headers()["content-length"], r.request().headers()["range"] || "", r.url());
});
ctx.on("request", (r) => {
  if (r.url().includes("/api/stream/")) seen.stream.push(r.url());
});
await ctx.addInitScript(fakeApp);
await ctx.addInitScript(() => {
  const j = sessionStorage.getItem("__inject");
  if (!j) return;
  const { session } = JSON.parse(j);
  localStorage.setItem("player.session", JSON.stringify(session));
  localStorage.removeItem("player.pos");
  sessionStorage.removeItem("__inject");
});
page = await ctx.newPage();
page.on("pageerror", (e) => console.log("pageerror:", e.message));
if (process.env.DEBUG) page.on("console", (m) => console.log("console:", m.text()));
await login(page, base);

const queue = ids.ids.slice(0, 2).map((id, k) => song(id, k + 1));
const session = { queue, index: 0, start: 0, currentTime: 0, context: null, shuffle: false, repeat: "off", _orig: null, at: Date.now() };
await page.evaluate((j) => {
  localStorage.setItem("__bridge", "4");
  // The archived file as it is (this library's are WAV): a transcode is not what is tested here.
  localStorage.setItem("offline.quality", JSON.stringify("FLAC"));
  sessionStorage.setItem("__inject", j);
}, JSON.stringify({ session }));
await page.reload();
await page.waitForFunction(() => document.querySelector("footer.player .pp"), null, { timeout: 30000 });
await page.waitForTimeout(500);

// What IndexedDB holds for a key: the record and the Blob's bytes, hashed.
const idb = () =>
  page.evaluate(async () => {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open("nsupy-offline");
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const all = (s) => new Promise((res) => {
      const r = db.transaction(s, "readonly").objectStore(s).getAll();
      r.onsuccess = () => res(r.result);
    });
    const hash = async (blob) => {
      const d = new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()));
      return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
    };
    const metas = await all("meta");
    const audio = await all("audio");
    const out = { metas: metas.map((m) => ({ id: m.id, native: !!m.native, size: m.size })), audio: [] };
    for (const a of audio) out.audio.push({ id: a.id, size: a.blob.size, hash: await hash(a.blob) });
    db.close();
    return out;
  });
const appFiles = () =>
  page.evaluate(async () => {
    const f = JSON.parse(localStorage.getItem("__fakeoff") || "{}");
    const out = {};
    for (const [k, v] of Object.entries(f)) {
      const u8 = Uint8Array.from(atob(v.b64), (c) => c.charCodeAt(0));
      const d = new Uint8Array(await crypto.subtle.digest("SHA-256", u8));
      out[k] = { size: v.size, hash: [...d].map((b) => b.toString(16).padStart(2, "0")).join("") };
    }
    return out;
  });
const fromMenu = async () => {
  await page.locator('footer.player button[aria-label="Plus d\'options"]').first().click();
  await page.getByRole("menuitem", { name: "Télécharger", exact: true }).or(page.locator(".menu button", { hasText: /^\s*Télécharger\s*$/ })).first().click();
};

// 1. An older app: the download is a Blob in IndexedDB.
await fromMenu();
for (let i = 0; i < 60 && !(await idb()).audio.length; i++) await page.waitForTimeout(300);
const before = await idb();
check(before.audio.length === 1 && before.metas.length === 1 && !before.metas[0].native,
  "an app without the store: the download is a Blob in IndexedDB", `${before.audio.length} blob(s), ${before.audio[0]?.size} bytes`);
check(Object.keys(await appFiles()).length === 0, "and nothing in the app");

// The app updated: the move happens at launch, on its own.
await page.evaluate(() => localStorage.setItem("__bridge", "5"));
seen.stream.length = 0;
seen.offline.length = 0;
await page.reload();
await page.waitForFunction(() => document.querySelector("footer.player .pp"), null, { timeout: 30000 });
const tMove = Date.now();
await page.waitForFunction(() => Object.keys(JSON.parse(localStorage.getItem("__fakeoff") || "{}")).length > 0, null, { timeout: 20000 });
await page.waitForTimeout(500);
const after = await idb();
const files = await appFiles();
const key = before.audio[0].id;
check(files[key] && files[key].hash === before.audio[0].hash && files[key].size === before.audio[0].size,
  "the app updated: the Blob moves into the app's storage byte for byte", `${files[key]?.size} bytes in ${Date.now() - tMove} ms`);
check(after.audio.length === 0 && after.metas.length === 1 && after.metas[0].native,
  "and leaves IndexedDB: the record stays, marked as the app's", JSON.stringify(after.metas));

// 2. Played from the app's file, never from the server. Next launch: the page
//    that did the move may still hold the Blob it had resolved before it.
seen.stream.length = 0;
seen.offline.length = 0;
await page.reload();
await page.waitForFunction(() => document.querySelector("footer.player .pp"), null, { timeout: 30000 });
await page.waitForTimeout(500);
await page.locator("footer.player .pp").click();
await page.waitForTimeout(2500);
const t = await page.evaluate(() => window.__nsAudioPath().t);
check(t > 1.2, "the download plays", `t ${t?.toFixed(2)}`);
check(seen.offline.length > 0 && seen.stream.filter((u) => u.includes(ids.ids[0])).length === 0,
  "from /__nsoffline/, not from /api/stream", `${seen.offline.length} offline request(s) [${seen.offline.slice(0, 3).join(", ")}], ${seen.stream.length} stream`);
await page.locator("footer.player .pp").click();

// 3. A new download goes straight to the app.
await page.locator('footer.player button[aria-label="Suivant"]').first().click();
await page.waitForTimeout(800);
const dlBefore = await page.evaluate(() => window.__fakeOff.downloads);
await fromMenu();
await page.waitForFunction(() => Object.keys(JSON.parse(localStorage.getItem("__fakeoff") || "{}")).length > 1, null, { timeout: 20000 });
await page.waitForTimeout(500);
const third = await idb();
check((await page.evaluate(() => window.__fakeOff.downloads)) === dlBefore + 1 && third.audio.length === 0 &&
  third.metas.length === 2 && third.metas.every((m) => m.native),
  "a new download: fetched by the app, nothing heavy in IndexedDB", JSON.stringify(third.metas.map((m) => m.size)));

// 4. Réglages → Titres téléchargés, desktop and phone.
await page.evaluate(() => (location.hash = "#/settings"));
await page.locator("button.tab", { hasText: "Qualité sonore" }).click();
await page.locator("button.subnav").filter({ hasText: /téléchargés/i }).first().click();
await page.waitForSelector(".list .row", { timeout: 10000 });
for (const [w, h, name] of [[1280, 900, "desktop"], [390, 844, "phone"]]) {
  await page.setViewportSize({ width: w, height: h });
  await page.waitForTimeout(400);
  const g = await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".list .row")];
    const over = document.documentElement.scrollWidth - document.documentElement.clientWidth;
    const clipped = rows.filter((r) => {
      const rm = r.querySelector(".rm").getBoundingClientRect();
      return rm.right > window.innerWidth || rm.width < 24;
    }).length;
    return { rows: rows.length, over, clipped, head: document.querySelector(".dl-head h2")?.textContent.trim() };
  });
  check(g.rows === 2 && g.over <= 0 && g.clipped === 0, `the list of downloads at ${name} width`, `${g.rows} rows, "${g.head}", overflow ${g.over}`);
  if (shotsAt) await page.screenshot({ path: join(shotsAt, `downloads-${name}.png`) });
}

// Removing one removes the app's file.
await page.locator(".list .row .rm").first().click();
await page.waitForTimeout(600);
const left = Object.keys(await appFiles()).length;
check(left === 1, "removing a download removes the app's file", `${left} left`);

await browser.close();
stop();
console.log(state.failed ? `\n${state.failed} FAILED` : "\nall passed");
process.exit(state.failed ? 1 : 0);
