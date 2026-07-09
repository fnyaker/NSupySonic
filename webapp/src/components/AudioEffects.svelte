<script>
  // Settings UI for the opt-in DSP chain (see lib/visualizer.js): volume
  // normalization, bass enhancement and a 10-band equalizer. Everything writes
  // to the persisted fx.* stores, which the audio graph subscribes to live.
  import { player, eqEnabled, eqBands, bassBoost, normalization } from "../lib/stores.js";
  import { EQ_FREQS, EQ_MIN_DB, EQ_MAX_DB } from "../lib/visualizer.js";
  import Icon from "./Icon.svelte";

  const NORM_LEVELS = [
    { id: "off", label: "Désactivée", hint: "Volume d'origine" },
    { id: "low", label: "Basse", hint: "Cible plus calme" },
    { id: "medium", label: "Normale", hint: "Cible standard" },
    { id: "high", label: "Élevée", hint: "Cible plus forte" },
  ];

  // Master output volume — the same store the desktop player bar drives, exposed
  // here so it's reachable on mobile (where the player bar is hidden) and so the
  // user can pull the level down to offset the EQ / bass boost.
  $: volPct = Math.round(($player.muted ? 0 : $player.volume) * 100);

  // A few useful curves (dB per band, low→high). "Plat" resets everything.
  const PRESETS = [
    { id: "flat", label: "Plat", bands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
    { id: "bass", label: "Basses+", bands: [6, 5, 4, 2, 0, 0, 0, 0, 0, 0] },
    { id: "vocal", label: "Voix", bands: [-2, -1, 0, 2, 4, 4, 3, 1, 0, -1] },
    { id: "treble", label: "Aigus+", bands: [0, 0, 0, 0, 0, 1, 2, 4, 5, 6] },
    { id: "loud", label: "Loudness", bands: [6, 4, 2, 0, -1, -1, 0, 2, 4, 6] },
  ];

  function freqLabel(hz) {
    return hz >= 1000 ? hz / 1000 + "k" : String(hz);
  }

  function setBand(i, v) {
    const next = $eqBands.slice();
    next[i] = Math.max(EQ_MIN_DB, Math.min(EQ_MAX_DB, +v || 0));
    eqBands.set(next);
  }
  function applyPreset(bands) {
    eqBands.set(bands.slice());
    eqEnabled.set(true);
  }
  $: activePreset = PRESETS.find((p) => p.bands.every((v, i) => v === $eqBands[i]))?.id;

  $: bassPct = Math.round($bassBoost * 100);
</script>

<section class="card">
  <h2><Icon name="sliders" size={18} /> Audio</h2>
  <p class="muted sub">
    Ces effets traitent le son dans le navigateur. Ils sont désactivés par
    défaut ; une fois activés, la lecture passe par le processeur audio (ce qui
    peut, sur certains mobiles, affecter la lecture en arrière-plan).
  </p>

  <!-- Master volume ------------------------------------------------------- -->
  <div class="block">
    <div class="block-head">
      <span class="block-title">Volume</span>
      <span class="muted block-hint">
        Volume de sortie général (identique à la barre du lecteur) — accessible
        sur mobile, et pratique pour compenser l'égaliseur ou l'amplification
        des basses.
      </span>
    </div>
    <div class="slider-row">
      <button class="vbtn" on:click={() => player.toggleMute()} aria-label="Muet" title="Muet">
        <Icon name={$player.muted || $player.volume === 0 ? "mute" : "volume"} size={18} />
      </button>
      <input type="range" min="0" max="1" step="0.01" value={$player.muted ? 0 : $player.volume} on:input={(e) => player.setVolume(+e.target.value)} />
      <span class="val">{volPct}%</span>
    </div>
  </div>

  <!-- Volume normalization ------------------------------------------------ -->
  <div class="block">
    <div class="block-head">
      <span class="block-title">Normalisation du volume</span>
      <span class="muted block-hint">
        Gain fixe par titre (selon sa loudness ReplayGain analysée par Deezer)
        pour que tous jouent au même niveau — sans compression ni ajustement
        pendant la lecture.
      </span>
    </div>
    <div class="seg">
      {#each NORM_LEVELS as n}
        <button class="seg-btn" class:sel={$normalization === n.id} on:click={() => normalization.set(n.id)} title={n.hint}>
          {n.label}
        </button>
      {/each}
    </div>
  </div>

  <!-- Bass boost ---------------------------------------------------------- -->
  <div class="block">
    <div class="block-head">
      <span class="block-title">Amélioration des basses</span>
      <span class="muted block-hint">Renforce le grave. Un limiteur automatique évite la saturation.</span>
    </div>
    <div class="slider-row">
      <input type="range" min="0" max="1" step="0.01" value={$bassBoost} on:input={(e) => bassBoost.set(+e.target.value)} />
      <span class="val">{bassPct}%</span>
    </div>
  </div>

  <!-- 10-band equalizer --------------------------------------------------- -->
  <div class="block">
    <button class="toggle" role="switch" aria-checked={$eqEnabled} on:click={() => eqEnabled.set(!$eqEnabled)}>
      <span class="tg-txt">
        <span class="tg-title">Égaliseur 10 bandes</span>
        <span class="tg-hint muted">Ajustez chaque bande de fréquence (±16 dB).</span>
      </span>
      <span class="sw" class:on={$eqEnabled}><span class="knob"></span></span>
    </button>

    <div class="presets">
      {#each PRESETS as p}
        <button class="preset" class:sel={activePreset === p.id} on:click={() => applyPreset(p.bands)}>{p.label}</button>
      {/each}
    </div>

    <div class="eq" class:dim={!$eqEnabled}>
      {#each EQ_FREQS as hz, i}
        <div class="band">
          <span class="gain">{$eqBands[i] > 0 ? "+" : ""}{$eqBands[i]}</span>
          <input
            class="vert"
            type="range"
            min={EQ_MIN_DB}
            max={EQ_MAX_DB}
            step="1"
            value={$eqBands[i]}
            disabled={!$eqEnabled}
            on:input={(e) => setBand(i, e.target.value)}
            aria-label={freqLabel(hz) + " Hz"}
          />
          <span class="freq">{freqLabel(hz)}</span>
        </div>
      {/each}
    </div>
  </div>
</section>

<style>
  .card {
    background: var(--bg-card);
    border-radius: var(--radius);
    padding: 18px 20px;
    margin-bottom: 18px;
  }
  .card h2 {
    font-size: 1.05rem;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .sub {
    font-size: 0.85rem;
    margin: 4px 0 14px;
  }
  .block {
    padding: 14px 0;
    border-top: 1px solid var(--bg-hover);
  }
  .block:first-of-type {
    border-top: none;
    padding-top: 4px;
  }
  .block-head {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin-bottom: 10px;
  }
  .block-title {
    font-weight: 600;
  }
  .block-hint {
    font-size: 0.78rem;
  }
  .seg {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .seg-btn {
    padding: 8px 14px;
    border-radius: 999px;
    background: var(--bg);
    border: 1px solid var(--bg-hover);
    color: var(--text-dim);
    font-weight: 600;
    font-size: 0.85rem;
  }
  .seg-btn.sel {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
  }
  .slider-row {
    display: flex;
    align-items: center;
    gap: 14px;
  }
  .vbtn {
    flex: none;
    color: var(--text-dim);
    display: flex;
    align-items: center;
  }
  .vbtn:hover {
    color: var(--text);
  }
  .slider-row input[type="range"] {
    -webkit-appearance: none;
    appearance: none;
    height: 4px;
    border-radius: 2px;
    background: var(--bg-hover);
    flex: 1;
    cursor: pointer;
  }
  .slider-row input[type="range"]::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: var(--accent);
    cursor: pointer;
  }
  .slider-row input[type="range"]::-moz-range-thumb {
    width: 16px;
    height: 16px;
    border: none;
    border-radius: 50%;
    background: var(--accent);
    cursor: pointer;
  }
  .val {
    font-variant-numeric: tabular-nums;
    font-weight: 600;
    width: 46px;
    text-align: right;
  }
  .toggle {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    width: 100%;
    text-align: left;
    padding: 0 0 12px;
  }
  .tg-txt {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .tg-title {
    font-weight: 600;
  }
  .tg-hint {
    font-size: 0.78rem;
  }
  .sw {
    flex: none;
    width: 44px;
    height: 26px;
    border-radius: 999px;
    background: var(--bg-hover);
    position: relative;
    transition: background 0.15s ease;
  }
  .sw.on {
    background: var(--accent);
  }
  .knob {
    position: absolute;
    top: 3px;
    left: 3px;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: #fff;
    transition: transform 0.15s ease;
  }
  .sw.on .knob {
    transform: translateX(18px);
  }
  .presets {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-bottom: 16px;
  }
  .preset {
    padding: 6px 12px;
    border-radius: 999px;
    background: var(--bg);
    border: 1px solid var(--bg-hover);
    color: var(--text-dim);
    font-weight: 600;
    font-size: 0.8rem;
  }
  .preset.sel {
    border-color: var(--accent);
    color: var(--accent);
  }
  .eq {
    display: flex;
    justify-content: space-between;
    gap: 6px;
    overflow-x: auto;
    padding: 4px 2px 0;
    transition: opacity 0.15s ease;
  }
  .eq.dim {
    opacity: 0.45;
  }
  .band {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
    flex: 1;
    min-width: 42px;
  }
  .gain {
    font-size: 0.74rem;
    font-variant-numeric: tabular-nums;
    color: var(--text-dim);
    min-height: 1em;
  }
  .freq {
    font-size: 0.72rem;
    color: var(--text-dim);
  }
  input.vert {
    writing-mode: vertical-lr;
    direction: rtl;
    width: 10px;
    height: 170px;
    -webkit-appearance: none;
    appearance: none;
    background: var(--bg-hover);
    border-radius: 5px;
    cursor: pointer;
  }
  input.vert:disabled {
    cursor: default;
  }
  input.vert::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: var(--accent);
    cursor: pointer;
  }
  input.vert::-moz-range-thumb {
    width: 20px;
    height: 20px;
    border: none;
    border-radius: 50%;
    background: var(--accent);
    cursor: pointer;
  }

  /* On phones a horizontal row of ten vertical faders forces horizontal
     scrolling, and dragging to scroll grabs whichever fader is under the
     finger. Rotate the whole EQ for touch: one horizontal fader per row,
     stacked vertically. Page scroll (up/down) and fader drag (left/right)
     are now on perpendicular axes, so they never fight — `touch-action:
     pan-y` makes the browser hand vertical swipes to the page and horizontal
     drags to the fader. */
  @media (max-width: 640px) {
    .eq {
      flex-direction: column;
      justify-content: flex-start;
      gap: 4px;
      overflow-x: visible;
      padding: 2px 0 0;
    }
    .band {
      flex-direction: row;
      align-items: center;
      gap: 12px;
      width: 100%;
      min-width: 0;
    }
    .freq {
      order: -1;
      flex: none;
      width: 38px;
      text-align: left;
    }
    .gain {
      flex: none;
      width: 40px;
      text-align: right;
      min-height: 0;
    }
    input.vert {
      writing-mode: horizontal-tb;
      direction: ltr;
      flex: 1;
      width: auto;
      height: 6px;
      touch-action: pan-y;
    }
    input.vert::-webkit-slider-thumb {
      width: 26px;
      height: 26px;
    }
    input.vert::-moz-range-thumb {
      width: 26px;
      height: 26px;
    }
  }
</style>
