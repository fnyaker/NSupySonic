import test from "node:test";
import assert from "node:assert/strict";
import { topResult, mixPodcasts } from "../src/lib/searchrank.js";

const art = (name) => ({ deezer_id: name, name });

test("an artist named exactly leads, accents and case aside", () => {
  const r = { artists: [art("Stromae Tribute"), art("Stromaé")] };
  assert.equal(topResult("stromae", r).item.name, "Stromaé");
});

test("the first artist leads on the start of its name, never from inside a word", () => {
  const r = { artists: [art("Daft Punk"), art("Daftside")] };
  assert.equal(topResult("daft", r).item.name, "Daft Punk");
  assert.equal(topResult("daft p", r).item.name, "Daft Punk");
  assert.equal(topResult("aft", r), null);
  assert.equal(topResult("da", r), null); // two letters name nothing yet
});

test("a title search does not get an artist on top", () => {
  const r = { artists: [art("Indila")], tracks: [{ title: "Dernière danse" }] };
  assert.equal(topResult("derniere danse", r), null);
});

test("a show named exactly leads only where podcasts are shown", () => {
  const r = { artists: [], podcasts: [{ deezer_id: "1", title: "Les Pieds sur terre" }] };
  assert.equal(topResult("les pieds sur terre", r), null);
  assert.equal(topResult("les pieds sur terre", r, true).kind, "podcast");
});

test("shows are mixed in after the first two albums, labelled", () => {
  const out = mixPodcasts([{ id: "a" }, { id: "b" }, { id: "c" }], [{ deezer_id: "p" }]);
  assert.deepEqual(out.map((x) => x.id || x.deezer_id), ["a", "b", "p", "c"]);
  assert.equal(out[2].podcast, true);
  assert.equal(mixPodcasts([{ id: "a" }], []).length, 1);
});
