<script>
  import { player } from "../lib/stores.js";
  import TrackRow from "./TrackRow.svelte";

  export let tracks = [];
  export let numbered = false;
  export let showAlbum = true;
  export let showCover = true;
  export let context = null;
  // Progressive loading hooks (used by PagedTrackBrowser). `hasMore` keeps the
  // sentinel alive when more DATA can be fetched beyond what's loaded;
  // `onNearEnd` asks the parent to fetch the next block when the render window
  // reaches the end of the loaded data; `onPlayed` fires when a row starts
  // playback (so the parent can load the rest and extend the queue).
  export let hasMore = false;
  export let onNearEnd = null;
  export let onPlayed = null;

  const STEP = 60;
  let limit = STEP;

  // Reset the window whenever the list itself changes. Referencing `.length`
  // (not the array identity) so appending a loaded block doesn't reset the
  // window back to the top — it just reveals what the user scrolled to.
  let lastLen = 0;
  $: if (tracks.length < lastLen) limit = STEP; // shrunk/replaced -> reset
  $: lastLen = tracks.length;

  $: visible = tracks.slice(0, limit);

  function playFrom(i) {
    player.playQueue(tracks, i, context);
    onPlayed?.();
  }

  // IntersectionObserver-based "load more" so huge lists (favorites) stay snappy.
  // Two-stage: first grow the render window over already-loaded rows; once the
  // window reaches the end of loaded data, ask the parent for the next block.
  function lazyload(node) {
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries[0].isIntersecting) return;
        if (limit < tracks.length) limit = Math.min(limit + STEP, tracks.length);
        else if (hasMore) onNearEnd?.();
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
  {#if limit < tracks.length || hasMore}
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
