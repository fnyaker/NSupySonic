// What the browser tests share (test/queue/run.mjs, test/player/run.mjs): a
// real server on a big synthetic library, Playwright, and audio to play.
//
// Not a test itself (npm test only picks up *.test.mjs).
import { spawn, execSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

export async function loadPlaywright() {
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

/**
 * tools/perf_api.py --serve: 8 000 tracks, a 4 000-track playlist, Deezer off,
 * against the BUILT SPA (npm run build first). Login: bench / Bench1.
 * Resolves { base, ids, stop }.
 */
export async function startServer() {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const py =
    process.env.PYTHON || (existsSync(join(repo, ".venv/bin/python")) ? join(repo, ".venv/bin/python") : "python3");
  const srv = spawn(py, [join(repo, "tools/perf_api.py"), "--runs", "1", "--serve"], {
    stdio: ["pipe", "pipe", "ignore"],
  });
  const ready = await new Promise((res, rej) => {
    let buf = "";
    srv.stdout.on("data", (d) => {
      buf += d;
      const m = buf.match(/READY (\d+) (.*)\n/);
      if (m) res({ port: +m[1], ids: JSON.parse(m[2]) });
    });
    srv.on("exit", () => rej(new Error("server exited")));
  });
  return { base: `http://127.0.0.1:${ready.port}`, ids: ready.ids, stop: () => srv.kill() };
}

/** Silence as a WAV (8 kHz, 8-bit, mono) — the tracks in that library have no audio. */
export function silence(seconds = 60) {
  const rate = 8000;
  const n = rate * seconds;
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + n, 4);
  h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate, 28);
  h.writeUInt16LE(1, 32);
  h.writeUInt16LE(8, 34);
  h.write("data", 36);
  h.writeUInt32LE(n, 40);
  return Buffer.concat([h, Buffer.alloc(n, 128)]);
}

export async function login(page, base) {
  await page.goto(base + "/app/");
  await page.evaluate(() =>
    fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "bench", password: "Bench1" }),
    })
  );
}

export function checker() {
  const state = { failed: 0 };
  const check = (ok, what, extra = "") => {
    console.log(`${ok ? "ok  " : "FAIL"} ${what}${extra ? "  — " + extra : ""}`);
    if (!ok) state.failed++;
  };
  return { check, state };
}
