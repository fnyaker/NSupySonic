// Whether this document could get a WebGL2 context, as the visualizer found
// out. Its own tiny module so the settings can say it without importing the GL
// engine: `null` until a GL scene was tried, then true or false for the life
// of the document — a browser that refused WebGL (after a GPU crash, typically)
// refuses it until the page is reloaded (lib/hardreload.js).

import { writable } from "svelte/store";

export const glAvailable = writable(null);
