// Imported FIRST by main.js, for its side effect alone: ES modules run in import
// order, and the router (and nav.js) read the location while they load, so a
// rescue run any later is a URL rewritten under a router already on the wrong
// screen — the login page, measured, with the service worker in control.
import { rescuePathLink } from "./applink.js";

if (typeof window !== "undefined") rescuePathLink();
