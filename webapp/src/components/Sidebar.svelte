<script>
  import { onMount } from "svelte";
  import { link, push } from "svelte-spa-router";
  import { location } from "../lib/router.js";
  import { user, isAdmin, syncing } from "../lib/stores.js";
  import { api } from "../lib/api.js";
  import { userPlaylists, invalidatePlaylists, runDeezerSync } from "../lib/actions.js";
  import Icon from "./Icon.svelte";

  let q = "";
  let playlists = [];

  onMount(async () => {
    // Deezer playlists belong to the account owner — guests don't see them.
    if ($isAdmin) playlists = await userPlaylists();
  });

  function submitSearch(e) {
    e.preventDefault();
    const term = q.trim();
    if (term) push("/search/" + encodeURIComponent(term));
  }

  async function logout() {
    try {
      await api.logout();
    } catch {
      /* ignore */
    }
    user.set(null);
  }

  // Manual "refresh from Deezer" (shared action), then refresh the sidebar list.
  async function syncDeezer() {
    if (await runDeezerSync()) playlists = await userPlaylists(true);
  }

  async function newPlaylist() {
    const title = window.prompt("Nom de la playlist ?");
    if (!title || !title.trim()) return;
    try {
      const r = await api.createPlaylist(title.trim(), []);
      invalidatePlaylists();
      playlists = await userPlaylists(true);
      if (r.id) push("/playlist/" + r.id);
    } catch {
      /* ignore */
    }
  }

  $: active = (path) => ($location === path ? "active" : "");
</script>

<nav class="sidebar">
  <div class="brand"><span class="dot"></span> NSupySonic</div>

  <form class="search" on:submit={submitSearch}>
    <input placeholder="Rechercher…" bind:value={q} />
  </form>

  <ul class="nav">
    <li><a use:link href="/" class={active("/")}><Icon name="home" size={20} /> Accueil</a></li>
    <li><a use:link href="/search" class={active("/search")}><Icon name="search" size={20} /> Rechercher</a></li>
    <li><a use:link href="/library" class={active("/library")}><Icon name="library" size={20} /> Ma bibliothèque</a></li>
  </ul>

  {#if $isAdmin}
    <div class="pl-head">
      <span>Playlists</span>
      <div class="pl-actions">
        <button
          class="new"
          class:spin={$syncing}
          on:click={syncDeezer}
          disabled={$syncing}
          title="Synchroniser depuis Deezer"
          aria-label="Synchroniser depuis Deezer"
        >
          <Icon name="refresh" size={16} />
        </button>
        <button class="new" on:click={newPlaylist} aria-label="Nouvelle playlist"><Icon name="plus" size={18} /></button>
      </div>
    </div>
    <ul class="playlists">
      {#each playlists as p (p.id)}
        <li><a use:link href={"/playlist/" + p.id}>{p.title}</a></li>
      {/each}
    </ul>
  {:else}
    <div class="spacer"></div>
  {/if}

  <div class="account">
    <span class="who">{$user?.name}</span>
    <button class="logout" on:click={logout}>Déconnexion</button>
  </div>
</nav>

<style>
  .sidebar {
    background: var(--bg-elev);
    padding: 22px 14px;
    display: flex;
    flex-direction: column;
    gap: 14px;
    overflow: hidden;
    height: 100%;
  }
  @media (max-width: 640px) {
    .sidebar {
      display: none;
    }
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 8px;
    font-weight: 800;
    font-size: 1.15rem;
  }
  .dot {
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: linear-gradient(90deg, var(--accent), var(--accent-2));
  }
  .search input {
    width: 100%;
    padding: 10px 12px;
    border-radius: var(--radius);
    border: 1px solid transparent;
    background: var(--bg-card);
    color: var(--text);
    outline: none;
  }
  .search input:focus {
    border-color: var(--accent);
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .nav {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .nav a {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 9px 12px;
    border-radius: var(--radius);
    color: var(--text-dim);
    font-weight: 600;
  }
  .new {
    display: flex;
    align-items: center;
  }
  .pl-actions {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .new:disabled {
    opacity: 0.6;
    cursor: default;
  }
  .new.spin :global(svg) {
    animation: spin 1s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  .nav a:hover,
  .nav a.active {
    background: var(--bg-hover);
    color: var(--text);
  }
  .pl-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    color: var(--text-dim);
    font-size: 0.78rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    padding: 6px 6px 0;
    border-top: 1px solid var(--bg-hover);
    padding-top: 12px;
  }
  .new {
    color: var(--text-dim);
    font-size: 1.1rem;
  }
  .new:hover {
    color: var(--text);
  }
  .playlists {
    flex: 1;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
  }
  .spacer {
    flex: 1;
  }
  .playlists a {
    display: block;
    padding: 7px 10px;
    border-radius: 7px;
    color: var(--text-dim);
    font-size: 0.9rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .playlists a:hover {
    color: var(--text);
    background: var(--bg-hover);
  }
  .account {
    display: flex;
    flex-direction: column;
    gap: 4px;
    border-top: 1px solid var(--bg-hover);
    padding-top: 12px;
  }
  .who {
    font-weight: 700;
  }
  .logout {
    color: var(--text-dim);
    text-align: left;
  }
  .logout:hover {
    color: var(--text);
  }
</style>
