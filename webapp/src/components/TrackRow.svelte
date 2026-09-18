<script>
  import { push } from "svelte-spa-router";
  import {
    player,
    currentId,
    playing,
    favorites,
    openMenu,
    downloads,
    unavailableIds,
    openReplace,
  } from "../lib/stores.js";
  import { toggleFavorite, buildTrackMenu } from "../lib/actions.js";
  import { duration as fmtDuration } from "../lib/format.js";
  import { playbackIdle } from "../lib/playback.js";
  import Icon from "./Icon.svelte";
  import Cover from "./Cover.svelte";
  import ArtistLine from "./ArtistLine.svelte";

  export let track;
  export let index = null; // optional track number
  export let onplay = null; // optional override: () => void
  export let showAlbum = true;
  export let showCover = true; // album thumbnail per row (off on album pages)

  $: isCurrent = $currentId === track.deezer_id;
  $: isPlaying = isCurrent && $playing;
  $: fav = $favorites.has(String(track.deezer_id));
  $: downloaded = $downloads.has(String(track.deezer_id));
  // Flagged by the API when the list was fetched, or discovered mid-session by
  // the player's probe. A track you have downloaded plays from the device, so it
  // is never "unavailable" to YOU whatever Deezer decided.
  $: unavailable =
    !downloaded &&
    (track.unavailable === true || $unavailableIds.has(String(track.deezer_id)));

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

  // -- swipe right: "lire ensuite" -------------------------------------------
  // Touch-only, and deliberately the SAME gesture language as the now-playing
  // sheet: arm on touchstart, commit to an axis after a few pixels, and never
  // fight the scroller — a gesture that locks to "y" is left entirely alone, so
  // flicking through a 4000-track list feels exactly as it did before.
  //
  // The row slides right and the strip it vacates on the LEFT is what shows the
  // action. Drawing it there (rather than behind the row) is what keeps this
  // cheap and correct: the row itself stays transparent, so it needs no opaque
  // background to hide a layer underneath and nothing has to match whatever
  // page background — gradient header included — it happens to sit on.
  const AXIS_LOCK = 10; // px before a gesture commits to an axis
  const COMMIT = 64; // px of pull that actually queues the track
  const MAX_PULL = 104; // hard stop, rubber-banded past COMMIT
  // iOS reserves the very left edge for its own back gesture; starting there
  // means the system wins mid-drag and we would be left holding a translated
  // row. Cheaper to never arm than to recover from it.
  const EDGE_GUARD = 24;

  let dx = 0;
  let dragging = false; // finger down AND locked to the horizontal axis
  let armed = false;
  let axis = null;
  let startX = 0;
  let startY = 0;
  let swiped = false; // this gesture ended in a commit -> swallow the click

  $: committed = dx >= COMMIT;

  function resetSwipe() {
    armed = false;
    axis = null;
    dragging = false;
    dx = 0;
  }

  function onTouchStart(e) {
    swiped = false;
    // Multi-touch, or a gesture that starts on a control, belongs to that
    // control (or to a pinch) — not to us.
    if (e.touches.length !== 1 || e.target.closest("button")) {
      armed = false;
      return;
    }
    const t = e.touches[0];
    if (t.clientX < EDGE_GUARD) {
      armed = false;
      return;
    }
    armed = true;
    axis = null;
    startX = t.clientX;
    startY = t.clientY;
  }

  function onTouchMove(e) {
    if (!armed) return;
    const t = e.touches[0];
    const mx = t.clientX - startX;
    const my = t.clientY - startY;
    if (axis === null && (Math.abs(mx) > AXIS_LOCK || Math.abs(my) > AXIS_LOCK)) {
      axis = Math.abs(mx) > Math.abs(my) ? "x" : "y";
      // A vertical gesture is the scroller's: disarm so we never look at it again.
      if (axis === "y") armed = false;
    }
    if (axis !== "x") return;
    // Right only: a left pull has no action behind it, so it must not move.
    if (mx <= 0) {
      dragging = false;
      dx = 0;
      return;
    }
    // Hold the horizontal gesture so the list doesn't scroll under the finger.
    if (e.cancelable) e.preventDefault();
    dragging = true;
    dx = mx <= COMMIT ? mx : COMMIT + Math.min(MAX_PULL - COMMIT, (mx - COMMIT) * 0.35);
  }

  // The click the browser synthesises after a drag would play the track (or hit
  // whatever control the finger happens to be over) on release. preventDefault
  // on touchend normally stops it; this capture-phase guard is what makes that
  // certain on the engines that emit it anyway.
  function onClickCapture(e) {
    if (!swiped) return;
    swiped = false;
    e.preventDefault();
    e.stopPropagation();
  }

  function onTouchEnd(e) {
    if (!armed) return;
    armed = false;
    const go = axis === "x" && dx >= COMMIT;
    // Any horizontal drag has already moved the row under the finger: the click
    // the browser would synthesise from it would play the track (or hit a
    // control) on release. Swallow it.
    if (axis === "x" && dx > 0) {
      swiped = true;
      if (e.cancelable) e.preventDefault();
    }
    axis = null;
    dragging = false;
    dx = 0;
    if (go) {
      player.playNext([track]);
      try {
        navigator.vibrate?.(12);
      } catch {
        /* no haptics here — the queue still got the track */
      }
    }
  }
</script>

<!-- The click handler here only SWALLOWS the click a drag synthesises; the row
     itself keeps every one of its real controls. -->
<!-- svelte-ignore a11y-no-static-element-interactions a11y-click-events-have-key-events -->
<div
  class="swipe"
  class:dragging
  on:touchstart|passive={onTouchStart}
  on:touchmove={onTouchMove}
  on:touchend={onTouchEnd}
  on:touchcancel={resetSwipe}
  on:click|capture={onClickCapture}
>
  <!-- The strip the row vacates: it only ever exists to the LEFT of the row,
       so it is clipped to exactly the pulled distance and never paints under
       the row itself. -->
  <div class="action" class:committed style="width:{dx}px" aria-hidden="true">
    <span class="act-in"><Icon name="next" size={20} /></span>
  </div>

  <div
    class="row track"
    class:active={isCurrent}
    style={dx ? `transform:translate3d(${dx}px,0,0)` : ""}
    on:dblclick={play}
    on:contextmenu={menu}
  >
    <button class="play" on:click={play} aria-label="Lire">
      {#if isPlaying && $playbackIdle}
        <span class="eq" aria-hidden="true"><i></i><i></i><i></i></span>
      {:else if isPlaying}
        <!-- current row but audio isn't flowing yet (loading/buffering): a spinner
             tells the truth instead of an equalizer dancing over silence. -->
        <span class="rowspin" aria-hidden="true"></span>
      {:else}
        {#if index !== null}<span class="num">{index}</span>{/if}
        <span class="ic"><Icon name="play" size={15} /></span>
      {/if}
    </button>

    <div class="titles">
      {#if showCover}
        <div class="thumb"><Cover src={track.album?.cover} alt={track.title} size={40} kind="track" fallbackId={track.deezer_id} /></div>
      {/if}
      <div class="meta">
        <div class="t" class:gone={unavailable}>
          {#if unavailable}
            <button
              class="gonebadge"
              title="Titre indisponible — cliquez pour le remplacer"
              aria-label="Titre indisponible, remplacer"
              on:click|stopPropagation={() => openReplace(track)}><Icon name="alert" size={13} /></button>
          {/if}
          {#if track.local}<span class="local" title="Fichier local (pas sur Deezer)"><Icon name="cloudOff" size={13} /></span>{/if}
          {#if downloaded}<span class="dlbadge" title="Disponible hors-ligne"><Icon name="downloaded" size={13} /></span>{/if}
          {track.title}
          {#if track.explicit}<span class="explicit">E</span>{/if}
        </div>
        <span class="a muted"><ArtistLine {track} /></span>
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
</div>

<style>
  /* Clips the pulled row and hosts the reveal strip. `position: relative` only
     — no transform, no stacking context beyond that, so the virtual list keeps
     measuring rows exactly as before. */
  .swipe {
    position: relative;
    overflow: hidden;
    border-radius: 8px;
  }
  /* Released: glide home. Held: follow the finger with no transition at all.
     The strip and the row share the SAME curve and duration — they are two
     halves of one movement, and letting the strip snap shut while the row was
     still travelling left a gap of bare page behind it for a fifth of a
     second. */
  .swipe .track,
  .swipe .action {
    transition: transform 0.22s cubic-bezier(0.22, 1, 0.36, 1),
      width 0.22s cubic-bezier(0.22, 1, 0.36, 1);
  }
  .swipe.dragging .track,
  .swipe.dragging .action {
    transition: none;
  }
  .swipe.dragging .track {
    will-change: transform;
  }
  .action {
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    overflow: hidden;
    display: flex;
    align-items: center;
    border-radius: 8px;
    background: linear-gradient(90deg, rgba(162, 56, 255, 0.34), rgba(162, 56, 255, 0.12));
    color: var(--text-dim);
    pointer-events: none;
  }
  .action.committed {
    background: linear-gradient(90deg, var(--accent), rgba(162, 56, 255, 0.45));
    color: #fff;
  }
  /* Pinned to the left of the strip so the glyph stays put while the strip
     grows around it — the icon is revealed like a curtain rather than drifting
     with the finger. Deliberately WORDLESS: the strip is only ~64 px wide at
     the point it commits, and any label long enough to be honest ("Lire
     ensuite") gets cut down to a word that names a different action ("Lire").
     The toast on release says it in full. */
  .act-in {
    display: flex;
    align-items: center;
    padding-left: 18px;
    transition: transform 0.14s ease;
  }
  .action.committed .act-in {
    transform: scale(1.12);
  }
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
  /* A dead track stays readable but visibly demoted, and its badge is the way
     in to replacing it — the icon IS the button, so there's no hunting. */
  .t.gone {
    color: var(--text-dim);
  }
  .gonebadge {
    display: inline-flex;
    vertical-align: -2px;
    color: var(--accent-2);
    margin-right: 4px;
    padding: 0;
  }
  .gonebadge:hover {
    filter: brightness(1.25);
  }
  .dlbadge {
    display: inline-flex;
    vertical-align: -2px;
    color: var(--accent);
    margin-right: 3px;
  }
  .a,
  .alb {
    display: block;
    text-align: left;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 100%;
    font-size: 0.85rem;
  }
  /* `.a` holds one hoverable button per credited artist (ArtistLine), so the
     hover treatment belongs on each name, not on the whole line. */
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
  /* small spinner shown on the current row while audio isn't flowing yet */
  .rowspin {
    width: 14px;
    height: 14px;
    border-radius: 50%;
    border: 2px solid var(--bg-hover);
    border-top-color: var(--accent);
    animation: rowspin 0.8s linear infinite;
  }
  @keyframes rowspin {
    to {
      transform: rotate(360deg);
    }
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
