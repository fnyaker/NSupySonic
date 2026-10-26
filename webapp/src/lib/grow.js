// A long grid mounted as it is scrolled, not all at once (CLAUDE.md rule 4:
// render only what is visible). A 300-artist library mounted its 300 tiles,
// covers and menus in one task — 1.2 s of main thread on a 4x-throttled
// phone before the chip answered. The grid now mounts one screenful, and the
// next one when its end comes within reach (`nearEnd` on a sentinel after the
// last tile): the same tiles in the same place, no "load more" button, no
// request. A grid's tiles are not one fixed height (titles wrap), so this
// grows instead of windowing like VirtualList.

/** How many tiles to mount at first and per step: more than a desktop screen
 *  of 180 px tiles holds, so the first paint never shows the sentinel. */
export const STEP = 36;

function scroller(node) {
  for (let el = node.parentElement; el && el !== document.body; el = el.parentElement) {
    // overflow-x alone computes overflow-y to auto too: only a box that
    // really scrolls clips the grid.
    if (/(auto|scroll)/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight + 1) return el;
  }
  return null;
}

/** `use:nearEnd={() => (limit += STEP)}` on an element placed after the last
 *  tile: calls back while it is within 800 px of the viewport. */
export function nearEnd(node, onNear) {
  let cb = onNear;
  if (typeof IntersectionObserver === "undefined") {
    cb?.(); // no observer (none of the browsers served lack one): one step
    return { update: (f) => (cb = f) };
  }
  const io = new IntersectionObserver(
    (entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      cb?.();
      // Still in reach once the new tiles are laid out (a tall screen, a fast
      // fling)? An observer only speaks on a CHANGE, so ask it again.
      requestAnimationFrame(() => {
        io.unobserve(node);
        io.observe(node);
      });
    },
    // The margin only extends the ROOT: against the viewport it is cut back
    // by the app's own scrolling <main>, so the root is that scroller.
    { root: scroller(node), rootMargin: "0px 0px 800px 0px" },
  );
  io.observe(node);
  return {
    update(f) {
      cb = f;
    },
    destroy: () => io.disconnect(),
  };
}
