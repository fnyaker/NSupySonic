// Lot O: the genre hierarchy on the player's side. genreOf must still resolve
// every label of the studio's vocabulary to the family it always did (the same
// JSON the server's tests hold the default tree to), and a genre it has no row
// for is read as the nearest genre above it in the tree.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { genreOf } from "../src/lib/audio/style.js";
import { skinId } from "../src/lib/viz/skins.js";
import { ancestorsOf, setTree, DEFAULT_EDGES } from "../src/lib/genretree.js";

const families = JSON.parse(readFileSync(new URL("./data/genre-families.json", import.meta.url)));

test("every studio label resolves to the family it always did", () => {
  for (const [label, family] of Object.entries(families)) {
    assert.equal(genreOf(label)?.family, family, label);
  }
});

test("the static shelves answer without a server", () => {
  assert.deepEqual(ancestorsOf("Hard dance"), ["Électronique"]);
  assert.ok(genreOf("Hard dance")); // by its word, as before; the tree is the second chance
  assert.ok(DEFAULT_EDGES.length >= 1);
});

test("a genre the person placed in the tree takes its ancestor's family and picture", () => {
  assert.equal(genreOf("Zaagcore"), null);
  const before = skinId("Zaagcore");
  setTree({
    version: "7",
    edges: [
      { child: "Zaagcore", parent: "Frenchcore", weight: 1 },
      { child: "Frenchcore", parent: "Hardcore", weight: 1 },
    ],
  });
  assert.equal(genreOf("Zaagcore")?.family, "frenchcore");
  assert.equal(skinId("Zaagcore"), skinId("Frenchcore"));
  assert.notEqual(before, undefined);
  assert.deepEqual(ancestorsOf("zaag-core"), ["Frenchcore", "Hardcore"]);
});

test("the nearer and the firmer parent comes first", () => {
  setTree({
    version: "8",
    edges: [
      { child: "X", parent: "A", weight: 0.4 },
      { child: "X", parent: "B", weight: 0.9 },
      { child: "A", parent: "C", weight: 1 },
    ],
  });
  assert.deepEqual(ancestorsOf("X"), ["B", "A", "C"]);
});
