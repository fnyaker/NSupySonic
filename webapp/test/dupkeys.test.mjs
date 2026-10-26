// No object literal in the web app names the same key twice.
//
// JavaScript keeps the LAST one silently, and that is how "Importer maintenant"
// in Réglages → Mes comptes ran a different import for a whole release: lot P2
// added `api.importAccount(id)` next to the older `api.importAccount()` of the
// one-off Deezer import, the old one came later in the object and won, and the
// button started the import that put every removed favourite back. Svelte's own
// parser (acorn) reads every module; nothing to install.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "acorn";

const SRC = fileURLToPath(new URL("../src", import.meta.url));

function files(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else if (/\.(m?js)$/.test(name) && !name.endsWith(".worklet.js")) out.push(p);
  }
  return out;
}

function keyOf(prop) {
  if (prop.type !== "Property" || prop.computed || prop.kind !== "init") return null;
  if (prop.key.type === "Identifier") return prop.key.name;
  if (prop.key.type === "Literal") return String(prop.key.value);
  return null;
}

export function duplicateKeys(code) {
  const ast = parse(code, { ecmaVersion: "latest", sourceType: "module", locations: true });
  const found = [];
  (function walk(node) {
    if (!node || typeof node.type !== "string") return;
    if (node.type === "ObjectExpression") {
      const seen = new Map();
      for (const prop of node.properties) {
        const k = keyOf(prop);
        if (k === null) continue;
        if (seen.has(k)) found.push({ key: k, line: prop.loc.start.line, first: seen.get(k) });
        else seen.set(k, prop.loc.start.line);
      }
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === "object" && typeof value.type === "string") walk(value);
    }
  })(ast);
  return found;
}

test("the checker sees the fault it exists for", () => {
  const twice = "export const api = {\n  a: () => 1,\n  b: 2,\n  a: () => 3,\n};";
  assert.deepEqual(duplicateKeys(twice), [{ key: "a", line: 4, first: 2 }]);
  assert.deepEqual(duplicateKeys("const o = { a: 1, ...x, b: { a: 2 } };"), []);
});

test("no module of the web app names a key twice in one object", () => {
  const faults = [];
  for (const f of files(SRC)) {
    for (const d of duplicateKeys(readFileSync(f, "utf8"))) {
      faults.push(`${relative(SRC, f)}:${d.line} "${d.key}" (first at line ${d.first})`);
    }
  }
  assert.deepEqual(faults, []);
});
