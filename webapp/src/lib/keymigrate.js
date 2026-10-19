// The one-off move of the device's own records from Deezer ids to track UUIDs.
//
// The small caches (verdicts, silence bounds, gains) rename their keys as they
// load, because that costs nothing. What is left is the audio the device keeps
// in IndexedDB — downloads and the playback cache — and it moves here, in the
// background, once the first screen is up. Nothing waits on it: both indexes
// already answer to the UUID of a record that has not been renamed yet.
//
// `keys.v2` says it is done. It is only written when every part ran, so a
// failure (storage full, a closed database) is simply tried again next launch.

import { migrateStoredKeys as migrateDownloads } from "./offline.js";
import { migrateStoredKeys as migratePlayCache } from "./playcache.js";
import { logInfo } from "./log.js";

const FLAG = "keys.v2";

export function keysMigrated() {
  try {
    return localStorage.getItem(FLAG) === "1";
  } catch {
    return false;
  }
}

export async function migrateKeysOnce() {
  if (keysMigrated()) return false;
  try {
    const a = await migrateDownloads();
    const b = await migratePlayCache();
    if (a || b) logInfo("keys", `device records moved to track UUIDs: ${a} download(s), ${b} cached`, null, { important: true });
    localStorage.setItem(FLAG, "1");
    return true;
  } catch (e) {
    logInfo("keys", `key migration deferred: ${e?.message || e}`, null, { important: true });
    return false;
  }
}
