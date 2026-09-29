#!/usr/bin/env node
// The Explore screen in headless Chromium: the front page, into a genre and
// back, playing a chart. The server is the real one (Deezer off), so what
// Deezer would answer is put in by the test — the point here is the screen.
//
//   npm run build && node test/explore/run.mjs [--phone]     (SHOTS=<dir> keeps pictures)
import { join } from "node:path";
import { loadPlaywright, startServer, silence, login, checker } from "../harness.mjs";

const { chromium } = await loadPlaywright();
const PHONE = process.argv.includes("--phone");
const { base, stop } = await startServer();
const { check, state } = checker();
const WAV = silence(30);

const GENRES = ["Pop", "Rap/Hip Hop", "Rock", "Dance", "R&B", "Alternative", "Électro", "Folk", "Reggae", "Jazz", "Classique", "Films/Jeux vidéo"];
const track = (i) => ({
  deezer_id: String(900 + i), title: `Titre ${i}`, duration: 200,
  artist: { deezer_id: "9", name: "Artiste " + i },
  artists: [{ deezer_id: "9", name: "Artiste " + i, role: "Main" }],
  album: { deezer_id: "10", title: "Album", cover: "" },
});
const album = (i) => ({ deezer_id: String(10 + i), title: `Album ${i}`, cover: "", artist: { deezer_id: "9", name: "Artiste " + i } });
const artist = (i) => ({ deezer_id: String(20 + i), name: `Artiste ${i}`, picture: "" });
const playlist = (i) => ({ deezer_id: String(30 + i), title: `Playlist ${i}`, cover: "", owner: "Deezer", nb_tracks: 50 });
const chart = () => ({
  tracks: Array.from({ length: 50 }, (_, i) => track(i + 1)),
  albums: [1, 2, 3, 4, 5, 6].map(album), artists: [1, 2, 3, 4, 5, 6].map(artist), playlists: [1, 2, 3, 4, 5, 6].map(playlist),
});
const asked = [];

const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
const ctx = await browser.newContext(
  PHONE
    ? { viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }
    : { viewport: { width: 1280, height: 1000 } }
);
await ctx.route(/dzcdn\.net|api\.deezer\.com/, (r) => r.abort());
await ctx.route(/\/api\/stream\//, (r) => r.fulfill({ status: 200, body: WAV, headers: { "Content-Type": "audio/wav", "Accept-Ranges": "none" } }));
const json = (r, body) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
await ctx.route(/\/api\/explore/, (r) => {
  const u = new URL(r.request().url()).pathname;
  asked.push(u);
  if (u === "/api/explore") return json(r, { ...chart(), genres: GENRES.map((name, i) => ({ deezer_id: String(100 + i), name, picture: "" })), releases: [7, 8, 9, 10].map(album) });
  if (u === "/api/explore/countries") return json(r, { playlists: ["France", "Japon", "Brésil"].map((c, i) => ({ ...playlist(40 + i), title: "Top " + c })) });
  const m = u.match(/genre\/(\d+)$/);
  return json(r, { ...chart(), genre: { deezer_id: m[1], name: GENRES[+m[1] - 100] || "Genre", picture: "" } });
});
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("pageerror:", e.message));
await login(page, base);
await page.reload();
await page.waitForTimeout(1200);

// The way in: the navigation.
await page.locator(PHONE ? ".mobilenav a[href='#/explore']" : ".sidebar a[href='#/explore'], a[href='#/explore']").first().click();
await page.waitForSelector(".tile", { timeout: 15000 });
check((await page.locator(".tile").count()) === GENRES.length, "every genre is a tile", `${await page.locator(".tile").count()}`);
check((await page.locator("h2", { hasText: "Genres" }).count()) === 1, "under a Genres heading");
check((await page.locator("h2", { hasText: "Top titres" }).count()) === 1, "with the top tracks");
{
  // Windowed: a phone mounts what it shows. Never more than the ten, never none.
  const n = await page.locator(".row.track").count();
  check(n >= 3 && n <= 10, "ten of them at most, the rest a tap away", `${n} mounted`);
}
for (const h of ["Nouveautés", "Albums du moment", "Artistes en vogue", "Playlists populaires"])
  check((await page.locator("h2", { hasText: h }).count()) === 1, `a “${h}” shelf`);
await page.waitForSelector("h2:has-text('Classements par pays')", { timeout: 8000 }).catch(() => {});
check((await page.locator("h2", { hasText: "Classements par pays" }).count()) === 1, "and the country charts, which arrive on their own");
if (process.env.SHOTS) await page.screenshot({ path: join(process.env.SHOTS, PHONE ? "explore-phone.png" : "explore-desktop.png") });

// Play the chart from the front page.
await page.locator("button", { hasText: "Lire les 50 titres" }).click();
await page.waitForTimeout(800);
const queued = await page.evaluate(() => JSON.parse(localStorage.getItem("player.session") || "null")?.queue?.length ?? null);
check(await page.locator("footer.player .info .t", { hasText: "Titre 1" }).count() === 1, "‘Lire les 50 titres’ plays the chart from the top");

// Into a genre.
await page.locator(".tile", { hasText: "Rock" }).click();
await page.waitForSelector("h1:has-text('Rock')", { timeout: 8000 });
check(asked.includes("/api/explore/genre/102"), "a genre asks for its own charts", asked.at(-1));
check((await page.locator(".row.track").count()) > 10, "and lists them all (windowed)", `${await page.locator(".row.track").count()} rows mounted`);
check((await page.locator(".tile").count()) === 0, "without the genre tiles");
if (process.env.SHOTS) await page.screenshot({ path: join(process.env.SHOTS, PHONE ? "explore-genre-phone.png" : "explore-genre-desktop.png") });
await page.locator("button", { hasText: "Aléatoire" }).click();
await page.waitForTimeout(500);
check((await page.locator("footer.player .info .t").count()) === 1, "shuffling it plays");

// And back to where we were.
await page.locator("button.back").click();
await page.waitForSelector(".tile");
check((await page.locator(".tile").count()) === GENRES.length, "‘Explorer’ is back on the front page");

await browser.close();
stop();
process.exit(state.failed ? 1 : 0);
