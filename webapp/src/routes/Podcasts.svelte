<script>
  import { push } from "svelte-spa-router";
  import { onMount } from "svelte";
  import { api } from "../lib/api.js";
  import { isAdmin, toasts } from "../lib/stores.js";
  import Cover from "../components/Cover.svelte";
  import Skeleton from "../components/Skeleton.svelte";
  import Icon from "../components/Icon.svelte";

  let channels = [];
  let loading = true;
  let url = "";
  let busy = false;

  onMount(load);

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

  async function subscribe() {
    const value = url.trim();
    if (!value || busy) return;
    busy = true;
    try {
      const c = await api.subscribePodcast(value);
      url = "";
      toasts.push("Podcast ajouté");
      if (c?.id) push("/podcast/" + c.id);
      else await load();
    } catch (e) {
      toasts.push(e?.message || "Échec de l'ajout", "error");
    } finally {
      busy = false;
    }
  }
</script>

<div class="fade-in">
  <div class="head">
    <h1><Icon name="mic" size={26} /> Podcasts</h1>
  </div>

  {#if $isAdmin}
    <form class="add" on:submit|preventDefault={subscribe}>
      <input
        placeholder="Coller une URL de podcast Deezer (deezer.com/show/…)"
        bind:value={url}
      />
      <button class="pill" disabled={busy || !url.trim()}>
        <Icon name="plus" size={18} /> Ajouter
      </button>
    </form>
  {/if}

  {#if loading}
    <Skeleton kind="list" />
  {:else if !channels.length}
    <p class="muted empty">
      Aucun podcast pour l'instant.{#if $isAdmin} Ajoutez-en un avec une URL Deezer ci-dessus.{/if}
    </p>
  {:else}
    <div class="grid">
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
  .add {
    display: flex;
    gap: 10px;
    margin-bottom: 22px;
  }
  .add input {
    flex: 1;
    padding: 11px 14px;
    border-radius: var(--radius);
    border: 1px solid transparent;
    background: var(--bg-card);
    color: var(--text);
    outline: none;
  }
  .add input:focus {
    border-color: var(--accent);
  }
  .pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    white-space: nowrap;
  }
  .empty {
    margin-top: 40px;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
    gap: 16px;
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
