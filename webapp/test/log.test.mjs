// The client log (lib/log.js) has to say WHY something failed, not only that
// it did. A picture the page's own policy refused reports a bare `error` —
// identical to a broken file — and for weeks that was all the log said about
// every cached cover: "img failed from blob:…". The refusal itself only ever
// surfaces as a securitypolicyviolation event.
import test from "node:test";
import assert from "node:assert/strict";

const store = new Map([["debug.logs", "1"]]);
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
const on = {};
const target = () => ({ addEventListener: (type, fn) => ((on[type] ||= []).push(fn)) });
globalThis.window = Object.assign(target(), { location: { href: "https://app.example/app/" } });
globalThis.document = target();

const { installCapture, logText, clearLog } = await import("../src/lib/log.js");
installCapture();

const POLICY =
  "default-src 'self'; img-src 'self' data: https://*.dzcdn.net; media-src 'self' blob:; connect-src 'self'";
const violate = (blockedURI, effectiveDirective = "img-src") =>
  on.securitypolicyviolation.forEach((fn) =>
    fn({ effectiveDirective, blockedURI, originalPolicy: POLICY, disposition: "enforce" })
  );
const lines = () => logText().split("\n").filter((l) => l.includes(" csp "));

test("a policy refusal is logged with the rule that refused it", () => {
  clearLog();
  assert.ok(on.securitypolicyviolation, "the listener is installed on the document");
  violate("blob");
  violate("blob");
  violate("blob");
  const got = lines();
  assert.equal(got.length, 2, "the first in full, the repeats counted on one line");
  assert.match(got[0], /img-src refused blob {2}img-src 'self' data: https:\/\/\*\.dzcdn\.net$/);
  assert.match(got[1], /img-src refused blob \(x2\)$/);
});

test("a refused URL is reported by its origin, never its path", () => {
  clearLog();
  violate("https://cdn.example/images/cover/abc/500x500.jpg?token=secret");
  const [line] = lines();
  assert.match(line, /img-src refused https:\/\/cdn\.example /);
  assert.ok(!line.includes("secret") && !line.includes("/images/"));
});

test("the exported log keeps a blank line between the header and the entries", () => {
  clearLog();
  violate("blob", "media-src");
  const text = logText();
  assert.match(text, /\n\n\d{4}-\d{2}-\d{2} /);
});
