// lib/youtube.js: when the player says what a YouTube track REALLY plays at,
// and what it costs to know it.
//
// The rule mirrors the server's (webui/youtube.py#serve): a client asking for
// less than the file holds gets a transcode at that rate, so the quality chip
// is then the truth; asking for about as much or more gets the file itself, so
// a chip reading "FLAC" or "Opus 320" over it would claim a quality nobody is
// hearing — that is when the badge shows. The real figure is read once per
// track from /probe (our server; never YouTube).

import test from "node:test";
import assert from "node:assert/strict";

globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.window = { addEventListener() {}, removeEventListener() {}, location: { hash: "" } };

const asked = [];
globalThis.fetch = async (url) => {
  asked.push(String(url));
  return {
    ok: true,
    status: 200,
    statusText: "",
    headers: { get: () => null },
    json: async () => ({ available: true, reason: null, bitrate: 131 }),
    clone() {
      return this;
    },
    text: async () => "{}",
  };
};

const { askedKbps, realBitrateBadge, realBitrate } = await import("../src/lib/youtube.js");

const yt = { deezer_id: "7f9c2d1e-0000-5000-8000-000000000001", source: "youtube", bitrate: 0 };
const deezer = { deezer_id: "3135556", title: "Harder, Better" };

test("a quality setting is read as the kbit/s it asks for", () => {
  assert.equal(askedKbps("FLAC"), Infinity);
  assert.equal(askedKbps("OPUS_320"), 320);
  assert.equal(askedKbps("OPUS_64"), 64);
});

test("the badge shows only when the setting asks for more than the file has", () => {
  // A 131 kbit/s file: FLAC, 320, 256 and 192 are promises it cannot keep.
  for (const q of ["FLAC", "OPUS_320", "OPUS_256", "OPUS_192"]) {
    assert.deepEqual(realBitrateBadge(yt, q, 131)?.short, "YT 131k", q);
  }
  // 128 and 64 are transcodes of it (or the file at about that rate): true.
  assert.equal(realBitrateBadge(yt, "OPUS_128", 131), null);
  assert.equal(realBitrateBadge(yt, "OPUS_64", 131), null);
  // Not measured yet: still says where it comes from.
  assert.equal(realBitrateBadge(yt, "FLAC", 0).short, "YT");
  // A Deezer track never gets one.
  assert.equal(realBitrateBadge(deezer, "FLAC", 0), null);
});

test("the real rate is asked of our server once per track, and never for Deezer", async () => {
  assert.equal(await realBitrate(yt), 131);
  assert.equal(await realBitrate(yt), 131);
  assert.equal(await realBitrate(deezer), 0);
  // A copy of the track that already knows it asks nobody.
  assert.equal(await realBitrate({ ...yt, deezer_id: "other", bitrate: 150 }), 150);
  assert.deepEqual(asked, ["/api/track/" + yt.deezer_id + "/probe"]);
});
