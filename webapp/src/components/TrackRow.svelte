<script>
  import { push } from "svelte-spa-router";
  import { player, currentId, playing, favorites, openMenu, downloads } from "../lib/stores.js";
  import { toggleFavorite, buildTrackMenu } from "../lib/actions.js";
  import { duration as fmtDuration } from "../lib/format.js";
  import Icon from "./Icon.svelte";
  import Cover from "./Cover.svelte";

  export let track;
  export let index = null; // optional track number
  export let onplay = null; // optional override: () => void
  export let showAlbum = true;
  export let showCover = true; // album thumbnail per row (off on album pages)

  $: isCurrent = $currentId === track.deezer_id;
  $: isPlaying = isCurrent && $playing;
  $: fav = $favorites.has(String(track.deezer_id));
  $: downloaded = $downloads.has(String(track.deezer_id));

  function play() {
    if (isCurrent) player.toggle();
    else if (onplay) onplay();
    else player.playTrack(track);
  }

  function menu(e) {
    e.preventDefault();
    e.stopPropagation();
    const coords = { clientX: e.clientX, clientY: e.clientY, preventDefault() {}, stopPropagation() {} };
    openMenu(coords, buildTrackMenu(track, push));
  }
</script>

<!-- svelte-ignore a11y-no-static-element-interactions -->
<div
  class="row track"
  class:active={isCurrent}
  on:dblclick={play}
  on:contextmenu={menu}
>
  <button class="play" on:click={play} aria-label="Lire">
    {#if isPlaying}
      <span class="eq" aria-hidden="true"><i></i><i></i><i></i></span>
    {:else}
      {#if index !== null}<span class="num">{index}</span>{/if}
      <span class="ic"><Icon name="play" size={15} /></span>
    {/if}
  </button>

  <div class="titles">
    {#if showCover}
      <div class="thumb"><Cover src={track.album?.cover} alt={track.title} size={40} /></div>
    {/if}
    <div class="meta">
      <div class="t">
        {#if track.local}<span class="local" title="Fichier local (pas sur Deezer)"><Icon name="cloudOff" size={13} /></span>{/if}
        {#if downloaded}<span class="dlbadge" title="Disponible hors-ligne"><Icon name="downloaded" size={13} /></span>{/if}
        {track.title}
        {#if track.explicit}<span class="explicit">E</span>{/if}
      </div>
      <button class="a muted" on:click|stopPropagation={() => track.artist && push("/artist/" + track.artist.deezer_id)}>
        {track.artist?.name}
      </button>
    </div>
  </div>

  {#if showAlbum && track.album}
    <button class="alb muted" on:click|stopPropagation={() => push("/album/" + track.album.deezer_id)}>
      {track.album.title}
    </button>
  {/if}

  <button class="fav" class:on={fav} on:click|stopPropagation={() => toggleFavorite(track)} aria-label="Favori">
    <Icon name={fav ? "heartFilled" : "heart"} size={17} />
  </button>
  <span class="dur muted">{fmtDuration(track.duration)}</span>
  <button class="more" on:click|stopPropagation={menu} aria-label="Plus d'options"><Icon name="more" size={18} /></button>
</div>

<style>
  .track {
    display: grid;
    grid-template-columns: 40px 1fr 1fr 30px 44px 30px;
    align-items: center;
    gap: 12px;
    padding: 6px 8px;
    border-radius: 8px;
    user-select: none;
  }
  .track:hover {
    background: var(--bg-hover);
  }
  .track.active .t {
    color: var(--accent);
  }
  .play {
    width: 40px;
    height: 40px;
    display: grid;
    place-items: center;
    position: relative;
  }
  .play .num {
    color: var(--text-dim);
  }
  .play .ic {
    display: none;
  }
  .track:hover .play .num {
    display: none;
  }
  .track:hover .play .ic {
    display: block;
  }
  .titles {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
  }
  .thumb {
    flex: none;
    width: 40px;
  }
  .meta {
    min-width: 0;
  }
  .t {
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .local {
    display: inline-flex;
    vertical-align: -2px;
    color: var(--text-dim);
    margin-right: 3px;
  }
  .dlbadge {
    display: inline-flex;
    vertical-align: -2px;
    color: var(--accent);
    margin-right: 3px;
  }
  .a,
  .alb {
    text-align: left;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 100%;
    font-size: 0.85rem;
  }
  .a:hover,
  .alb:hover {
    color: var(--text);
    text-decoration: underline;
  }
  .fav,
  .more {
    color: var(--text-dim);
    opacity: 0;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .track:hover .fav,
  .track:hover .more,
  .fav.on {
    opacity: 1;
  }
  .fav.on {
    color: var(--accent-2);
  }
  .fav:hover,
  .more:hover {
    color: var(--text);
  }
  .dur {
    text-align: right;
    font-variant-numeric: tabular-nums;
    font-size: 0.85rem;
  }
  /* equalizer animation on the playing row */
  .eq {
    display: flex;
    align-items: flex-end;
    gap: 2px;
    height: 16px;
  }
  .eq i {
    width: 3px;
    background: var(--accent);
    animation: eq 0.9s ease-in-out infinite;
  }
  .eq i:nth-child(1) {
    animation-delay: -0.2s;
  }
  .eq i:nth-child(2) {
    animation-delay: -0.5s;
  }
  .eq i:nth-child(3) {
    animation-delay: -0.8s;
  }
  @keyframes eq {
    0%,
    100% {
      height: 30%;
    }
    50% {
      height: 100%;
    }
  }
  @media (max-width: 640px) {
    .track {
      grid-template-columns: 36px 1fr 30px 30px;
    }
    .alb,
    .dur {
      display: none;
    }
    .fav,
    .more {
      opacity: 1;
    }
  }
</style>
