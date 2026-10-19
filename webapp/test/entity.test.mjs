// How the app names an album, an artist or a playlist (lib/entity.js), and
// what an older build's saved state does under it: a link built from state
// that only carries a provider id still has to open its page.

import test from "node:test";
import assert from "node:assert/strict";

const { entityRef, trackEntityRef } = await import("../src/lib/entity.js");
const { aliasPath } = await import("../src/lib/apicache.js");
const { credits } = await import("../src/lib/format.js");

const UUID = "11111111-2222-5333-8444-555555555555";

test("a row's id names it, the provider's id only when there is no row", () => {
  assert.equal(entityRef({ id: UUID, deezer_id: "2000000" }), UUID);
  assert.equal(entityRef({ deezer_id: "2000000" }), "2000000", "a catalogue result");
  assert.equal(entityRef({ id: UUID, deezer_id: "" }), UUID, "an upload");
});

test("nothing to open is an empty reference, never 'undefined'", () => {
  for (const x of [null, undefined, {}, { deezer_id: "" }, { id: "", deezer_id: "" }, { id: null }])
    assert.equal(entityRef(x), "", JSON.stringify(x));
  assert.equal(entityRef({ id: 42 }), "42");
});

test("state an older build saved (no nested ids) still opens its pages", () => {
  const queued = {
    id: UUID,
    deezer_id: "3135556",
    artist: { deezer_id: "11", name: "Édith" },
    artists: [{ deezer_id: "11", name: "Édith", role: "Main" }],
    album: { deezer_id: "21", title: "Album Un" },
  };
  assert.equal(entityRef(queued.album), "21");
  assert.equal(entityRef(queued.artist), "11");
  assert.equal(entityRef(credits(queued)[0]), "11");
  // A YouTube hit has no page: its empty ids are "not a link".
  assert.equal(entityRef({ id: "", deezer_id: "" }), "");
});

test("the credit fallback keeps the artist's id", () => {
  const t = { artist: { id: UUID, deezer_id: "11", name: "Édith" } };
  assert.equal(entityRef(credits(t)[0]), UUID);
});

test("a page read by provider id is also kept under its row's id", () => {
  const body = JSON.stringify({ album: { id: UUID, deezer_id: "21" }, tracks: [] });
  assert.equal(aliasPath("/album/21", body), "/album/" + UUID);
  assert.equal(aliasPath("/artist/11?x=1", JSON.stringify({ artist: { id: UUID } })), "/artist/" + UUID);
  // Already by id, a playlist, a page with no id, a body that is not JSON: no alias.
  assert.equal(aliasPath("/album/" + UUID, body), null);
  assert.equal(aliasPath("/playlist/21", body), null);
  assert.equal(aliasPath("/album/21", JSON.stringify({ album: {} })), null);
  assert.equal(aliasPath("/album/21", "<html>"), null);
  assert.equal(aliasPath("/album/21", null), null);
});

// Computed with `ids.album_uuid(...)` / `ids.artist_uuid(...)`; tests/test_detach_spa.py
// holds Python to the same values.
export const ALBUMS = { "1": "36a0c40c-51ef-5eb0-9de3-d35c031043de", "2000000": "9f920a71-d7de-58b2-87a9-dfa63a5fe246", "302127": "f9da9aa5-2c85-501c-b96d-02961d0c3c8e" };
export const ARTISTS = { "1": "7d7a6d14-5ff4-5b42-b321-c6e03cdbb47a", "2000000": "1ecb95fa-30da-5690-a747-44d1939568ee", "302127": "c3eced5b-1392-51a9-b178-8df8640a901c" };

test("the album and artist of a library track hash to the UUID of their row", () => {
  const t = { id: UUID };
  for (const [dz, u] of Object.entries(ALBUMS)) assert.equal(trackEntityRef(t, "album", { deezer_id: dz }), u, dz);
  for (const [dz, u] of Object.entries(ARTISTS)) assert.equal(trackEntityRef(t, "artist", { deezer_id: dz }), u, dz);
});

test("a row's own id wins; an upload's UUID, a catalogue track and a YouTube hit are left alone", () => {
  assert.equal(trackEntityRef({ id: UUID }, "album", { id: "x-id", deezer_id: "1" }), "x-id");
  assert.equal(trackEntityRef({ id: UUID }, "album", { deezer_id: UUID }), UUID, "an upload");
  assert.equal(trackEntityRef({ deezer_id: "5" }, "album", { deezer_id: "21" }), "21", "no row yet: the catalogue page");
  assert.equal(trackEntityRef({ id: UUID }, "album", { deezer_id: "" }), "");
  assert.equal(trackEntityRef(null, "artist", { deezer_id: "11" }), "11");
  assert.equal(trackEntityRef({ id: UUID }, "album", null), "");
});
