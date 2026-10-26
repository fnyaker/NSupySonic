// The Flow one title at a time (lib/flow.js): the next title is chosen late,
// with what the session said, and a "suivant" never waits on the network.
//
// Counts, not times: each test says how many /api/flow/next requests an
// action costs and what they carried.
import test from "node:test";
import assert from "node:assert/strict";

const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};
globalThis.window = { addEventListener() {}, removeEventListener() {}, location: { href: "http://x/app/", hash: "" } };
globalThis.document = { addEventListener() {}, visibilityState: "visible" };
globalThis.location = globalThis.window.location;

let n = 0;
let fail = false;
const asked = [];
globalThis.fetch = async (url, opts) => {
  const b = opts && opts.body ? JSON.parse(opts.body) : null;
  if (!String(url).includes("/flow/next")) return response(200, {});
  asked.push(b);
  if (fail) return response(500, {});
  const tracks = Array.from({ length: b.n || 1 }, () => ({ deezer_id: `t${++n}`, title: `T${n}`, duration: 200, energy: 0.4 }));
  return response(200, { tracks });
};
function response(status, body) {
  return { ok: status < 300, status, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) };
}

const { get } = await import("svelte/store");
const { player } = await import("../src/lib/stores.js");
const flow = await import("../src/lib/flow.js");
const settle = () => new Promise((r) => setTimeout(r, 0));
const ids = () => get(player).queue.map((t) => t.deezer_id);

async function started(energy = null) {
  asked.length = 0;
  fail = false;
  await flow.startFlow(energy);
  await settle();
}

test("starting asks once for two titles: the first plays, the second is held back", async () => {
  await started(0.7);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].n, 2);
  assert.equal(asked[0].energy, 0.7);
  assert.equal(ids().length, 1);
  assert.equal(get(player).context.kind, "flow");
  assert.ok(flow._state().reserve);
});

test("the next title is chosen only PICK_AHEAD seconds before the end, once", async () => {
  await started();
  const s = () => get(player);
  flow.tick(s(), { remaining: 120, background: false });
  flow.tick(s(), { remaining: 40, background: false });
  await settle();
  assert.equal(asked.length, 1, "nothing asked a minute before the end");
  flow.tick(s(), { remaining: 19.5, background: false });
  flow.tick(s(), { remaining: 19.2, background: false });
  await settle();
  await settle();
  assert.equal(asked.length, 2, "one choice, not one per position update");
  assert.equal(asked[1].n, 1);
  assert.equal(ids().length, 2);
  flow.tick(s(), { remaining: 10, background: false });
  await settle();
  assert.equal(asked.length, 2, "a next already chosen is not asked again");
});

test("a hidden page chooses at once: the app's player needs the next named", async () => {
  await started();
  flow.tick(get(player), { remaining: 180, background: true });
  await settle();
  await settle();
  assert.equal(ids().length, 2);
});

test("'suivant' before the choice plays the reserve at once, with no request", async () => {
  await started();
  const reserve = flow._state().reserve.deezer_id;
  const before = asked.length;
  player.next();
  assert.equal(get(player).queue[get(player).index].deezer_id, reserve);
  assert.equal(asked.length, before, "nothing waited on the network");
});

test("what was heard and the buttons go with the next choice", async () => {
  await started();
  const first = ids()[0];
  flow.noteHeard(first, 7);
  flow.moreLikeThis();
  flow.nudgeEnergy(1);
  flow.tick(get(player), { remaining: 5, background: false });
  await settle();
  await settle();
  const last = asked[asked.length - 1];
  assert.deepEqual(last.heard, [{ id: first, s: 7 }]);
  assert.deepEqual(last.more, [first]);
  // from "Libre", one notch up from the playing title's own energy (0.4)
  assert.equal(last.energy, 0.5);
  assert.ok(last.exclude.includes(first));
});

test("feedback after the choice chooses the next again", async () => {
  await started();
  flow.tick(get(player), { remaining: 5, background: false });
  await settle();
  await settle();
  const chosen = ids()[1];
  flow.nudgeEnergy(-1);
  await settle();
  await settle();
  assert.equal(ids().length, 2);
  assert.notEqual(ids()[1], chosen);
});

test("'moins comme ça' notes it and moves on to a title chosen with it", async () => {
  await started();
  const cur = ids()[0];
  await flow.lessLikeThis();
  const last = asked.filter((b) => b.less.length).pop();
  assert.deepEqual(last.less, [cur]);
  assert.notEqual(get(player).queue[get(player).index].deezer_id, cur);
});

test("a failed choice falls back on the reserve", async () => {
  await started();
  const reserve = flow._state().reserve.deezer_id;
  fail = true;
  flow.tick(get(player), { remaining: 3, background: false });
  await settle();
  await settle();
  await settle();
  assert.equal(ids()[1], reserve);
});

test("nudges stop at the ends, and the names are the server's", async () => {
  await started(0.9);
  flow.nudgeEnergy(1);
  assert.equal(get(flow.flowSession).energy, 0.9);
  flow.nudgeEnergy(-1);
  assert.equal(get(flow.flowSession).energy, 0.7);
  assert.equal(flow.energyName(null), "Libre");
  assert.equal(flow.energyName(0.68), "Énergique");
});

test("a Flow queue saved by an older app goes on, in a session of its own", async () => {
  asked.length = 0;
  fail = false;
  flow.flowSession.set(null);
  player.playQueue([{ deezer_id: "old1", duration: 200 }], 0, { kind: "flow" });
  flow.tick(get(player), { remaining: 5, background: false });
  await settle();
  await settle();
  assert.equal(asked.length >= 1, true);
  assert.ok(get(player).context.id, "the queue is given a session");
  assert.equal(get(player).context.id, get(flow.flowSession).sid);
  assert.equal(ids().length, 2);
});
