// A spec-shaped IndexedDB in memory, shared by the tests of the on-device stores.

/**
 * A spec-shaped IndexedDB, in memory: every request settles on a later task,
 * and a transaction completes once it has nothing pending — which is what
 * makes holding one across a non-IndexedDB await a bug here as it is there.
 */
export function fakeIndexedDB() {
  const dbs = new Map();
  const later = (fn) => setTimeout(fn, 0);
  function transaction(db) {
    const t = { pending: 0, done: false, oncomplete: null, onerror: null, onabort: null };
    t.settle = () =>
      later(() => {
        if (t.done || t.pending) return;
        t.done = true;
        if (t.oncomplete) t.oncomplete();
      });
    t.objectStore = (name) => {
      const s = db.stores.get(name);
      const req = (fn) => {
        if (t.done) throw new DOMException("The transaction has finished.", "TransactionInactiveError");
        const r = { onsuccess: null, onerror: null, result: undefined };
        t.pending++;
        later(() => {
          try {
            r.result = fn();
            if (r.onsuccess) r.onsuccess({ target: r });
          } catch (e) {
            r.error = e;
            if (r.onerror) r.onerror({ target: r });
          }
          t.pending--;
          t.settle();
        });
        return r;
      };
      return {
        get: (k) => req(() => s.rows.get(k)),
        getAll: () => req(() => [...s.rows.values()]),
        put: (v) => req(() => void s.rows.set(v[s.keyPath], v)),
        delete: (k) => req(() => void s.rows.delete(k)),
        clear: () => req(() => s.rows.clear()),
      };
    };
    t.settle();
    return t;
  }
  return {
    dbs,
    open(name) {
      const req = { onsuccess: null, onerror: null, onupgradeneeded: null, result: undefined };
      later(() => {
        let db = dbs.get(name);
        const fresh = !db;
        if (fresh) {
          db = {
            stores: new Map(),
            objectStoreNames: { contains: (n) => db.stores.has(n) },
            createObjectStore: (n, { keyPath }) => db.stores.set(n, { keyPath, rows: new Map() }),
            transaction: () => transaction(db),
          };
          dbs.set(name, db);
        }
        req.result = db;
        if (fresh && req.onupgradeneeded) req.onupgradeneeded();
        if (req.onsuccess) req.onsuccess();
      });
      return req;
    },
  };
}
