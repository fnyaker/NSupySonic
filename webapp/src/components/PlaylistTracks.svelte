<script>
  import { flip } from "svelte/animate";
  import { dndzone } from "svelte-dnd-action";
  import { push } from "svelte-spa-router";
  import { player, currentId, playing, openMenu } from "../lib/stores.js";
  import { buildTrackMenu, userPlaylists } from "../lib/actions.js";
  import { duration as fmtDuration } from "../lib/format.js";
  import Icon from "./Icon.svelte";
  import Cover from "./Cover.svelte";

  // An editable, reorderable playlist track list. Reordering is initiated from
  // the grip handle (so a normal click/tap still plays the track) and works with
  // both mouse and touch. `editing` (the mobile "Modifier" mode) keeps the grips
  // and remove buttons permanently visible.
  export let tracks = [];
  export let context = null;
  export let editing = false;
  export let onreorder = null; // (newTracks) => void
  export let onremove = null; // (index) => void

  const FLIP = 180;
  let dragDisabled = true;

  // Wrap each track with a stable id for keyed iteration + dnd. Rebuilt only
  // when the parent's track array changes (load / add / remove), never mid-drag.
  let seq = 0;
  let rows = [];
  $: syncRows(tracks);
  function syncRows(list) {
    rows = list.map((t) => ({ id: ++seq, track: t }));
  }

  function handleConsider(e) {
    rows = e.detail.items;
  }
  function handleFinalize(e) {
    rows = e.detail.items;
    dragDisabled = true;
    onreorder?.(rows.map((r) => r.track));
  }

  // Touch/mouse: arm dragging only while the grip is held.
  function grab(e) {
    e.preventDefault();
    dragDisabled = false;
  }

  function playAt(i) {
    if (editing) return;
    const t = rows[i].track;
    if ($currentId === t.deezer_id) player.toggle();
    else player.playQueue(rows.map((r) => r.track), i, context);
  }

  async function menu(e, track) {
    e.preventDefault();
    e.stopPropagation();
    const coords = { clientX: e.clientX, clientY: e.clientY, preventDefault() {}, stopPropagation() {} };
    await userPlaylists();
    openMenu(coords, buildTrackMenu(track, push));
  }
</script>

<div
  class="list"
  class:editing
  use:dndzone={{ items: rows, dragDisabled, flipDurationMs: FLIP, dropTargetStyle: {} }}
  on:consider={handleConsider}
  on:finalize={handleFinalize}
>
  {#each rows as row, i (row.id)}
    {@const track = row.track}
    {@const isCurrent = $currentId === track.deezer_id}
    <!-- svelte-ignore a11y-no-static-element-interactions -->
    <div class="row" class:active={isCurrent} animate:flip={{ duration: FLIP }} on:contextmenu={(e) => menu(e, track)}>
      <button
        class="grip"
        aria-label="Déplacer"
        title="Glisser pour réordonner"
        on:pointerdown={grab}
        on:pointerup={() => (dragDisabled = true)}
      >
        <Icon name="grip" size={18} />
      </button>

      <button class="play" on:click={() => playAt(i)} aria-label="Lire">
        {#if isCurrent && $playing}
          <span class="eq" aria-hidden="true"><i></i><i></i><i></i></span>
        {:else}
          <span class="num">{i + 1}</span>
          <span class="ic"><Icon name="play" size={14} /></span>
        {/if}
      </button>

      <div class="titles">
        <div class="thumb"><Cover src={track.album?.cover} alt={track.title} size={40} /></div>
        <div class="meta">
          <div class="t">
            {#if track.local}<span class="local" title="Fichier local (pas sur Deezer)"><Icon name="cloudOff" size={13} /></span>{/if}
            {track.title}
            {#if track.explicit}<span class="explicit">E</span>{/if}
          </div>
          <button class="a muted" on:click|stopPropagation={() => track.artist && push("/artist/" + track.artist.deezer_id)}>
            {track.artist?.name}
          </button>
        </div>
      </div>

      <span class="dur muted">{fmtDuration(track.duration)}</span>

      <button class="remove" on:click|stopPropagation={() => onremove?.(i)} aria-label="Retirer de la playlist" title="Retirer">
        <Icon name="minusCircle" size={20} />
      </button>
      <button class="more" on:click|stopPropagation={(e) => menu(e, track)} aria-label="Plus d'options"><Icon name="more" size={18} /></button>
    </div>
  {/each}
</div>

{#if !rows.length}
  <p class="muted empty">Cette playlist est vide. Ajoutez des titres pour commencer.</p>
{/if}

<style>
  .list {
    display: flex;
    flex-direction: column;
  }
  .row {
    display: grid;
    grid-template-columns: 28px 40px 1fr 48px 30px 30px;
    align-items: center;
    gap: 12px;
    padding: 6px 8px;
    border-radius: 8px;
    user-select: none;
    background: var(--bg);
  }
  .row:hover {
    background: var(--bg-hover);
  }
  .row.active .t {
    color: var(--accent);
  }
  .grip {
    color: var(--text-dim);
    cursor: grab;
    opacity: 0;
    display: flex;
    justify-content: center;
    touch-action: none;
  }
  .grip:active {
    cursor: grabbing;
  }
  .row:hover .grip,
  .list.editing .grip {
    opacity: 1;
  }
  .play {
    width: 40px;
    height: 40px;
    display: grid;
    place-items: center;
    position: relative;
  }
  .play .num {
    color: var(--text-dim);
  }
  .play .ic {
    display: none;
  }
  .row:hover .play .num {
    display: none;
  }
  .row:hover .play .ic {
    display: block;
  }
  .list.editing .play {
    display: none;
  }
  .titles {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
  }
  .thumb {
    flex: none;
    width: 40px;
  }
  .meta {
    min-width: 0;
  }
  .t {
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .local {
    display: inline-flex;
    vertical-align: -2px;
    color: var(--text-dim);
    margin-right: 3px;
  }
  .explicit {
    font-size: 0.6rem;
    background: var(--bg-hover);
    padding: 1px 3px;
    border-radius: 3px;
    vertical-align: 1px;
  }
  .a {
    text-align: left;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 100%;
    font-size: 0.85rem;
  }
  .a:hover {
    color: var(--text);
    text-decoration: underline;
  }
  .dur {
    text-align: right;
    font-variant-numeric: tabular-nums;
    font-size: 0.85rem;
  }
  .remove {
    color: var(--text-dim);
    opacity: 0;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .remove:hover {
    color: var(--accent-2);
  }
  .more {
    color: var(--text-dim);
    opacity: 0;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .row:hover .remove,
  .row:hover .more,
  .list.editing .remove {
    opacity: 1;
  }
  .more:hover {
    color: var(--text);
  }
  .empty {
    margin-top: 18px;
  }
  /* equalizer animation on the playing row */
  .eq {
    display: flex;
    align-items: flex-end;
    gap: 2px;
    height: 16px;
  }
  .eq i {
    width: 3px;
    background: var(--accent);
    animation: eq 0.9s ease-in-out infinite;
  }
  .eq i:nth-child(1) {
    animation-delay: -0.2s;
  }
  .eq i:nth-child(2) {
    animation-delay: -0.5s;
  }
  .eq i:nth-child(3) {
    animation-delay: -0.8s;
  }
  @keyframes eq {
    0%,
    100% {
      height: 30%;
    }
    50% {
      height: 100%;
    }
  }
  @media (max-width: 640px) {
    .row {
      grid-template-columns: 30px 40px 1fr 30px 28px;
    }
    .dur {
      display: none;
    }
    /* On mobile the remove/more controls stay visible for thumb reach. */
    .list.editing .remove,
    .more {
      opacity: 1;
    }
  }
</style>
