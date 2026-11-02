// A file fetched in blocks (HTTP Range), each retried on its own: a flaky link or a refused
// background request costs one block, not the track. The server holds requests that say they
// are background to a share of its threads and refuses the excess (503 + Retry-After): that is
// waited out here, never fought (CLAUDE.md, rule 1).

export const BLOCK = 4 * 1024 * 1024;
const MAX_TRIES = 6;

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), reject(new DOMException("aborted", "AbortError"))), { once: true });
  });

function parseRange(h) {
  const m = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(h || "");
  return m ? { start: +m[1], end: +m[2], total: m[3] === "*" ? null : +m[3] } : null;
}

/**
 * @returns Uint8Array the whole file
 * @param opts { fetch, block, maxBytes, signal, onProgress(done, total) }
 */
export async function fetchBlocks(url, opts = {}) {
  const doFetch = opts.fetch || ((u, init) => fetch(u, init));
  const block = opts.block || BLOCK;
  const maxBytes = opts.maxBytes || 600 * 1024 * 1024;
  let total = null;
  let out = null;
  let at = 0;
  while (total === null || at < total) {
    const end = at + block - 1;
    let got = null;
    for (let tries = 0; tries < MAX_TRIES && !got; tries++) {
      opts.signal?.throwIfAborted?.();
      let res;
      try {
        res = await doFetch(url, {
          credentials: "include",
          signal: opts.signal,
          headers: { Range: `bytes=${at}-${end}`, "X-NS-Background": "1" },
        });
      } catch (e) {
        if (e?.name === "AbortError") throw e;
        await sleep(Math.min(8000, 500 * 2 ** tries), opts.signal);
        continue;
      }
      if (res.status === 503 || res.status === 429) {
        const wait = Number(res.headers.get("Retry-After"));
        await sleep(Math.min(30000, (Number.isFinite(wait) && wait > 0 ? wait : 2 ** tries) * 1000), opts.signal);
        continue;
      }
      if (res.status === 200 && at === 0) {
        // The server ignored the range: a whole file in one piece.
        const whole = new Uint8Array(await res.arrayBuffer());
        if (whole.length > maxBytes) throw new Error("file larger than any track");
        opts.onProgress?.(whole.length, whole.length);
        return whole;
      }
      if (res.status !== 206) {
        if (res.status >= 400 && res.status < 500 && res.status !== 408) throw new Error(`HTTP ${res.status}`);
        await sleep(Math.min(8000, 500 * 2 ** tries), opts.signal);
        continue;
      }
      const cr = parseRange(res.headers.get("Content-Range"));
      const body = new Uint8Array(await res.arrayBuffer());
      // A block that is not the one asked for (a proxy, a changed file) is a failure, not data.
      if (!cr || cr.start !== at || body.length !== cr.end - cr.start + 1 || (total !== null && cr.total !== total)) {
        await sleep(Math.min(8000, 500 * 2 ** tries), opts.signal);
        continue;
      }
      got = { cr, body };
    }
    if (!got) throw new Error(`block at ${at} could not be fetched`);
    if (total === null) {
      if (!got.cr.total) throw new Error("the server did not say how long the file is");
      total = got.cr.total;
      if (total > maxBytes) throw new Error("file larger than any track");
      out = new Uint8Array(total);
    }
    out.set(got.body, at);
    at += got.body.length;
    opts.onProgress?.(at, total);
  }
  return out;
}
