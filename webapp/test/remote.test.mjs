// Remote control, the part that runs without a server (lib/remote/commands.js,
// settings.js, mode.js): a player-store method said over the wire, and the
// same method run on the other side.
//
// The property that matters is that the SAME BUTTON DOES THE SAME THING on the
// device that plays as it would have done locally. So these drive two real,
// independent player stores (stores.js imported twice): what the controller's
// own store shows after a tap must be what the controlled player's store ends
// up in once the command has crossed as JSON and been run there.
import test from "node:test";
import assert from "node:assert/strict";

const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};
globalThis.window = { addEventListener() {}, location: { href: "http://x/app/", hash: "" } };
globalThis.document = { addEventListener() {}, visibilityState: "visible" };
globalThis.location = globalThis.window.location;

const { get } = await import("svelte/store");
const A = await import("../src/lib/stores.js?controller");
const B = await import("../src/lib/stores.js?player");
const C = await import("../src/lib/remote/commands.js");
const { MIRRORED, settingLevel } = await import("../src/lib/remote/settings.js");
const S = await import("../src/lib/stores.js");
const { claimToken, LEVELS } = await import("../src/lib/remote/mode.js");

const track = (id, extra = {}) => ({
  deezer_id: String(id),
  title: `T${id}`,
  duration: 200,
  artist: { deezer_id: "9", name: "Band" },
  album: { deezer_id: "7", title: "Album", cover: "https://e-cdns-images.dzcdn.net/images/cover/x/500x500.jpg" },
  description: "a long podcast blurb nobody draws",
  ...extra,
});
const Q = [1, 2, 3, 4, 5].map((i) => track(i));

function fresh(store, queue = Q, index = 1) {
  store.player.set({
    ...get(store.player),
    queue: queue.slice(),
    index,
    playing: true,
    currentTime: 42,
    duration: 200,
    shuffle: false,
    repeat: "off",
    volume: 1,
    muted: false,
    _orig: null,
  });
}

const env = (store) => ({
  player: store.player,
  seekTo: store.seekTo,
  state: () => get(store.player),
  settings: new Map(),
  read: get,
});

// Tap on the controller's store, send, run on the player's.
function tap(method, args) {
  const before = get(A.player);
  const cmd = C.commandFor(method, args, before);
  A.player[method](...args);
  if (cmd) C.runCommand(JSON.parse(JSON.stringify(cmd)), env(B));
  return cmd;
}

const view = (s) => ({
  ids: s.queue.map((t) => t.deezer_id),
  index: s.index,
  playing: s.playing,
  volume: s.volume,
  muted: s.muted,
  repeat: s.repeat,
});

test("every transport and queue button lands the player where the controller shows it", () => {
  const cases = [
    ["next", []],
    ["prev", []],
    ["toggle", []],
    ["pause", []],
    ["play", []],
    ["jump", [3]],
    ["removeAt", [0]],
    ["removeAt", [1]],
    ["move", [3, 2]],
    ["move", [1, 4]],
    ["move", [4, 0]],
    ["clearUpcoming", []],
    ["setVolume", [0.35]],
    ["toggleMute", []],
    ["cycleRepeat", []],
    ["addToQueue", [[track(8), track(9)]]],
    ["playNext", [[track(8)]]],
    ["playQueue", [[track(6), track(7), track(8)], 2, { kind: "album", id: "7" }]],
    ["playTrack", [track(6)]],
  ];
  for (const [method, args] of cases) {
    fresh(A);
    fresh(B);
    const cmd = tap(method, args);
    assert.ok(cmd, method);
    assert.deepEqual(view(get(B.player)), view(get(A.player)), method);
  }
});

test("a seek goes through the player's own inbox, clamped to the track", () => {
  fresh(B);
  let got = null;
  const off = B.seekTo.subscribe((t) => (got = t));
  C.runCommand({ op: "seek", args: { t: 90.5 } }, env(B));
  assert.equal(got, 90.5);
  C.runCommand({ op: "seek", args: { t: 999 } }, env(B));
  assert.equal(got, 199.75, "never past the end, where the player would skip");
  off();
  B.seekTo.set(null);
});

test("a row is named by index AND id, so a queue that moved meanwhile is not a wrong jump", () => {
  // The controller saw row 3 = track 4; the player has had a track inserted
  // at the top since.
  fresh(B, [track(0), ...Q], 2);
  C.runCommand({ op: "jump", args: { i: 3, id: "4" } }, env(B));
  assert.equal(get(B.player).queue[get(B.player).index].deezer_id, "4");
  // Gone from the queue: nothing happens rather than the wrong thing.
  fresh(B);
  assert.equal(C.runCommand({ op: "jump", args: { i: 1, id: "77" } }, env(B)), null);
  assert.equal(get(B.player).index, 1);
  // The same track twice: the nearest copy.
  assert.equal(C.resolveIndex([track(1), track(2), track(1)].map((t) => t), 2, "1"), 2);
  assert.equal(C.resolveIndex([track(1), track(2), track(1)], 1, "1"), 0);
});

test("a list command starts on the tapped track even when rows before it cannot play", () => {
  const list = [track(1), { title: "no id" }, track(2), { deezer_id: "../x" }, track(3)];
  const cmd = C.commandFor("playQueue", [list, 4, null], get(A.player));
  assert.deepEqual(cmd.args.tracks.map((t) => t.deezer_id), ["1", "2", "3"]);
  assert.equal(cmd.args.start, 2);
  fresh(B);
  C.runCommand(cmd, env(B));
  const s = get(B.player);
  assert.equal(s.queue[s.index].deezer_id, "3");
});

test("a queue longer than the server takes is cut to a window around the tapped track", () => {
  const big = Array.from({ length: 12000 }, (_, i) => track(i + 1));
  const { tracks, start } = C.packTracks(big, 9000);
  assert.equal(tracks.length, C.MAX_QUEUE);
  assert.equal(tracks[start].deezer_id, "9001");
});

test("what crosses is what is drawn, not the whole record", () => {
  const t = C.slimTrack(track(1));
  assert.equal(t.description, undefined);
  assert.deepEqual(Object.keys(t.album).sort(), ["cover", "deezer_id", "title"]);
  const q = Array.from({ length: 1000 }, (_, i) => track(i + 1));
  const bytes = JSON.stringify(q.map(C.slimTrack)).length;
  // Measured: 202 bytes a track slimmed against 252 whole for this fixture;
  // a real podcast episode's description alone is up to a paragraph.
  assert.ok(bytes < JSON.stringify(q).length * 0.9, `${bytes}`);
});

test("a setting takes only a value of the shape it holds", () => {
  const settings = new Map([["viz.mode", S.vizMode], ["fx.eq.bands", S.eqBands]]);
  const e = { ...env(B), settings };
  S.vizMode.set("smart");
  assert.equal(C.runCommand({ op: "set", args: { key: "viz.mode", value: "bars" } }, e), "set viz.mode");
  assert.equal(get(S.vizMode), "bars");
  assert.equal(C.runCommand({ op: "set", args: { key: "viz.mode", value: { evil: 1 } } }, e), null);
  assert.equal(C.runCommand({ op: "set", args: { key: "fx.eq.bands", value: "loud" } }, e), null);
  assert.equal(C.runCommand({ op: "set", args: { key: "auth.user", value: "x" } }, e), null, "not a lent setting");
  assert.equal(get(S.vizMode), "bars");
});

test("the lent settings exist, and the strobe acceptance is never one of them", () => {
  for (const k of MIRRORED) assert.ok(S.persistedStores.has(k), `${k} is not a persisted store`);
  assert.ok(!MIRRORED.includes("viz.flash.ack"), "the photosensitivity warning is accepted on the device");
  assert.ok(!MIRRORED.includes("viz.lookahead"), "a latency of this device's own output");
  assert.equal(settingLevel("viz.world"), "read");
  assert.equal(settingLevel("fx.eq.enabled"), "full");
});

test("the client's command table matches the levels it names", () => {
  for (const [op, level] of Object.entries(C.OPS)) assert.ok(LEVELS.includes(level), op);
  assert.equal(C.opLevel("set", { key: "viz.mode" }), "read");
  assert.equal(C.opLevel("set", { key: "fade.enabled" }), "full");
  assert.equal(C.opLevel("seek"), "queue");
  assert.equal(C.opLevel("add"), "read");
  assert.equal(C.opLevel("nope"), null);
});

test("only a well-formed link is claimed", () => {
  assert.equal(claimToken("#/rc/AbCdEfGhIjKlMnOp.ABCDEFGHIJKLMNOPQRSTUVWX"), "AbCdEfGhIjKlMnOp.ABCDEFGHIJKLMNOPQRSTUVWX");
  assert.equal(claimToken("#/rc/short.x"), null);
  assert.equal(claimToken("#/rc/AbCdEfGhIjKlMnOp.ABCDEFGHIJKLMNOPQRSTUVWX/../settings"), null);
  assert.equal(claimToken("#/party/AbCdEfGhIjKlMnOp"), null);
});

test("a link is built from where the app is served, whatever the page's own path", async () => {
  const { shortLink, appRoot } = await import("../src/lib/applink.js");
  const T = "5w2T6xuj4bZpU9Sa._7flFFqdWNgqXgRm-ZQXTvj5";
  const at = (pathname) => shortLink("rc", T, { origin: "https://h", pathname });
  // The reported link was /app/rc/<token>: "../rc/" resolved from a path one
  // level deeper than "/app/". Every one of these must name /rc/.
  for (const p of ["/app/", "/app", "/app/index.html", "/app//", "//app/", "/app/app/"])
    assert.equal(at(p), `https://h/rc/${T}`, p);
  assert.equal(at("/music/app/"), `https://h/music/rc/${T}`, "a path prefix is kept");
  assert.equal(appRoot("/"), "/");
});

test("a link that arrives under the app's path opens the route it names", async () => {
  const { routeForPath, rescuePathLink } = await import("../src/lib/applink.js");
  const T = "5w2T6xuj4bZpU9Sa._7flFFqdWNgqXgRm-ZQXTvj5";
  assert.equal(routeForPath(`/app/rc/${T}`), `#/rc/${T}`);
  assert.equal(routeForPath("/app/party/AbCdEfGhIjKlMnOpQr"), "#/party/AbCdEfGhIjKlMnOpQr");
  assert.equal(routeForPath("/app/"), null);
  assert.equal(routeForPath("/app/rc/../../api/x"), null);
  assert.equal(routeForPath("/app/settings/AbCdEfGhIjKlMnOpQr"), null);
  let url = null;
  const hist = { state: null, replaceState: (_s, _t, u) => (url = u) };
  assert.ok(rescuePathLink({ pathname: `/music/app/rc/${T}`, hash: "" }, hist));
  assert.equal(url, `/music/app/#/rc/${T}`);
  url = null;
  assert.ok(!rescuePathLink({ pathname: "/app/", hash: "#/search" }, hist));
  assert.equal(url, null);
});
