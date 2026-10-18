#!/usr/bin/env node
// Importing a shared playlist, in headless Chromium: the link pasted into the
// search box, the import screen while the server reads and matches, the result
// played, kept, and the phone/desktop geometry. The server is the real one
// (Deezer off), so the import job's answers are put in by the test — the
// matching itself is pinned in tests/test_playlist_import.py.
//
//   npm run build && node test/import/run.mjs [--phone]     (SHOTS=<dir> keeps pictures)
import { join } from "node:path";
import { loadPlaywright, startServer, silence, login, checker } from "../harness.mjs";

const { chromium } = await loadPlaywright();
const PHONE = process.argv.includes("--phone");
const { base, stop } = await startServer();
const { check, state } = checker();
const WAV = silence(30);
const LINK = "https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M?si=abc";

const track = (i, via) => ({
  deezer_id: String(900 + i),
  title: `Un titre assez long pour être coupé sur un téléphone ${i}`,
  duration: 200,
  artist: { deezer_id: "9", name: "Artiste " + i },
  artists: [{ deezer_id: "9", name: "Artiste " + i, role: "Main" }],
  display_artist: "Artiste " + i,
  album: { deezer_id: "10", title: "Album", cover: "" },
  source: via === "youtube" ? "youtube" : undefined,
});
const line = (i) => ({ title: `Titre original ${i}`, artists: ["Artiste " + i], album: "Album", duration: 200 });
const items = [
  ...Array.from({ length: 30 }, (_, i) => ({ line: line(i + 1), track: track(i + 1), via: i < 4 ? "local" : "deezer", sure: true })),
  { line: line(31), track: track(31, "youtube"), via: "youtube", sure: false },
  { line: { title: "Une chanson que personne n'a", artists: ["Inconnu", "Featuring"], album: "Rare", duration: 245 }, track: null, via: null, sure: false },
  { line: line(33), track: null, via: null, sure: false },
];
const base_job = {
  id: "job1", source: "spotify", source_label: "Spotify", kind: "playlist", url: LINK,
  name: "Today's Top Hits", cover: null, total: items.length, truncated: false, error: null, playlist_id: null,
};
let polls = 0;
let saved = false;
const asked = [];

const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
const ctx = await browser.newContext(
  PHONE
    ? { viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }
    : { viewport: { width: 1280, height: 1000 } }
);
await ctx.route(/dzcdn\.net|api\.deezer\.com|scdn\.co/, (r) => r.abort());
await ctx.route(/\/api\/stream\//, (r) => r.fulfill({ status: 200, body: WAV, headers: { "Content-Type": "audio/wav", "Accept-Ranges": "none" } }));
const json = (r, body, status = 200) => r.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
await ctx.route(/\/api\/import\/playlist/, (r) => {
  const req = r.request();
  const u = new URL(req.url()).pathname;
  asked.push(req.method() + " " + u);
  if (req.method() === "POST" && u === "/api/import/playlist") {
    const sent = JSON.parse(req.postData() || "{}");
    check(sent.url === LINK, "the screen sends the pasted link as it is", sent.url);
    return json(r, { id: "job1" });
  }
  if (req.method() === "POST" && u.endsWith("/save")) {
    saved = JSON.parse(req.postData() || "{}");
    return json(r, { ok: true });
  }
  polls++;
  if (saved) return json(r, { ...base_job, state: "saved", playlist_id: "11111111-2222-3333-4444-555555555555", items, done: items.length, matched: 31, counts: { local: 4, deezer: 26, youtube: 1 } });
  if (polls === 1) return json(r, { ...base_job, state: "reading", name: null, total: 0, done: 0, matched: 0, counts: {} });
  if (polls <= 3) return json(r, { ...base_job, state: "matching", done: 12, matched: 11, counts: { deezer: 11 } });
  return json(r, { ...base_job, state: "done", items, done: items.length, matched: 31, counts: { local: 4, deezer: 26, youtube: 1 } });
});

const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("pageerror:", e.message));
await login(page, base);
await page.reload();
await page.waitForTimeout(1000);

// The way in most people will take: pasting the link into the search box.
await page.goto(base + "/app/#/search");
await page.locator(".bar input").fill(LINK);
await page.waitForSelector("a.shared", { timeout: 5000 });
check(await page.locator("a.shared", { hasText: "Spotify" }).count() === 1, "a pasted Spotify link offers the import");
check(await page.locator(".tabs").count() === 0, "and is not searched as words");
if (process.env.SHOTS) await page.screenshot({ path: join(process.env.SHOTS, PHONE ? "import-search-phone.png" : "import-search-desktop.png") });
await page.locator("a.shared").click();

await page.waitForSelector(".working", { timeout: 8000 });
check(true, "the screen shows the work while the server reads the list");
await page.waitForSelector(".working h1:has-text('Today')", { timeout: 8000 });
if (process.env.SHOTS) await page.screenshot({ path: join(process.env.SHOTS, PHONE ? "import-working-phone.png" : "import-working-desktop.png") });

await page.waitForSelector("h1:has-text(\"Today's Top Hits\")", { timeout: 8000 });
await page.waitForSelector(".row.track", { timeout: 8000 });
check(await page.locator(".chip", { hasText: "4 dans ta bibliothèque" }).count() === 1, "it says where the titles were found");
check(await page.locator(".chip.warn", { hasText: "2 introuvables" }).count() === 1, "and how many were not");
check(polls >= 4, "it polled until the job was done", `${polls} polls`);

// Nothing sticks out sideways, at any width.
const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
check(overflow <= 0, "no horizontal scroll", `${overflow}px`);
const boxes = await page.evaluate(() =>
  [...document.querySelectorAll(".actions > *, .chip")].map((e) => {
    const r = e.getBoundingClientRect();
    return { right: r.right, w: r.width };
  })
);
check(boxes.every((b) => b.right <= window_w() && b.w > 0), "every action and chip is on screen");
function window_w() {
  return PHONE ? 412 : 1280;
}
if (process.env.SHOTS) await page.screenshot({ path: join(process.env.SHOTS, PHONE ? "import-done-phone.png" : "import-done-desktop.png"), fullPage: true });

// The unmatched lines lead to a search for them.
await page.locator(".lines .l-btn").first().scrollIntoViewIfNeeded();
const missH = await page.locator(".lines .l-btn").first().evaluate((e) => e.getBoundingClientRect().height);
check(missH >= 44, "an unmatched line is a thumb-sized target", `${missH}px`);

await page.locator("h2.sec", { hasText: "Introuvables" }).scrollIntoViewIfNeeded();
await page.waitForTimeout(300);
if (process.env.SHOTS) await page.screenshot({ path: join(process.env.SHOTS, PHONE ? "import-missing-phone.png" : "import-missing-desktop.png") });

// Play it.
await page.locator(".actions .pill", { hasText: "Lire" }).click();
await page.waitForTimeout(800);
check(await page.locator("footer.player .info .t", { hasText: "Un titre assez long" }).count() === 1, "‘Lire’ plays the first title found");

// Keep it.
await page.locator(".actions .ghost", { hasText: "Enregistrer" }).click();
await page.locator("form.keep input").fill("Mes hits");
await page.locator("form.keep button[type=submit]").click();
await page.waitForSelector(".actions .ghost:has-text('Ouvrir la playlist')", { timeout: 8000 });
check(saved && saved.title === "Mes hits", "it is saved under the name typed", JSON.stringify(saved));
check(await page.locator(".kind", { hasText: "Playlist enregistrée" }).count() === 1, "and says so");

// The other way in: the library's own button, which must fit beside the others.
await page.goto(base + "/app/#/library");
await page.waitForSelector(".head-actions a[href='#/import']", { timeout: 8000 });
const heads = await page.evaluate(() =>
  [...document.querySelectorAll(".head-actions > *")].map((e) => e.getBoundingClientRect().right)
);
check(heads.every((r) => r <= window_w()), "the library's import button fits on screen", heads.map(Math.round).join(","));
if (process.env.SHOTS) await page.screenshot({ path: join(process.env.SHOTS, PHONE ? "import-library-phone.png" : "import-library-desktop.png") });

await browser.close();
stop();
process.exit(state.failed ? 1 : 0);
