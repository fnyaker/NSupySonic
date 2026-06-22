// svelte-spa-router v5 dropped the `location`/`querystring` stores in favour of
// a runes-based `router` object that legacy-mode components can't `$`-subscribe
// to. This re-exposes the current hash path as a plain readable store so the
// existing `$location` usages keep working unchanged.
import { readable } from "svelte/store";

function currentPath() {
  const href = window.location.href;
  const i = href.indexOf("#/");
  let loc = i > -1 ? href.substring(i + 1) : "/";
  const q = loc.indexOf("?");
  if (q >= 0) loc = loc.substring(0, q);
  return loc;
}

// push() and link() navigate by mutating the hash, which fires `hashchange` —
// the same signal the router itself listens to, so this stays in sync.
export const location = readable(currentPath(), (set) => {
  const update = () => set(currentPath());
  window.addEventListener("hashchange", update);
  return () => window.removeEventListener("hashchange", update);
});
