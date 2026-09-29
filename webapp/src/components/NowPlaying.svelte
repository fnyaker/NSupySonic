<script>
  import { push } from "svelte-spa-router";
  import { slide } from "svelte/transition";
  import {
    player,
    current,
    favorites,
    nowPlayingOpen,
  } from "../lib/stores.js";
  import { toggleFavorite } from "../lib/actions.js";
  import Cover from "./Cover.svelte";
  import Lyrics from "./Lyrics.svelte";
  import Icon from "./Icon.svelte";
  import ArtistLine from "./ArtistLine.svelte";
  import QueueList from "./QueueList.svelte";

  let tab = "queue"; // queue | lyrics

  $: fav = $current && $favorites.has(String($current.deezer_id));
  $: queue = $player.queue;
  $: idx = $player.index;

  function go(path) {
    push(path);
  }
</script>

<aside class="np" transition:slide={{ axis: "x", duration: 200 }}>
  <header class="np-head">
    <span class="title">En lecture</span>
    <button class="close" on:click={() => nowPlayingOpen.set(false)} aria-label="Fermer"><Icon name="close" size={18} /></button>
  </header>

  {#if $current}
    <div class="art">
      <Cover src={$current.album?.cover} alt={$current.title} kind={$current.podcast ? "podcast" : "album"} fallbackId={$current.deezer_id} eager />
    </div>
    <div class="meta">
      <div class="info">
        <button class="t" on:click={() => $current.album && go("/album/" + $current.album.deezer_id)}>
          {$current.title}
        </button>
        <span class="a muted"><ArtistLine track={$current} navigate={go} /></span>
      </div>
      <button class="fav" class:on={fav} on:click={() => toggleFavorite($current)} aria-label="Favori">
        <Icon name={fav ? "heartFilled" : "heart"} size={20} />
      </button>
    </div>

    <div class="tabs">
      <button class:active={tab === "queue"} on:click={() => (tab = "queue")}>File d'attente</button>
      <button class:active={tab === "lyrics"} on:click={() => (tab = "lyrics")}>Paroles</button>
    </div>

    <div class="body">
      {#if tab === "queue"}
        <div class="queue">
          <QueueList items={queue} {idx} showDuration />
        </div>
      {:else}
        <Lyrics />
      {/if}
    </div>
  {:else}
    <p class="muted empty">Aucune lecture en cours.</p>
  {/if}
</aside>

<style>
  .np {
    background: var(--bg-elev);
    border-left: 1px solid var(--bg-hover);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    height: 100%;
  }
  /* Narrow desktop: float over the content instead of taking a column. */
  @media (max-width: 1024px) {
    .np {
      position: fixed;
      inset: 0;
      bottom: var(--player-h);
      z-index: 110;
      border-left: none;
    }
  }
  /* Phone: clear the mini player instead of the full desktop player bar. */
  @media (max-width: 640px) {
    .np {
      bottom: 60px;
    }
  }
  .np-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 18px 8px;
  }
  .np-head .title {
    font-weight: 700;
  }
  .close {
    color: var(--text-dim);
    font-size: 1rem;
  }
  .close:hover {
    color: var(--text);
  }
  .art {
    padding: 8px 18px;
  }
  .meta {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 4px 18px 12px;
  }
  .info {
    min-width: 0;
    flex: 1;
    display: flex;
    flex-direction: column;
  }
  .t {
    font-weight: 800;
    font-size: 1.15rem;
    text-align: left;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .t:hover {
    text-decoration: underline;
  }
  /* `display: block` is load-bearing: this used to be a <button> and now wraps
     one button per credited artist (each with its own hover), and ellipsis
     doesn't apply to an inline. */
  .a {
    display: block;
    text-align: left;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .fav {
    color: var(--text-dim);
    font-size: 1.3rem;
  }
  .fav.on {
    color: var(--accent-2);
  }
  .tabs {
    display: flex;
    gap: 6px;
    padding: 0 14px;
  }
  .tabs button {
    padding: 7px 12px;
    border-radius: 999px;
    color: var(--text-dim);
    font-weight: 600;
    font-size: 0.85rem;
  }
  .tabs button.active {
    background: var(--bg-hover);
    color: var(--text);
  }
  .body {
    flex: 1;
    overflow-y: auto;
    padding: 10px 14px 18px;
  }
  .queue {
    margin: 0;
    padding: 0;
    --ql-dim: var(--text-dim);
    --ql-hover: var(--bg-hover);
    --ql-bg: var(--bg-elev);
    --ql-ghost: var(--bg-hover);
    color: var(--text);
  }
  .empty {
    padding: 24px 18px;
  }
</style>
