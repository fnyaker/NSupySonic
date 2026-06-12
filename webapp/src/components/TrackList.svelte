<script>
  import { player } from "../lib/stores.js";
  import TrackRow from "./TrackRow.svelte";

  export let tracks = [];
  export let numbered = false;
  export let showAlbum = true;
  export let showCover = true;
  export let context = null;

  const STEP = 60;
  let limit = STEP;

  // Reset the window whenever the list itself changes.
  $: tracks, (limit = STEP);

  $: visible = tracks.slice(0, limit);

  function playFrom(i) {
    player.playQueue(tracks, i, context);
  }

  // IntersectionObserver-based "load more" so huge lists (favorites) stay snappy.
  function lazyload(node) {
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && limit < tracks.length) {
          limit = Math.min(limit + STEP, tracks.length);
        }
      },
      { rootMargin: "600px 0px" }
    );
    io.observe(node);
    return { destroy: () => io.disconnect() };
  }
</script>

<div class="list">
  {#each visible as track, i (track.deezer_id + ":" + i)}
    <TrackRow
      {track}
      index={numbered ? i + 1 : null}
      {showAlbum}
      {showCover}
      onplay={() => playFrom(i)}
    />
  {/each}
  {#if limit < tracks.length}
    <div class="sentinel" use:lazyload>Chargement…</div>
  {/if}
</div>

<style>
  .list {
    display: flex;
    flex-direction: column;
  }
  .sentinel {
    padding: 16px;
    text-align: center;
    color: var(--text-dim);
    font-size: 0.85rem;
  }
</style>
