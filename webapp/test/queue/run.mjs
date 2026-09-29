#!/usr/bin/env node
// The queue's editing, end to end in headless Chromium: drag a row to reorder
// the queue, drag toward the far end of a 4 000-track queue (the list scrolls
// under the finger and the row being dragged leaves the DOM), clear what is
// left. On what a person does, on what the page then shows.
//
//   npm run build && node test/queue/run.mjs [--phone]     (SHOTS=<dir> keeps a picture of the drag)
//
// Runs tools/perf_api.py --serve (8 000 tracks, a 4 000-track playlist, Deezer
// off) against the BUILT SPA. The tracks have no audio, so /api/stream answers
// with a minute of silence: the player has to be really playing for the queue
// to be a queue and not a list.
import { join } from "node:path";
import { loadPlaywright, startServer, silence, login, checker } from "../harness.mjs";

const { chromium } = await loadPlaywright();
const PHONE = process.argv.includes("--phone");
const { base, ids, stop } = await startServer();
const WAV = silence();
const { check, state } = checker();

const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
const ctx = await browser.newContext(
  PHONE
    ? { viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }
    : { viewport: { width: 1280, height: 1200 } }
);
await ctx.route(/dzcdn\.net|api\.deezer\.com/, (r) => r.abort());
await ctx.route(/\/api\/stream\//, (r) =>
  r.fulfill({ status: 200, body: WAV, headers: { "Content-Type": "audio/wav", "Accept-Ranges": "none" } })
);
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("pageerror:", e.message));
await login(page, base);
await page.reload();
await page.waitForTimeout(1500);

await page.goto(base + "/app/#/playlist/" + ids.big);
await page.waitForFunction(() => document.body.innerText.includes("4000 titres"), null, { timeout: 60000 });
await page.waitForTimeout(500);

// Play the playlist from its first row.
await page.locator('button.play[aria-label="Lire"]').first().click();
await page.waitForTimeout(1000);

// Open the queue: the phone's full-screen player has a sheet for it, the desktop
// a side panel.
if (PHONE) {
  await page.locator("footer.player .now").first().click();
  await page.waitForTimeout(500);
  await page.locator('.m button[aria-label="File d\'attente"]').first().click();
} else {
  await page.locator('button[aria-label="File d\'attente"]').first().click();
}
await page.waitForTimeout(600);
const titles = () => page.evaluate(() => [...document.querySelectorAll(".qitem")].map((r) => ({ i: +r.dataset.qi, t: r.querySelector(".qt")?.textContent, now: r.classList.contains("now"), grip: !!r.querySelector(".grip") })));

const rows = async () => (await titles()).filter((r) => r.i >= 0);
const at = async (i) => (await rows()).find((r) => r.i === i);
const around = async (from, n) => (await rows()).filter((r) => r.i >= from && r.i < from + n).map((r) => r.t);
const box = async (sel) => page.locator(sel).first().boundingBox();
const center = (b) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
const counting = async () => (await page.locator(".qcount").first().textContent().catch(() => "")) || "";

const scrollerSel = PHONE ? ".sheet .queue" : ".np .body, .side-body";

// The pointer: a mouse on the desktop, a finger (real touch events, through the
// protocol) on the phone. A finger lands on the grip and the browser must leave
// the list alone for as long as it is down: that is `touch-action: none`.
const cdp = PHONE ? await ctx.newCDPSession(page) : null;
const finger = { x: 0, y: 0 };
const touch = (type, pts) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: pts });
const ptr = {
  async down(x, y) {
    if (!PHONE) { await page.mouse.move(x, y); return page.mouse.down(); }
    Object.assign(finger, { x, y });
    return touch("touchStart", [{ x, y }]);
  },
  async move(x, y, steps = 1) {
    if (!PHONE) return page.mouse.move(x, y, { steps });
    const from = { ...finger };
    for (let k = 1; k <= steps; k++) {
      Object.assign(finger, { x: from.x + ((x - from.x) * k) / steps, y: from.y + ((y - from.y) * k) / steps });
      await touch("touchMove", [{ ...finger }]);
      await page.waitForTimeout(16);
    }
  },
  async up() {
    if (!PHONE) return page.mouse.up();
    return touch("touchEnd", []);
  },
};
async function grab(i) {
  const g = center(await box(`.qitem[data-qi="${i}"] .grip`));
  await ptr.down(g.x, g.y);
  return g;
}
async function toRow(i, g, offset = 0) {
  const r = center(await box(`.qitem[data-qi="${i}"]`));
  await ptr.move(g.x, r.y + offset, 10);
}

const first = await rows();
const before = first.slice(0, 6).map((r) => r.t);
check(first[0].now && !first[0].grip, "the playing row is marked, and has no grip");
check(first.slice(1).every((r) => r.grip), "every upcoming row has one");
check(/4\s?0\d\d|39\d\d/.test(await counting()) || (await counting()).includes("À suivre"), "the header counts what is left", await counting());

// 1. Drag row 1 down to row 4.
{
  const g = await grab(1);
  await toRow(4, g);
  if (process.env.SHOTS) await page.screenshot({ path: join(process.env.SHOTS, PHONE ? "queue-phone.png" : "queue-desktop.png") });
  check((await page.locator(".ghost").count()) === 1, "a copy of the row follows the pointer");
  check((await page.locator(".qitem.after").count()) === 1 && (await at(4)) && (await page.locator('.qitem.after').first().getAttribute("data-qi")) === "4",
    "the line shows where it will land");
  await ptr.up();
  await page.waitForTimeout(150);
  const now = await around(1, 4);
  check(JSON.stringify(now) === JSON.stringify([before[2], before[3], before[4], before[1]]), "dropped where the line was", now.join(" | "));
  check((await at(0)).now && (await at(0)).t === before[0], "the playing track is untouched");
  check((await page.locator(".ghost").count()) === 0, "the copy is gone");
}

// 2. Above the playing track it stops just after it.
{
  const cur = await around(0, 5);
  const g = await grab(3);
  await toRow(0, g, -20);
  await ptr.up();
  await page.waitForTimeout(150);
  const now = await around(0, 5);
  check(now[0] === cur[0] && now[1] === cur[3], "a drop above the playing row lands right after it", now.join(" | "));
}

// 3. Escape puts it back.
{
  const cur = await around(0, 6);
  const g = await grab(2);
  await toRow(5, g);
  await page.keyboard.press("Escape");
  await ptr.up();
  await page.waitForTimeout(150);
  check(JSON.stringify(await around(0, 6)) === JSON.stringify(cur), "Escape cancels the drag");
  check((await page.locator(".ghost").count()) === 0, "...and drops the copy");
}

// 4. Toward the far end: the list scrolls under the pointer, the row leaves the DOM.
{
  const moved = (await at(1)).t;
  const g = await grab(1);
  const sb = await box(scrollerSel);
  await ptr.move(g.x, sb.y + sb.height - 6, 6);
  await page.waitForTimeout(1800);
  const seen = (await rows()).filter((r) => r.i > 30).length;
  check(seen > 0, "holding at the edge scrolls the list", `${seen} rows past #30 mounted`);
  check((await page.locator(".ghost").count()) === 1, "the copy is still there though the row is not");
  await ptr.up();
  await page.waitForTimeout(200);
  const landed = (await rows()).find((r) => r.t === moved && r.i > 30);
  check(!!landed, "it lands far down the queue", landed ? `#${landed.i}` : "");
  await page.locator(scrollerSel).first().evaluate((el) => (el.scrollTop = 0));
  await page.waitForTimeout(250);
  check((await at(0)).now && (await at(0)).t === before[0], "the playing track is still the one it was");
}

// 5. Keyboard: focus a grip, arrow down.
{
  const cur = await around(1, 3);
  await page.locator('.qitem[data-qi="1"] .grip').focus();
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(150);
  const now = await around(1, 3);
  check(now[0] === cur[1] && now[1] === cur[0], "the arrows move a row one place", now.join(" | "));
  check((await page.evaluate(() => document.activeElement?.closest(".qitem")?.dataset.qi)) === "2", "and the focus follows it");
}

// 6. Clear.
{
  let radio = 0;
  page.on("request", (r) => /\/api\/radio|\/api\/flow/.test(r.url()) && radio++);
  await page.locator(".qclear").first().click();
  await page.waitForTimeout(600);
  const left = await rows();
  check(left.length === 1 && left[0].now, "'Vider la file' keeps only the playing track", `${left.length} row(s)`);
  check((await page.locator(".qhead").count()) === 0, "and the header goes with what it counted");
  await page.waitForTimeout(6500);
  check(radio === 0 && (await rows()).length === 1, "nothing refills it", `${radio} radio request(s)`);
}

await browser.close();
stop();
process.exit(state.failed ? 1 : 0);
