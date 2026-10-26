<script>
  // The search's best result: the one artist (or show) the query plainly
  // names, large, with what it is said in a small label and its own play
  // button — the "Top result" card Spotify and YouTube Music both open their
  // results on. Which result earns the place is lib/searchrank.js's call.
  import { push } from "svelte-spa-router";
  import { openMenu } from "../lib/stores.js";
  import { playEntity, buildEntityMenu, subscribeToPodcast } from "../lib/actions.js";
  import { entityRef } from "../lib/entity.js";
  import { isLocalId } from "../lib/format.js";
  import Cover from "./Cover.svelte";
  import Icon from "./Icon.svelte";

  export let kind = "artist"; // artist | podcast
  export let item;

  let busy = false;

  $: title = item.name || item.title || "";
  $: image = item.picture || item.cover || null;
  $: ref = entityRef(item);

  async function open() {
    if (kind === "artist") return push("/artist/" + ref);
    if (busy) return;
    busy = true;
    try {
      const c = await subscribeToPodcast(item.deezer_id);
      if (c?.id) push("/podcast/" + c.id);
    } finally {
      busy = false;
    }
  }
  function play(e) {
    e.stopPropagation();
    if (kind === "artist") playEntity("artist", ref);
    else open();
  }
  function menu(e) {
    if (kind === "artist") openMenu(e, buildEntityMenu("artist", item, push));
  }
</script>

<div
  class="top"
  role="button"
  tabindex="0"
  title={title}
  on:click={open}
  on:contextmenu={menu}
  on:keydown={(e) => e.key === "Enter" && open()}
>
  <div class="art" class:round={kind === "artist"}>
    <Cover src={image} alt={title} {kind} round={kind === "artist"} fallbackId={isLocalId(item.id) ? item.id : null} />
  </div>
  <div class="text">
    <div class="name">{title}</div>
    <span class="label">{kind === "artist" ? "Artiste" : "Podcast"}</span>
  </div>
  <button
    class="play"
    class:spin={busy}
    on:click={play}
    disabled={busy}
    aria-label={kind === "artist" ? "Lire" : "S'abonner"}
  >
    <Icon name={kind === "artist" ? "play" : busy ? "refresh" : "plus"} size={22} />
  </button>
</div>

<style>
  .top {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 10px;
    padding: 20px;
    border-radius: var(--radius);
    background: var(--bg-card);
    cursor: pointer;
    transition: background 0.15s ease;
    min-width: 0;
  }
  .top:hover {
    background: var(--bg-hover);
  }
  .art {
    width: 104px;
    height: 104px;
    border-radius: 10px;
    overflow: hidden;
    box-shadow: 0 10px 28px rgba(0, 0, 0, 0.35);
  }
  .art.round {
    border-radius: 50%;
  }
  .text {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 10px;
    min-width: 0;
    max-width: 100%;
    padding-right: 64px;
  }
  .name {
    max-width: 100%;
    margin-top: 6px;
    font-size: 1.85rem;
    font-weight: 800;
    letter-spacing: -0.02em;
    line-height: 1.15;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .label {
    padding: 3px 10px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--text) 10%, transparent);
    color: var(--text);
    font-size: 0.76rem;
    font-weight: 700;
    letter-spacing: 0.02em;
  }
  .play {
    position: absolute;
    right: 18px;
    bottom: 18px;
    width: 52px;
    height: 52px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    background: linear-gradient(90deg, var(--accent), var(--accent-2));
    color: #fff;
    box-shadow: 0 8px 20px rgba(0, 0, 0, 0.4);
    transition: transform 0.15s ease;
  }
  .play:hover {
    transform: scale(1.05);
  }
  /* A phone: the card is the row it sits in, not a poster. */
  @media (max-width: 640px) {
    .top {
      flex-direction: row;
      align-items: center;
      gap: 14px;
      padding: 12px;
    }
    .art {
      width: 64px;
      height: 64px;
      flex: none;
    }
    .text {
      flex: 1 1 0;
      gap: 6px;
      padding-right: 0;
    }
    .name {
      margin: 0;
      font-size: 1.25rem;
    }
    .play {
      position: static;
      flex: none;
      width: 46px;
      height: 46px;
    }
  }
</style>
