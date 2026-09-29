<script>
  // The player's bar and its full-screen views — the PICTURE of the player,
  // with no engine in it. Player.svelte renders it over the audio it drives;
  // a remote control (lib/remote/controller.js) renders exactly the same one
  // over somebody else's player, which is what "same app, another player"
  // means: every control here goes through the player store and `seekTo`,
  // never through an <audio> element.
  import { push } from "svelte-spa-router";
  import {
    player,
    current,
    favorites,
    nowPlayingOpen,
    immersiveOpen,
    seekTo,
    buffered,
    quality,
    openMenu,
    openShare,
  } from "../lib/stores.js";
  import { playbackLabel, playbackBusy } from "../lib/playback.js";
  import { toggleFavorite, buildTrackMenu } from "../lib/actions.js";
  import { duration as fmtDuration, artistLine } from "../lib/format.js";
  import { REMOTE, atLeast } from "../lib/remote/mode.js";
  import Cover from "./Cover.svelte";
  import Icon from "./Icon.svelte";
  import ImmersivePlayer from "./ImmersivePlayer.svelte";
  import PartyButton from "./PartyButton.svelte";
  import RemoteButton from "./RemoteButton.svelte";
  import SleepButton from "./SleepButton.svelte";
  import SpeedButton from "./SpeedButton.svelte";

  const QUALITIES = ["FLAC", "OPUS_320", "OPUS_256", "OPUS_192", "OPUS_128", "OPUS_64"];
  const QUALITY_LABEL = {
    FLAC: "FLAC",
    OPUS_320: "Opus 320",
    OPUS_256: "Opus 256",
    OPUS_192: "Opus 192",
    OPUS_128: "Opus 128",
    OPUS_64: "Opus 64",
  };
  const QUALITY_HINT = {
    FLAC: "Sans perte",
    OPUS_320: "Haute qualité",
    OPUS_256: "Haute qualité",
    OPUS_192: "Bon compromis",
    OPUS_128: "Standard",
    OPUS_64: "Données réduites",
  };
  let qOpen = false;
  function selectQuality(q) {
    quality.set(q);
    qOpen = false;
  }

  $: fav = $current && $favorites.has(String($current.deezer_id));

  function trackMenu(e) {
    e.preventDefault();
    e.stopPropagation();
    if (!$current) return;
    const coords = { clientX: e.clientX, clientY: e.clientY, preventDefault() {}, stopPropagation() {} };
    openMenu(coords, buildTrackMenu($current, push));
  }

  // Through `seekTo`, like every other view: the engine chases it on a live
  // stream (performSeek), a remote control sends it to the player it drives.
  function seek(e) {
    seekTo.set(+e.target.value);
  }

  // What a remote control may touch: a narrower level sees the bar without the
  // controls it could not use (the server would refuse them anyway).
  const canKeep = atLeast("full");
  const canQueue = atLeast("read");

  $: progress = $player.duration ? ($player.currentTime / $player.duration) * 100 : 0;
  // Buffered region (lighter fill), clamped to never read below the playhead.
  $: bufferedPct = $player.duration
    ? Math.min(100, Math.max(progress, ($buffered / $player.duration) * 100))
    : 0;
  $: repeatIconName = $player.repeat === "one" ? "repeat1" : "repeat";
</script>

<svelte:window on:click={() => (qOpen = false)} />

<!-- the <audio> elements are created and managed in JS (see makeEl/switchQuality) -->

<footer class="player">
  <!-- now playing (left / tap to open the immersive view) -->
  <button class="now" on:click={() => immersiveOpen.set(true)}>
    {#if $current}
      <Cover src={$current.album?.cover} alt={$current.title} size={56} kind={$current.podcast ? "podcast" : "album"} fallbackId={$current.deezer_id} eager />
      <span class="info">
        <span class="t">{$current.title}</span>
        <!-- While the player is working toward playback, the subtitle line says
             WHAT is happening (Chargement…, Nouvel essai…) instead of the artist,
             so silence under a "playing" icon is never unexplained. -->
        <span class="a muted" class:status={$playbackLabel}>{$playbackLabel || artistLine($current)}</span>
      </span>
    {:else}
      <span class="muted ph">Rien en lecture</span>
    {/if}
  </button>

  {#if $current && canKeep}
    <button class="fav desk" class:on={fav} on:click={() => toggleFavorite($current)} aria-label="Favori">
      <Icon name={fav ? "heartFilled" : "heart"} size={18} />
    </button>
  {/if}

  <!-- transport (flat children so the grid can reflow shuffle/repeat to a 2nd
       row at narrow-desktop widths instead of squeezing the play button) -->
  <div class="controls">
    {#if canQueue}
      <button class="sm shuf" class:on={$player.shuffle} on:click={() => player.toggleShuffle()} aria-label="Aléatoire"><Icon name="shuffle" size={18} /></button>
    {/if}
    <button class="prev" on:click={() => player.prev()} aria-label="Précédent"><Icon name="prev" size={20} /></button>
    <button class="pp" class:busy={$playbackBusy} on:click={() => player.toggle()} aria-label="Lecture/Pause">
      <Icon name={$player.playing ? "pause" : "play"} size={18} />
    </button>
    <button class="next" on:click={() => player.next()} aria-label="Suivant"><Icon name="next" size={20} /></button>
    {#if canQueue}
      <button class="sm rep" class:on={$player.repeat !== "off"} on:click={() => player.cycleRepeat()} aria-label="Répéter">
        <Icon name={repeatIconName} size={18} />
      </button>
    {/if}
    <div class="seek">
      <span class="time">{fmtDuration($player.currentTime)}</span>
      <input type="range" min="0" max={$player.duration || 0} value={$player.currentTime} on:input={seek} style={`--p:${progress}%; --b:${bufferedPct}%`} />
      <span class="time">{fmtDuration($player.duration)}</span>
    </div>
  </div>

  <!-- extras -->
  <div class="extra">
    {#if canKeep}
      <div class="q-wrap">
        <button
          class="q"
          class:hifi={$quality === "FLAC"}
          class:open={qOpen}
          on:click|stopPropagation={() => (qOpen = !qOpen)}
          title="Qualité de streaming"
          aria-haspopup="listbox"
          aria-expanded={qOpen}
        >
          {QUALITY_LABEL[$quality]}
          <Icon name="chevronUp" size={12} />
        </button>
        {#if qOpen}
          <ul class="q-menu" role="listbox">
            {#each QUALITIES as qq}
              <li>
                <button
                  role="option"
                  aria-selected={$quality === qq}
                  class:sel={$quality === qq}
                  on:click|stopPropagation={() => selectQuality(qq)}
                >
                  <span class="ql">
                    <span class="qn">{QUALITY_LABEL[qq]}</span>
                    <span class="qh muted">{QUALITY_HINT[qq]}</span>
                  </span>
                  {#if $quality === qq}<Icon name="check" size={15} />{/if}
                </button>
              </li>
            {/each}
          </ul>
        {/if}
      </div>
    {/if}
    {#if canKeep}<SpeedButton />{/if}
    <!-- A remote control lends neither: the party plays from THIS device's
         engine, and links are the owner's to make (and the sleep timer runs
         where the audio is). -->
    {#if !REMOTE}
      <SleepButton size={17} />
      <PartyButton size={17} />
      <RemoteButton size={17} />
    {/if}
    {#if $current && canKeep}
      <button class="sm" on:click={() => openShare($current)} title="Partager" aria-label="Partager"><Icon name="share" size={17} /></button>
    {/if}
    {#if canQueue}
      <button class="sm" on:click={trackMenu} title="Plus d'options" aria-label="Plus d'options"><Icon name="moreVertical" size={18} /></button>
    {/if}
    <button class="sm max" on:click={() => immersiveOpen.set(true)} title="Plein écran" aria-label="Plein écran"><Icon name="maximize" size={17} /></button>
    <button class="sm" class:on={$nowPlayingOpen} on:click={() => nowPlayingOpen.update((v) => !v)} title="File / Paroles" aria-label="File d'attente"><Icon name="queue" size={18} /></button>
    <button class="sm vol-ic" on:click={() => player.toggleMute()} aria-label="Muet"><Icon name={$player.muted || $player.volume === 0 ? "mute" : "volume"} size={18} /></button>
    <input class="vol" type="range" min="0" max="1" step="0.01" value={$player.muted ? 0 : $player.volume} on:input={(e) => player.setVolume(+e.target.value)} />
  </div>
</footer>

<!-- mobile full-screen now playing -->
<ImmersivePlayer />

<style>
  .player {
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    height: var(--player-h);
    display: grid;
    grid-template-columns: 1fr auto 2fr 1fr;
    align-items: center;
    gap: 12px;
    padding: 0 16px;
    background: var(--bg-elev);
    border-top: 1px solid var(--bg-hover);
    z-index: 50;
  }
  .now {
    display: flex;
    align-items: center;
    gap: 12px;
    min-width: 0;
    text-align: left;
  }
  .now .info {
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .t,
  .a {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 22vw;
  }
  .t {
    font-weight: 700;
  }
  .a {
    font-size: 0.85rem;
  }
  .ph {
    padding-left: 4px;
  }
  .fav {
    color: var(--text-dim);
    font-size: 1.2rem;
  }
  .fav.on {
    color: var(--accent-2);
  }
  .controls {
    display: grid;
    align-items: center;
    justify-content: center;
    column-gap: 16px;
    row-gap: 6px;
    grid-template-areas:
      "shuf prev pp next rep"
      "seek seek seek seek seek";
  }
  .controls .shuf {
    grid-area: shuf;
  }
  .controls .prev {
    grid-area: prev;
  }
  .controls .pp {
    grid-area: pp;
  }
  .controls .next {
    grid-area: next;
  }
  .controls .rep {
    grid-area: rep;
  }
  .controls > button {
    color: var(--text-dim);
    font-size: 1.05rem;
    justify-self: center;
  }
  .controls > button:hover {
    color: var(--text);
  }
  .sm {
    font-size: 0.95rem !important;
  }
  .sm.on {
    color: var(--accent) !important;
  }
  .pp {
    width: 40px;
    height: 40px;
    border-radius: 50%;
    background: var(--text);
    color: var(--bg) !important;
    display: grid;
    place-items: center;
    position: relative;
  }
  .pp:hover {
    transform: scale(1.06);
  }
  /* Discreet spinner ring around the play/pause button while the player is
     working toward playback (loading / buffering / archiving / retrying). */
  .pp.busy::after {
    content: "";
    position: absolute;
    inset: -4px;
    border-radius: 50%;
    border: 2px solid transparent;
    border-top-color: var(--accent);
    animation: pp-spin 0.8s linear infinite;
  }
  @keyframes pp-spin {
    to {
      transform: rotate(360deg);
    }
  }
  .a.status {
    color: var(--accent);
  }
  .seek {
    grid-area: seek;
    display: flex;
    align-items: center;
    gap: 10px;
    width: min(100%, 540px);
    justify-self: center;
  }
  .time {
    font-size: 0.72rem;
    color: var(--text-dim);
    font-variant-numeric: tabular-nums;
    width: 36px;
    text-align: center;
  }
  input[type="range"] {
    -webkit-appearance: none;
    appearance: none;
    height: 4px;
    border-radius: 2px;
    background: var(--bg-hover);
    flex: 1;
    cursor: pointer;
  }
  .seek input[type="range"] {
    background: linear-gradient(
      90deg,
      var(--accent) var(--p, 0%),
      rgba(255, 255, 255, 0.28) var(--p, 0%),
      rgba(255, 255, 255, 0.28) var(--b, 0%),
      var(--bg-hover) var(--b, 0%)
    );
  }
  input[type="range"]::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: #fff;
  }
  .extra {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 10px;
  }
  .extra .sm {
    color: var(--text-dim);
  }
  .extra .sm:hover {
    color: var(--text);
  }
  /* input.vol, or `input[type="range"]`'s flex: 1 wins and the slider eats
     whatever the column has spare. */
  input.vol {
    width: 90px;
    flex: none;
  }
  .q-wrap {
    position: relative;
  }
  .q {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 0.72rem;
    font-weight: 700;
    color: var(--text-dim);
    border: 1px solid var(--bg-hover);
    border-radius: 6px;
    padding: 3px 7px;
    white-space: nowrap;
  }
  .q :global(svg) {
    transition: transform 0.15s ease;
  }
  .q.open :global(svg) {
    transform: rotate(180deg);
  }
  .q:hover {
    color: var(--text);
  }
  .q.hifi {
    color: var(--accent);
    border-color: var(--accent);
  }
  .q-menu {
    position: absolute;
    bottom: calc(100% + 8px);
    right: 0;
    min-width: 188px;
    list-style: none;
    margin: 0;
    padding: 6px;
    background: var(--bg-elev);
    border: 1px solid var(--bg-hover);
    border-radius: 10px;
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.5);
    z-index: 60;
  }
  .q-menu button {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    width: 100%;
    padding: 8px 10px;
    border-radius: 7px;
    color: var(--text);
    text-align: left;
  }
  .q-menu button:hover {
    background: var(--bg-hover);
  }
  .q-menu button.sel {
    color: var(--accent);
  }
  .ql {
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .qn {
    font-size: 0.82rem;
    font-weight: 600;
  }
  .qh {
    font-size: 0.68rem;
  }

  /* The heart is not always there (nothing playing, a remote control that
     keeps nothing), and without it every later child slid one column left:
     the transport off-centre, the extras in the 2fr column. Pin the columns. */
  @media (min-width: 641px) {
    .controls {
      grid-column: 3;
    }
    .extra {
      grid-column: 4;
    }
  }

  /* narrow desktop: drop shuffle/repeat to a 2nd row flanking the seek bar
     instead of cramming everything on one line and squeezing the play button. */
  @media (min-width: 641px) and (max-width: 1024px) {
    .player {
      grid-template-columns: 1fr auto 1.6fr auto;
      gap: 10px;
    }
    .controls {
      grid-template-columns: auto 1fr auto;
      grid-template-areas:
        "prev pp next"
        "shuf seek rep";
      column-gap: 12px;
    }
    .extra {
      gap: 8px;
    }
    .extra .max {
      display: none; /* tap the track to open the full-screen player */
    }
    .vol {
      width: 72px;
    }
  }

  /* mobile (phone-sized): just the now-playing + play/next, tap to expand */
  @media (max-width: 640px) {
    .player {
      grid-template-columns: 1fr auto auto;
      height: 60px;
      gap: 8px;
    }
    .controls .seek,
    .fav.desk {
      display: none;
    }
    /* Keep only the fullscreen toggle from the extras cluster — the quality
       menu, volume, etc. don't fit a narrow bar, but the fullscreen button
       (class "max") must stay reachable. */
    .extra > :not(.max) {
      display: none;
    }
    .extra {
      gap: 0;
    }
    .controls {
      display: flex;
      gap: 14px;
    }
    .controls .shuf,
    .controls .rep,
    .controls .prev {
      display: none;
    }
    .t,
    .a {
      max-width: 46vw;
    }
  }
</style>

