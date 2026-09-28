// The links the app hands out to other people (a listen party, a remote
// control), and the way back in from one.
//
// A link is built from WHERE THE APP IS SERVED, never relative to the page's
// own path. `new URL("../rc/…", location)` assumed that path is exactly
// "/app/", and a page reached any other way ("/app//", a WebView's base
// joined with a slash too many) handed out "/app/rc/<token>" — which the
// server read as a missing file (the token has a dot in it) and answered 404.
// The app's root is whatever comes before its "/app/" segment, so a deployment
// under a path prefix still gets "/prefix/rc/<token>".

const SEGMENT = "/app/";

/** The path the server's own routes hang off ("/", or "/prefix/"). */
export function appRoot(pathname) {
  const p = String(pathname || "/");
  const i = p.indexOf(SEGMENT);
  if (i < 0) return "/";
  // "/app//", "//app/": collapse the empty segments a sloppy base left behind.
  return (p.slice(0, i) + "/").replace(/\/{2,}/g, "/");
}

/** `https://host[/prefix]/<kind>/<id>` — the short link a QR code carries. */
export function shortLink(kind, id, loc = window.location) {
  return `${loc.origin}${appRoot(loc.pathname)}${kind}/${id}`;
}

// A short link that came in under the app's own path ("/app/rc/<token>", as
// the faulty builder above handed out): the service worker answers any
// navigation there with the app shell, which then boots with no route. Turn the
// path back into the route it names. Only the two link kinds, only well-formed
// ids, and never anything that reaches past the app.
const PATH_LINK = /\/app\/+(rc|party)\/([A-Za-z0-9_-]{16,64}(?:\.[A-Za-z0-9_-]{24})?)\/?$/;

/** The hash route a path-style link names, or null. */
export function routeForPath(pathname) {
  const m = PATH_LINK.exec(String(pathname || ""));
  return m ? `#/${m[1]}/${m[2]}` : null;
}

/** Rewrite the current URL in place when it is such a link. */
export function rescuePathLink(loc = window.location, hist = window.history) {
  const route = routeForPath(loc.pathname);
  if (!route || (loc.hash && loc.hash !== "#" && loc.hash !== "#/")) return false;
  const base = loc.pathname.slice(0, loc.pathname.search(/\/app\/+(rc|party)\//)) + SEGMENT;
  hist.replaceState(hist.state, "", base.replace(/\/{2,}/g, "/") + route);
  return true;
}
