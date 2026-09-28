// The part of hosting a remote control every page carries: whether THIS
// device's player is lent, and to whom — what the player bar's button and the
// "controlled by…" chip show. The machinery itself (lib/remote/host.js, its
// two loops, the command runner) is fetched only once a link points here, so
// the vast majority of launches never download it.

import { writable } from "svelte/store";
import { api } from "../api.js";
import { deviceId } from "./device.js";

/** {active, controllers: [{link, level, label}]} */
export const remoteHost = writable({ active: false, controllers: [] });

const load = () => import("./host.js");

/** After login: is anything lent to this device? Then start answering. */
export async function initRemoteHost() {
  try {
    const r = await api.remoteLinks(deviceId());
    if (r && Array.isArray(r.links) && r.links.length) (await load()).startRemoteHost();
  } catch {
    /* offline, or an older server: nothing is lent, nothing to do */
  }
}

/** Right after a link is made on this device. */
export async function startHosting() {
  (await load()).startRemoteHost();
}

/** Cut every link onto this device — the owner's button, always within reach. */
export async function cutAll() {
  return (await load()).cutAll();
}
