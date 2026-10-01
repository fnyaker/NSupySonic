#!/usr/bin/env node
// The desktop full-screen player at the window sizes a PC really has: every
// control must be on screen and be what a click at its centre lands on —
// nothing drawn over it, nothing pushed under the side panel or off the edge.
//
//   npm run build && node test/fullscreen/run.mjs     (SHOTS=<dir> keeps pictures)
import { join } from "node:path";
import { loadPlaywright, startServer, silence, login, checker } from "../harness.mjs";

const { chromium } = await loadPlaywright();
const { base, ids, stop } = await startServer();
const { check, state } = checker();
const WAV = silence(60);

const SIZES = [
  [1920, 1080], [1440, 900], [1366, 768], [1280, 720], [1024, 768], [900, 700], [800, 600], [700, 900], [1280, 560],
];

const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.route(/dzcdn\.net|api\.deezer\.com/, (r) => r.abort());
await ctx.route(/\/api\/stream\//, (r) => r.fulfill({ status: 200, body: WAV, headers: { "Content-Type": "audio/wav", "Accept-Ranges": "none" } }));
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("pageerror:", e.message));
await login(page, base);
await page.reload();
await page.goto(base + "/app/#/playlist/" + ids.big);
await page.waitForFunction(() => document.body.innerText.includes("4000 titres"), null, { timeout: 60000 });
await page.locator('button.play[aria-label="Lire"]').first().click();
await page.waitForTimeout(1000);
await page.locator('button[aria-label="Plein écran"]').first().click();
await page.waitForSelector(".d .controls .pp");

for (const [w, h] of SIZES) {
  await page.setViewportSize({ width: w, height: h });
  await page.waitForTimeout(400);
  const bad = await page.evaluate(() => {
    const out = [];
    const root = document.querySelector(".d");
    for (const el of root.querySelectorAll("button, input, [role=button]")) {
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none") continue;
      if (el.closest(".side-body")) continue; // the queue's rows scroll in their own pane
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const name = el.getAttribute("aria-label") || el.textContent.trim().slice(0, 24) || el.className;
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      if (r.left < 0 || r.top < 0 || r.right > innerWidth + 0.5 || r.bottom > innerHeight + 0.5) {
        out.push(`${name}: off screen (${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)})`);
        continue;
      }
      const hit = document.elementFromPoint(cx, cy);
      if (!hit || !(el === hit || el.contains(hit))) {
        out.push(`${name}: covered by ${hit ? hit.tagName.toLowerCase() + "." + [...hit.classList].join(".") : "nothing"}`);
      }
    }
    // Controls of the main column must not spill out of it (into the side panel).
    const main = root.querySelector(".main").getBoundingClientRect();
    for (const el of root.querySelectorAll(".main button, .main input")) {
      const r = el.getBoundingClientRect();
      if (!r.width || getComputedStyle(el).visibility === "hidden") continue;
      if (r.left < main.left - 1 || r.right > main.right + 1) out.push(`${el.getAttribute("aria-label") || el.className}: outside its column`);
    }
    return [...new Set(out)];
  });
  check(bad.length === 0, `${w}x${h}: every control on screen and clickable`, bad.join("; "));
  if (process.env.SHOTS) await page.screenshot({ path: join(process.env.SHOTS, `fullscreen-${w}x${h}.png`) });
}

await browser.close();
stop();
process.exit(state.failed ? 1 : 0);
