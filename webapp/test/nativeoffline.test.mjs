// Downloads kept by the Android app (lib/nativeoffline.js ↔ OfflineStore.kt,
// through lib/offline.js): what a download, a play, a removal and the one-off
// move of the Blobs already on the device do — and that nothing a page holds is
// ever dropped before the app has the whole file.
import test from "node:test";
import assert from "node:assert/strict";
import { fakeIndexedDB } from "./fakeidb.mjs";

globalThis.window = { addEventListener() {}, location: { href: "http://srv/app/", origin: "http://srv" } };
globalThis.location = globalThis.window.location;
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
const idb = fakeIndexedDB();
globalThis.indexedDB = idb;
// Nothing here reaches the server: covers and gains are best effort and fail.
const fetched = [];
globalThis.fetch = async (url) => {
  fetched.push(String(url));
  if (String(url).includes("/stream/")) return new Response(new Uint8Array(3000), { headers: { "Content-Type": "audio/flac" } });
  return new Response("", { status: 404 });
};

/**
 * The app, modelled on OfflineStore.kt: files by key, a download that reports
 * progress then its outcome on a later task, pieces that must follow each other.
 */
function app({ version = 5, refuseAt = -1, failDownload = false, free = 1e12 } = {}) {
  const files = new Map(); // key -> { bytes, type }
  const parts = new Map();
  const calls = [];
  window.NSNative = {
    bridgeVersion: () => version,
    offAvailable: () => true,
    offDownload(key, url) {
      calls.push(["download", key, url]);
      setTimeout(() => window.__nsOffline({ id: key, st: "progress", r: 500, t: 2000 }), 0);
      setTimeout(() => {
        if (failDownload) return window.__nsOffline({ id: key, st: "error", msg: "HTTP 503" });
        files.set(key, { bytes: new Uint8Array(2000), type: "audio/flac" });
        window.__nsOffline({ id: key, st: "done", size: 2000, type: "audio/flac" });
      }, 1);
      return true;
    },
    offPut(key, offset, b64) {
      calls.push(["put", key, offset]);
      if (refuseAt >= 0 && offset >= refuseAt) return false;
      const prev = offset === 0 ? new Uint8Array(0) : parts.get(key);
      if (!prev || prev.length !== offset) return false;
      const add = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const next = new Uint8Array(prev.length + add.length);
      next.set(prev);
      next.set(add, prev.length);
      parts.set(key, next);
      return true;
    },
    offCommit(key, type) {
      const p = parts.get(key);
      if (!p) return -1;
      files.set(key, { bytes: p, type });
      parts.delete(key);
      return p.length;
    },
    offRemove: (key) => {
      calls.push(["remove", key]);
      files.delete(key);
    },
    offClear: () => {
      calls.push(["clear"]);
      files.clear();
    },
    offList: () => JSON.stringify([...files].map(([id, f]) => ({ id, type: f.type, size: f.bytes.length }))),
    offFree: () => free,
  };
  N.resetNativeOffline();
  return { files, calls };
}

const { get } = await import("svelte/store");
const S = await import("../src/lib/stores.js");
const N = await import("../src/lib/nativeoffline.js");
const offline = await import("../src/lib/offline.js");

const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const track = (n) => ({ id: U(n), title: "T" + n, duration: 100, gain: -6, album: null, artist: { name: "A" } });
const rows = (store) => idb.dbs.get("nsupy-offline").stores.get(store).rows;

test("a download goes to the app: nothing heavy in IndexedDB, played from the app's URL", async () => {
  const { files, calls } = app();
  await offline.loadOfflineIndex();
  const seen = [];
  assert.equal(await offline.downloadTrack(track(1), "FLAC", (f) => seen.push(f)), true);
  assert.deepEqual(seen, [0.25]);
  assert.ok(files.has(U(1)));
  assert.match(calls[0][2], /^http:\/\/srv\/api\/stream\//, "the server's own stream, absolute");
  assert.equal(rows("audio").has(U(1)), false, "no Blob kept by the page");
  const m = rows("meta").get(U(1));
  assert.equal(m.native, true);
  assert.equal(m.size, 2000);
  assert.ok(get(S.downloads).has(U(1)));
  assert.equal(await offline.getObjectURL(U(1)), `http://srv/__nsoffline/${U(1)}`);
});

test("a download the app could not make is not recorded", async () => {
  const { files } = app({ failDownload: true });
  assert.equal(await offline.downloadTrack(track(2), "FLAC"), false);
  assert.equal(files.has(U(2)), false);
  assert.equal(rows("meta").has(U(2)), false);
  assert.equal(get(S.downloads).has(U(2)), false);
  assert.equal(get(S.downloading).has(U(2)), false);
});

test("an app without the store keeps the old path: the Blob in IndexedDB", async () => {
  app({ version: 4 });
  assert.equal(await offline.downloadTrack(track(3), "FLAC"), true);
  assert.equal(rows("audio").get(U(3)).blob.size, 3000);
  assert.notEqual(rows("meta").get(U(3)).native, true);
  assert.match(await offline.getObjectURL(U(3)), /^blob:/);
});

function seedBlob(n, size) {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = (i * 31 + n) & 255;
  rows("meta").set(U(n), { id: U(n), quality: "FLAC", size, track: { id: U(n), title: "T" }, addedAt: 1, lastPlayedAt: 1 });
  rows("audio").set(U(n), { id: U(n), blob: new Blob([bytes], { type: "audio/flac" }) });
  return bytes;
}

test("the Blobs already on the device move to the app byte for byte, then leave IndexedDB", async () => {
  const { files } = app();
  const bytes = seedBlob(4, 2 * 1024 * 1024 + 7); // three pieces, the last one short
  assert.equal(await offline.moveDownloadsToApp(), 2, "this one and the old-path one above");
  assert.deepEqual(files.get(U(4)).bytes, bytes);
  assert.equal(files.get(U(4)).type, "audio/flac");
  assert.equal(rows("audio").has(U(4)), false);
  assert.equal(rows("meta").get(U(4)).native, true);
  assert.equal(await offline.getObjectURL(U(4)), `http://srv/__nsoffline/${U(4)}`);
  assert.equal(await offline.moveDownloadsToApp(), 0, "once");
});

test("a move the app refuses halfway leaves the page's copy exactly as it was", async () => {
  const { files } = app({ refuseAt: 768 * 1024 });
  seedBlob(5, 1024 * 1024);
  assert.equal(await offline.moveDownloadsToApp(), 0);
  assert.equal(files.has(U(5)), false);
  assert.equal(rows("audio").get(U(5)).blob.size, 1024 * 1024);
  assert.notEqual(rows("meta").get(U(5)).native, true);
  assert.match(await offline.getObjectURL(U(5)), /^blob:/, "still plays from the page");
});

test("no room on the device: the move waits, nothing is touched", async () => {
  const { calls } = app({ free: 10 * 1048576 });
  assert.equal(await offline.moveDownloadsToApp(), 0);
  assert.equal(calls.filter((c) => c[0] === "put").length, 0);
  assert.ok(rows("audio").has(U(5)));
});

test("at launch a file nobody lists is dropped, and a record whose file is gone is forgotten", async () => {
  const { files, calls } = app();
  files.set(U(90), { bytes: new Uint8Array(5), type: "audio/flac" }); // the page went away mid-download
  rows("meta").set(U(91), { id: U(91), native: true, size: 9, track: { id: U(91) } }); // file lost
  files.set(U(1), { bytes: new Uint8Array(2000), type: "audio/flac" });
  files.set(U(4), { bytes: new Uint8Array(9), type: "audio/flac" });
  await offline.loadOfflineIndex();
  assert.ok(calls.some((c) => c[0] === "remove" && c[1] === U(90)));
  assert.equal(rows("meta").has(U(91)), false);
  assert.equal(get(S.downloads).has(U(91)), false);
  assert.ok(get(S.downloads).has(U(1)) && get(S.downloads).has(U(4)));
});

test("removing a download, or all of them, removes the app's files too", async () => {
  const { files } = app();
  files.set(U(1), { bytes: new Uint8Array(2000), type: "audio/flac" });
  files.set(U(4), { bytes: new Uint8Array(9), type: "audio/flac" });
  await offline.loadOfflineIndex();
  assert.equal(await offline.removeTrack(U(1)), true);
  assert.equal(files.has(U(1)), false);
  assert.equal(await offline.getObjectURL(U(1)), null);
  assert.equal(await offline.clearAll(), true);
  assert.equal(files.size, 0);
});

test("keys that could name anything else are refused before the app is asked", async () => {
  const { calls } = app();
  for (const bad of ["../x", "a/b", "", "x".repeat(97), "a b"])
    await assert.rejects(N.nativeDownload(bad, "/api/stream/x"));
  assert.equal(calls.length, 0);
});
