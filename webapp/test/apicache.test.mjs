// The offline API cache's records (lib/apicache.js). It used to store the
// PARSED response — a structured clone of every object in it, synchronously,
// on each visit to a big list (17-24 ms for 4000 tracks, measured) — and now
// stores the response's text. Records written by an older build must still
// read, since the cache outlives an update.
import test from "node:test";
import assert from "node:assert/strict";
import { decode } from "../src/lib/apicache.js";

test("a record written as text reads back as the response", () => {
  const data = { tracks: [{ deezer_id: "1", title: "Été" }] };
  assert.deepEqual(decode({ path: "/me/favorites", text: JSON.stringify(data), ts: 1 }), data);
});

test("a record an older build wrote as an object still reads", () => {
  const data = { playlists: [{ id: "x" }] };
  assert.deepEqual(decode({ path: "/me/playlists", data, ts: 1 }), data);
});

test("a missing or damaged record is no answer, not an error", () => {
  assert.equal(decode(null), null);
  assert.equal(decode(undefined), null);
  assert.equal(decode({ path: "/x", text: "{not json", ts: 1 }), null);
  assert.equal(decode({ path: "/x", ts: 1 }), null);
});
