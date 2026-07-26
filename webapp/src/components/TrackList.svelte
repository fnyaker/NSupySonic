<script>
  import { onMount, tick } from "svelte";
  import { player } from "../lib/stores.js";
  import TrackRow from "./TrackRow.svelte";

  export let tracks = [];
  export let numbered = false;
  export let showAlbum = true;
  export let showCover = true;
  export let context = null;

  // Windowed rendering (virtual list): only the rows actually on screen (plus a
  // small buffer) are mounted, no matter how long the playlist is. The list
  // reserves its full height with a spacer, and visible rows are absolutely
  // positioned, so scrolling a 5000-track favorites list keeps ~20 rows in the
  // DOM instead of thousands — the difference between smooth and janky.
  const BUFFER = 8; // extra rows above/below the viewport (smooth fast scroll)
  const FALLBACK_H = 52; // row height until measured

  let listEl;
  let scroller = null; // nearest scrolling ancestor (the app's <main>)
  let rowH = FALLBACK_H;
  let start = 0;
  let end = 0;

  $: total = tracks.length;
  $: topPad = start * rowH;
  $: visible = tracks.slice(start, end);

  function findScroller(node) {
    let el = node.parentElement;
    while (el) {
      const oy = getComputedStyle(el).overflowY;
      if (oy === "auto" || oy === "scroll") return el;
      el = el.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }
  // The document scroller is a special case: its bounding rect describes the
  // WHOLE page, not the visible area, so measuring it like a normal element
  // reported a viewport as tall as the document — and the window degenerated
  // into "render every row", which is exactly what windowing exists to avoid.
  function viewport(el) {
    if (el === document.scrollingElement || el === document.documentElement || el === document.body)
      return { top: 0, height: window.innerHeight };
    const r = el.getBoundingClientRect();
    return { top: r.top, height: r.height };
  }

  function recompute() {
    if (!listEl || !scroller) return;
    const lr = listEl.getBoundingClientRect();
    const sr = viewport(scroller);
    // Where the viewport sits relative to the list's own top.
    const above = sr.top - lr.top; // list content scrolled above the viewport
    const viewH = sr.height;
    let s = Math.floor(above / rowH) - BUFFER;
    let e = Math.ceil((above + viewH) / rowH) + BUFFER;
    s = Math.max(0, Math.min(s, total));
    e = Math.max(0, Math.min(e, total));
    if (s !== start || e !== end) {
      start = s;
      end = e;
    }
  }

  let ticking = false;
  function onScroll() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      ticking = false;
      recompute();
    });
  }

  // Measure the real (natural) row height once rows exist — rows flow normally
  // inside the translated window, so an accurate uniform height keeps their
  // absolute offsets pixel-perfect. Covers theme/font/zoom differences.
  async function measure() {
    await tick();
    const row = listEl?.querySelector(".vrow");
    if (row) {
      const h = row.getBoundingClientRect().height;
      if (h && Math.abs(h - rowH) > 0.5) {
        rowH = h;
        await tick();
      }
    }
    recompute();
  }

  onMount(() => {
    scroller = findScroller(listEl);
    end = Math.min(total, Math.ceil((scroller?.clientHeight || 800) / rowH) + BUFFER);
    scroller?.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    // The scroll container can change size without the WINDOW ever resizing —
    // opening/closing the now-playing panel, the toolbar wrapping. Watching only
    // `resize` left the window stale (too few rows mounted, blank space below)
    // until the next scroll event nudged it.
    let ro = null;
    if (typeof ResizeObserver !== "undefined" && scroller) {
      ro = new ResizeObserver(onScroll);
      ro.observe(scroller);
    }
    measure();
    return () => {
      scroller?.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      ro?.disconnect();
    };
  });

  // Re-window whenever the list contents change (new playlist, sort, filter, or
  // an in-place edit like un-starring a row). We DON'T jump to the top — the
  // window is recomputed from the current scroll position, so removing a row
  // mid-list keeps you where you were.
  let lastRef = null;
  $: if (tracks !== lastRef) {
    lastRef = tracks;
    if (scroller) measure();
  }

  function playFrom(i) {
    player.playQueue(tracks, i, context);
  }
</script>

<div class="list" bind:this={listEl} style="height:{total * rowH}px">
  <div class="win" style="transform:translateY({topPad}px)">
    {#each visible as track, i (track.deezer_id + ":" + (start + i))}
      <div class="vrow">
        <TrackRow
          {track}
          index={numbered ? start + i + 1 : null}
          {showAlbum}
          {showCover}
          onplay={() => playFrom(start + i)}
        />
      </div>
    {/each}
  </div>
</div>

<style>
  .list {
    position: relative;
    width: 100%;
  }
  .win {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    will-change: transform;
  }
</style>
