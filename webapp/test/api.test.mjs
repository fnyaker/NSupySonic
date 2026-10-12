// lib/api.js on a failure the server has classified as Deezer's.
//
// A page only Deezer has, asked while Deezer is out, answered 404 and the page
// said "introuvable"; made a 503, it would have been retried three times with
// ~3 s of backoff for the same instant refusal. The server now marks such an
// answer (`X-NS-Error`) and does the reaching itself — every call retries
// inside its own budget, the circuit breaker probes Deezer once its cooldown is
// over — so the client asks ONCE and says what happened. An unmarked 503 (a
// server restarting) is still retried: that one is worth another try.
//
// Time is node's mock clock, so the backoff costs nothing.

import test, { mock } from "node:test";
import assert from "node:assert/strict";

globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.window = { addEventListener() {}, removeEventListener() {}, location: { hash: "" } };

let calls = 0;
let answer = null;
globalThis.fetch = async () => {
  calls++;
  return answer();
};

function response(status, body, headers = {}) {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    headers: { get: (k) => h.get(String(k).toLowerCase()) ?? null },
    json: async () => body,
    clone() {
      return this;
    },
    text: async () => JSON.stringify(body),
  };
}

mock.timers.enable({ apis: ["setTimeout"] });
const { api, isDeezerUnreachable, onServerError } = await import("../src/lib/api.js");

// Run a request to its end, moving the mock clock through any backoff: a
// client that retried must show up as a call count, not as a test that hangs.
async function drive(promise) {
  let done = false;
  const p = promise.then(
    () => ((done = true), null),
    (e) => ((done = true), e)
  );
  for (let i = 0; i < 50 && !done; i++) {
    for (let j = 0; j < 20; j++) await Promise.resolve();
    mock.timers.tick(10_000);
  }
  return p;
}

const reported = [];
onServerError((status, path) => reported.push([status, path]));

test("a page only Deezer has, while Deezer is out: asked once, said as such", async () => {
  calls = 0;
  answer = () =>
    response(
      503,
      { error: "Deezer est injoignable", code: "deezer-unreachable", retry_in: 42 },
      { "X-NS-Error": "deezer-unreachable", "Retry-After": "42" }
    );
  const err = await drive(api.album("600"));
  assert.equal(calls, 1, "the client retried what the server had already tried");
  assert.ok(isDeezerUnreachable(err));
  assert.equal(err.status, 503);
  assert.equal(err.retryIn, 42);
  // The Deezer health watcher still hears of it (it raises the notice).
  assert.deepEqual(reported.at(-1), [503, "/album/600"]);
});

test("a disabled proxy is final too, and is not 'unreachable'", async () => {
  calls = 0;
  answer = () =>
    response(503, { error: "Deezer proxy disabled", code: "deezer-disabled" }, { "X-NS-Error": "deezer-disabled" });
  const err = await drive(api.playlist("123"));
  assert.equal(calls, 1);
  assert.equal(err.code, "deezer-disabled");
  assert.equal(isDeezerUnreachable(err), false);
});

test("an unmarked 503 (a server restarting) is still retried", async () => {
  calls = 0;
  answer = () => response(503, { error: "busy" });
  const err = await drive(api.album("600"));
  assert.equal(calls, 4);
  assert.equal(err.status, 503);
  assert.equal(err.code, undefined);
});
