// The sources' names and places (lib/sources.js): every screen that names a
// source reads it there, from what the server said (`user.sources`), so the
// admin's order in Réglages → Sources is what they all say.
import test from "node:test";
import assert from "node:assert/strict";

globalThis.window = { addEventListener() {}, location: { href: "http://x/", hash: "" } };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.sessionStorage = globalThis.localStorage;

const { user } = await import("../src/lib/stores.js");
const { nameOf, offMain, sourceTitle, chain } = await import("../src/lib/sources.js");

const src = (id, name, place, rank) => ({ id, name, place, rank });

test("before the server said anything, nothing gets a badge", () => {
  user.set({ name: "a" });
  assert.equal(offMain("youtube"), false);
  assert.equal(nameOf("qobuz"), "Qobuz");
});

test("names and badges follow the admin's order", () => {
  user.set({ name: "a", sources: [src("deezer", "Deezer", "main", 0), src("youtube", "YouTube", "fallback", 1)] });
  assert.equal(offMain("deezer"), false);
  assert.equal(offMain("youtube"), true);
  assert.equal(offMain("local"), false);
  assert.equal(sourceTitle("youtube"), "Source : YouTube (pas sur Deezer)");
  assert.equal(sourceTitle("local"), "Fichier local (pas sur Deezer)");

  // Another main source: the same track now reads differently, nothing static.
  user.set({ name: "a", sources: [src("qobuz", "Qobuz", "main", 0), src("deezer", "Deezer", "fallback", 1)] });
  assert.equal(offMain("deezer"), true);
  assert.equal(sourceTitle("deezer"), "Source : Deezer (pas sur Qobuz)");
});

test("a chain of sources in words", () => {
  const s = (name) => ({ name });
  assert.equal(chain([]), "");
  assert.equal(chain([s("A")]), "A");
  assert.equal(chain([s("A"), s("B"), s("C")]), "A, B puis C");
});
