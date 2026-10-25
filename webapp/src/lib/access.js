// What the person may use of each provider (plan multi-provider §15), as the
// server said at login (`user.access`: { provider: [features] }). A server
// that predates it, or a user restored offline from an older copy, says
// nothing: then everything is offered, as before, and the server still decides.
import { derived } from "svelte/store";
import { user } from "./stores.js";

export function canUse(u, provider, feature) {
  const map = u && u.access;
  if (!map) return true;
  const list = map[provider];
  return Array.isArray(list) && list.includes(feature);
}

export const access = derived(user, ($user) => ({
  can: (provider, feature) => canUse($user, provider, feature),
}));
