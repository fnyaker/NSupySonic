<script>
  // The queue, as one component shared by the three places that show it (the
  // desktop side panel, the desktop full-screen player, the phone's sheet).
  //
  // Everything that edits it lives here so the three cannot drift apart:
  // tap to play a row, remove an upcoming one, drag one to reorder, clear what
  // is left. Only what is AFTER the playing track can be moved or removed —
  // moving the track being heard, or one already played, is not something a
  // queue is for.
  //
  // The list is windowed (VirtualList), so a drag never depends on a row being
  // mounted: the target row comes from geometry (`indexAt`), the picture that
  // follows the finger is a separate floating copy, and the pointer is followed
  // on the window rather than on the grip — the row may scroll out of the DOM
  // while it is being dragged toward the end of a 4 000-track queue.
  import { onDestroy, tick } from "svelte";
  import { player, toasts } from "../lib/stores.js";
  import { atLeast } from "../lib/remote/mode.js";
  import { duration as fmtDuration, artistLine } from "../lib/format.js";
  import Cover from "./Cover.svelte";
  import Icon from "./Icon.svelte";
  import VirtualList from "./VirtualList.svelte";

  export let items = [];
  export let idx = -1; // index of the playing track
  export let showDuration = false;
  // Called after a row is tapped (the phone's sheet closes itself).
  export let onPick = null;

  // Moving and removing are "read" level on a remote control; jumping is the
  // queue level and is always there.
  const editable = atLeast("read");

  let vl;
  let root;
  let drag = null; // { from, to, y, left, width, item }
  let raf = 0;
  let lastY = 0;

  $: upcoming = Math.max(0, items.length - idx - 1);

  export function scrollToIndex(...args) {
    return vl?.scrollToIndex(...args);
  }

  function pick(i) {
    player.jump(i);
    if (onPick) onPick(i);
  }

  function clearAll() {
    player.clearUpcoming();
    toasts.push("File vidée");
  }

  function buzz(ms) {
    try {
      navigator.vibrate?.(ms);
    } catch {
      /* not everywhere */
    }
  }

  // -- dragging ---------------------------------------------------------------

  function startDrag(e, from) {
    if (!editable || (e.button != null && e.button !== 0)) return;
    e.preventDefault();
    // A touch pointer is captured by the element it began on, which is removed
    // from the DOM if the list scrolls far enough: hit-test normally instead.
    try {
      e.currentTarget.releasePointerCapture?.(e.pointerId);
    } catch {
      /* not captured */
    }
    const box = root.getBoundingClientRect();
    drag = { from, to: from, y: e.clientY, left: box.left, width: box.width, item: items[from] };
    lastY = e.clientY;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", onKey);
    raf = requestAnimationFrame(loop);
    buzz(10);
  }

  function retarget() {
    if (!drag) return;
    const at = vl ? vl.indexAt(lastY) : drag.from;
    // Nothing can land on or before the playing track.
    const to = Math.max(idx + 1, at < 0 ? drag.from : at);
    if (to !== drag.to) {
      drag = { ...drag, to };
      buzz(4);
    }
  }

  function onMove(e) {
    if (!drag) return;
    lastY = e.clientY;
    drag = { ...drag, y: e.clientY };
    retarget();
  }

  // Once a frame: the edge scroll, then the target again — scrolling moved the
  // rows under a pointer that itself did not move.
  function loop() {
    if (!drag) return;
    if (vl && vl.autoScroll(lastY)) retarget();
    raf = requestAnimationFrame(loop);
  }

  function stop() {
    cancelAnimationFrame(raf);
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", cancel);
    window.removeEventListener("keydown", onKey);
    drag = null;
  }

  function onUp() {
    const d = drag;
    stop();
    if (d && d.to !== d.from) player.move(d.from, d.to);
  }

  function cancel() {
    stop();
  }

  function onKey(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      stop();
    }
  }

  onDestroy(stop);

  // The same thing from the keyboard: the grip is focusable and the arrows move
  // the row one place, keeping the focus on it.
  async function gripKey(e, i) {
    const step = e.key === "ArrowUp" ? -1 : e.key === "ArrowDown" ? 1 : 0;
    if (!step) return;
    e.preventDefault();
    const to = i + step;
    if (to <= idx || to >= items.length) return;
    player.move(i, to);
    await tick();
    root?.querySelector(`[data-qi="${to}"] .grip`)?.focus();
  }
</script>

<div class="ql" bind:this={root}>
  {#if editable && upcoming > 0}
    <div class="qhead">
      <span class="qcount">À suivre · {upcoming} titre{upcoming > 1 ? "s" : ""}</span>
      <button class="qclear" on:click={clearAll}>Vider la file</button>
    </div>
  {/if}

  <VirtualList {items} bind:this={vl} estimateHeight={56} let:item let:index>
    <div
      class="qitem"
      class:now={index === idx}
      class:past={index < idx}
      class:dragging={drag && drag.from === index}
      class:before={drag && drag.to === index && drag.to < drag.from}
      class:after={drag && drag.to === index && drag.to > drag.from}
      data-qi={index}
    >
      <button class="qrow" on:click={() => pick(index)}>
        <Cover src={item.album?.cover} alt="" size={42} kind={item.podcast ? "podcast" : "track"} fallbackId={item.deezer_id} />
        <span class="qm">
          <span class="qt">{item.title}</span>
          <span class="qa">{artistLine(item)}</span>
        </span>
        {#if showDuration}<span class="qd">{fmtDuration(item.duration)}</span>{/if}
      </button>
      {#if editable && index > idx}
        <button class="qx" on:click={() => player.removeAt(index)} aria-label="Retirer de la file" title="Retirer">
          <Icon name="close" size={15} />
        </button>
        <span
          class="grip"
          role="button"
          tabindex="0"
          aria-label="Déplacer « {item.title} » (glisser, ou flèches haut et bas)"
          title="Glisser pour déplacer"
          on:pointerdown={(e) => startDrag(e, index)}
          on:keydown={(e) => gripKey(e, index)}
        >
          <Icon name="grip" size={18} />
        </span>
      {/if}
    </div>
  </VirtualList>
</div>

{#if drag}
  <!-- The row as it is carried: a copy, so it survives the real one leaving the
       window when the list scrolls under the finger. -->
  <div class="ghost" style="top:{drag.y}px; left:{drag.left}px; width:{drag.width}px" aria-hidden="true">
    <Cover src={drag.item.album?.cover} alt="" size={42} kind={drag.item.podcast ? "podcast" : "track"} fallbackId={drag.item.deezer_id} />
    <span class="qm">
      <span class="qt">{drag.item.title}</span>
      <span class="qa">{artistLine(drag.item)}</span>
    </span>
  </div>
{/if}

<style>
  /* The parent sets the palette: --ql-dim (secondary text), --ql-hover (row
     under the pointer), --ql-bg (the sticky header's ground) and --ql-ghost. */
  .ql {
    color: inherit;
    --dim: var(--ql-dim, rgba(255, 255, 255, 0.6));
  }
  .qhead {
    position: sticky;
    top: 0;
    z-index: 2;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 6px 6px 6px 8px;
    background: var(--ql-bg, transparent);
  }
  .qcount {
    font-size: 0.74rem;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--dim);
  }
  .qclear {
    font-size: 0.8rem;
    font-weight: 700;
    color: inherit;
    padding: 8px 12px;
    border-radius: 999px;
    background: var(--ql-hover, rgba(255, 255, 255, 0.08));
  }
  .qclear:hover {
    background: color-mix(in srgb, currentColor 16%, transparent);
  }

  .qitem {
    position: relative;
    display: flex;
    align-items: center;
    box-sizing: border-box;
    height: 56px;
    border-radius: 8px;
  }
  .qitem:hover {
    background: var(--ql-hover, rgba(255, 255, 255, 0.08));
  }
  .qitem.now .qt {
    color: var(--accent);
  }
  .qitem.past {
    opacity: 0.5;
  }
  .qitem.dragging {
    opacity: 0.3;
  }
  /* Where the row will land: a line on the side it arrives from. */
  .qitem.before::before,
  .qitem.after::after {
    content: "";
    position: absolute;
    left: 6px;
    right: 6px;
    height: 2px;
    border-radius: 2px;
    background: var(--accent);
    z-index: 1;
  }
  .qitem.before::before {
    top: -1px;
  }
  .qitem.after::after {
    bottom: -1px;
  }

  .qrow {
    display: flex;
    align-items: center;
    gap: 10px;
    flex: 1;
    min-width: 0;
    height: 100%;
    padding: 0 7px;
    border-radius: 8px;
    text-align: left;
    color: inherit;
  }
  .qm {
    display: flex;
    flex-direction: column;
    min-width: 0;
    flex: 1;
  }
  .qt,
  .qa {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .qt {
    font-weight: 600;
    font-size: 0.92rem;
  }
  .qa {
    font-size: 0.78rem;
    color: var(--dim);
  }
  .qd {
    font-size: 0.78rem;
    color: var(--dim);
    font-variant-numeric: tabular-nums;
  }

  .qx,
  .grip {
    display: grid;
    place-items: center;
    flex: none;
    width: 40px;
    height: 100%;
    color: var(--dim);
  }
  .qx:hover,
  .grip:hover,
  .grip:focus-visible {
    color: inherit;
  }
  /* The grip is the only part of a row that does not scroll it: a finger that
     lands anywhere else is the list's, one that lands here is a drag. */
  .grip {
    cursor: grab;
    touch-action: none;
    user-select: none;
    -webkit-user-select: none;
    border-radius: 8px;
  }
  .grip:active {
    cursor: grabbing;
  }
  .grip:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }
  /* Hover is the desktop's way of keeping a row calm until it is wanted; a
     touch screen has no hover, so there the controls are simply always there. */
  @media (hover: hover) {
    .qx {
      opacity: 0;
    }
    .qitem:hover .qx,
    .qx:focus-visible {
      opacity: 1;
    }
  }

  .ghost {
    position: fixed;
    z-index: 400;
    display: flex;
    align-items: center;
    gap: 10px;
    box-sizing: border-box;
    height: 56px;
    padding: 0 7px;
    margin-top: -28px; /* centred on the pointer */
    border-radius: 10px;
    background: var(--ql-ghost, #2a2536);
    color: #fff;
    box-shadow: 0 14px 40px rgba(0, 0, 0, 0.55);
    pointer-events: none;
    --dim: rgba(255, 255, 255, 0.6);
  }
</style>
