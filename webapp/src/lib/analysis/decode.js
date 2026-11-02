// Decoding one downloaded FLAC the way the server's ffmpeg reads it: at the file's OWN rate
// and channels (the descriptors move with a resample), plus the 44.1 kHz mono the beat
// tracker reads. Browsers decode FLAC natively; `decodeAudioData` resamples to the context's
// rate, so the context is made at the file's rate.

import { monoOf } from "./measure.js";

async function decodeAt(bytes, channels, rate) {
  const Ctx = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  if (!Ctx) throw new Error("this browser cannot decode audio");
  const ctx = new Ctx(channels, 1, rate);
  // decodeAudioData detaches its input: hand it a copy only when we still need the bytes.
  const buf = await ctx.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  return Array.from({ length: buf.numberOfChannels }, (_, i) => buf.getChannelData(i));
}

export async function decodeTrack(bytes, rate, channels) {
  const chans = await decodeAt(bytes, channels, rate);
  const mono44 = rate === 44100 ? monoOf(chans) : monoOf(await decodeAt(bytes, 1, 44100));
  return { channels: chans, mono44 };
}

/** The track as 16 kHz mono: what the extractor's front-end reads (the server's ffmpeg: `-ac 1 -ar 16000`). */
export async function decodeMono16(bytes) {
  return monoOf(await decodeAt(bytes, 1, 16000));
}
