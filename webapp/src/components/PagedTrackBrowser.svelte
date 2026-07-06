<script context="module">
  // Cross-navigation cache: revisiting a list (favorites, a playlist) shows
  // the already-loaded blocks instantly instead of refetching from block 0.
  const _cache = new Map(); // cacheKey -> { items, total }
  export function invalidatePaged(key) {
    _cache.delete(key);
  }
</script>

<script>
  import { onMount } from "svelte";
  import TrackBrowser from "./TrackBrowser.svelte";
  import { player } from "../lib/stores.js";

  // Progressive, block-by-block track list. Loads the first block for a fast
  // first paint, fetches further blocks as the user scrolls, and pulls the
  // WHOLE list the moment it's actually needed (sort, search, or play). On
  // play it starts the tapped/loaded tracks immediately, then extends the queue
  // to the full list once every block has arrived — the user never waits.
  export let load; // async (offset, limit) => { tracks, total }
  export let context = null;
  export let cacheKey = null; // enables instant revisit via the module cache
  export let seed = null; // { tracks, total } already fetched by the parent
  export let pageSize = 100;
  export let numbered = true;
  export let showAlbum = true;
  export let showCover = true;
  export let downloadable = true;
  export let oncount = null; // (total) => void — for the parent's header count

  let items = [];
  let total = null;
  let inflight = null; // the block fetch currently in flight (shared)

  $: loading = inflight != null;
  $: allLoaded = total != null && items.length >= total;
  $: if (oncount) oncount(total);

  onMount(() => {
    const cached = cacheKey && _cache.get(cacheKey);
    if (cached && cached.items.length) {
      items = cached.items;
      total = cached.total;
      // Cheap freshness check: if the total moved (new/removed favorites), the
      // cache is stale — reload from the top in the background.
      revalidate();
    } else if (seed && seed.tracks) {
      // Reuse the first block the parent already fetched (e.g. the playlist
      // page needs it for the header) — no redundant round-trip.
      items = seed.tracks;
      total = seed.total ?? seed.tracks.length;
      store();
    } else {
      loadBlock(0);
    }
  });

  function store() {
    if (cacheKey) _cache.set(cacheKey, { items, total });
  }

  // Fetch one block. A load already in flight is SHARED (returned) rather than
  // skipped, so a background block-load racing a "play"/"sort" never makes the
  // caller think loading is finished — it awaits the real completion.
  function loadBlock(offset) {
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const r = await load(offset, pageSize);
        const got = r?.tracks || [];
        total = r?.total ?? offset + got.length;
        // offset 0 replaces (fresh load); a later offset appends its block.
        items = offset === 0 ? got : [...items, ...got];
        store();
      } catch {
        if (total == null) total = items.length; // stop trying; keep what we have
      }
    })().finally(() => (inflight = null));
    return inflight;
  }

  // Load every remaining block. Re-entrant-safe: a single chain runs to
  // completion and is shared by concurrent callers (sort + play at once).
  let allPromise = null;
  function ensureAll() {
    if (allLoaded) return Promise.resolve();
    if (!allPromise) {
      allPromise = (async () => {
        let stalls = 0;
        while (!(total != null && items.length >= total)) {
          const before = items.length;
          await loadBlock(items.length);
          // A shared in-flight load may have targeted a different offset; only
          // treat repeated no-progress as a real dead end.
          if (items.length === before) {
            if (++stalls > 3) break;
          } else {
            stalls = 0;
          }
        }
      })().finally(() => (allPromise = null));
    }
    return allPromise;
  }

  async function revalidate() {
    try {
      const r = await load(0, pageSize);
      if ((r?.total ?? null) !== total) {
        // Membership changed since we cached — rebuild from the fresh first
        // block (further blocks reload lazily on scroll / play).
        items = r?.tracks || [];
        total = r?.total ?? items.length;
        store();
      }
    } catch {
      /* offline: keep the cached copy */
    }
  }

  function onNearEnd() {
    if (!loading && !allLoaded) loadBlock(items.length);
  }
  function onNeedAll() {
    ensureAll();
  }
  // A row started playing from the loaded block: extend the queue to the whole
  // list once it's all here, without interrupting the track that's playing.
  function onPlayed() {
    ensureAll().then(() => player.fillQueue(items, context));
  }

  // -- imperative API for the parent's header buttons ----------------------
  export function playAll() {
    if (!items.length) return;
    player.playQueue(items, 0, context); // instant start on the loaded block
    ensureAll().then(() => player.fillQueue(items, context));
  }
  export function shufflePlay() {
    // Shuffle only means something over the whole list, so wait for it — fast,
    // and by revisit the cache makes it instant.
    ensureAll().then(() => player.shufflePlay(items, context));
  }
  export function refresh() {
    if (cacheKey) _cache.delete(cacheKey);
    items = [];
    total = null;
    loadBlock(0);
  }
  export function currentTracks() {
    return items;
  }
</script>

<TrackBrowser
  tracks={items}
  {context}
  {numbered}
  {showAlbum}
  {showCover}
  {downloadable}
  hasMore={!allLoaded}
  {onNearEnd}
  {onNeedAll}
  {onPlayed}
/>
