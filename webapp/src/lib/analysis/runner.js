// The client's analysis run: ask the server what is left (`/api/analysis/todo`), and for each
// track download the original FLAC in blocks, decode it AT ITS OWN RATE (ffmpeg measures the
// source), measure it with the Rust core and send the numbers back (`/measures`). The server
// decides the style. Every track's result is stored the moment it is sent, so a run cut off
// anywhere resumes on the next `todo` with exactly what has not been sent; a failure names its
// cause per track (never just a count).

import { writable } from "svelte/store";
import { fetchBlocks } from "./download.js";

export const FAILURES_MAX = 40;

export const clientJob = writable({
  running: false, done: 0, failed: 0, skipped: 0, total: 0, current: [], failures: [], error: null,
  stopped: false,
});

class VersionError extends Error {}

/**
 * @param deps { api, decode(bytes, rate, channels) -> {channels, mono44}, measure(...) -> {spectral, tempo},
 *               fetchBlocks, lanes }
 */
export function createRunner(deps) {
  const lanes = Math.max(1, deps.lanes || 1);
  const download = deps.fetchBlocks || fetchBlocks;
  let ctl = null;
  const state = { running: false, done: 0, failed: 0, skipped: 0, total: 0, current: [], failures: [], error: null, stopped: false };
  const publish = () => clientJob.set({ ...state, current: [...state.current], failures: [...state.failures] });

  async function one(t, todo, signal) {
    const label = t.title || t.id;
    state.current.push(label);
    publish();
    try {
      const bytes = await download(t.url, { signal });
      const decoded = await deps.decode(bytes, t.rate, t.channels);
      const caps = { spectral: todo.spectral_seconds, tempo: todo.tempo_seconds };
      const m = await deps.measure({ channels: decoded.channels, rate: t.rate, mono44: decoded.mono44, caps });
      const res = await deps.api.analysisMeasures(t.id, { version: todo.version, ...m });
      if (res?.error === "version") throw new VersionError(`the server measures version ${res.server}`);
      state.done++;
    } catch (e) {
      if (e instanceof VersionError || e?.status === 409) throw new VersionError(e.message || "version");
      if (e?.name === "AbortError") throw e;
      state.failed++;
      if (state.failures.length < FAILURES_MAX) state.failures.push({ id: t.id, track: label, reason: String(e?.message || e) });
    } finally {
      state.current = state.current.filter((x) => x !== label);
      publish();
    }
  }

  async function run() {
    if (state.running) return;
    Object.assign(state, { running: true, done: 0, failed: 0, skipped: 0, total: 0, current: [], failures: [], error: null, stopped: false });
    ctl = new AbortController();
    publish();
    let after = null;
    try {
      const plan = await deps.api.analysisPlan().catch(() => null);
      state.total = plan ? (plan.unmeasured || 0) + (plan.stale_measure || 0) : 0;
      for (;;) {
        ctl.signal.throwIfAborted();
        const todo = await deps.api.analysisTodo(after);
        const list = todo.tracks || [];
        // `lanes` tracks at a time, each on its own decode and measure
        const queue = [...list];
        await Promise.all(
          Array.from({ length: Math.min(lanes, queue.length) }, async () => {
            while (queue.length) {
              ctl.signal.throwIfAborted();
              await one(queue.shift(), todo, ctl.signal);
            }
          })
        );
        if (!todo.next) break;
        after = todo.next;
      }
    } catch (e) {
      if (e?.name === "AbortError") state.stopped = true;
      else if (e instanceof VersionError) state.error = `Ce navigateur ne mesure pas comme le serveur (${e.message}) : rechargez la page.`;
      else state.error = String(e?.message || e);
    } finally {
      state.running = false;
      state.current = [];
      ctl = null;
      publish();
    }
  }

  return { run, stop: () => ctl?.abort(), state: () => ({ ...state }) };
}
