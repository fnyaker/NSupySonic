// The key a track is known by in the app must be the UUID the server gives its
// row. Both sides are pinned to the same table: tests/test_detach_g.py holds
// Python's `ids.track_uuid` to these exact values.

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const { migrateKey, sameTrack, sha1, trackKey, trackRef, uuid5Track } = await import(
  "../src/lib/trackkey.js"
);

// Computed with `ids.track_uuid(...)`.
export const VECTORS = {
  "3135556": "07e9d96b-af2c-5213-96bf-e9d8ea203276",
  "1": "a64d64fb-a1af-54c3-ae08-6a2bcba4c767",
  "0": "f8565452-5211-5bd0-b63a-0b7697f0b013",
  "123456789012": "4e96fe4d-5562-556d-8bca-525baa23aa52",
  "1234567890123456789": "8213ca82-6bec-5548-bf04-0ac8e0959a78",
  "99999999999": "13cc20fb-1759-5f39-ac5e-2469de74e123",
};

test("a Deezer id hashes to the UUID Python gives its row", () => {
  for (const [dz, uuid] of Object.entries(VECTORS)) {
    assert.equal(uuid5Track(dz), uuid, dz);
    assert.equal(migrateKey(dz), uuid, dz);
    assert.equal(trackKey({ deezer_id: dz }), uuid, dz);
  }
});

test("sha1 agrees with node's on every padding boundary", () => {
  for (const n of [0, 1, 54, 55, 56, 57, 63, 64, 65, 119, 120, 1000]) {
    const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 31 + 7) & 255);
    assert.equal(
      Buffer.from(sha1(bytes)).toString("hex"),
      createHash("sha1").update(bytes).digest("hex"),
      `length ${n}`
    );
  }
});

test("a row's own id wins; episodes, uploads and UUIDs pass through", () => {
  const u = "11111111-2222-5333-8444-555555555555";
  assert.equal(trackKey({ id: u, deezer_id: "3135556" }), u);
  assert.equal(trackKey({ deezer_id: u }), u, "an episode: its deezer_id is already a UUID");
  assert.equal(migrateKey(u), u);
  assert.equal(trackKey(null), null);
  assert.equal(trackKey({}), null);
  assert.equal(migrateKey(""), "");
});

test("a request names a row by its id, a catalogue result by its Deezer id", () => {
  assert.equal(trackRef({ id: "u1", deezer_id: "3135556" }), "u1");
  assert.equal(trackRef({ deezer_id: "3135556" }), "3135556");
  assert.equal(trackRef(null), null);
});

test("the same track before and after it enters the library is one track", () => {
  assert.ok(sameTrack({ deezer_id: "3135556" }, { id: VECTORS["3135556"], deezer_id: "3135556" }));
  assert.ok(!sameTrack({ deezer_id: "1" }, { deezer_id: "3135556" }));
});

test("a hostile id is not hashed", () => {
  const long = "9".repeat(64);
  assert.equal(migrateKey(long), long);
  assert.equal(migrateKey("12abc"), "12abc");
});
