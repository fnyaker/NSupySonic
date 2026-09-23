<script>
  // Réglages → Animations.
  //
  // The page is built around a LIVE preview rather than a list of names: every
  // control here changes something you cannot describe in a label, so the
  // preview shows the actual scene, driven by the actual track, reacting to the
  // actual settings as they move.
  //
  // The readout under it is the other half of that idea. The smart engine's
  // whole claim is that it understands what it is listening to; showing the
  // tempo it locked, the style it settled on and what it made of the kick is
  // how that claim becomes checkable instead of a promise.
  import { onDestroy, onMount } from "svelte";
  import {
    vizMode,
    vizQuality,
    vizPalette,
    vizIntensity,
    vizBeatDetect,
    vizShowStyle,
    vizLookahead,
    vizFps,
    vizFullBleed,
    vizScopeOrientation,
    vizScopeColour,
    vizScreenMode,
    vizScreenQuality,
    vizWorld,
    vizScreenWorld,
    vizFlash,
    ecoMode,
    current,
    playing,
    toasts,
    isAdmin,
  } from "../lib/stores.js";
  import { push } from "svelte-spa-router";
  import { MODES, effectiveMode, needsWave } from "../lib/viz/modes.js";
  import { PALETTES } from "../lib/viz/palette.js";
  import { TIERS, autoTier } from "../lib/viz/quality.js";
  import { LEVEL, subscribeFrames, readout } from "../lib/audio/engine.js";
  import { LOOKAHEAD_MAX } from "../lib/audio/graph.js";
  import { openProjector } from "../lib/viz/host.js";
  import { FAMILY_LIST } from "../lib/audio/style.js";
  import Visualizer from "./Visualizer.svelte";
  import Icon from "./Icon.svelte";
  import EcoToggle from "./EcoToggle.svelte";
  import WorldPicker from "./WorldPicker.svelte";

  const FPS_CHOICES = [
    { v: 30, label: "30", hint: "Le plus économe" },
    { v: 45, label: "45", hint: "Bon compromis" },
    { v: 60, label: "60", hint: "Fluide" },
    { v: 0, label: "Écran", hint: "Sans limite (120 Hz…)" },
  ];

  const KICK_LABEL = { soft: "souple", hard: "dur", industrial: "industriel" };

  // How bright a flash may be. How OFTEN one may happen is not a setting: the
  // engine holds every level, "full" included, under three onsets a second.
  const FLASH_CHOICES = [
    { v: "off", label: "Aucun", hint: "Rien ne clignote, jamais" },
    { v: "soft", label: "Doux", hint: "Une lueur sur les drops" },
    { v: "full", label: "Plein", hint: "Le vrai éclair de scène" },
  ];

  // The oscilloscope's two knobs. Written out here rather than imported from
  // the scene: `lib/viz/scenes/scope.js` is code-split precisely so that a
  // launch never parses it, and importing it for two arrays of labels would
  // hoist the whole scene back into the settings chunk.
  const SCOPE_AXES = [
    { v: "horizontal", label: "Horizontal", hint: "Deux bandes, l'une sous l'autre" },
    { v: "vertical", label: "Vertical", hint: "Deux colonnes, côte à côte" },
  ];
  const SCOPE_TINTS = [
    { v: "duo", label: "Deux teintes", hint: "Gauche et droite aux deux bouts de la palette" },
    { v: "mono", label: "Une teinte", hint: "Les deux voies sur la couleur de base" },
    { v: "sweep", label: "Dégradé", hint: "La teinte parcourt la trace, comme les barres" },
  ];

  $: mode = effectiveMode($vizMode, $vizBeatDetect, $ecoMode);
  $: degraded = mode !== $vizMode && !$ecoMode;
  $: autoLabel = autoTier();
  // "Aucune" means none — including here. A preview that keeps a canvas alive
  // to show what the user just switched OFF is exactly the kind of pointless
  // work this setting exists to stop.
  $: showPreview = mode !== "off";
  // The scope is configured wherever it is running: the player here, or the
  // separate screen, which has its own scene and the same instrument.
  $: scopeChosen = needsWave(mode) || needsWave($vizScreenMode);
  $: previewLive = showPreview && !!$current && $playing;

  // While this page is open the engine runs its full analysis, whatever the
  // selected scene needs, so the readout below is never blank because the
  // chosen mode happens not to want a beat tracker. Dropped as soon as the
  // page goes away — and never taken at all when the user has switched the
  // rhythm analysis off, because claiming to analyse then would be a lie.
  let stopProbe = null;
  $: {
    stopProbe?.();
    // Not while the animations are off: running the whole engine to fill a
    // readout nothing is driving would be the same waste from the other side.
    stopProbe =
      $vizBeatDetect && showPreview ? subscribeFrames(() => {}, LEVEL.SMART) : null;
  }
  onDestroy(() => stopProbe?.());

  function openScreen() {
    if (!openProjector())
      toasts.push("Le navigateur a bloqué la nouvelle fenêtre", "error");
  }

  $: styleName =
    FAMILY_LIST.find((f) => f.id === $readout.style)?.label || $readout.styleLabel || "—";
  // The world catalogue and the skins are loaded ON DEMAND. Importing them
  // statically made this panel a static importer of modules the (code-split)
  // scene also imports, and Rollup hoists a module two chunks share into their
  // common parent — the entry. The gallery below is not worth putting the
  // genre table on every launch's critical path.
  let catalogue = null;
  onMount(async () => {
    try {
      const [worlds, skins] = await Promise.all([
        import("../lib/viz/worlds/catalogue.js"),
        import("../lib/viz/skins.js"),
      ]);
      catalogue = { GROUPS: worlds.GROUPS, WORLDS: worlds.WORLD_META, skinFor: skins.skinFor };
    } catch {
      /* offline mid-deploy: the gallery stays hidden, everything else works */
    }
  });
  // What "auto" draws for the genre the engine settled on: the genre's own
  // skin, then the world that skin dresses. Two sub-genres sharing a world is
  // normal and is exactly what this line is for.
  $: resolvedWorld =
    catalogue && ($readout.style || $readout.archetype)
      ? catalogue.skinFor($readout.style, $readout.archetype).world
      : "";
  function worldLabel(id) {
    return (catalogue && catalogue.WORLDS[id]?.label) || "—";
  }
  $: worldName =
    mode !== "smart"
      ? "—"
      : $vizWorld !== "auto" && catalogue?.WORLDS[$vizWorld]
        ? `${worldLabel($vizWorld)} · épinglé`
        : resolvedWorld
          ? worldLabel(resolvedWorld)
          : "—";
  $: screenWorldName =
    $vizScreenWorld !== "auto" && catalogue?.WORLDS[$vizScreenWorld] ? worldLabel($vizScreenWorld) : "Auto";
</script>

<section class="card">
  <h2><Icon name="maximize" size={18} /> Animations</h2>
  <p class="sub muted">
    Ce que le lecteur plein écran affiche pendant la lecture. Tout se règle ici et
    l'aperçu suit en direct.
  </p>

  {#if showPreview}
    <div class="preview" class:idle={!previewLive}>
      <Visualizer
        {mode}
        quality={$vizQuality}
        palette={$vizPalette}
        intensity={$vizIntensity}
        fps={$vizFps}
        layout="full"
        paused={!previewLive}
        scopeOrientation={$vizScopeOrientation}
        scopeColour={$vizScopeColour}
        world={$vizWorld}
        flash={$vizFlash}
      />
      {#if !previewLive}
        <span class="ph">Lancez un titre pour voir l'aperçu</span>
      {/if}
    </div>
  {:else}
    <div class="preview none">
      <span class="ph">
        {$ecoMode ? "Mode éco actif : aucune animation." : "Aucune animation."}
      </span>
    </div>
  {/if}

  <div class="block eco-row">
    <div class="block-head">
      <span class="block-title">Mode éco</span>
      <span class="block-hint muted">
        Coupe toutes les animations d'un coup — le visualiseur, le fondu de la
        pochette en arrière-plan et la ligne de paroles qui défile — sans perdre
        vos réglages. Le même bouton est dans le lecteur plein écran.
      </span>
    </div>
    <label class="sw">
      <input type="checkbox" checked={$ecoMode} on:change={(e) => ecoMode.set(e.target.checked)} />
      <span>Aucune animation sur cet appareil</span>
      <EcoToggle size={17} />
    </label>
  </div>

  <div class="block">
    <div class="block-head">
      <span class="block-title">Type d'animation</span>
      <span class="block-hint muted">
        « Aucune » rend le lecteur d'origine, sans canvas ni analyse.
      </span>
    </div>
    <div class="modes" class:overridden={$ecoMode}>
      {#each MODES as m}
        <button class="mode" class:sel={$vizMode === m.id} on:click={() => vizMode.set(m.id)}>
          <span class="mode-t">{m.label}</span>
          <span class="mode-h">{m.hint}</span>
          {#if m.rhythm}<span class="tag">analyse rythmique</span>{/if}
        </button>
      {/each}
    </div>
    {#if $ecoMode}
      <p class="warn">
        <Icon name="leaf" size={14} />
        Le mode éco est actif : ce choix est mémorisé mais rien n'est animé.
      </p>
    {/if}
    {#if degraded}
      <p class="warn">
        <Icon name="info" size={14} />
        « {MODES.find((m) => m.id === $vizMode)?.label} » a besoin de l'analyse rythmique :
        « {MODES.find((m) => m.id === mode)?.label} » est affiché en attendant.
      </p>
    {/if}
  </div>

  {#if mode === "smart" && catalogue}
    <div class="block">
      <div class="block-head">
        <span class="block-title">Monde</span>
        <span class="block-hint muted">
          Chaque genre a son monde et ses couleurs. Épinglez-en un pour le garder quel
          que soit le morceau : il prend quand même la teinte du genre qui passe.
        </span>
      </div>
      <WorldPicker
        value={$vizWorld}
        groups={catalogue.GROUPS}
        meta={catalogue.WORLDS}
        resolved={$vizBeatDetect ? resolvedWorld : ""}
        genre={$readout.style ? styleName : ""}
        on:pick={(e) => vizWorld.set(e.detail)}
      />
    </div>
  {/if}

  <!-- The scope's own settings, shown when it is the scene somewhere — here or
       on the separate screen. They sit directly under the picker that reveals
       them, which is where a reader looks next. -->
  {#if scopeChosen}
    <div class="block">
      <div class="block-head">
        <span class="block-title">Oscilloscope</span>
        <span class="block-hint muted">
          Une trace par canal, déclenchée sur le grave comme un vrai oscilloscope —
          l'image tient en place au lieu de glisser. La précision suit le niveau de
          détail plus bas : à « ultra » chaque échantillon est tracé, avec un
          déclenchement au sous-échantillon. Les couleurs viennent de la palette
          choisie ci-dessous.
        </span>
      </div>
      <div class="seg">
        {#each SCOPE_AXES as o}
          <button
            class="seg-btn"
            class:sel={$vizScopeOrientation === o.v}
            title={o.hint}
            on:click={() => vizScopeOrientation.set(o.v)}>{o.label}</button
          >
        {/each}
      </div>
      <div class="seg mt">
        {#each SCOPE_TINTS as c}
          <button
            class="seg-btn"
            class:sel={$vizScopeColour === c.v}
            title={c.hint}
            on:click={() => vizScopeColour.set(c.v)}>{c.label}</button
          >
        {/each}
      </div>
    </div>
  {/if}

  <div class="block">
    <div class="block-head">
      <span class="block-title">Couleurs</span>
      <span class="block-hint muted">
        « Spectre » teinte selon l'équilibre grave/aigu et fait tourner la couleur au tempo.
      </span>
    </div>
    <div class="seg">
      {#each PALETTES as p}
        <button class="seg-btn" class:sel={$vizPalette === p.id} on:click={() => vizPalette.set(p.id)}
          >{p.label}</button
        >
      {/each}
    </div>
  </div>

  <div class="block">
    <div class="block-head">
      <span class="block-title">Intensité</span>
      <span class="block-hint muted">L'ampleur du mouvement, pas la luminosité.</span>
    </div>
    <div class="slider-row">
      <input
        type="range"
        min="0"
        max="1"
        step="0.05"
        value={$vizIntensity}
        on:input={(e) => vizIntensity.set(+e.target.value)}
        style={`--p:${$vizIntensity * 100}%`}
        aria-label="Intensité"
      />
      <span class="val">{Math.round($vizIntensity * 100)}%</span>
    </div>
  </div>

  <div class="block">
    <div class="block-head">
      <span class="block-title"><Icon name="zap" size={15} /> Flashs</span>
      <span class="block-hint muted">
        L'éclair qui accompagne un drop ou une grosse frappe. Même en « Plein », jamais
        plus de trois par seconde : au-delà, une lumière qui clignote devient un risque
        pour les personnes photosensibles. Coupés d'office si l'appareil demande de
        réduire les animations. Vaut aussi pour l'écran séparé.
      </span>
    </div>
    <div class="seg">
      {#each FLASH_CHOICES as f}
        <button class="seg-btn" class:sel={$vizFlash === f.v} title={f.hint} on:click={() => vizFlash.set(f.v)}
          >{f.label}</button
        >
      {/each}
    </div>
  </div>

  <div class="block">
    <div class="block-head">
      <span class="block-title">Fond animé dans le lecteur</span>
      <span class="block-hint muted">
        L'animation remplace la pochette floutée en arrière-plan. Décoché, elle reste
        confinée à sa bande.
      </span>
    </div>
    <label class="sw">
      <input type="checkbox" checked={$vizFullBleed} on:change={(e) => vizFullBleed.set(e.target.checked)} />
      <span>Plein écran</span>
    </label>
  </div>
</section>

<section class="card">
  <h2><Icon name="activity" size={18} /> Analyse rythmique</h2>
  <p class="sub muted">
    Tempo, grille de temps, type de kick et style. C'est ce qui permet aux animations
    de tomber juste plutôt que de réagir après coup. Le tempo et le style sont
    mesurés une fois par le serveur sur le morceau entier — l'animation est donc
    juste dès la première mesure ; ici on ne cherche plus que la phase, le kick et
    les frappes, qui sont les seules choses réellement instantanées.
  </p>

  <div class="block">
    <label class="sw">
      <input type="checkbox" checked={$vizBeatDetect} on:change={(e) => vizBeatDetect.set(e.target.checked)} />
      <span>Activer l'analyse</span>
    </label>
    <p class="block-hint muted">
      Quelques centaines de microsecondes par image. Désactivée, les modes qui en
      dépendent basculent sur « Aurore ».
    </p>
  </div>

  <div class="block" class:off={!$vizBeatDetect}>
    <div class="block-head">
      <span class="block-title">Compensation de latence</span>
      <span class="block-hint muted">
        L'analyse écoute le son avant vos enceintes, du délai choisi. Une frappe
        imprévue est alors dessinée pile à l'heure au lieu d'arriver après. Les temps
        prédits restent alignés quoi qu'il arrive.
      </span>
    </div>
    <div class="slider-row">
      <input
        type="range"
        min="0"
        max={LOOKAHEAD_MAX}
        step="10"
        value={$vizLookahead}
        disabled={!$vizBeatDetect}
        on:input={(e) => vizLookahead.set(+e.target.value)}
        style={`--p:${($vizLookahead / LOOKAHEAD_MAX) * 100}%`}
        aria-label="Compensation de latence"
      />
      <span class="val">{$vizLookahead ? `${$vizLookahead} ms` : "aucune"}</span>
    </div>
  </div>

  <div class="block" class:off={!$vizBeatDetect}>
    <label class="sw">
      <input type="checkbox" checked={$vizShowStyle} on:change={(e) => vizShowStyle.set(e.target.checked)} />
      <span>Afficher le style reconnu dans le lecteur</span>
    </label>
  </div>

  <div class="readout" class:live={$vizBeatDetect && $readout.locked}>
    <div class="ro">
      <span class="ro-k">Tempo{#if $readout.served} · serveur{/if}</span>
      <span class="ro-v">{$readout.locked ? `${$readout.bpm} BPM` : "—"}</span>
      <span class="bar"><i style={`width:${Math.round($readout.confidence * 100)}%`}></i></span>
    </div>
    <div class="ro">
      <span class="ro-k">Style</span>
      <span class="ro-v">{$readout.style ? styleName : "—"}</span>
      <span class="bar"><i style={`width:${Math.round($readout.styleConfidence * 100)}%`}></i></span>
    </div>
    <div class="ro">
      <span class="ro-k">Kick</span>
      <span class="ro-v">{KICK_LABEL[$readout.kick] || "—"}</span>
      <span class="bar"></span>
    </div>
    <!-- Which world the style above has chosen (or the one pinned). Without it
         the smart engine's whole point — that the picture is different per
         genre — is something you have to notice rather than something the
         settings tell you. -->
    <div class="ro">
      <span class="ro-k">Monde</span>
      <span class="ro-v">{worldName}</span>
      <span class="bar"></span>
    </div>
  </div>

  {#if $isAdmin}
    <!-- The escape hatch from a fixed vocabulary. The classifier above knows the
         genres it was written with; the studio is where you teach it yours. -->
    <div class="studio">
      <div>
        <strong>Studio de genres</strong>
        <p class="muted">
          Le classifieur ci-dessus connaît les styles avec lesquels il a été écrit.
          Si le vôtre lui échappe — un sous-genre, une scène, votre propre découpage —
          créez-le, étiquetez quelques titres et entraînez le modèle ici même.
        </p>
      </div>
      <button class="studio-btn" on:click={() => push("/genres")}>
        <Icon name="sliders" size={16} /> Ouvrir
      </button>
    </div>
  {/if}
</section>

<section class="card">
  <h2><Icon name="monitor" size={18} /> Rendu</h2>
  <p class="sub muted">
    « Auto » lit l'appareil (ici : <strong>{autoLabel}</strong>) et redescend d'un cran
    tout seul si une image prend trop de temps.
  </p>

  <div class="block">
    <div class="block-head"><span class="block-title">Niveau de détail</span></div>
    <div class="seg">
      <button class="seg-btn" class:sel={$vizQuality === "auto"} on:click={() => vizQuality.set("auto")}
        >Auto</button
      >
      {#each TIERS as t}
        <button class="seg-btn cap" class:sel={$vizQuality === t} on:click={() => vizQuality.set(t)}
          >{t}</button
        >
      {/each}
    </div>
  </div>

  <div class="block">
    <div class="block-head">
      <span class="block-title">Images par seconde</span>
      <span class="block-hint muted">
        L'analyse tourne à part, à sa propre cadence : baisser ce plafond n'a jamais
        fait rater un temps.
      </span>
    </div>
    <div class="seg">
      {#each FPS_CHOICES as f}
        <button class="seg-btn" class:sel={$vizFps === f.v} on:click={() => vizFps.set(f.v)} title={f.hint}
          >{f.label}</button
        >
      {/each}
    </div>
  </div>
</section>

<section class="card">
  <h2><Icon name="cast" size={18} /> Écran séparé</h2>
  <p class="sub muted">
    Ouvre l'animation dans une seconde fenêtre, à poser sur un vidéoprojecteur ou un
    grand écran et à passer en plein écran. Rien n'y est lu : c'est cet onglet qui
    joue et qui lui envoie son analyse, au même instant.
  </p>
  <div class="row-actions">
    <button class="primary" on:click={openScreen}>
      <Icon name="maximize" size={16} /> Ouvrir l'écran d'animation
    </button>
    {#if $vizMode !== "off"}
      <button class="ghost" on:click={() => vizMode.set("off")}>
        <Icon name="minimize" size={16} /> Couper l'animation ici
      </button>
    {/if}
  </div>
  <p class="sub muted tight">
    Les deux sont séparés : le lecteur peut être sur <em>Aucune</em> pendant que
    l'écran dédié tourne. L'analyse du son, elle, n'a lieu qu'UNE fois — dans cet
    onglet, au niveau du plus exigeant des deux — donc le genre, le tempo et la
    grille sont les mêmes des deux côtés, par construction.
  </p>

  <div class="block">
    <div class="block-head">
      <span class="block-title">Réglages de cet écran</span>
      <span class="block-hint muted">
        Indépendants de ceux du lecteur : un grand écran mérite une autre réponse
        qu'un téléphone. Ils se règlent aussi depuis la fenêtre elle-même.
      </span>
    </div>
    <div class="seg">
      {#each MODES.filter((m) => m.id !== "off") as m}
        <button class="seg-btn" class:sel={$vizScreenMode === m.id} on:click={() => vizScreenMode.set(m.id)}
          >{m.label}</button
        >
      {/each}
    </div>
    <div class="seg mt">
      <button
        class="seg-btn"
        class:sel={$vizScreenQuality === "auto"}
        on:click={() => vizScreenQuality.set("auto")}>Auto</button
      >
      {#each TIERS as t}
        <button class="seg-btn cap" class:sel={$vizScreenQuality === t} on:click={() => vizScreenQuality.set(t)}
          >{t}</button
        >
      {/each}
    </div>
    {#if $vizScreenMode === "smart" && catalogue}
      <!-- Folded: the player's own gallery above is the one people browse;
           this is the same choice for the other screen, one tap away. -->
      <details class="screen-world">
        <summary>
          <span>Monde de cet écran</span>
          <span class="sw-val">{screenWorldName}</span>
        </summary>
        <div class="screen-world-body">
          <WorldPicker
            value={$vizScreenWorld}
            groups={catalogue.GROUPS}
            meta={catalogue.WORLDS}
            resolved={$vizBeatDetect ? resolvedWorld : ""}
            genre={$readout.style ? styleName : ""}
            on:pick={(e) => vizScreenWorld.set(e.detail)}
          />
        </div>
      </details>
    {/if}
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
  .muted {
    color: var(--text-dim);
  }
  /* The preview follows the reader down the card: every control in it
     changes what the preview shows, and a world picked at the bottom of the
     gallery is worth nothing if the picture it changed has scrolled away. */
  .preview {
    position: sticky;
    top: 8px;
    z-index: 2;
    box-shadow: 0 10px 28px -14px rgba(0, 0, 0, 0.7);
    width: 100%;
    aspect-ratio: 16 / 9;
    max-height: 260px;
    border-radius: 12px;
    overflow: hidden;
    background: #08070d;
    border: 1px solid var(--bg-hover);
    display: grid;
    place-items: center;
  }
  @media (max-width: 640px) {
    .preview {
      max-height: 190px;
    }
  }
  /* Dim the picture, never the box: the box is sticky and slides over the
     controls, so it has to stay opaque. */
  .preview.idle :global(canvas) {
    opacity: 0.85;
  }
  .preview.none {
    aspect-ratio: auto;
    min-height: 92px;
    max-height: none;
  }
  .eco-row .sw {
    gap: 12px;
  }
  .ph {
    position: relative;
    z-index: 1;
    font-size: 0.82rem;
    color: rgba(255, 255, 255, 0.45);
    text-align: center;
    padding: 0 16px;
  }
  .block {
    padding: 14px 0;
    border-top: 1px solid var(--bg-hover);
  }
  .block.off {
    opacity: 0.45;
  }
  .block-head {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin-bottom: 10px;
  }
  .block-title {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-weight: 600;
  }
  .screen-world {
    margin-top: 12px;
    border: 1px solid var(--bg-hover);
    border-radius: 12px;
    background: var(--bg);
  }
  .screen-world summary {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    min-height: 44px;
    padding: 0 14px;
    font-weight: 600;
    cursor: pointer;
    list-style: none;
  }
  .screen-world summary::-webkit-details-marker {
    display: none;
  }
  .screen-world summary::after {
    content: "";
    width: 7px;
    height: 7px;
    margin-left: 4px;
    border-right: 2px solid var(--text-dim);
    border-bottom: 2px solid var(--text-dim);
    transform: translateY(-2px) rotate(45deg);
    transition: transform 0.16s ease;
  }
  .screen-world[open] summary::after {
    transform: translateY(2px) rotate(-135deg);
  }
  .sw-val {
    margin-left: auto;
    color: var(--text-dim);
    font-weight: 600;
    font-size: 0.86rem;
  }
  .screen-world-body {
    padding: 4px 14px 14px;
  }
  .block-hint {
    font-size: 0.78rem;
    line-height: 1.45;
  }
  .modes.overridden {
    opacity: 0.5;
  }
  .modes {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 10px;
  }
  .mode {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 4px;
    text-align: left;
    padding: 12px 14px;
    border-radius: 12px;
    background: var(--bg);
    border: 1px solid var(--bg-hover);
    color: var(--text-dim);
    cursor: pointer;
    transition:
      border-color 0.16s ease,
      background 0.16s ease;
  }
  .mode:hover {
    background: var(--bg-hover);
  }
  .mode.sel {
    border-color: var(--accent);
    background: color-mix(in srgb, var(--accent) 14%, var(--bg));
    color: var(--text);
  }
  .mode-t {
    font-weight: 650;
    color: var(--text);
  }
  .mode-h {
    font-size: 0.76rem;
    line-height: 1.4;
  }
  .tag {
    margin-top: 2px;
    font-size: 0.64rem;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--accent-2);
  }
  .warn {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 10px 0 0;
    font-size: 0.78rem;
    color: var(--text-dim);
  }
  .seg {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .seg.mt {
    margin-top: 8px;
  }
  .seg-btn {
    padding: 8px 14px;
    border-radius: 999px;
    background: var(--bg);
    border: 1px solid var(--bg-hover);
    color: var(--text-dim);
    font-weight: 600;
    font-size: 0.85rem;
    cursor: pointer;
  }
  .seg-btn.cap {
    text-transform: capitalize;
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
  .slider-row input[type="range"] {
    flex: 1;
  }
  .val {
    min-width: 72px;
    text-align: right;
    font-size: 0.82rem;
    color: var(--text-dim);
    font-variant-numeric: tabular-nums;
  }
  .sw {
    display: flex;
    align-items: center;
    gap: 10px;
    font-weight: 600;
    cursor: pointer;
  }
  .sw input {
    width: 18px;
    height: 18px;
    accent-color: var(--accent);
  }
  .studio {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    flex-wrap: wrap;
    margin-top: 14px;
    padding: 14px 16px;
    border: 1px solid var(--border, #2a2d33);
    border-radius: 14px;
  }
  .studio p {
    margin: 4px 0 0;
    font-size: 0.82rem;
    line-height: 1.5;
    max-width: 52ch;
  }
  .studio-btn {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    background: var(--surface-2, #1b1d21);
    border: 1px solid var(--border, #2a2d33);
    border-radius: 11px;
    color: inherit;
    font: inherit;
    font-weight: 600;
    padding: 9px 15px;
    cursor: pointer;
    flex: none;
  }
  .studio-btn:hover {
    background: var(--surface-3, #24262b);
  }

  .readout {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    gap: 10px;
    margin-top: 14px;
    padding: 14px;
    border-radius: 12px;
    background: var(--bg);
    border: 1px solid var(--bg-hover);
    opacity: 0.55;
    transition: opacity 0.3s ease;
  }
  .readout.live {
    opacity: 1;
  }
  .ro {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .ro-k {
    font-size: 0.68rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-dim);
  }
  .ro-v {
    font-weight: 700;
    font-size: 1rem;
    font-variant-numeric: tabular-nums;
  }
  .bar {
    display: block;
    height: 3px;
    border-radius: 2px;
    background: var(--bg-hover);
    overflow: hidden;
  }
  .bar i {
    display: block;
    height: 100%;
    background: linear-gradient(90deg, var(--accent), var(--accent-2));
    transition: width 0.3s ease;
  }
  /* The projector's two actions sit side by side: opening the second screen
     and muting this one are the same decision seen from two ends. */
  .row-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    align-items: center;
  }
  .sub.tight {
    margin-top: 12px;
    margin-bottom: 0;
  }
  .ghost {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 10px 14px;
    border-radius: 11px;
    border: 1px solid var(--line, rgba(255, 255, 255, 0.14));
    background: transparent;
    color: var(--fg, #e8e4f0);
    font: inherit;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.15s ease, border-color 0.15s ease;
  }
  .ghost:hover {
    background: rgba(255, 255, 255, 0.06);
    border-color: rgba(255, 255, 255, 0.24);
  }
  .primary {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 10px 18px;
    border-radius: 999px;
    background: var(--accent);
    border: none;
    color: #fff;
    font-weight: 650;
    font-size: 0.88rem;
    cursor: pointer;
  }
  .primary:hover {
    filter: brightness(1.08);
  }
</style>
