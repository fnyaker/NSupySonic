#!/usr/bin/env node
// The listen party end to end, scored on what the two devices actually PLAY.
//
//   node test/party/run.mjs                  # host and guest, one scenario
//   node test/party/run.mjs --host-trim 40   # the host's device says it sounds 40 ms late
//
// A real server (server.py: a throwaway database, two click tracks cut by
// ffmpeg), a host page running the real hosting code over a real graph, a
// guest page running the real guest — two browser contexts in headless
// Chromium. Each page has a click detector on its own OUTPUT, and each maps
// what it detected to the epoch millisecond it was heard at through its own
// browser's output clock (getOutputTimestamp). The two pages share one machine
// and so one wall clock, so the difference between a click heard on the host
// and the same click heard on the guest is the party's real error — not what
// either page SAYS its position is, which is all a comparison of the two
// pages' numbers can ever check.
//
// Measured with it (headless Chromium, FLAC and Opus chunks, six runs each):
// the guest is heard within 0.5 ms of the host after a seek, a pause and a
// skip, and within the host's own 2.5 ms republish threshold in between. The
// code it replaced put every guest 8-21 ms after the host. What is left are
// audio dropouts: a device whose output clock steps (Chromium steps it by a
// render burst when a callback is late) is re-placed within ~0.1 s on its own
// side; a step on the HOST moves the line, and a guest less than 30 ms off it
// waits for its next chunk seam (up to 6 s) — the one point it can correct at
// without a click. Each such click is listed with the step that caused it.
//
// Like the other benches it needs a browser, so it is not part of `npm test`.

import { spawn, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const webapp = resolve(here, "../..");
const repo = resolve(webapp, "..");

function arg(name, dflt = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return dflt;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : true;
}

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
  // The server's request log is noise here; its errors are not.
  const proc = spawn(py, [join(here, "server.py")], { cwd: repo, stdio: ["pipe", "pipe", "pipe"] });
  proc.stderr.on("data", (d) => {
    for (const line of String(d).split("\n")) if (line && !/"(GET|POST) \//.test(line)) process.stderr.write(line + "\n");
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
const q = (xs, f) => (xs.length ? xs[Math.min(xs.length - 1, Math.floor(xs.length * f))] : NaN);
const f1 = (x) => (Number.isFinite(x) ? `${x >= 0 ? "+" : ""}${x.toFixed(1)}` : "-");

const hostTrim = +arg("host-trim", 0);
const guestTrim = +arg("guest-trim", 0);
const guestFmt = arg("fmt", null); // "flac" to take the codec out of the measurement

const server = await startServer();
const { createServer } = await import("vite");
const vite = await createServer({
  root: webapp,
  configFile: false,
  logLevel: "error",
  server: {
    port: 0,
    host: "127.0.0.1",
    hmr: false,
    watch: null,
    proxy: { "/api": `http://127.0.0.1:${server.port}` },
  },
  optimizeDeps: { noDiscovery: true, entries: [] },
});
await vite.listen();
const url = vite.resolvedUrls.local[0].replace(/\/$/, "");
const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
let code = 0;
try {
  const logs = [];
  const open = async (path) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on("pageerror", (e) => logs.push(`${path}: ${e}`));
    page.on("console", (m) => m.type() === "error" && logs.push(`${path}: ${m.text()}`));
    await page.goto(`${url}/test/party/${path}`);
    await page.waitForFunction(() => window.benchReady, null, { timeout: 30000 });
    return page;
  };
  const host = await open("host.html");
  const guest = await open("guest.html");
  const { a, b } = server.tracks;
  const marks = {};
  const mark = (name) => (marks[name] = Date.now());

  if (!(await host.evaluate(() => window.hostBench.login()))) throw new Error("login refused");
  await host.evaluate(({ a, trim }) => window.hostBench.play(a, { trim }), { a, trim: hostTrim });
  const pid = await host.evaluate(() => window.hostBench.startParty());
  if (!pid) throw new Error("no party");
  await sleep(2000);
  await guest.evaluate(({ pid, trim, fmt }) => window.guestBench.join(pid, { trim, fmt }), { pid, trim: guestTrim, fmt: guestFmt });
  mark("join");
  for (let i = 0; i < 60; i++) {
    const s = await guest.evaluate(() => window.guestBench.status());
    if (s.status === "sync") break;
    await sleep(250);
  }
  mark("sync");
  await sleep(14000);
  mark("seek");
  await host.evaluate(() => window.hostBench.seek(36));
  await sleep(7000);
  mark("pause");
  await host.evaluate(() => window.hostBench.pause());
  await sleep(2500);
  mark("resume");
  await host.evaluate(() => window.hostBench.resume());
  await sleep(7000);
  mark("skip");
  await host.evaluate(({ b, trim }) => window.hostBench.play(b, { trim }), { b, trim: hostTrim });
  await sleep(9000);
  mark("end");

  const H = await host.evaluate(() => window.hostBench.heard());
  const G = await guest.evaluate(() => window.guestBench.heard());
  const gs = await guest.evaluate(() => window.guestBench.status());

  // Each click the guest played, against the host's nearest. The spacing is
  // irregular (server.py), so a guest a click off would not line up.
  const pair = (g) => {
    let best = null;
    for (const h of H.heard) if (best == null || Math.abs(g - h) < Math.abs(g - best)) best = h;
    return best == null ? NaN : g - best;
  };
  const segs = [
    ["steady", marks.sync + 2000, marks.seek],
    ["after a seek", marks.seek, marks.pause],
    ["after pause/resume", marks.resume, marks.skip],
    ["after a skip", marks.skip, marks.end],
  ];
  const expect = hostTrim - guestTrim; // the host's claimed extra latency, less the guest's
  console.log(
    `host: base ${(H.base * 1000).toFixed(1)} ms, output ${(H.output * 1000).toFixed(1)} ms, ${H.sr} Hz, trim ${hostTrim} · ` +
      `guest: base ${(G.base * 1000).toFixed(1)} ms, output ${(G.output * 1000).toFixed(1)} ms (reports ${gs.osLatency} ms), trim ${guestTrim}` +
      ` · joined in ${((marks.sync - marks.join) / 1000).toFixed(1)} s`
  );
  console.log(`guest minus host, ms (positive: the guest is heard later${expect ? `; ${expect} expected from the trims` : ""})`);
  for (const [name, from, to] of segs) {
    const errs = G.heard.filter((g) => g >= from && g < to).map((g) => pair(g) - expect);
    const settle = from + (name === "steady" ? 0 : 1500);
    const settled = G.heard.filter((g) => g >= settle && g < to).map((g) => pair(g) - expect).sort((x, y) => x - y);
    // How long after the event before the guest is back within 5 ms.
    let back = null;
    for (const g of G.heard.filter((g) => g >= from && g < to)) {
      if (Math.abs(pair(g) - expect) <= 5) {
        back = g - from;
        break;
      }
    }
    const abs = settled.map(Math.abs).sort((x, y) => x - y);
    // A systematic error fails (the median off by more than the host's own
    // republish threshold, 2.5 ms, give or take); so does a segment spent
    // mostly off. A click or two caught in an audio dropout does not: those are
    // listed below with the clock step that caused them.
    const within = abs.filter((x) => x <= 5).length / Math.max(1, abs.length);
    const ok = settled.length >= 5 && Math.abs(q(settled, 0.5)) <= 3 && within >= 0.75;
    if (!ok) code = 1;
    console.log(
      `${ok ? "ok  " : "FAIL"} ${name.padEnd(20)} ${String(settled.length).padStart(3)} clicks  p05 ${f1(q(settled, 0.05))}  p50 ${f1(q(settled, 0.5))}  p95 ${f1(q(settled, 0.95))}  |max| ${f1(abs.at(-1))}  within 5 ms ${Math.round(within * 100)}%` +
        (name === "steady" ? "" : `  back in sync after ${back == null ? "never" : `${(back / 1000).toFixed(2)} s`}`) +
        `  (${errs.length} in the segment)`
    );
  }
  // Where each side stands against the line the host PUBLISHED: the published
  // position at the instant a click was heard, minus that click's media time
  // (positive: the line says more than was heard). The host's figure is the
  // accuracy of its latency model; the guest's, of its scheduling.
  const lineAt = (epoch) => {
    let cur = null;
    for (const L of H.lines) if (L[0] <= epoch) cur = L;
    if (!cur || !cur[2].playing) return null;
    const [e0, S0, pub, id] = cur;
    const S = S0 + (epoch - e0);
    return { pos: pub.p + (S - pub.t) / 1000, id };
  };
  const clicksOf = (id) => (id === a.id ? a.clicks : id === b.id ? b.clicks : []);
  const against = (heard) => {
    const out = [];
    for (const e of heard) {
      const L = lineAt(e);
      if (!L) continue;
      let best = null;
      for (const m of clicksOf(L.id)) if (best == null || Math.abs(L.pos - m) < Math.abs(L.pos - best)) best = m;
      if (best != null && Math.abs(L.pos - best) < 0.15) out.push([e, (L.pos - best) * 1000]);
    }
    return out;
  };
  const hostVs = against(H.heard);
  const guestVs = against(G.heard);
  for (const [name, from, to] of segs) {
    const settle = from + (name === "steady" ? 0 : 1500);
    const h = hostVs.filter(([e]) => e >= settle && e < to).map((x) => x[1]).sort((x, y) => x - y);
    const g = guestVs.filter(([e]) => e >= settle && e < to).map((x) => x[1]).sort((x, y) => x - y);
    console.log(
      `     ${name.padEnd(20)} against the published line: host p50 ${f1(q(h, 0.5))} (p05 ${f1(q(h, 0.05))} p95 ${f1(q(h, 0.95))})  guest p50 ${f1(q(g, 0.5))} (p05 ${f1(q(g, 0.05))} p95 ${f1(q(g, 0.95))})`
    );
  }
  // Where each side's output clock stepped (a render burst, usually), as epoch ms.
  const steps = (side) => {
    const out = [];
    for (let i = 1; i < side.stamps.length; i++) {
      const jump = (side.stamps[i][1] - side.stamps[i - 1][1]) * 1000;
      if (Math.abs(jump) > 4) out.push([side.origin + side.stamps[i][0], jump]);
    }
    return out;
  };
  const hSteps = steps(H);
  const gSteps = steps(G);
  const near = (list, e) => list.filter(([t]) => Math.abs(t - e) < 1500).map(([t, j]) => `${f1(j)} ms at ${f1((t - e) / 1000)} s`).join(", ");
  // Any click more than 3 ms off, with its context, whatever the segment.
  for (const g of G.heard.filter((g) => g >= marks.sync && g < marks.end)) {
    const e = pair(g) - expect;
    if (Math.abs(e) <= 3) continue;
    const seg = segs.find(([, from, to]) => g >= from && g < to);
    const gv = guestVs.find(([x]) => x === g);
    const hv = hostVs.reduce((best, x) => (best == null || Math.abs(x[0] - g) < Math.abs(best[0] - g) ? x : best), null);
    const L = lineAt(g);
    const seam = L ? ((L.pos + 3) % 6) - 3 : NaN; // media seconds from the nearest chunk seam
    console.log(
      `       off: +${((g - marks.join) / 1000).toFixed(2)} s after joining (${seg ? seg[0] : "between"}, +${seg ? ((g - seg[1]) / 1000).toFixed(2) : "?"} s in)  guest-host ${f1(e)}  guest vs line ${gv ? f1(gv[1]) : "-"}  host vs line ${hv ? f1(hv[1]) : "-"}` +
        `  seam ${f1(seam)} s` +
        (near(gSteps, g) ? `  guest clock stepped ${near(gSteps, g)}` : "") +
        (near(hSteps, g) ? `  host clock stepped ${near(hSteps, g)}` : "")
    );
  }
  if (arg("trace")) {
    // Every click of the first segment, in order: what happened when.
    for (const g of G.heard.filter((g) => g >= marks.join && g < marks.seek)) {
      const gv = guestVs.find(([e]) => e === g);
      console.log(`       +${((g - marks.join) / 1000).toFixed(2)} s  guest-host ${f1(pair(g))}  guest vs line ${gv ? f1(gv[1]) : "-"}`);
    }
  }
  for (const l of logs.slice(0, 8)) console.log("     ", l);
} finally {
  await browser.close();
  await vite.close();
  server.proc.stdin.end();
}
process.exit(code);
