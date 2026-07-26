<script>
  // Headless windowed (virtual) list. Only the rows actually on screen (plus a
  // small buffer) are mounted, no matter how long `items` is — so a 4000-track
  // queue keeps ~20 rows + ~20 cover images in the DOM instead of thousands.
  // The result is visually identical to a plain {#each}; it's just bounded work
  // instead of O(n), which is what kept a huge favorites queue from spiking the
  // CPU. Same idea as TrackList.svelte, extracted so the now-playing queue
  // panels can share it.
  //
  // Usage:
  //   <VirtualList items={queue} let:item let:index bind:this={vl}>
  //     <div class="row" class:now={index === current}>{item.title}</div>
  //   </VirtualList>
  // The slot's root element is measured for row height, so every row must be
  // the same height (they are — fixed-height queue rows).
  import { onMount, tick } from "svelte";

  export let items = [];
  export let estimateHeight = 52; // row height until measured
  export let buffer = 8; // extra rows above/below the viewport (smooth fast scroll)
  // Key each row by identity + absolute position so duplicates in the queue
  // don't collide. Overridable if a caller has a better key.
  export let key = (item, index) => (item?.deezer_id ?? "") + ":" + index;

  let listEl;
  let winEl;
  let scroller = null; // nearest scrolling ancestor
  let rowH = estimateHeight;
  let start = 0;
  let end = 0;

  $: total = items.length;
  $: topPad = start * rowH;
  $: visible = items.slice(start, end);

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
    const above = sr.top - lr.top; // list content scrolled above the viewport
    const viewH = sr.height;
    let s = Math.floor(above / rowH) - buffer;
    let e = Math.ceil((above + viewH) / rowH) + buffer;
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

  // Measure the real row height once rows exist, so absolute offsets stay
  // pixel-perfect across theme/font/zoom.
  export async function measure() {
    await tick();
    const row = winEl?.firstElementChild;
    if (row) {
      const h = row.getBoundingClientRect().height;
      if (h && Math.abs(h - rowH) > 0.5) {
        rowH = h;
        await tick();
      }
    }
    recompute();
  }

  // Bring row `index` to `ratio` down the viewport (default first quarter).
  // Computed from row height, so it works even when that row isn't mounted yet
  // — the follow-the-playing-track behavior can't rely on querying the DOM once
  // the list is windowed.
  export async function scrollToIndex(index, { ratio = 0.25, smooth = true } = {}) {
    if (!listEl || !scroller || index < 0) return;
    await measure();
    const lr = listEl.getBoundingClientRect();
    const sr = viewport(scroller);
    const listTop = scroller.scrollTop + (lr.top - sr.top); // list top in scroll coords
    const target = listTop + index * rowH - scroller.clientHeight * ratio;
    scroller.scrollTo({ top: Math.max(0, target), behavior: smooth ? "smooth" : "auto" });
  }

  onMount(() => {
    scroller = findScroller(listEl);
    end = Math.min(total, Math.ceil((scroller?.clientHeight || 800) / rowH) + buffer);
    scroller?.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    // The scroll container can change size without the WINDOW ever resizing —
    // opening/closing the now-playing panel, a header collapsing. Watching only
    // `resize` left the window stale (a short list of rows in a suddenly taller
    // panel, blank space below) until the next scroll event nudged it.
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

  // Re-window whenever the list contents change. We DON'T jump to the top — the
  // window is recomputed from the current scroll position, so removing a row
  // mid-list keeps you where you were.
  let lastRef = null;
  $: if (items !== lastRef) {
    lastRef = items;
    if (scroller) measure();
  }
</script>

<div class="vlist" bind:this={listEl} style="height:{total * rowH}px">
  <div class="vwin" bind:this={winEl} style="transform:translateY({topPad}px)">
    {#each visible as item, i (key(item, start + i))}
      <slot {item} index={start + i} />
    {/each}
  </div>
</div>

<style>
  .vlist {
    position: relative;
    width: 100%;
  }
  .vwin {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    will-change: transform;
  }
</style>
