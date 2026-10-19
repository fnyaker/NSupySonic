// The key an album, an artist, a playlist or a show is known by must be the UUID the
// server gives its row. Both sides are pinned to the same table: tests/test_multi_d.py
// holds Python's `ids.*_uuid` to these exact values (computed there, written here as literals).

import test from "node:test";
import assert from "node:assert/strict";

const { canonicalPath, entityKey, entityRef, entityUuid } = await import("../src/lib/entity.js");

const VECTORS = {
  album: { "3361": "0e98c954-4182-557a-8e56-846307201e91", "302127": "f9da9aa5-2c85-501c-b96d-02961d0c3c8e" },
  artist: { "27": "3edfce92-d4c7-5601-b907-5399645439a3", "1": "7d7a6d14-5ff4-5b42-b321-c6e03cdbb47a" },
  playlist: { "908622995": "61f2274f-2bb5-5f9b-950f-c6618dab76af", "1": "fdffb472-c5e9-522b-963f-e89aeb26999a" },
  show: { "12345": "01f551b4-6c46-5311-bbb8-a6d8a6c89f0a" },
};

test("a provider id hashes to the UUID Python gives its row, per kind", () => {
  for (const [kind, table] of Object.entries(VECTORS))
    for (const [dz, uuid] of Object.entries(table)) {
      assert.equal(entityUuid(kind, dz), uuid, `${kind} ${dz}`);
      assert.equal(entityKey({ deezer_id: dz }, kind), uuid, `${kind} ${dz}`);
    }
});

test("the same number is a different entity in each kind", () => {
  assert.notEqual(entityUuid("album", "1"), entityUuid("artist", "1"));
  assert.notEqual(entityUuid("artist", "1"), entityUuid("playlist", "1"));
});

test("the row's own id wins; nothing usable is null", () => {
  assert.equal(entityKey({ id: "abc", deezer_id: "3361" }, "album"), "abc");
  assert.equal(entityKey({ deezer_id: "" }, "album"), null);
  assert.equal(entityKey({ deezer_id: "not-a-number" }, "album"), null);
  assert.equal(entityKey(null, "album"), null);
  assert.equal(entityUuid("mix", "1"), null);
});

test("a route names an entity by its provider id, else its UUID", () => {
  assert.equal(entityRef({ id: "u", deezer_id: "3361" }), "3361");
  assert.equal(entityRef({ id: "u", deezer_id: "" }), "u");
  assert.equal(entityRef({ id: "u" }), "u");
  assert.equal(entityRef(null), null);
});

test("a path with a provider id is spelled with the UUID, nothing else moves", () => {
  assert.equal(canonicalPath("/album/3361"), "/album/" + VECTORS.album["3361"]);
  assert.equal(canonicalPath("/artist/27/on-deezer"), "/artist/" + VECTORS.artist["27"] + "/on-deezer");
  assert.equal(canonicalPath("/playlist/1/"), "/playlist/" + VECTORS.playlist["1"] + "/");
  const same = ["/album/" + VECTORS.album["3361"], "/home", "/home/mix/techno", "/artist/", "/albums/12", "/me/playlists"];
  for (const p of same) assert.equal(canonicalPath(p), p);
});
