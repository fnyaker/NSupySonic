<script>
  // One artist as a round portrait and a name, nothing else: the home's
  // "Tes artistes" row and the library's artist grid. The whole tile is the
  // target (a 44 px minimum is the platforms' rule; this is 96+).
  import { push } from "svelte-spa-router";
  import { openMenu } from "../lib/stores.js";
  import { buildEntityMenu } from "../lib/actions.js";
  import { entityRef } from "../lib/entity.js";
  import Cover from "./Cover.svelte";

  export let artist;
  // An optional second line ("12 titres"); the name alone says enough on the home.
  export let detail = "";

  $: ref = entityRef(artist);
  function open() {
    if (ref) push("/artist/" + ref);
  }
  function menu(e) {
    openMenu(e, buildEntityMenu("artist", artist, push));
  }
</script>

<button class="tile" on:click={open} on:contextmenu={menu} title={artist.name}>
  <span class="pic"><Cover src={artist.picture} alt={artist.name} kind="artist" round /></span>
  <span class="name">{artist.name}</span>
  {#if detail}<span class="detail muted">{detail}</span>{/if}
</button>

<style>
  .tile {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 10px 6px 12px;
    border-radius: var(--radius);
    text-align: center;
    color: var(--text);
    transition: background 0.12s ease;
    content-visibility: auto;
    contain-intrinsic-size: auto 170px;
  }
  .tile:hover,
  .tile:focus-visible {
    background: var(--bg-hover);
  }
  .pic {
    display: block;
    width: 100%;
    aspect-ratio: 1;
    border-radius: 50%;
    overflow: hidden;
  }
  .name {
    max-width: 100%;
    font-weight: 600;
    font-size: 0.92rem;
    line-height: 1.25;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .detail {
    margin-top: -4px;
    font-size: 0.8rem;
  }
</style>
