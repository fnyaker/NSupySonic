// The client analysis run (src/lib/analysis): the Rust core through its JS wrapper on a real
// synthetic click track, the block downloader against a mock server (Range, 503 + Retry-After,
// a wrong block), and the runner's ledger, stop and version stop.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadMeasure, measureTrack, monoOf } from "../src/lib/analysis/measure.js";
import { fetchBlocks } from "../src/lib/analysis/download.js";
import { createRunner } from "../src/lib/analysis/runner.js";

const here = dirname(fileURLToPath(import.meta.url));
const wasm = readFileSync(join(here, "../src/lib/measure/measure.wasm"));

function clicks(bpm, seconds, rate = 44100) {
  const n = seconds * rate;
  const out = new Float32Array(n);
  const period = (60 / bpm) * rate;
  for (let at = 0; at < n; at += period) {
    const s = Math.floor(at);
    for (let i = 0; i < 4000 && s + i < n; i++) {
      out[s + i] += 0.8 * Math.sin(2 * Math.PI * (50 + 150 * Math.exp(-i / 300)) * (i / rate)) * Math.exp(-i / 900);
    }
  }
  return out;
}

test("a 150 BPM kick reads at 150 through the wrapper", async () => {
  const x = await loadMeasure(wasm);
  const ch = clicks(150, 40);
  const r = measureTrack(x, { channels: [ch], rate: 44100, mono44: ch });
  assert.ok(r.tempo, "a tempo is found");
  assert.ok(Math.abs(r.tempo.bpm - 150) < 0.5, `bpm ${r.tempo.bpm}`);
  assert.ok(r.tempo.attacks > 100);
  assert.ok(r.spectral.centroid > 0 && r.spectral.frames > 100);
  // a second run on the same instance gives the same numbers (no state leaks between tracks)
  const again = measureTrack(x, { channels: [ch], rate: 44100, mono44: ch });
  assert.deepEqual(again, r);
});

test("silence is a named failure (no spectral frames), not a made-up measure", async () => {
  const x = await loadMeasure(wasm);
  const z = new Float32Array(44100 * 20);
  assert.throws(() => measureTrack(x, { channels: [z], rate: 44100, mono44: z }), /no spectral frames/);
  // and the instance is still good for the next track
  const ch = clicks(120, 30);
  assert.ok(measureTrack(x, { channels: [ch], rate: 44100, mono44: ch }).tempo);
});

test("monoOf averages the channels", () => {
  const m = monoOf([Float32Array.of(1, 0), Float32Array.of(0, 1)]);
  assert.deepEqual([...m], [0.5, 0.5]);
});

// -- the downloader ------------------------------------------------------------------------

const FILE = Uint8Array.from({ length: 1000 }, (_, i) => i % 251);

function server(script = () => null) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push(init.headers.Range);
    const forced = script(calls.length);
    if (forced) return forced;
    const [, a, b] = /bytes=(\d+)-(\d+)/.exec(init.headers.Range);
    const end = Math.min(+b, FILE.length - 1);
    return new Response(FILE.slice(+a, end + 1), {
      status: 206,
      headers: { "Content-Range": `bytes ${a}-${end}/${FILE.length}` },
    });
  };
  return { fn, calls };
}

test("a file arrives whole in blocks, each marked as background", async () => {
  const s = server();
  const got = await fetchBlocks("/api/stream/x", { fetch: s.fn, block: 300 });
  assert.deepEqual(got, FILE);
  assert.equal(s.calls.length, 4);
});

test("a 503 with Retry-After is waited out, one block re-asked", async () => {
  const s = server((n) => (n === 2 ? new Response("", { status: 503, headers: { "Retry-After": "0" } }) : null));
  const got = await fetchBlocks("/x", { fetch: s.fn, block: 500 });
  assert.deepEqual(got, FILE);
  assert.equal(s.calls.length, 3);
});

test("a block that is not the one asked for is refused, not stitched in", async () => {
  const wrong = () =>
    new Response(FILE.slice(0, 300), { status: 206, headers: { "Content-Range": "bytes 100-399/1000" } });
  const s = server((n) => (n === 1 ? wrong() : null));
  const got = await fetchBlocks("/x", { fetch: s.fn, block: 300 });
  assert.deepEqual(got, FILE);
});

test("a 404 fails at once with its status", async () => {
  const s = server(() => new Response("", { status: 404 }));
  await assert.rejects(fetchBlocks("/x", { fetch: s.fn, block: 300 }), /HTTP 404/);
  assert.equal(s.calls.length, 1);
});

test("a server that ignores Range still delivers the file", async () => {
  const whole = async () => new Response(FILE, { status: 200 });
  assert.deepEqual(await fetchBlocks("/x", { fetch: whole, block: 300 }), FILE);
});

// -- the runner ----------------------------------------------------------------------------

function deps({ pages, post, fail = () => false }) {
  const posted = [];
  let i = 0;
  return {
    posted,
    d: {
      api: {
        analysisPlan: async () => ({ unmeasured: 3, stale_measure: 0 }),
        analysisTodo: async () => pages[i++],
        analysisMeasures: async (id, body) => (posted.push(id), post ? post(id, body) : { ok: true }),
      },
      fetchBlocks: async (url) => {
        if (fail(url)) throw new Error("block at 0 could not be fetched");
        return new Uint8Array(1);
      },
      decode: async () => ({ channels: [new Float32Array(1)], mono44: new Float32Array(1) }),
      measure: async () => ({ spectral: { centroid: 1 }, tempo: null }),
    },
  };
}
const T = (id) => ({ id, title: "t" + id, url: "/api/stream/" + id, rate: 44100, channels: 2 });
const PAGE = (ids, next) => ({ tracks: ids.map(T), next, version: 7, spectral_seconds: 600, tempo_seconds: 1200 });

test("the runner pages through the todo and names each failure's cause", async () => {
  const { d, posted } = deps({ pages: [PAGE(["a", "b"], "b"), PAGE(["c"], null)], fail: (u) => u.endsWith("/b") });
  const r = createRunner(d);
  await r.run();
  const s = r.state();
  assert.equal(s.done, 2);
  assert.equal(s.failed, 1);
  assert.deepEqual(posted, ["a", "c"]);
  assert.match(s.failures[0].reason, /block at 0/);
  assert.equal(s.running, false);
});

test("a version refusal stops the whole run with a message", async () => {
  const { d, posted } = deps({
    pages: [PAGE(["a", "b"], null)],
    post: () => {
      throw { status: 409, message: "version" };
    },
  });
  const r = createRunner(d);
  await r.run();
  assert.equal(posted.length, 1);
  assert.match(r.state().error, /recharg/i);
});

test("stop ends after the track in hand and resumes from the server's todo", async () => {
  let r;
  const { d, posted } = deps({ pages: [PAGE(["a", "b", "c"], null)] });
  const orig = d.api.analysisMeasures;
  d.api.analysisMeasures = async (id, b) => {
    const res = await orig(id, b);
    r.stop();
    return res;
  };
  r = createRunner(d);
  await r.run();
  assert.deepEqual(posted, ["a"]);
  assert.equal(r.state().stopped, true);
});
