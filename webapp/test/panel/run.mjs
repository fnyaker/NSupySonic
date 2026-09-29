#!/usr/bin/env node
// What is under the full-screen player: a swipe up on the phone (real touch
// events) brings up similar tracks and the artist; on the desktop it is a tab.
//
//   npm run build && node test/panel/run.mjs [--desktop]     (SHOTS=<dir> keeps pictures)
import { join } from "node:path";
import { loadPlaywright, startServer, silence, login, checker } from "../harness.mjs";

const { chromium } = await loadPlaywright();
const DESKTOP = process.argv.includes("--desktop");
const { base, ids, stop } = await startServer();
const { check, state } = checker();
const WAV = silence(60);

const tr = (i) => ({
  deezer_id: String(7000 + i), title: `Similaire ${i}`, duration: 190,
  artist: { deezer_id: "9", name: "Groupe " + i }, artists: [{ deezer_id: "9", name: "Groupe " + i, role: "Main" }],
  album: { deezer_id: "10", title: "Album", cover: "" },
});
const asked = [];
const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
const ctx = await browser.newContext(
  DESKTOP
    ? { viewport: { width: 1280, height: 900 } }
    : { viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }
);
await ctx.route(/dzcdn\.net|api\.deezer\.com/, (r) => r.abort());
await ctx.route(/\/api\/stream\//, (r) => r.fulfill({ status: 200, body: WAV, headers: { "Content-Type": "audio/wav", "Accept-Ranges": "none" } }));
const json = (r, body) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
await ctx.route(/\/api\/radio\/track\//, (r) => {
  asked.push(new URL(r.request().url()).pathname);
  return json(r, { tracks: Array.from({ length: 12 }, (_, i) => tr(i + 1)) });
});
await ctx.route(/\/api\/artist\/\d+$/, (r) => {
  asked.push(new URL(r.request().url()).pathname);
  return json(r, {
    artist: { deezer_id: "9", name: "Le Groupe", picture: "", nb_fan: 1234567 },
    bio: null, top: [1, 2, 3].map((i) => tr(20 + i)), albums: [],
    related: [1, 2, 3].map((i) => ({ deezer_id: String(50 + i), name: "Proche " + i, picture: "" })),
  });
});
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("pageerror:", e.message));
await login(page, base);
await page.reload();
await page.goto(base + "/app/#/playlist/" + ids.big);
await page.waitForFunction(() => document.body.innerText.includes("4000 titres"), null, { timeout: 60000 });
await page.locator('button.play[aria-label="Lire"]').first().click();
await page.waitForTimeout(1000);

const cdp = DESKTOP ? null : await ctx.newCDPSession(page);
const touch = (type, pts) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: pts });
async function swipe(x, y0, y1, steps = 12) {
  await touch("touchStart", [{ x, y: y0 }]);
  for (let k = 1; k <= steps; k++) {
    await touch("touchMove", [{ x, y: y0 + ((y1 - y0) * k) / steps }]);
    await page.waitForTimeout(16);
  }
  await touch("touchEnd", []);
  await page.waitForTimeout(450);
}
const shown = () => page.evaluate(() => {
  const el = document.querySelector(".under");
  if (!el) return 0;
  const r = el.getBoundingClientRect();
  return Math.max(0, Math.min(innerHeight, innerHeight - r.top));
});
const H = 915;

if (DESKTOP) {
  await page.locator('button[aria-label="Plein écran"]').first().click();
  await page.waitForTimeout(600);
  await page.locator(".side .tabs button", { hasText: "Similaires" }).click();
  await page.waitForSelector(".more .row.track", { timeout: 8000 });
  check(asked.some((u) => /radio\/track\/\d+$/.test(u)), "the tab asks for the mix of the playing track", asked.join(" "));
  check((await page.locator(".more .row.track").count()) >= 5, "and lists similar tracks");
  check((await page.locator(".more .aname").textContent()).trim() === "Le Groupe", "with the artist under them");
  check((await page.locator(".more h4", { hasText: "Artistes similaires" }).count()) === 1, "and related artists");
  if (process.env.SHOTS) await page.screenshot({ path: join(process.env.SHOTS, "panel-desktop.png") });
  await page.locator(".more .pill", { hasText: "Tout lire" }).click();
  await page.waitForTimeout(700);
  check(await page.evaluate(() => JSON.parse(localStorage.getItem("player.session")).queue.length) === 12, "‘Tout lire’ plays them");
} else {
  await page.locator("footer.player .now").first().click();
  await page.waitForSelector(".m .scroller");
  await page.waitForTimeout(600);
  check((await page.locator(".under").count()) === 0, "nothing under the player until asked for");
  check((await page.locator(".peek").count()) === 1, "but a hint says there is something");

  // A short swipe changes nothing.
  await swipe(206, 600, 560);
  check((await shown()) === 0, "a swipe of 40 px snaps back", `${await shown()} px`);
  // A swipe up from the cover opens it, and the finger is followed (checked mid-way).
  await touch("touchStart", [{ x: 206, y: 640 }]);
  for (let k = 1; k <= 8; k++) { await touch("touchMove", [{ x: 206, y: 640 - k * 30 }]); await page.waitForTimeout(16); }
  const mid = await shown();
  check(mid > 200 && mid < 260, "the panel follows the finger", `${mid} px for a 240 px drag`);
  await touch("touchEnd", []);
  await page.waitForTimeout(500);
  check((await shown()) >= H - 2, "and settles fully open past the threshold", `${await shown()} px`);
  await page.waitForSelector(".under .row.track", { timeout: 8000 });
  check((await page.locator(".under .row.track").count()) >= 3, "with similar tracks in it");
  check((await page.locator(".under .aname").textContent()).trim() === "Le Groupe", "and the artist");
  if (process.env.SHOTS) await page.screenshot({ path: join(process.env.SHOTS, "panel-phone.png") });

  // Scrolling inside it is its own business: the player does not move.
  await swipe(206, 700, 400);
  check((await shown()) >= H - 2, "scrolling its list leaves it open");
  check((await page.locator(".m").count()) === 1, "and the player is still there");

  // Down from the header closes the panel, not the player.
  await swipe(206, 40, 420);
  check((await shown()) === 0 || (await page.locator(".under").count()) === 0, "a swipe down on its header closes it");
  check((await page.locator(".m .scroller").count()) === 1, "the player is still open under it");

  // Down on the cover still puts the player away.
  await swipe(206, 300, 640);
  check((await page.locator(".m").count()) === 0, "a swipe down on the cover still dismisses the player");

  // The button does the same as the gesture.
  await page.locator("footer.player .now").first().click();
  await page.waitForSelector(".peek");
  await page.locator(".peek").click();
  await page.waitForTimeout(500);
  check((await shown()) >= H - 2, "the hint opens it too");
  await page.locator('.under button[aria-label="Fermer"]').click();
  await page.waitForTimeout(500);
  check((await page.locator(".under").count()) === 0, "and the chevron closes it");

  // Following an artist leaves the player.
  await page.locator(".peek").click();
  await page.waitForTimeout(400);
  await page.locator(".under .artist").click();
  await page.waitForTimeout(600);
  check((await page.locator(".m").count()) === 0 && page.url().includes("#/artist/9"), "the artist card goes to the artist and leaves the player", page.url().split("#")[1]);
}

await browser.close();
stop();
process.exit(state.failed ? 1 : 0);
