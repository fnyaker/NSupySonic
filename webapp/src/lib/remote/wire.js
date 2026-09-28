// The remote control's own HTTP, apart from api.js on purpose: its loops poll
// several times a second and must fail FAST and quietly — api.js retries a
// GET for up to twelve seconds and treats a 401 as a logout, both right for a
// screen and both wrong for a loop that simply asks again in a moment.

import { reportOnline, reportOffline } from "../net.js";

/**
 * One request. Resolves {ok, status, data, network} and never throws: a loop
 * reads the outcome and decides.
 */
export async function wire(path, { method = "GET", body, headers, timeout = 8000, background = false } = {}) {
  const ctl = typeof AbortController === "function" ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), timeout) : null;
  try {
    const res = await fetch(path, {
      method,
      credentials: "include",
      cache: "no-store",
      headers: {
        ...(body !== undefined && !(headers && headers["Content-Type"]) ? { "Content-Type": "application/json" } : {}),
        // The loops are nobody's foreground: the server's priority gate counts
        // them apart from the person waiting on a screen (webui#_admit_by_priority).
        ...(background ? { "X-NS-Background": "1" } : {}),
        ...(headers || {}),
      },
      body,
      signal: ctl ? ctl.signal : undefined,
    });
    reportOnline();
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* an empty or non-JSON answer: the status says enough */
    }
    return { ok: res.ok, status: res.status, data, network: false };
  } catch {
    reportOffline();
    return { ok: false, status: 0, data: null, network: true };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * A JSON body, gzip-compressed when that is worth it and the browser can. A
 * 1000-track queue is ~250 kB of JSON and ~35 kB compressed — on a phone
 * uplink, the difference between a queue that shows up and one that does not.
 */
export async function jsonBody(obj, threshold = 16 * 1024) {
  const text = JSON.stringify(obj);
  if (text.length < threshold || typeof CompressionStream !== "function") {
    return { body: text, headers: { "Content-Type": "application/json" } };
  }
  try {
    const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
    const buf = await new Response(stream).arrayBuffer();
    return { body: buf, headers: { "Content-Type": "application/json", "Content-Encoding": "gzip" } };
  } catch {
    return { body: text, headers: { "Content-Type": "application/json" } };
  }
}
