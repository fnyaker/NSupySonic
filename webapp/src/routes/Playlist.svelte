<script>
  import { push } from "svelte-spa-router";
  import { api } from "../lib/api.js";
  import { player, isAdmin, toasts } from "../lib/stores.js";
  import { toggleEntityFavorite, invalidatePlaylists, downloadTracks } from "../lib/actions.js";
  import { duration as fmtDuration } from "../lib/format.js";
  import Cover from "../components/Cover.svelte";
  import TrackBrowser from "../components/TrackBrowser.svelte";
  import PlaylistTracks from "../components/PlaylistTracks.svelte";
  import AddTracksSheet from "../components/AddTracksSheet.svelte";
  import GradientHeader from "../components/GradientHeader.svelte";
  import Skeleton from "../components/Skeleton.svelte";
  import Icon from "../components/Icon.svelte";

  export let params = {};

  let id = null;
  let data = null;
  let fav = false;
  let loading = true;

  let editing = false; // mobile "Modifier" mode (drag handles + remove always on)
  let editingMeta = false; // header rename/description inputs open
  let showAdd = false; // AddTracksSheet open
  let draftTitle = "";
  let draftDesc = "";

  $: if (params.id && params.id !== id) {
    id = params.id;
    load(id);
  }

  $: editable = !!data?.playlist?.editable && $isAdmin;
  $: existingIds = new Set((data?.tracks || []).map((t) => String(t.deezer_id)));

  async function load(plId) {
    loading = true;
    data = null;
    editing = false;
    editingMeta = false;
    showAdd = false;
    try {
      data = await api.playlist(plId);
      fav = !!data.playlist?.is_favorite;
    } catch {
      data = null;
    }
    loading = false;
  }

  function playAll() {
    if (data?.tracks?.length) player.playQueue(data.tracks, 0, { kind: "playlist", id });
  }
  let dlBusy = false;
  async function downloadAll() {
    if (dlBusy || !data?.tracks?.length) return;
    dlBusy = true;
    try {
      await downloadTracks(data.tracks);
    } finally {
      dlBusy = false;
    }
  }
  function shufflePlay() {
    if (data?.tracks?.length) player.shufflePlay(data.tracks, { kind: "playlist", id });
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

  async function reorder(newTracks) {
    data.tracks = newTracks;
    data = data;
    try {
      await api.reorderPlaylist(id, newTracks.map((t) => String(t.deezer_id)));
    } catch {
      toasts.push("Échec du réordonnancement", "error");
    }
  }

  async function removeAt(index) {
    const removed = data.tracks[index];
    data.tracks = data.tracks.filter((_, i) => i !== index);
    data = data;
    try {
      await api.removePlaylistIndexes(id, [index]);
    } catch {
      // rollback
      data.tracks = [...data.tracks.slice(0, index), removed, ...data.tracks.slice(index)];
      data = data;
      toasts.push("Échec de la suppression", "error");
    }
  }

  function onAdded(track) {
    data.tracks = [...data.tracks, track];
    data = data;
    invalidatePlaylists();
  }

  async function deletePlaylist() {
    if (!window.confirm(`Supprimer la playlist « ${data.playlist.title} » ?`)) return;
    try {
      await api.deletePlaylist(id);
      invalidatePlaylists();
      toasts.push("Playlist supprimée");
      push("/library");
    } catch {
      toasts.push("Échec de la suppression", "error");
    }
  }

  $: total = (data?.tracks || []).reduce((s, t) => s + (t.duration || 0), 0);
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
            {data.playlist.owner ? data.playlist.owner + " · " : ""}{data.tracks.length} titres · {fmtDuration(total)}
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
        <!-- Mobile-only edit toggle (dedicated edit mode) -->
        <button class="edit-toggle" class:on={editing} on:click={() => (editing = !editing)}>
          {editing ? "Terminé" : "Modifier"}
        </button>
      {:else if $isAdmin}
        <button class="icon-btn" class:on={fav} on:click={toggleFav} aria-label="Favori"><Icon name={fav ? "heartFilled" : "heart"} size={22} /></button>
      {/if}
    </div>

    {#if editable}
      <PlaylistTracks
        tracks={data.tracks}
        context={{ kind: "playlist", id }}
        {editing}
        onreorder={reorder}
        onremove={removeAt}
      />
    {:else}
      <TrackBrowser tracks={data.tracks} context={{ kind: "playlist", id }} />
    {/if}
  </div>

  {#if showAdd}
    <AddTracksSheet
      playlistId={id}
      {existingIds}
      onadd={onAdded}
      onclose={() => (showAdd = false)}
    />
  {/if}
{/if}

<style>
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
  .edit-toggle {
    display: none;
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
  @media (max-width: 640px) {
    .art {
      width: 150px;
    }
    /* The dedicated edit mode is the primary mobile editing affordance. */
    .edit-toggle {
      display: inline-flex;
      align-items: center;
    }
  }
</style>
