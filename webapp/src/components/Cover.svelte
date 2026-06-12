<script>
  import { afterUpdate } from "svelte";
  import Icon from "./Icon.svelte";
  export let src = null;
  export let alt = "";
  export let round = false;
  export let size = null; // optional fixed px size

  let loaded = false;
  let img;
  // Reset the fade when the source changes (e.g. recycled rows in a long list).
  $: src, (loaded = false);
  // …but if the new image is already cached, mark it loaded before the browser
  // paints, so swapping to an already-seen cover doesn't flash (no re-fade).
  afterUpdate(() => {
    if (!loaded && img && img.complete && img.naturalWidth > 0) loaded = true;
  });
</script>

<div
  class="cover"
  class:round
  style={size ? `width:${size}px;height:${size}px` : ""}
>
  {#if src}
    <img
      bind:this={img}
      {src}
      {alt}
      loading="lazy"
      decoding="async"
      class:loaded
      on:load={() => (loaded = true)}
      on:error={() => (loaded = true)}
    />
  {:else}
    <div class="ph"><Icon name="music" size={28} /></div>
  {/if}
</div>

<style>
  .cover {
    aspect-ratio: 1 / 1;
    width: 100%;
    border-radius: var(--radius);
    overflow: hidden;
    background: var(--bg-hover);
  }
  .cover.round {
    border-radius: 50%;
  }
  img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    opacity: 0;
    transition: opacity 0.35s ease;
  }
  img.loaded {
    opacity: 1;
  }
  .ph {
    width: 100%;
    height: 100%;
    display: grid;
    place-items: center;
    font-size: 2rem;
    color: var(--text-dim);
  }
</style>
