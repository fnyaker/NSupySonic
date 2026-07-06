<script>
  import { onDestroy } from "svelte";
  import { push } from "svelte-spa-router";
  import { api } from "../lib/api.js";
  import { player, isAdmin, toasts, lastPlaylist } from "../lib/stores.js";
  import { toggleEntityFavorite, invalidatePlaylists, downloadTracks } from "../lib/actions.js";
  import { duration as fmtDuration } from "../lib/format.js";
  import Cover from "../components/Cover.svelte";
  import TrackList from "../components/TrackList.svelte";
  import PagedTrackBrowser from "../components/PagedTrackBrowser.svelte";
  import PlaylistTracks from "../components/PlaylistTracks.svelte";
  import AddTracksSheet from "../components/AddTracksSheet.svelte";
  import GradientHeader from "../components/GradientHeader.svelte";
  import Skeleton from "../components/Skeleton.svelte";
  import Icon from "../components/Icon.svelte";

  export let params = {};

  const PAGE = 100; // progressive-loading block size

  let id = null;
  let data = null; // { playlist, tracks, total }
  let fav = false;
  let loading = true;
  let fullLoading = false; // editable playlist: fetching the remaining blocks
  let roPager = null; // read-only PagedTrackBrowser instance

  let editing = false; // mobile "Modifier" mode (drag handles + remove always on)
  let editingMeta = false; // header rename/description inputs open
  let showAdd = false; // AddTracksSheet open
  let draftTitle = "";
  let draftDesc = "";

  // View sort/search for editable playlists (like the favorites browser). A
  // non-default sort or a search shows a read-only, sorted projection; the
  // reorderable manual view is "Ordre d'origine" with no search.
  let plSort = "default";
  let plQuery = "";
  let plDir = 1;
  const PL_SORTS = [
    { key: "default", label: "Ordre d'origine" },
    { key: "title", label: "Titre" },
    { key: "artist", label: "Artiste" },
    { key: "album", label: "Album" },
    { key: "duration", label: "Durée" },
    { key: "added", label: "Date d'ajout" },
  ];
  const _lc = (s) => (s || "").toLowerCase();
  $: manualView = plSort === "default" && !plQuery.trim();
  $: sortedTracks = projectTracks(data?.tracks || [], plSort, plDir, plQuery);
  function projectTracks(list, sort, dir, query) {
    const q = _lc(query.trim());
    if (q)
      list = list.filter(
        (t) => _lc(t.title).includes(q) || _lc(t.artist?.name).includes(q) || _lc(t.album?.title).includes(q)
      );
    if (sort !== "default") {
      const key = {
        title: (t) => _lc(t.title),
        artist: (t) => _lc(t.artist?.name),
        album: (t) => _lc(t.album?.title),
        duration: (t) => t.duration || 0,
        added: (t) => t.added || 0,
      }[sort];
      list = [...list].sort((a, b) => {
        const ka = key(a), kb = key(b);
        return ka < kb ? -dir : ka > kb ? dir : 0;
      });
    } else if (dir === -1) {
      list = [...list].reverse();
    }
    return list;
  }

  $: if (params.id && params.id !== id) {
    id = params.id;
    load(id);
  }

  $: editable = !!data?.playlist?.editable && $isAdmin;
  $: allLoaded = !!data && data.tracks.length >= (data.total ?? data.tracks.length);
  // Leaving the manual order (a sort/search) can't coexist with drag-edit mode.
  $: if ((!manualView || fullLoading) && editing) editing = false;
  $: existingIds = new Set((data?.tracks || []).map((t) => String(t.deezer_id)));
  const roLoad = (offset, limit) => api.playlist(id, { offset, limit });

  // Sequence guard: a delayed earlier response must not overwrite the page
  // after a quick navigation to another playlist.
  let loadSeq = 0;
  async function load(plId) {
    const mine = ++loadSeq;
    queueOrder(); // save any pending reorder of the playlist we're leaving
    loading = true;
    data = null;
    editing = false;
    editingMeta = false;
    showAdd = false;
    fullLoading = false;
    plSort = "default";
    plQuery = "";
    plDir = 1;
    try {
      // First block only: fast first paint. It also tells us total + editability.
      const r = await api.playlist(plId, { offset: 0, limit: PAGE });
      if (mine !== loadSeq) return;
      data = r;
      fav = !!r.playlist?.is_favorite;
      loading = false;
      // Editable playlists need EVERY track for index-correct reorder/remove:
      // load the remaining blocks in the background, then swap in the full list.
      if (r.playlist?.editable && $isAdmin && (r.total ?? 0) > (r.tracks?.length ?? 0)) {
        fullLoading = true;
        try {
          const full = await api.playlist(plId); // no limit -> all tracks
          if (mine === loadSeq) data = { ...data, tracks: full.tracks };
        } finally {
          if (mine === loadSeq) fullLoading = false;
        }
      }
    } catch {
      if (mine === loadSeq) {
        data = null;
        loading = false;
      }
    }
  }

  const ctx = () => ({ kind: "playlist", id });
  function playAll() {
    if (editable) {
      if (data?.tracks?.length) player.playQueue(data.tracks, 0, ctx());
    } else roPager?.playAll();
  }
  function shufflePlay() {
    if (editable) {
      if (data?.tracks?.length) player.shufflePlay(data.tracks, ctx());
    } else roPager?.shufflePlay();
  }
  let dlBusy = false;
  async function downloadAll() {
    if (dlBusy) return;
    dlBusy = true;
    try {
      let tracks = data?.tracks || [];
      // Read-only playlist not fully loaded yet: fetch every track to download.
      if (!editable && !allLoaded) {
        try {
          tracks = (await api.playlist(id)).tracks || tracks;
        } catch {
          /* fall back to what's loaded */
        }
      }
      if (tracks.length) await downloadTracks(tracks);
    } finally {
      dlBusy = false;
    }
  }

  async function toggleFav() {
    const next = !fav;
    if (await toggleEntityFavorite("playlist", id, next)) fav = next;
  }

  // -- editing -------------------------------------------------------------

  function openMeta() {
    draftTitle = data.playlist.title;
    draftDesc = data.playlist.description || "";
    editingMeta = true;
  }

  async function saveMeta() {
    const title = draftTitle.trim();
    if (!title) return;
    editingMeta = false;
    data.playlist.title = title;
    data.playlist.description = draftDesc.trim();
    data = data;
    try {
      await api.editPlaylist(id, { title, description: draftDesc.trim() });
      invalidatePlaylists();
    } catch {
      toasts.push("Échec de l'enregistrement", "error");
    }
  }

  // -- edits: instant UI, serialized background saves -----------------------
  // Every mutation updates the page IMMEDIATELY; the matching API call is
  // pushed onto a FIFO chain, so at most one request is in flight and the
  // server applies operations in exactly the order the user made them (an
  // index-based remove racing a reorder would corrupt the playlist). Reorders
  // are coalesced: a burst of drags / up-down taps collapses into ONE PUT of
  // the latest order. The user never waits — worst case a save fails and the
  // list silently resyncs from the server.
  let chain = Promise.resolve();
  function enqueue(op) {
    chain = chain.then(op, op);
  }

  // Resync from the server after a failed save (source of truth) — without
  // resetting the edit-mode/scroll state the way a full load() would.
  async function resync(plId) {
    try {
      const r = await api.playlist(plId);
      if (r?.playlist && plId === id) {
        data = r;
        fav = !!r.playlist.is_favorite;
      }
    } catch {
      /* offline: the optimistic state stays; next load will settle it */
    }
  }

  let orderTimer = null;
  let pendingOrder = null;
  let orderQueued = false;
  function reorder(newTracks) {
    data.tracks = newTracks;
    data = data;
    // Capture the playlist id with the order: a quick navigation to another
    // playlist swaps `id` before the debounce fires.
    pendingOrder = { plId: id, order: newTracks.map((t) => String(t.deezer_id)) };
    clearTimeout(orderTimer);
    orderTimer = setTimeout(queueOrder, 400);
  }
  function queueOrder() {
    clearTimeout(orderTimer);
    orderTimer = null;
    if (!pendingOrder || orderQueued) return; // the queued op sends the latest
    orderQueued = true;
    enqueue(async () => {
      orderQueued = false;
      if (!pendingOrder) return;
      const { plId, order } = pendingOrder;
      pendingOrder = null;
      try {
        await api.reorderPlaylist(plId, order);
      } catch {
        toasts.push("Échec du réordonnancement", "error");
        await resync(plId);
      }
    });
  }
  onDestroy(queueOrder);

  function removeAt(index) {
    const plId = id;
    data.tracks = data.tracks.filter((_, i) => i !== index);
    data = data;
    // Any pending reorder is queued FIRST: the server resolves the remove
    // index against its own order, which must match what the user saw.
    queueOrder();
    enqueue(async () => {
      try {
        await api.removePlaylistIndexes(plId, [index]);
        invalidatePlaylists(); // sidebar/menu track counts
      } catch {
        toasts.push("Échec de la suppression", "error");
        await resync(plId);
      }
    });
  }

  function onAdded(track) {
    const plId = id;
    data.tracks = [...data.tracks, track];
    data = data;
    enqueue(async () => {
      try {
        await api.addToPlaylist(plId, [String(track.deezer_id)]);
        invalidatePlaylists();
      } catch {
        toasts.push(`Échec de l'ajout de « ${track.title} »`, "error");
        await resync(plId);
      }
    });
  }

  async function deletePlaylist() {
    if (!window.confirm(`Supprimer la playlist « ${data.playlist.title} » ?`)) return;
    try {
      await api.deletePlaylist(id);
      invalidatePlaylists();
      // Drop the "add to last playlist" shortcut if it pointed here.
      if ($lastPlaylist?.id === id) lastPlaylist.set(null);
      toasts.push("Playlist supprimée");
      push("/library");
    } catch {
      toasts.push("Échec de la suppression", "error");
    }
  }

  // Duration of the loaded tracks; only meaningful (shown) once every block is
  // in, since a partial list would under-report it.
  $: durLoaded = (data?.tracks || []).reduce((s, t) => s + (t.duration || 0), 0);
  $: countLabel = data ? (data.total ?? data.tracks.length) : 0;
</script>

{#if loading}
  <Skeleton kind="header" />
  <Skeleton kind="list" />
{:else if !data?.playlist}
  <p class="muted">Playlist introuvable.</p>
{:else}
  <div class="fade-in">
    <GradientHeader cover={data.playlist.cover}>
      <div class="art"><Cover src={data.playlist.cover} alt={data.playlist.title} /></div>
      <div class="meta">
        <span class="kind">Playlist</span>
        {#if editingMeta}
          <input class="title-input" bind:value={draftTitle} placeholder="Nom de la playlist" />
          <textarea class="desc-input" bind:value={draftDesc} rows="2" placeholder="Description (optionnel)"></textarea>
          <div class="meta-actions">
            <button class="pill sm" on:click={saveMeta}><Icon name="check" size={16} /> Enregistrer</button>
            <button class="ghost sm" on:click={() => (editingMeta = false)}>Annuler</button>
          </div>
        {:else}
          <h1>{data.playlist.title}</h1>
          {#if data.playlist.description}<p class="desc muted">{data.playlist.description}</p>{/if}
          <span class="muted">
            {data.playlist.owner ? data.playlist.owner + " · " : ""}{countLabel} titres{allLoaded ? " · " + fmtDuration(durLoaded) : ""}
          </span>
        {/if}
      </div>
    </GradientHeader>

    <div class="row actions">
      <button class="pill" on:click={playAll}><Icon name="play" size={18} /> Lire</button>
      <button class="icon-btn" on:click={shufflePlay} aria-label="Lecture aléatoire"><Icon name="shuffle" size={22} /></button>
      <button class="icon-btn" on:click={downloadAll} disabled={dlBusy} aria-label="Télécharger la playlist" title="Télécharger sur l'appareil (hors-ligne)"><Icon name="download" size={22} /></button>

      {#if editable}
        <button class="icon-btn" on:click={() => (showAdd = true)} aria-label="Ajouter des titres" title="Ajouter des titres"><Icon name="plus" size={24} /></button>
        <button class="icon-btn" on:click={openMeta} aria-label="Renommer" title="Renommer / description"><Icon name="edit" size={20} /></button>
        <button class="icon-btn danger" on:click={deletePlaylist} aria-label="Supprimer la playlist" title="Supprimer la playlist"><Icon name="trash" size={20} /></button>
        <!-- Dedicated edit mode (drag + up/down + remove). Disabled until the
             whole playlist is loaded, so index-based reorder/remove is exact. -->
        <button
          class="edit-toggle"
          class:on={editing}
          disabled={fullLoading || !manualView}
          title={!manualView ? "Repassez en « Ordre d'origine » pour réorganiser" : (fullLoading ? "Chargement de la playlist…" : "")}
          on:click={() => (editing = !editing)}
        >
          {editing ? "Terminé" : "Modifier"}
        </button>
      {:else if $isAdmin}
        <button class="icon-btn" class:on={fav} on:click={toggleFav} aria-label="Favori"><Icon name={fav ? "heartFilled" : "heart"} size={22} /></button>
      {/if}
    </div>

    {#if editable}
      <!-- Sort/search toolbar (like the favorites browser). A non-default sort
           or a search switches to a read-only, sorted projection; reordering is
           only offered in the natural "Ordre d'origine". -->
      <div class="toolbar">
        <div class="searchbox">
          <Icon name="search" size={16} />
          <input placeholder="Rechercher dans la playlist…" bind:value={plQuery} />
        </div>
        <div class="spacer"></div>
        <select class="sortsel" bind:value={plSort} aria-label="Trier par">
          {#each PL_SORTS as s}<option value={s.key}>{s.label}</option>{/each}
        </select>
        <button class="tb" class:rev={plDir === -1} on:click={() => (plDir = -plDir)} aria-label="Inverser l'ordre" title="Inverser l'ordre">
          <Icon name="sort" size={17} />
        </button>
      </div>
      {#if fullLoading}
        <p class="muted loadhint"><Icon name="refresh" size={14} /> Chargement de la playlist complète…</p>
      {/if}
      {#if manualView}
        <PlaylistTracks
          tracks={data.tracks}
          context={{ kind: "playlist", id }}
          {editing}
          onreorder={reorder}
          onremove={removeAt}
        />
      {:else}
        {#if plQuery.trim() && !sortedTracks.length}
          <p class="muted loadhint">Aucun titre ne correspond à « {plQuery} ».</p>
        {:else}
          <TrackList tracks={sortedTracks} context={{ kind: "playlist", id }} numbered={true} />
        {/if}
      {/if}
    {:else}
      <!-- Keyed on id so navigating between two read-only playlists remounts
           the pager with the new playlist's seed block. -->
      {#key id}
        <PagedTrackBrowser
          bind:this={roPager}
          load={roLoad}
          seed={{ tracks: data.tracks, total: data.total }}
          context={{ kind: "playlist", id }}
        />
      {/key}
    {/if}
  </div>

  {#if showAdd}
    <AddTracksSheet
      {existingIds}
      onadd={onAdded}
      onclose={() => (showAdd = false)}
    />
  {/if}
{/if}

<style>
  /* Sort/search toolbar for the editable playlist view (mirrors TrackBrowser). */
  .toolbar {
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 6px 0 12px;
  }
  .searchbox {
    display: flex;
    align-items: center;
    gap: 8px;
    background: var(--bg-card);
    border: 1px solid transparent;
    border-radius: 999px;
    padding: 8px 14px;
    color: var(--text-dim);
    max-width: 340px;
    flex: 1;
  }
  .searchbox:focus-within {
    border-color: var(--accent);
    color: var(--text);
  }
  .searchbox input {
    border: none;
    background: none;
    outline: none;
    color: var(--text);
    width: 100%;
  }
  .toolbar .spacer {
    flex: 1;
  }
  .sortsel {
    background: var(--bg-card);
    color: var(--text);
    border: 1px solid var(--bg-hover);
    border-radius: 8px;
    padding: 8px 10px;
    outline: none;
    cursor: pointer;
  }
  .tb {
    display: grid;
    place-items: center;
    width: 38px;
    height: 38px;
    border-radius: 8px;
    background: var(--bg-card);
    color: var(--text-dim);
  }
  .tb:hover {
    color: var(--text);
    background: var(--bg-hover);
  }
  .tb.rev {
    color: var(--accent);
  }
  .loadhint {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 4px 0 12px;
    font-size: 0.85rem;
  }
  .art {
    width: 200px;
    flex: none;
    box-shadow: 0 16px 40px rgba(0, 0, 0, 0.5);
    border-radius: var(--radius);
    overflow: hidden;
  }
  .meta {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
    max-width: 60ch;
  }
  .kind {
    font-size: 0.8rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  h1 {
    font-size: clamp(1.8rem, 5vw, 3rem);
  }
  .desc {
    margin: 0;
  }
  .title-input {
    font-size: clamp(1.4rem, 4vw, 2.2rem);
    font-weight: 800;
    background: rgba(0, 0, 0, 0.25);
    border: 1px solid var(--bg-hover);
    border-radius: 8px;
    color: var(--text);
    padding: 6px 10px;
    outline: none;
  }
  .title-input:focus {
    border-color: var(--accent);
  }
  .desc-input {
    background: rgba(0, 0, 0, 0.25);
    border: 1px solid var(--bg-hover);
    border-radius: 8px;
    color: var(--text);
    padding: 8px 10px;
    outline: none;
    resize: vertical;
    font: inherit;
  }
  .desc-input:focus {
    border-color: var(--accent);
  }
  .meta-actions {
    display: flex;
    gap: 8px;
    margin-top: 2px;
  }
  .pill.sm,
  .ghost.sm {
    font-size: 0.85rem;
    padding: 6px 12px;
  }
  .ghost {
    color: var(--text-dim);
  }
  .ghost:hover {
    color: var(--text);
  }
  .actions {
    margin: 16px 0 18px;
    gap: 18px;
    flex-wrap: wrap;
  }
  .icon-btn {
    font-size: 1.4rem;
    color: var(--text-dim);
  }
  .icon-btn:hover {
    color: var(--text);
  }
  .icon-btn.on {
    color: var(--accent-2);
  }
  .icon-btn.danger:hover {
    color: var(--accent-2);
  }
  /* The dedicated edit mode (drag handles + up/down + remove) is available on
     every screen size — it used to be mobile-only, which made reordering
     nearly undiscoverable there and unavailable as a "big handles" mode here. */
  .edit-toggle {
    display: inline-flex;
    align-items: center;
    margin-left: auto;
    padding: 8px 16px;
    border-radius: 999px;
    border: 1px solid var(--bg-hover);
    color: var(--text);
    font-weight: 600;
  }
  .edit-toggle.on {
    background: var(--accent);
    color: #fff;
    border-color: transparent;
  }
  .edit-toggle:disabled {
    opacity: 0.4;
    cursor: default;
  }
  @media (max-width: 640px) {
    .art {
      width: 150px;
    }
  }
</style>
