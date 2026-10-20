// The Android app's in-place update (lib/appversion.js ↔ Updater.kt): which
// button the notice offers, and what each message from the native side shows.
import test from "node:test";
import assert from "node:assert/strict";

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
globalThis.window = { addEventListener() {}, location: { href: "http://x/app/", hash: "" } };
globalThis.document = { addEventListener() {}, visibilityState: "visible" };
globalThis.location = globalThis.window.location;

const { get } = await import("svelte/store");
const S = await import("../src/lib/stores.js");
const A = await import("../src/lib/appversion.js");

let served;
globalThis.fetch = async () =>
  new Response(JSON.stringify(served), { headers: { "content-type": "application/json" } });

function native(extra) {
  const calls = [];
  window.NSNative = { appVersion: () => "v1.0.0", ...extra, _calls: calls };
  return calls;
}
const notice = () => get(S.notices).find((n) => n.id === "android-update");

test("an APK with the in-place installer gets Installer, and the native side is asked", async () => {
  S.notices.dismiss("android-update");
  const calls = native({ bridgeVersion: () => 2, installUpdate: () => calls.push("install") });
  served = { android: { version: "v1.4.0", url: "https://github.com/x/y/releases", apk: true } };
  await A.checkAndroidUpdate();
  assert.equal(notice().actionLabel, "Installer");
  notice().action();
  assert.deepEqual(calls, ["install"]);
  assert.match(notice().message, /0 %/);
  assert.equal(notice().dismissible, false);

  window.__nsUpdate({ state: "download", progress: 0.42 });
  assert.match(notice().message, /42 %/);
  window.__nsUpdate({ state: "install" });
  assert.match(notice().message, /confirmez/);
  window.__nsUpdate({ state: "error", reason: "network" });
  assert.equal(notice().actionLabel, "Réessayer");
  notice().action();
  assert.deepEqual(calls, ["install", "install"]);
  window.__nsUpdate({ state: "uptodate" });
  assert.equal(notice(), undefined);
});

test("a signature mismatch says to reinstall and sends to the download page", () => {
  const n = A.updateNotice({ state: "error", reason: "signature" }, "v1.4.0", "https://g/r", () => {});
  assert.equal(n.kind, "warn");
  assert.match(n.message, /Désinstallez/);
  assert.equal(n.actionLabel, "Télécharger");
});

test("an older APK, or a server with no APK to serve, keeps the download link", async () => {
  for (const [extra, apk] of [[{}, true], [{ bridgeVersion: () => 2, installUpdate() {} }, false]]) {
    S.notices.dismiss("android-update");
    native(extra);
    served = { android: { version: "v1.4.0", url: "https://github.com/x/y/releases", apk } };
    await A.checkAndroidUpdate();
    assert.equal(notice().actionLabel, "Télécharger");
  }
  // Up to date: nothing is claimed.
  S.notices.dismiss("android-update");
  native({ bridgeVersion: () => 2 });
  served = { android: { version: "v1.0.0", apk: true } };
  await A.checkAndroidUpdate();
  assert.equal(notice(), undefined);
});
