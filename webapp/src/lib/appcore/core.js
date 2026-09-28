// The app core (webapp/appcore, Rust): the time-sync estimators the listen
// party, the lyric line and the animations share, and the track lists' index.
//
// A few dozen kilobytes, fetched and compiled once per page and cached by the
// service worker with the rest of the build. main.js starts loading it as soon
// as the app has painted; what needs it before then either awaits it (joining
// or hosting a party) or behaves exactly as it does before its first reading
// (the output clock: "no mapping yet").
//
// Every object is a HANDLE into the module's tables (0 means none), wrapped in
// a small class whose `free()` releases it. A FinalizationRegistry frees what
// a caller forgot, so a handle can never outlive the object that held it.

let core = null;
let loading = null;
// A load that failed is not retried for a while: the output clock asks on every
// analysis frame, and a page offline before the service worker cached the
// binary would otherwise refetch it ninety times a second.
const RETRY_MS = 15_000;
let failedAt = -Infinity;
let failure = null;

function wrap(instance) {
  const x = instance.exports;
  const memory = x.memory;
  let buf = null;
  let out = null;
  const c = {
    x,
    memory,
    /** appcore_out: eight f64, re-viewed only when a grow replaced the buffer. */
    out() {
      if (buf !== memory.buffer) {
        buf = memory.buffer;
        out = new Float64Array(buf, x.appcore_out(), 8);
      }
      return out;
    },
    /** A fresh view `n` long at `ptr` (valid until the next call that may grow). */
    u8(ptr, n) {
      return new Uint8Array(memory.buffer, ptr, n);
    },
    u32(ptr, n) {
      return new Uint32Array(memory.buffer, ptr, n);
    },
    f64(ptr, n) {
      return new Float64Array(memory.buffer, ptr, n);
    },
  };
  return c;
}

/** The core, or null while it has not loaded. */
export function appCore() {
  return core;
}

/** The core, or an error naming what the caller should have awaited. */
export function requireCore() {
  if (!core) throw new Error("appcore: not loaded (await loadAppCore() first)");
  return core;
}

/**
 * Load the core, once per page. Rejects when WebAssembly is unavailable or the
 * binary cannot be fetched; a later call tries again.
 */
export function loadAppCore() {
  if (core) return Promise.resolve(core);
  if (!loading && failure && Date.now() - failedAt < RETRY_MS) return Promise.reject(failure);
  if (!loading) {
    loading = import("./assets.js")
      .then(({ url }) => fetch(url))
      .then((res) => {
        if (!res.ok) throw new Error(`appcore.wasm: HTTP ${res.status}`);
        return res.arrayBuffer();
      })
      .then((bytes) => WebAssembly.instantiate(bytes, {}))
      .then(({ instance }) => (core = wrap(instance)));
    loading.catch((e) => {
      loading = null;
      failure = e;
      failedAt = Date.now();
    });
  }
  return loading;
}

/** For Node (the tests and the benches): the core from the binary's bytes. */
export function appCoreFromBytes(bytes) {
  core = wrap(new WebAssembly.Instance(new WebAssembly.Module(bytes), {}));
  return core;
}

// Handles whose JavaScript owner was collected without calling free().
const orphans =
  typeof FinalizationRegistry === "function"
    ? new FinalizationRegistry(({ c, free, h }) => {
        try {
          c.x[free](h);
        } catch {
          /* the core went away with the page */
        }
      })
    : null;

/** Register `owner` so its handle is released if it is collected unfreed. */
export function adopt(owner, c, free, h) {
  if (orphans) orphans.register(owner, { c, free, h }, owner);
}

/** The explicit release: frees the handle and forgets the registration. */
export function release(owner, c, free, h) {
  if (orphans) orphans.unregister(owner);
  if (h) c.x[free](h);
}
