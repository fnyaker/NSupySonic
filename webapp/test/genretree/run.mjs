#!/usr/bin/env node
// The genre tree tab, end to end in headless Chromium: the list is windowed
// (a few hundred nodes, a few dozen rows in the DOM), a search keeps a genre's
// descendants, a drag-free move through the picker lands on the server, and
// nothing overflows at a desktop width, a phone and the narrow 360 px column.
//
//   npm run build && node test/genretree/run.mjs      (SHOTS=<dir> keeps pictures)
import { join } from "node:path";
import { loadPlaywright, startServer, login, checker } from "../harness.mjs";

const { chromium } = await loadPlaywright();
const { base, stop } = await startServer();
const { check, state } = checker();
const browser = await chromium.launch();

async function open(viewport, mobile) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2, isMobile: !!mobile, hasTouch: !!mobile });
  await ctx.route(/dzcdn\.net|api\.deezer\.com/, (r) => r.abort());
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("pageerror:", e.message));
  await login(page, base);
  await page.reload();
  await page.waitForTimeout(1500);
  await page.goto(base + "/app/#/genres");
  await page.waitForTimeout(1500);
  await page.getByRole("button", { name: "Arbre" }).click();
  await page.waitForSelector(".tree .row", { timeout: 20000 });
  return { ctx, page };
}

for (const [label, vp, mobile] of [
  ["desktop", { width: 1280, height: 900 }, false],
  ["phone", { width: 412, height: 915 }, true],
  ["narrow", { width: 360, height: 800 }, true],
]) {
  const { ctx, page } = await open(vp, mobile);
  const rows = await page.locator(".tree .row").count();
  check(rows > 3 && rows < 40, `${label}: the tree is windowed (${rows} rows mounted)`);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(overflow <= 1, `${label}: no horizontal overflow (${overflow}px)`);
  // every row's controls stay inside the row
  const clipped = await page.evaluate(() =>
    [...document.querySelectorAll(".tree .row")].filter((r) => {
      const b = r.getBoundingClientRect();
      return [...r.children].some((c) => c.getBoundingClientRect().right > b.right + 1);
    }).length,
  );
  check(clipped === 0, `${label}: no control leaves its row (${clipped})`);
  const named = await page.evaluate(() =>
    [...document.querySelectorAll(".tree .row .name")].filter((n) => n.scrollWidth > n.clientWidth + 1).length,
  );
  check(named === 0, `${label}: no genre name is cut (${named} truncated)`, await page.evaluate(() => [...document.querySelectorAll(".tree .row .name")].filter((n) => n.scrollWidth > n.clientWidth + 1).map((n) => n.textContent + ":" + n.clientWidth).join(",")));
  if (process.env.SHOTS) await page.screenshot({ path: join(process.env.SHOTS, `tree-${label}.png`) });

  if (label === "desktop") {
    await page.locator(".tree .search").fill("hard dance");
    await page.waitForTimeout(300);
    const names = await page.locator(".tree .row .name").allTextContents();
    check(names.includes("Hard dance") && names.includes("Hardcore"), "search keeps the genre and what is under it");
    await page.locator(".tree .search").fill("frenchcore");
    await page.waitForTimeout(300);
    // move Frenchcore under Techno through the picker
    await page.locator(".tree .row", { hasText: "Frenchcore" }).first().getByRole("button", { name: "Ranger" }).click();
    await page.locator(".picker input").fill("Techno");
    await page.locator(".picker li > button:first-child", { hasText: /^Techno$/ }).click();
    await page.waitForTimeout(800);
    const tree = await page.evaluate(() => fetch("/api/genre/tree").then((r) => r.json()));
    const parents = tree.edges.filter((e) => e.child === "Frenchcore").map((e) => e.parent);
    check(parents.length === 1 && parents[0] === "Techno", "the move reached the server");
    await page.getByRole("button", { name: "Annuler" }).click();
    await page.waitForTimeout(800);
    const back = await page.evaluate(() => fetch("/api/genre/tree").then((r) => r.json()));
    check(back.edges.some((e) => e.child === "Frenchcore" && e.parent === "Hardcore"), "undo put it back");
  }
  await ctx.close();
}
await browser.close();
await stop();
process.exit(state.failed ? 1 : 0);
