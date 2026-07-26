<script>
  import { push } from "svelte-spa-router";
  import { openMenu } from "../lib/stores.js";
  import { playEntity, buildEntityMenu } from "../lib/actions.js";
  import Cover from "./Cover.svelte";
  import { isLocalId } from "../lib/format.js";
  import Icon from "./Icon.svelte";

  // item: {deezer_id, title|name, cover|picture}, kind: album|artist|playlist|mix
  export let item;
  export let kind = "album";

  $: title = item.title || item.name || "";
  $: image = item.cover || item.picture || null;
  $: subtitle =
    item.subtitle ||
    (kind === "album"
      ? item.artist?.name || item.year || ""
      : kind === "artist"
        ? "Artiste"
        : kind === "mix"
          ? "Mix"
          : item.owner || "Playlist");

  // User playlists are addressed by their UUID (`id`); recommendation cards only
  // have a Deezer numeric id.
  $: routeId = item.id || item.deezer_id;

  function open() {
    push((kind === "mix" ? "/mix/" : "/" + kind + "/") + routeId);
  }
  function play(e) {
    e.stopPropagation();
    playEntity(kind, routeId);
  }
  function menu(e) {
    openMenu(e, buildEntityMenu(kind, item, push));
  }
</script>

<div
  class="card"
  on:click={open}
  on:contextmenu={menu}
  on:keydown={(e) => e.key === "Enter" && open()}
  role="button"
  tabindex="0"
  title={title}
>
  <div class="cv">
    <Cover src={image} alt={title} {kind} round={kind === "artist"} fallbackId={isLocalId(item.id) ? item.id : null} />
    <button class="play" on:click={play} aria-label="Lire"><Icon name="play" size={18} /></button>
  </div>
  <div class="meta">
    <div class="title">{title}</div>
    {#if subtitle}<div class="sub muted">{subtitle}</div>{/if}
  </div>
</div>

<style>
  .card {
    display: block;
    text-align: left;
    padding: 12px;
    border-radius: var(--radius);
    background: var(--bg-card);
    transition: background 0.12s ease;
    width: 100%;
    cursor: pointer;
    /* Skip rendering off-screen cards, but with `auto` on the placeholder size:
       the browser then REMEMBERS each card's last rendered height instead of
       assuming a flat 220px. The fixed guess was wrong for every grid whose
       columns are wider than a shelf card, so cards entering and leaving the
       viewport kept resizing the page under the scrollbar. */
    content-visibility: auto;
    contain-intrinsic-size: 232px; /* fallback: engines without the `auto` keyword */
    contain-intrinsic-size: auto 232px;
  }
  .card:hover {
    background: var(--bg-hover);
  }
  .cv {
    position: relative;
  }
  .play {
    position: absolute;
    right: 8px;
    bottom: 8px;
    width: 44px;
    height: 44px;
    border-radius: 50%;
    background: linear-gradient(90deg, var(--accent), var(--accent-2));
    color: #fff;
    display: grid;
    place-items: center;
    font-size: 1.1rem;
    box-shadow: 0 8px 20px rgba(0, 0, 0, 0.4);
    opacity: 0;
    transform: translateY(8px);
  }
  .card:hover .play {
    opacity: 1;
    transform: none;
  }
  .play:hover {
    transform: scale(1.07);
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
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    margin-top: 2px;
  }
</style>
