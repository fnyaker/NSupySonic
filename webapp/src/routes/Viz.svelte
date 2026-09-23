<script>
  // The projector screen: the same SPA, opened in a second window, drawing the
  // animation full-bleed and nothing else.
  //
  // It plays NOTHING. All of it — the spectrum, the beat grid, the style
  // verdict — arrives from the tab that is actually playing, over a
  // BroadcastChannel (see lib/viz/bridge.js). One decode, one analysis, one
  // timeline: a second <audio> here would drift out of sync with the room
  // within a minute and the animation would stop matching what people hear.
  //
  // Everything on top of the canvas hides itself. A projector screen should be
  // the animation, so the title card and the controls fade out a few seconds
  // after the last pointer movement and come back on the next one.
  import { onMount, onDestroy } from "svelte";
  import {
    vizScreenMode,
    vizScreenQuality,
    vizPalette,
    vizIntensity,
    vizScopeOrientation,
    vizScopeColour,
    vizScreenWorld,
    vizFlash,
  } from "../lib/stores.js";
  import { createSubscriber } from "../lib/viz/bridge.js";
  import { MODES, levelFor, needsWave } from "../lib/viz/modes.js";
  import { TIERS, resolveTier, tierPreset } from "../lib/viz/quality.js";
  import Visualizer from "../components/Visualizer.svelte";
  import Icon from "../components/Icon.svelte";

  let viz;
  let sub = null;
  let live = false;
  let playing = false;
  let loaded = false;
  let supported = true;
  let meta = { title: "", artist: "", album: "", cover: "", rgb: null };
  let style = { label: "", bpm: 0, confidence: 0, kick: "" };
  let uiVisible = true;
  let uiTimer = null;
  let isFull = false;
  let lastReadoutAt = 0;

  // The scene list minus "off": a screen whose whole purpose is the animation
  // has no use for an option that draws nothing.
  const SCREEN_MODES = MODES.filter((m) => m.id !== "off");

  // The world list for the picker, fetched when the window opens rather than
  // bundled into it: the same catalogue the settings gallery reads, and the
  // same chunk the engine's skins already share.
  let worldShelves = [];
  onMount(async () => {
    try {
      const { GROUPS, WORLD_META } = await import("../lib/viz/worlds/catalogue.js");
      worldShelves = GROUPS.map((g) => ({
        ...g,
        worlds: Object.entries(WORLD_META)
          .filter(([, m]) => m.group === g.id)
          .map(([id, m]) => ({ id, label: m.label })),
      })).filter((g) => g.worlds.length);
    } catch {
      /* offline mid-deploy: no picker, "auto" keeps working */
    }
  });

  function showUI() {
    uiVisible = true;
    clearTimeout(uiTimer);
    uiTimer = setTimeout(() => (uiVisible = false), 3000);
  }

  function onFrame(f) {
    viz?.pushFrame(f);
    // The overlay reads the style at 4 Hz, not at frame rate: this is Svelte
    // state, and reassigning it 45 times a second would re-render the card
    // 45 times a second for a label that changes every few bars.
    const now = f.t;
    if (now - lastReadoutAt < 0.25) return;
    lastReadoutAt = now;
    const s = f.style;
    const bpm = f.beat.locked ? Math.round(f.beat.bpm) : 0;
    const label = s?.confidence > 0.35 ? s.dominantLabel : "";
    if (label !== style.label || bpm !== style.bpm || s?.kick?.type !== style.kick)
      style = { label, bpm, confidence: s?.confidence || 0, kick: s?.kick?.type || "" };
  }

  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch {
      /* the browser refused (no gesture, or it is disabled) — nothing to do */
    }
  }

  // The projector picks its own scene, so it also decides its own analysis
  // needs — and tells the playing tab, which runs the engine at the most
  // demanding of the two. Changing the scene here re-announces at once.
  //
  // The oscilloscope needs one thing more: the raw samples, at ITS tier's
  // trigger window. The playing tab has no idea what is on this screen, so this
  // is the only place that number can come from.
  $: screenWave = needsWave($vizScreenMode)
    ? tierPreset(resolveTier($vizScreenQuality)).scope?.buffer || 4096
    : 0;
  $: sub?.setLevel(levelFor($vizScreenMode), screenWave);

  onMount(() => {
    sub = createSubscriber(
      onFrame,
      (m) => {
        // A meta message without `rgb` is the immediate one; the colour follows
        // once the playing tab has decoded the cover. Keep the previous colour
        // rather than flashing back to the default in between.
        meta = { ...meta, ...m, rgb: m.rgb ?? meta.rgb };
      },
      (st) => {
        live = st.alive;
        playing = st.playing;
        loaded = st.loaded;
      },
      levelFor($vizScreenMode),
      needsWave($vizScreenMode)
        ? tierPreset(resolveTier($vizScreenQuality)).scope?.buffer || 4096
        : 0
    );
    supported = sub.supported;
    showUI();
    const onFs = () => (isFull = !!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFs);
    // The projector window is often the only one with focus, so keep the usual
    // shortcuts working here: F for full screen, Escape to leave it.
    const onKey = (e) => {
      if (e.key === "f" || e.key === "F") toggleFullscreen();
      showUI();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("fullscreenchange", onFs);
      window.removeEventListener("keydown", onKey);
    };
  });

  onDestroy(() => {
    clearTimeout(uiTimer);
    sub?.close();
  });
</script>

<svelte:head><title>NSupySonic — Animation</title></svelte:head>

<div
  class="screen"
  class:idle={!uiVisible}
  data-link={live ? (playing ? "playing" : loaded ? "paused" : "idle") : "offline"}
  on:pointermove={showUI}
  on:pointerdown={showUI}
  role="presentation"
>
  <Visualizer
    bind:this={viz}
    mode={$vizScreenMode}
    quality={$vizScreenQuality}
    palette={$vizPalette}
    intensity={$vizIntensity}
    fps={0}
    layout="full"
    external
    paused={!playing}
    coverRgb={meta.rgb}
    coverUrl={meta.cover}
    scopeOrientation={$vizScopeOrientation}
    scopeColour={$vizScopeColour}
    world={$vizScreenWorld}
    flash={$vizFlash}
  />

  {#if !supported}
    <div class="notice">
      <h1>Écran d'animation</h1>
      <p>Ce navigateur ne permet pas la liaison entre onglets (BroadcastChannel).</p>
    </div>
  {:else if !live}
    <div class="notice">
      <h1>En attente du lecteur</h1>
      <p>
        Gardez NSupySonic ouvert dans un autre onglet et lancez la lecture : cette
        page s'anime toute seule. Rien n'est lu ici, c'est le même morceau, la
        même analyse, la même seconde.
      </p>
    </div>
  {:else if !playing}
    <div class="notice quiet">
      <h1>{loaded ? "En pause" : "Rien en lecture"}</h1>
      <p>{loaded ? "L'animation reprend dès que la lecture repart." : "Lancez un titre depuis le lecteur."}</p>
    </div>
  {/if}

  <div class="card" class:on={uiVisible && live}>
    {#if meta.cover}
      <img src={meta.cover} alt="" />
    {/if}
    <div class="txt">
      <strong>{meta.title}</strong>
      <span>{meta.artist}</span>
      {#if style.label}
        <em>{style.label}{#if style.bpm} · {style.bpm} BPM{/if}</em>
      {/if}
    </div>
  </div>

  <div class="bar" class:on={uiVisible}>
    <div class="grp">
      {#each SCREEN_MODES as m}
        <button
          class:sel={$vizScreenMode === m.id}
          on:click={() => vizScreenMode.set(m.id)}
          title={m.hint}>{m.label}</button
        >
      {/each}
    </div>
    <div class="grp">
      <button class:sel={$vizScreenQuality === "auto"} on:click={() => vizScreenQuality.set("auto")}
        >Auto</button
      >
      {#each TIERS as t}
        <button class:sel={$vizScreenQuality === t} on:click={() => vizScreenQuality.set(t)}
          >{t}</button
        >
      {/each}
    </div>
    {#if $vizScreenMode === "smart" && worldShelves.length}
      <!-- A native select: on a projector laptop it is a keyboard-driven list,
           and it keeps forty-seven worlds out of a bar that must stay small. -->
      <select
        class="world"
        value={$vizScreenWorld}
        on:change={(e) => vizScreenWorld.set(e.currentTarget.value)}
        aria-label="Monde"
        title="Le monde de cet écran : auto (le genre choisit) ou épinglé"
      >
        <option value="auto">Monde · auto</option>
        {#each worldShelves as g (g.id)}
          <optgroup label={g.label}>
            {#each g.worlds as w (w.id)}
              <option value={w.id}>{w.label}</option>
            {/each}
          </optgroup>
        {/each}
      </select>
    {/if}
    <button class="ic" on:click={toggleFullscreen} aria-label="Plein écran">
      <Icon name={isFull ? "minimize" : "maximize"} size={18} />
    </button>
  </div>
</div>

<style>
  .screen {
    position: fixed;
    inset: 0;
    background: #05040a;
    overflow: hidden;
  }
  .screen.idle {
    cursor: none;
  }
  .notice {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    text-align: center;
    padding: 0 10vw;
    color: rgba(255, 255, 255, 0.82);
  }
  .notice.quiet {
    /* A paused player is not an error — say so quietly and let the fading
       scene behind it still be the thing on screen. */
    opacity: 0.55;
  }
  .notice h1 {
    font-size: clamp(1.4rem, 3.4vw, 2.4rem);
    margin: 0 0 12px;
    font-weight: 700;
    letter-spacing: -0.02em;
  }
  .notice p {
    max-width: 44ch;
    line-height: 1.55;
    color: rgba(255, 255, 255, 0.5);
    font-size: clamp(0.9rem, 1.3vw, 1.05rem);
  }
  .card {
    position: absolute;
    left: clamp(20px, 3vw, 48px);
    bottom: clamp(20px, 3vw, 48px);
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 12px 20px 12px 12px;
    border-radius: 16px;
    background: rgba(10, 8, 16, 0.5);
    backdrop-filter: blur(18px);
    border: 1px solid rgba(255, 255, 255, 0.08);
    opacity: 0;
    transform: translateY(10px);
    transition:
      opacity 0.45s ease,
      transform 0.45s cubic-bezier(0.22, 1, 0.36, 1);
    pointer-events: none;
  }
  .card.on {
    opacity: 1;
    transform: none;
  }
  .card img {
    width: clamp(48px, 4.4vw, 72px);
    height: clamp(48px, 4.4vw, 72px);
    border-radius: 10px;
    object-fit: cover;
    flex: none;
  }
  .txt {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .txt strong {
    font-size: clamp(0.95rem, 1.5vw, 1.25rem);
    color: #fff;
    letter-spacing: -0.01em;
  }
  .txt span {
    font-size: clamp(0.8rem, 1.1vw, 0.95rem);
    color: rgba(255, 255, 255, 0.58);
  }
  .txt em {
    font-style: normal;
    font-size: 0.72rem;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: rgba(255, 255, 255, 0.4);
    margin-top: 4px;
  }
  .bar {
    position: absolute;
    top: clamp(16px, 2.2vw, 32px);
    right: clamp(16px, 2.2vw, 32px);
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px;
    border-radius: 999px;
    background: rgba(10, 8, 16, 0.55);
    backdrop-filter: blur(18px);
    border: 1px solid rgba(255, 255, 255, 0.08);
    opacity: 0;
    transition: opacity 0.35s ease;
    pointer-events: none;
  }
  .bar.on {
    opacity: 1;
    pointer-events: auto;
  }
  .grp {
    display: flex;
    gap: 4px;
  }
  .bar button {
    padding: 7px 13px;
    border-radius: 999px;
    background: transparent;
    border: none;
    color: rgba(255, 255, 255, 0.6);
    font-size: 0.78rem;
    font-weight: 600;
    text-transform: capitalize;
    cursor: pointer;
  }
  .bar button:hover {
    color: #fff;
    background: rgba(255, 255, 255, 0.08);
  }
  .bar button.sel {
    background: var(--accent);
    color: #fff;
  }
  .bar .world {
    appearance: none;
    -webkit-appearance: none;
    height: 34px;
    padding: 0 30px 0 13px;
    border-radius: 999px;
    border: 1px solid rgba(255, 255, 255, 0.12);
    background:
      linear-gradient(45deg, transparent 50%, rgba(255, 255, 255, 0.6) 50%) calc(100% - 15px) 15px / 5px 5px no-repeat,
      linear-gradient(135deg, rgba(255, 255, 255, 0.6) 50%, transparent 50%) calc(100% - 10px) 15px / 5px 5px no-repeat,
      rgba(255, 255, 255, 0.04);
    color: rgba(255, 255, 255, 0.85);
    font: inherit;
    font-size: 0.78rem;
    font-weight: 600;
    cursor: pointer;
  }
  .bar .world:hover,
  .bar .world:focus-visible {
    border-color: rgba(255, 255, 255, 0.28);
    outline: none;
  }
  .bar .world option,
  .bar .world optgroup {
    background: #14121c;
    color: #fff;
  }
  .bar .ic {
    display: grid;
    place-items: center;
    width: 34px;
    height: 34px;
    padding: 0;
    border-left: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 0 999px 999px 0;
  }
</style>
