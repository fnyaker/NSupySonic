// Main-thread half of the studio's construction measurer (measure.worker.js).
//
// Decoding has to happen here — a Worker has no AudioContext — so each track
// is fetched (Opus 128, FLAC where Opus does not decode), decoded by an
// OfflineAudioContext at 48 kHz, mixed to mono and
// handed to a worker, which runs the player's analyser over it.
//
// SEVERAL tracks at a time (`measureParallelism`), each on its own worker: one
// at a time, a library of a thousand tagged tracks was an evening, with all
// but one core idle and the next download waiting for the previous analysis.
// The bound is the smallest of three: half the cores (the page keeps the rest),
// the device's memory (a decoded track is tens of megabytes while it is being
// mixed down), and the server's quota for background requests (a quarter of
// its 16 threads — past it the fetch is refused and waits).

import { api } from "../api.js";

const SAMPLE_RATE = 48000;
// Opus at 128k keeps the whole band the analyser reads (the piep's 1.4-5 kHz,
// the beater's click), at 4 MB for four minutes; the server caches the
// transcode.
const QUALITY = "OPUS_128";
// A DJ set or an hour-long mix is not one genre, and it is hundreds of MB.
const MAX_SECONDS = 15 * 60;

// The server lets a quarter of its 16 request threads serve background work.
const SERVER_SHARE = 4;

/** How many tracks the studio measures at once on this device. */
export function measureParallelism() {
  const nav = typeof navigator !== "undefined" ? navigator : {};
  const cores = +nav.hardwareConcurrency || 2;
  // deviceMemory is Chromium-only and rounded (0.25 .. 8 GB); unknown is
  // taken as a middling machine.
  const mem = +nav.deviceMemory || 4;
  const byMem = mem <= 2 ? 1 : mem <= 4 ? 2 : SERVER_SHARE;
  return Math.max(1, Math.min(SERVER_SHARE, Math.floor(cores / 2), byMem));
}

// One worker per track in flight, each with at most one job: the callers bound
// how many there are (measureParallelism), so the pool never outgrows them.
const pool = []; // { worker, job: { id, resolve, reject } | null }
let seq = 0;

function idleSlot() {
  let slot = pool.find((s) => !s.job);
  if (slot) return slot;
  slot = { worker: new Worker(new URL("./measure.worker.js", import.meta.url), { type: "module" }), job: null };
  slot.worker.onmessage = (ev) => {
    const msg = ev.data || {};
    const job = slot.job;
    if (!job || job.id !== msg.id) return;
    slot.job = null;
    if (msg.type === "done") job.resolve(msg.summary);
    else job.reject(new Error(msg.message || "measurement failed"));
  };
  slot.worker.onerror = (ev) => {
    const job = slot.job;
    slot.job = null;
    slot.worker.terminate();
    const i = pool.indexOf(slot);
    if (i >= 0) pool.splice(i, 1);
    if (job) job.reject(new Error(ev.message || "measurement worker failed"));
  };
  pool.push(slot);
  return slot;
}

/** Drop the workers (the studio calls this when it unmounts). */
export function releaseMeasurer() {
  for (const slot of pool.splice(0)) {
    slot.worker.terminate();
    if (slot.job) slot.job.reject(new Error("cancelled"));
    slot.job = null;
  }
}

async function fetchAudio(id, quality, signal) {
  // Patient with refusals: several measurers share the server's background
  // quota with the player's own prefetches.
  for (let attempt = 0; attempt < 8; attempt++) {
    // A background request: the server holds these to a share of its threads
    // and refuses the excess (503 + Retry-After) rather than queueing them.
    const res = await fetch(api.streamUrl(encodeURIComponent(id), quality), {
      credentials: "include",
      headers: { "X-NS-Background": "1" },
      signal,
    });
    if (res.status === 503) {
      const wait = Math.min(30, +res.headers.get("Retry-After") || 3);
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.arrayBuffer();
  }
  throw new Error("the server stayed busy");
}

/**
 * Measure how one track is built and send the summary to the server.
 * Resolves to the summary (null when the track has too little groove to say).
 */
export async function measureTrack(id, bpm, signal) {
  const ctx = new OfflineAudioContext(1, 1, SAMPLE_RATE);
  let audio;
  try {
    audio = await ctx.decodeAudioData(await fetchAudio(id, QUALITY, signal));
  } catch (err) {
    // A browser that cannot decode Ogg Opus (older Safari) gets the FLAC.
    if (signal?.aborted || !(err instanceof DOMException) || err.name === "AbortError") throw err;
    audio = await ctx.decodeAudioData(await fetchAudio(id, "FLAC", signal));
  }
  if (audio.duration > MAX_SECONDS) throw new Error("too long to be one genre");
  const n = audio.length;
  const mono = new Float32Array(n);
  const channels = audio.numberOfChannels;
  for (let c = 0; c < channels; c++) {
    const data = audio.getChannelData(c);
    for (let i = 0; i < n; i++) mono[i] += data[i] / channels;
  }
  if (signal?.aborted) throw new Error("cancelled");
  const slot = idleSlot();
  const jobId = ++seq;
  const summary = await new Promise((resolve, reject) => {
    slot.job = { id: jobId, resolve, reject };
    slot.worker.postMessage(
      { type: "measure", id: jobId, pcm: mono.buffer, sampleRate: audio.sampleRate, bpm: +bpm || 0 },
      [mono.buffer]
    );
  });
  if (summary) await api.analysisLive(id, summary);
  return summary;
}
