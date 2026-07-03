<script>
  import { push } from "svelte-spa-router";
  import { onMount, onDestroy } from "svelte";
  import { api } from "../lib/api.js";
  import { isAdmin, toasts } from "../lib/stores.js";
  import { subscribeToPodcast } from "../lib/actions.js";
  import Cover from "../components/Cover.svelte";
  import PodcastCard from "../components/PodcastCard.svelte";
  import Skeleton from "../components/Skeleton.svelte";
  import Icon from "../components/Icon.svelte";

  let channels = [];
  let loading = true;

  // search
  let q = "";
  let searchResults = [];
  let searching = false;
  let timer;
  let seq = 0;

  onMount(load);
  onDestroy(() => clearTimeout(timer));

  async function load() {
    loading = true;
    try {
      const r = await api.podcasts();
      channels = r?.podcasts || [];
    } catch {
      channels = [];
    }
    loading = false;
  }

  function onInput() {
    clearTimeout(timer);
    const term = q.trim();
    if (!term) {
      searchResults = [];
      searching = false;
      return;
    }
    searching = true;
    timer = setTimeout(() => runSearch(term), 300);
  }

  async function runSearch(term) {
    const mine = ++seq;
    try {
      const r = await api.searchPodcasts(term);
      if (mine === seq) searchResults = r?.podcasts || [];
    } catch {
      if (mine === seq) searchResults = [];
    } finally {
      if (mine === seq) searching = false;
    }
  }

  // Allow pasting a direct Deezer show URL and pressing Enter to add it.
  async function onSubmit() {
    const term = q.trim();
    if (!term || !/deezer\.com\/.*(show|episode)\//.test(term)) return;
    try {
      const c = await api.subscribePodcast(term);
      toasts.push("Podcast ajouté");
      q = "";
      searchResults = [];
      if (c?.id) push("/podcast/" + c.id);
    } catch (e) {
      toasts.push(e?.message || "Échec de l'ajout", "error");
    }
  }
</script>

<div class="fade-in">
  <div class="head">
    <h1><Icon name="mic" size={26} /> Podcasts</h1>
  </div>

  {#if $isAdmin}
    <form class="search" on:submit|preventDefault={onSubmit}>
      <input
        placeholder="Rechercher un podcast (ou coller une URL Deezer)…"
        bind:value={q}
        on:input={onInput}
      />
    </form>

    {#if q.trim()}
      {#if searching}
        <Skeleton kind="list" />
      {:else if searchResults.length}
        <h2>Résultats</h2>
        <div class="grid">
          {#each searchResults as p (p.deezer_id)}
            <PodcastCard item={p} />
          {/each}
        </div>
      {:else}
        <p class="muted empty">Aucun podcast pour « {q} ».</p>
      {/if}
    {/if}
  {/if}

  <h2 class:hidden={$isAdmin && q.trim()}>Mes podcasts</h2>
  {#if loading}
    <Skeleton kind="list" />
  {:else if !channels.length}
    <p class="muted empty">
      Aucun abonnement pour l'instant.{#if $isAdmin} Cherchez un podcast ci-dessus pour vous abonner.{/if}
    </p>
  {:else}
    <div class="grid" class:hidden={$isAdmin && q.trim()}>
      {#each channels as c (c.id)}
        <div
          class="card"
          role="button"
          tabindex="0"
          title={c.title}
          on:click={() => push("/podcast/" + c.id)}
          on:keydown={(e) => e.key === "Enter" && push("/podcast/" + c.id)}
        >
          <Cover src={c.cover} alt={c.title} />
          <div class="meta">
            <div class="title">{c.title}</div>
            <div class="sub muted">
              {c.episode_count} épisode{c.episode_count > 1 ? "s" : ""}
            </div>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .head h1 {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: clamp(1.6rem, 4vw, 2.4rem);
    margin-bottom: 16px;
  }
  h2 {
    margin: 20px 0 12px;
  }
  h2.hidden {
    display: none;
  }
  .search {
    margin-bottom: 6px;
  }
  .search input {
    width: 100%;
    padding: 11px 14px;
    border-radius: var(--radius);
    border: 1px solid transparent;
    background: var(--bg-card);
    color: var(--text);
    outline: none;
  }
  .search input:focus {
    border-color: var(--accent);
  }
  .empty {
    margin-top: 20px;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
    gap: 16px;
  }
  .grid.hidden {
    display: none;
  }
  .card {
    padding: 12px;
    border-radius: var(--radius);
    background: var(--bg-card);
    cursor: pointer;
    transition: background 0.12s ease;
  }
  .card:hover {
    background: var(--bg-hover);
  }
  .meta {
    margin-top: 12px;
  }
  .title {
    font-weight: 700;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .sub {
    font-size: 0.85rem;
    margin-top: 2px;
  }
</style>
