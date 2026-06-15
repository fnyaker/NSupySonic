<script>
  import { get } from "svelte/store";
  import { push } from "svelte-spa-router";
  import {
    player,
    current,
    favorites,
    nowPlayingOpen,
    immersiveOpen,
    seekTo,
    pushRecent,
    quality,
    openMenu,
  } from "../lib/stores.js";
  import { api } from "../lib/api.js";
  import { toggleFavorite, buildTrackMenu, userPlaylists } from "../lib/actions.js";
  import { duration as fmtDuration } from "../lib/format.js";
  import { wireAudio, resumeAudio } from "../lib/visualizer.js";
  import Cover from "./Cover.svelte";
  import Icon from "./Icon.svelte";
  import ImmersivePlayer from "./ImmersivePlayer.svelte";

  let audio;
  let loadedKey = null;

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

  // Play telemetry: when the track changes, report how long the previous one
  // was played (feeds Deezer recommendations; server no-ops unless enabled).
  let listenId = null;
  let listenStart = 0;
  function flushListen(nextId = null) {
    if (listenId && listenId !== nextId) {
      const listened = Math.max(0, Math.round((Date.now() - listenStart) / 1000));
      const s = get(player);
      api.reportListen({
        deezer_id: listenId,
        listened,
        next_id: nextId,
        context: s.context || null,
        shuffle: s.shuffle,
      });
    }
    listenId = nextId;
    listenStart = Date.now();
  }

  // Seek requests from other views (e.g. the immersive player).
  $: if (audio && $seekTo != null) {
    audio.currentTime = $seekTo;
    seekTo.set(null);
  }

  $: fav = $current && $favorites.has(String($current.deezer_id));

  // (Re)load the source when the track OR the chosen quality changes.
  $: if (audio && $current) {
    const key = $current.deezer_id + "@" + $quality;
    if (key !== loadedKey) {
      const firstLoad = loadedKey === null;
      const sameTrack = loadedKey && loadedKey.split("@")[0] === $current.deezer_id;
      // Resume in place when only the quality changed, or restore the saved
      // position on the very first (session-restored) load.
      const resumeAt = sameTrack
        ? audio.currentTime
        : firstLoad && $player.currentTime > 1
          ? $player.currentTime
          : 0;
      loadedKey = key;
      audio.src = api.streamUrl($current.deezer_id, $quality);
      audio.load();
      if (resumeAt > 0) seekOnceLoaded(resumeAt);
      if ($player.playing) audio.play().catch(() => {});
      if (!sameTrack) {
        // Seed duration from metadata right away so the seek bar is correct
        // before the first timeupdate (live transcodes report no duration).
        player.setProgress(resumeAt, $current.duration || 0);
        flushListen($current.deezer_id);
        pushRecent($current);
        updateMediaSession($current);
      }
    }
  }

  // Apply a target time once the freshly-loaded source can seek. Cached/archived
  // files honour range requests; a live transcode may ignore it (best-effort).
  function seekOnceLoaded(t) {
    const apply = () => {
      try {
        audio.currentTime = t;
      } catch {
        /* not seekable yet */
      }
      audio.removeEventListener("loadedmetadata", apply);
    };
    audio.addEventListener("loadedmetadata", apply);
  }

  // Reflect transport state onto the element, but ONLY on a real mismatch.
  // This block re-runs on every player-store change (incl. 4×/s progress
  // updates), so blindly calling audio.play()/pause() here would fight the OS:
  // when another app (e.g. a TTS that grabs audio focus) pauses us, the element
  // is paused while the store may still read playing=true for a tick, and an
  // unconditional play() gets cut off again → a rapid play/pause loop. Guarding
  // on audio.paused makes each direction idempotent and breaks the oscillation.
  $: if (audio && loadedKey) {
    if ($player.playing && audio.paused) audio.play().catch(() => {});
    else if (!$player.playing && !audio.paused) audio.pause();
  }
  $: if (audio) audio.volume = $player.muted ? 0 : $player.volume;

  // Keep the OS media notification's transport state in sync (play/pause glyph).
  $: if ("mediaSession" in navigator)
    navigator.mediaSession.playbackState = $player.playing ? "playing" : "paused";

  function onTime() {
    // A live, on-the-fly transcoded stream (e.g. Opus/ogg piped from ffmpeg)
    // has no Content-Length, so audio.duration is Infinity/NaN. Fall back to
    // the duration we already know from the track metadata.
    const d =
      audio.duration && isFinite(audio.duration)
        ? audio.duration
        : $current?.duration || 0;
    player.setProgress(audio.currentTime, d);
    updatePositionState(audio.currentTime, d);
  }

  // Feed the OS media notification a duration/position so it can draw a seek
  // bar. Throws if duration <= 0 or position > duration, so clamp + guard.
  function updatePositionState(position, duration) {
    if (!("mediaSession" in navigator) || !("setPositionState" in navigator.mediaSession))
      return;
    if (!duration || !isFinite(duration)) return;
    try {
      navigator.mediaSession.setPositionState({
        duration,
        position: Math.min(Math.max(position, 0), duration),
        playbackRate: audio?.playbackRate || 1,
      });
    } catch {
      /* ignore */
    }
  }

  async function onEnded() {
    const s = get(player);
    const cur = $current;
    if (s.repeat === "one") {
      audio.currentTime = 0;
      audio.play().catch(() => {});
      return;
    }
    if (s.index < s.queue.length - 1) {
      player.next();
      return;
    }
    if (s.repeat === "all") {
      player.jump(0);
      return;
    }
    if (s.autoplay && cur) {
      try {
        const r = await api.trackRadio(cur.deezer_id);
        const more = (r.tracks || []).filter((t) => t.deezer_id !== cur.deezer_id);
        if (more.length) {
          player.autoExtend(more);
          return;
        }
      } catch {
        /* ignore */
      }
    }
    flushListen(null); // playback stops here — report the final track
    player.pause();
  }

  // Keep the queue topped up so Flow / radio play endlessly without a gap.
  let extending = false;
  async function ensureUpcoming() {
    const s = get(player);
    if (!s.autoplay || s.index < 0) return;
    if (s.index < s.queue.length - 3) return; // still buffered
    if (extending) return;
    extending = true;
    try {
      let more = [];
      if (s.context && s.context.kind === "flow") {
        more = (await api.flow()).tracks || [];
      } else {
        const seed = s.queue[s.queue.length - 1] || s.queue[s.index];
        if (seed) more = (await api.trackRadio(seed.deezer_id)).tracks || [];
      }
      player.extend(more);
    } catch {
      /* ignore */
    } finally {
      extending = false;
    }
  }

  // Re-check the buffer each time the playing track changes.
  $: if ($current) ensureUpcoming();

  // Pre-archive ONLY the next track (n+1) so it starts instantly, and re-fire
  // whenever that upcoming track changes — a skip, a queue extension, or a Flow
  // re-tune. Keeping it to a single track avoids hammering the archiver.
  let prefetchedId = null;
  $: {
    const nextId =
      $player.index >= 0 ? $player.queue[$player.index + 1]?.deezer_id : null;
    if (nextId && nextId !== prefetchedId) {
      prefetchedId = nextId;
      api.download([nextId]).catch(() => {});
    }
  }

  async function trackMenu(e) {
    e.preventDefault();
    e.stopPropagation();
    if (!$current) return;
    const coords = { clientX: e.clientX, clientY: e.clientY, preventDefault() {}, stopPropagation() {} };
    await userPlaylists();
    openMenu(coords, buildTrackMenu($current, push));
  }

  function seek(e) {
    if (audio && audio.duration) audio.currentTime = +e.target.value;
  }

  function updateMediaSession(track) {
    if (!("mediaSession" in navigator) || !track) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: track.title,
        artist: track.artist?.name,
        album: track.album?.title,
        artwork: track.album?.cover
          ? [{ src: track.album.cover, sizes: "500x500", type: "image/jpeg" }]
          : [],
      });
      navigator.mediaSession.setActionHandler("play", () => player.play());
      navigator.mediaSession.setActionHandler("pause", () => player.pause());
      navigator.mediaSession.setActionHandler("nexttrack", () => player.next());
      navigator.mediaSession.setActionHandler("previoustrack", () => player.prev());
      // Scrubbing + skip from the OS notification / lock screen.
      navigator.mediaSession.setActionHandler("seekto", (d) => {
        if (audio && d.seekTime != null) audio.currentTime = d.seekTime;
      });
      navigator.mediaSession.setActionHandler("seekbackward", (d) => {
        if (audio)
          audio.currentTime = Math.max(0, audio.currentTime - (d.seekOffset || 10));
      });
      navigator.mediaSession.setActionHandler("seekforward", (d) => {
        if (audio)
          audio.currentTime = Math.min(
            audio.duration || $current?.duration || 0,
            audio.currentTime + (d.seekOffset || 10)
          );
      });
    } catch {
      /* ignore */
    }
  }

  $: progress = $player.duration ? ($player.currentTime / $player.duration) * 100 : 0;
  $: repeatIconName = $player.repeat === "one" ? "repeat1" : "repeat";
</script>

<svelte:window on:click={() => (qOpen = false)} />

<audio
  bind:this={audio}
  on:timeupdate={onTime}
  on:ended={onEnded}
  on:play={() => {
    wireAudio(audio); // lazy: first play is a user gesture, so the context starts
    resumeAudio();
    if (!get(player).playing) player.play();
  }}
  on:pause={() => {
    if (get(player).playing) player.pause();
  }}
></audio>

<footer class="player">
  <!-- now playing (left / tap to open the immersive view) -->
  <button class="now" on:click={() => immersiveOpen.set(true)}>
    {#if $current}
      <Cover src={$current.album?.cover} alt={$current.title} size={56} />
      <span class="info">
        <span class="t">{$current.title}</span>
        <span class="a muted">{$current.artist?.name}</span>
      </span>
    {:else}
      <span class="muted ph">Rien en lecture</span>
    {/if}
  </button>

  {#if $current}
    <button class="fav desk" class:on={fav} on:click={() => toggleFavorite($current)} aria-label="Favori">
      <Icon name={fav ? "heartFilled" : "heart"} size={18} />
    </button>
  {/if}

  <!-- transport (flat children so the grid can reflow shuffle/repeat to a 2nd
       row at narrow-desktop widths instead of squeezing the play button) -->
  <div class="controls">
    <button class="sm shuf" class:on={$player.shuffle} on:click={() => player.toggleShuffle()} aria-label="Aléatoire"><Icon name="shuffle" size={18} /></button>
    <button class="prev" on:click={() => player.prev()} aria-label="Précédent"><Icon name="prev" size={20} /></button>
    <button class="pp" on:click={() => player.toggle()} aria-label="Lecture/Pause">
      <Icon name={$player.playing ? "pause" : "play"} size={18} />
    </button>
    <button class="next" on:click={() => player.next()} aria-label="Suivant"><Icon name="next" size={20} /></button>
    <button class="sm rep" class:on={$player.repeat !== "off"} on:click={() => player.cycleRepeat()} aria-label="Répéter">
      <Icon name={repeatIconName} size={18} />
    </button>
    <div class="seek">
      <span class="time">{fmtDuration($player.currentTime)}</span>
      <input type="range" min="0" max={$player.duration || 0} value={$player.currentTime} on:input={seek} style={`--p:${progress}%`} />
      <span class="time">{fmtDuration($player.duration)}</span>
    </div>
  </div>

  <!-- extras -->
  <div class="extra">
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
    <button class="sm" on:click={trackMenu} title="Plus d'options" aria-label="Plus d'options"><Icon name="moreVertical" size={18} /></button>
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
  }
  .pp:hover {
    transform: scale(1.06);
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
    background: linear-gradient(90deg, var(--accent) var(--p, 0%), var(--bg-hover) var(--p, 0%));
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
  .vol {
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
      grid-template-columns: 1fr auto;
      height: 60px;
      gap: 8px;
    }
    .controls .seek,
    .extra,
    .fav.desk {
      display: none;
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
