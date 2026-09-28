// The on-device cover caches (lib/playcache.js, lib/offline.js), on the one
// decision that can destroy something: what to do with a stored cover whose
// <img> just failed.
//
// They used to delete it on sight. For weeks every cached cover failed —
// the server's CSP had no `blob:` in img-src, so Chromium refused each object
// URL before loading it — and each one was deleted, fetched again on the next
// play, refused again. On the permanent downloads it was worse: nothing ever
// fetched their art again, so a library downloaded for the plane lost its
// pochettes one screen at a time.
//
// What the caches now ask is the bytes themselves (lib/imagebytes.js, via
// createImageBitmap). The decoder below is modelled on what Chromium measured,
// under the refusing policy: a complete JPEG decodes while the <img> showing it
// is refused; the first 90%, 50%, 10% or 1% of the same JPEG is REFUSED by
// createImageBitmap (an <img> draws it partially, so it never reaches this
// path); 4 KB of zeros and an HTML error page are refused by both.
import test from "node:test";
import assert from "node:assert/strict";

// --- the browser, as far as these modules reach ------------------------------
globalThis.window = { addEventListener() {}, location: { href: "http://x/" } };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };

/**
 * A spec-shaped IndexedDB, in memory: every request settles on a later task,
 * and a transaction completes once it has nothing pending — which is what
 * makes holding one across a non-IndexedDB await a bug here as it is there.
 */
function fakeIndexedDB() {
  const dbs = new Map();
  const later = (fn) => setTimeout(fn, 0);
  function transaction(db) {
    const t = { pending: 0, done: false, oncomplete: null, onerror: null, onabort: null };
    t.settle = () =>
      later(() => {
        if (t.done || t.pending) return;
        t.done = true;
        if (t.oncomplete) t.oncomplete();
      });
    t.objectStore = (name) => {
      const s = db.stores.get(name);
      const req = (fn) => {
        if (t.done) throw new DOMException("The transaction has finished.", "TransactionInactiveError");
        const r = { onsuccess: null, onerror: null, result: undefined };
        t.pending++;
        later(() => {
          try {
            r.result = fn();
            if (r.onsuccess) r.onsuccess({ target: r });
          } catch (e) {
            r.error = e;
            if (r.onerror) r.onerror({ target: r });
          }
          t.pending--;
          t.settle();
        });
        return r;
      };
      return {
        get: (k) => req(() => s.rows.get(k)),
        getAll: () => req(() => [...s.rows.values()]),
        put: (v) => req(() => void s.rows.set(v[s.keyPath], v)),
        delete: (k) => req(() => void s.rows.delete(k)),
        clear: () => req(() => s.rows.clear()),
      };
    };
    t.settle();
    return t;
  }
  return {
    dbs,
    open(name) {
      const req = { onsuccess: null, onerror: null, onupgradeneeded: null, result: undefined };
      later(() => {
        let db = dbs.get(name);
        const fresh = !db;
        if (fresh) {
          db = {
            stores: new Map(),
            objectStoreNames: { contains: (n) => db.stores.has(n) },
            createObjectStore: (n, { keyPath }) => db.stores.set(n, { keyPath, rows: new Map() }),
            transaction: () => transaction(db),
          };
          dbs.set(name, db);
        }
        req.result = db;
        if (fresh && req.onupgradeneeded) req.onupgradeneeded();
        if (req.onsuccess) req.onsuccess();
      });
      return req;
    },
  };
}
const idb = fakeIndexedDB();
globalThis.indexedDB = idb;

// A JPEG is SOI (FF D8) ... EOI (FF D9); anything short of that is refused.
let decodes = 0;
globalThis.createImageBitmap = async (blob) => {
  decodes++;
  const b = new Uint8Array(await blob.arrayBuffer());
  const whole =
    b.length > 4 && b[0] === 0xff && b[1] === 0xd8 && b[b.length - 2] === 0xff && b[b.length - 1] === 0xd9;
  if (!whole) throw new DOMException("The source image could not be decoded.", "InvalidStateError");
  return { close() {} };
};
const jpeg = (n = 64) => {
  const b = new Uint8Array(n).fill(0x42);
  b.set([0xff, 0xd8], 0);
  b.set([0xff, 0xd9], n - 2);
  return new Blob([b], { type: "image/jpeg" });
};
const truncated = () => new Blob([new Uint8Array([0xff, 0xd8, 0x42, 0x42, 0x42, 0x42])]);

const revoked = [];
const realRevoke = URL.revokeObjectURL;
URL.revokeObjectURL = (u) => {
  revoked.push(u);
  realRevoke(u);
};

const { get } = await import("svelte/store");
const { offlineCovers, playCacheSize } = await import("../src/lib/stores.js");
const { online } = await import("../src/lib/net.js");
const { coverKey } = await import("../src/lib/format.js");
const playcache = await import("../src/lib/playcache.js");
const offline = await import("../src/lib/offline.js");
online.set(true);

const CDN = "https://cdn-images.dzcdn.net/images/cover";
const art = (md5, px = 500) => `${CDN}/${md5}/${px}x${px}-000000-80-0-0.jpg`;

async function seed(dbName, store, rows) {
  // Open through the module under test so the schema is its own.
  const db = idb.dbs.get(dbName);
  for (const r of rows) db.stores.get(store).rows.set(r.url ?? r.id, r);
}

test("the play cache keeps a refused cover whose bytes decode, and drops one whose bytes do not", async () => {
  await playcache.initPlayCache(); // creates the database
  const good = art("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  const bad = art("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  await seed("nsupy-playcache", "covers", [
    { url: good, blob: jpeg(), size: 64, ts: 1 },
    { url: bad, blob: truncated(), size: 6, ts: 2 },
  ]);
  await playcache.initPlayCache(); // publishes both, as a launch does
  const goodUrl = get(offlineCovers)[coverKey(good)];
  const badUrl = get(offlineCovers)[coverKey(bad)];
  assert.ok(goodUrl && badUrl);
  const sizeBefore = get(playCacheSize);

  // The full-screen view asks for 1000px art: the key is what must match.
  assert.equal(await playcache.forgetCachedCover(art("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", 1000)), true);
  const rows = idb.dbs.get("nsupy-playcache").stores.get("covers").rows;
  assert.ok(rows.has(good), "intact bytes are never deleted");
  assert.equal(get(offlineCovers)[coverKey(good)], goodUrl, "…nor is the URL showing them");
  assert.ok(!revoked.includes(goodUrl));

  assert.equal(await playcache.forgetCachedCover(bad), true);
  assert.ok(!rows.has(bad), "bytes that do not decode are dropped");
  assert.equal(get(offlineCovers)[coverKey(bad)], undefined);
  assert.ok(revoked.includes(badUrl));
  assert.equal(get(playCacheSize), sizeBefore - 6, "and their size is given back");
});

test("every Cover failing on the same art at once costs one decode, not one each", async () => {
  const u = art("cccccccccccccccccccccccccccccccc");
  await seed("nsupy-playcache", "covers", [{ url: u, blob: jpeg(), size: 64, ts: 3 }]);
  await playcache.initPlayCache();
  decodes = 0;
  const all = await Promise.all([1, 2, 3, 4].map(() => playcache.forgetCachedCover(u)));
  assert.deepEqual(all, [true, true, true, true]);
  assert.equal(decodes, 1);
});

test("the play cache leaves alone art it does not own", async () => {
  // The downloads' copy is on screen; the play cache has none of its own.
  const u = art("dddddddddddddddddddddddddddddddd");
  const theirs = URL.createObjectURL(jpeg());
  offlineCovers.update((m) => ({ ...m, [coverKey(u)]: theirs }));
  assert.equal(await playcache.forgetCachedCover(u), false, "not ours: the caller asks offline.js");
  assert.equal(get(offlineCovers)[coverKey(u)], theirs);
  assert.ok(!revoked.includes(theirs));
});

test("a download's cover goes only when its bytes are really broken", async () => {
  await offline.loadOfflineIndex(); // creates the database (no cover pass: no repair timer)
  const good = art("eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee");
  const bad = art("ffffffffffffffffffffffffffffffff");
  await seed("nsupy-offline", "covers", [
    { url: good, blob: jpeg() },
    { url: bad, blob: truncated() },
  ]);
  const goodUrl = URL.createObjectURL(jpeg());
  const badUrl = URL.createObjectURL(truncated());
  offlineCovers.update((m) => ({ ...m, [coverKey(good)]: goodUrl, [coverKey(bad)]: badUrl }));
  const rows = idb.dbs.get("nsupy-offline").stores.get("covers").rows;

  await offline.forgetDownloadedCover(good);
  assert.ok(rows.has(good));
  assert.equal(get(offlineCovers)[coverKey(good)], goodUrl);

  await offline.forgetDownloadedCover(bad);
  assert.ok(!rows.has(bad));
  assert.equal(get(offlineCovers)[coverKey(bad)], undefined);
  assert.ok(revoked.includes(badUrl));
});

test("downloads that lost their art get it back, once per picture, in the background", async () => {
  const kept = art("11111111111111111111111111111111");
  const lost = art("22222222222222222222222222222222");
  const lostToo = art("33333333333333333333333333333333");
  const artless = art("44444444444444444444444444444444");
  await seed("nsupy-offline", "covers", [{ url: kept, blob: jpeg() }]);
  await seed("nsupy-offline", "meta", [
    { id: "1", track: { deezer_id: "1", album: { cover: kept } } },
    { id: "2", track: { deezer_id: "2", album: { cover: lost } } },
    { id: "3", track: { deezer_id: "3", album: { cover: lost } } }, // same album
    { id: "4", track: { deezer_id: "4", album: { cover: lostToo } } },
    { id: "5", track: { deezer_id: "5", album: { cover: artless } } },
    { id: "6", track: { deezer_id: "6", album: null } },
  ]);
  // The play cache is already showing one of them: the download still needs
  // a copy of its own, since the play cache's is evictable.
  const shown = URL.createObjectURL(jpeg());
  offlineCovers.update((m) => ({ ...m, [coverKey(lostToo)]: shown }));

  const asked = [];
  globalThis.fetch = async (url, opts) => {
    asked.push({ url, bg: opts?.headers?.["X-NS-Background"] });
    if (url.endsWith("/5")) return new Response('{"error":"no cover"}', { status: 404 });
    return new Response(jpeg(), { status: 200, headers: { "Content-Type": "image/jpeg" } });
  };
  const have = new Set([coverKey(kept)]);
  const out = await offline.repairMissingCovers(have);
  assert.deepEqual(out, { missing: 3, repaired: 2 });
  assert.deepEqual(
    asked.map((a) => a.url.split("/").pop()).sort(),
    ["2", "4", "5"],
    "one request per missing picture — not per track, not for what is there"
  );
  assert.ok(asked.every((a) => a.bg === "1"), "and every one says nobody is waiting on it");
  const rows = idb.dbs.get("nsupy-offline").stores.get("covers").rows;
  assert.ok(rows.has(lost) && rows.has(lostToo));
  assert.ok(get(offlineCovers)[coverKey(lost)], "a repaired cover shows at once");
  assert.equal(get(offlineCovers)[coverKey(lostToo)], shown, "the URL already on screen is not swapped");

  // Offline, it does not try at all.
  asked.length = 0;
  online.set(false);
  await offline.repairMissingCovers(new Set());
  assert.equal(asked.length, 0);
  online.set(true);
});
