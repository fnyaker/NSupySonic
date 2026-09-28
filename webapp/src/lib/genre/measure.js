// Main-thread half of the studio's construction measurer (measure.worker.js).
//
// Decoding has to happen here — a Worker has no AudioContext — so each track
// is fetched (Opus 128, FLAC where Opus does not decode), decoded by an
// OfflineAudioContext at 48 kHz, mixed to mono and
// handed to the worker, which runs the player's analyser over it. One track at
// a time: a decoded track is tens of megabytes, and this is a background task
// the admin started, not something to race through.

import { api } from "../api.js";

const SAMPLE_RATE = 48000;
// Opus at 128k keeps the whole band the analyser reads (the piep's 1.4-5 kHz,
// the beater's click), at 4 MB for four minutes; the server caches the
// transcode.
const QUALITY = "OPUS_128";
// A DJ set or an hour-long mix is not one genre, and it is hundreds of MB.
const MAX_SECONDS = 15 * 60;

let worker = null;
let seq = 0;
const jobs = new Map();

function ensure() {
  if (worker) return worker;
  worker = new Worker(new URL("./measure.worker.js", import.meta.url), { type: "module" });
  worker.onmessage = (ev) => {
    const msg = ev.data || {};
    const job = jobs.get(msg.id);
    if (!job) return;
    jobs.delete(msg.id);
    if (msg.type === "done") job.resolve(msg.summary);
    else job.reject(new Error(msg.message || "measurement failed"));
  };
  worker.onerror = (ev) => {
    const err = new Error(ev.message || "measurement worker failed");
    for (const [, job] of jobs) job.reject(err);
    jobs.clear();
    worker.terminate();
    worker = null;
  };
  return worker;
}

/** Drop the worker (the studio calls this when it unmounts). */
export function releaseMeasurer() {
  if (!worker) return;
  worker.terminate();
  worker = null;
  for (const [, job] of jobs) job.reject(new Error("cancelled"));
  jobs.clear();
}

async function fetchAudio(id, quality, signal) {
  for (let attempt = 0; attempt < 4; attempt++) {
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
  const w = ensure();
  const jobId = ++seq;
  const summary = await new Promise((resolve, reject) => {
    jobs.set(jobId, { resolve, reject });
    w.postMessage(
      { type: "measure", id: jobId, pcm: mono.buffer, sampleRate: audio.sampleRate, bpm: +bpm || 0 },
      [mono.buffer]
    );
  });
  if (summary) await api.analysisLive(id, summary);
  return summary;
}
