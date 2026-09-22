<script>
  // The listen party, as a guest sees it: whoever opened the link, account or
  // not. Everything here plays through lib/party/guest.js — this screen is the
  // landing card (who invited you, what is playing, one tap to join), then the
  // live view.
  import { onDestroy, onMount } from "svelte";
  import { fade } from "svelte/transition";
  import { createBackdrop } from "../lib/backdrop.js";
  import { cssUrl, duration as fmtDuration } from "../lib/format.js";
  import { joinParty, peekParty, rememberName, savedName } from "../lib/party/guest.js";
  import Icon from "../components/Icon.svelte";

  export let id;

  let phase = "loading"; // loading | landing | joining | live | ended | left | missing | unsupported
  let peek = null;
  let name = savedName();
  let session = null;
  let view = null;
  let pos = 0;
  let posTimer = null;
  let showLatency = false;
  let latencyTimer = null;
  let latencyDraft = 0;

  // A track with no art at all (a bare local file) gets the placeholder, not
  // an empty tile; the flag resets with every new cover.
  let artFailed = false;
  let artFor = null;
  $: if ((track ? track.cover : null) !== artFor) {
    artFor = track ? track.cover : null;
    artFailed = false;
  }

  const bg = createBackdrop();
  $: st = $view && $view.state ? $view.state : peek;
  $: track = st && st.track;
  $: bg.set(track ? track.cover : "", "");
  $: if ($view && $view.phase !== "joining" && $view.phase !== "live") phase = $view.phase;
  $: if ($view && $view.phase === "live" && phase === "joining") phase = "live";
  $: listeners = st && st.listeners ? st.listeners.length : 0;
  $: dur = track ? track.duration || 0 : 0;
  $: pct = dur ? Math.min(100, (pos / dur) * 100) : 0;
  $: if (track && phase === "live") document.title = `${track.title} — ${track.artist} · Listen party`;
  $: status = statusLine($view, st);
  $: if ($view && !latencyTimer) latencyDraft = $view.latency;

  onMount(async () => {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC || !window.fetch) {
      phase = "unsupported";
      return;
    }
    try {
      peek = await peekParty(id);
      phase = peek ? "landing" : "missing";
    } catch {
      phase = "missing";
    }
  });

  onDestroy(() => {
    clearInterval(posTimer);
    clearTimeout(latencyTimer);
    bg.destroy();
    if (session) session.leave();
  });

  // The tap IS the permission to play: the AudioContext is created inside it.
  function join() {
    const n = name.trim().slice(0, 32);
    rememberName(n);
    session = joinParty(id, n || "Invité");
    view = session.view;
    phase = "joining";
    posTimer = setInterval(() => (pos = session ? session.position() : 0), 250);
  }

  function leave() {
    if (session) session.leave();
    session = null;
    clearInterval(posTimer);
    phase = "left";
  }

  function rejoin() {
    view = null;
    peek = null;
    phase = "loading";
    peekParty(id)
      .then((p) => {
        peek = p;
        phase = p ? "landing" : "missing";
      })
      .catch(() => (phase = "missing"));
  }

  function statusLine(v, s) {
    if (!v || !s) return { text: "Connexion…", tone: "wait" };
    if (v.offline) return { text: "Connexion perdue — la musique continue", tone: "warn" };
    if (!s.live) return { text: `${s.host} s'est absenté`, tone: "warn" };
    if (!s.track) return { text: `En attente de ${s.host}`, tone: "wait" };
    if (!s.playing) return { text: `En pause chez ${s.host}`, tone: "wait" };
    if (!v.clock) return { text: "Synchronisation de l'horloge…", tone: "wait" };
    if (v.status === "load") return { text: "Chargement…", tone: "wait" };
    if (v.status === "sync") {
      const q = Math.max(0.1, v.clock.spread);
      return { text: `Calé sur ${s.host} · ±${q.toFixed(1)} ms`, tone: "ok" };
    }
    return { text: "Mise en place…", tone: "wait" };
  }

  // Latency: applied a moment after the last tap, so a run of taps is one
  // re-alignment rather than ten.
  function nudge(ms) {
    latencyDraft = Math.max(-500, Math.min(1000, latencyDraft + ms));
    clearTimeout(latencyTimer);
    latencyTimer = setTimeout(() => {
      latencyTimer = null;
      if (session) session.setLatency(latencyDraft);
    }, 350);
  }
  function resetLatency() {
    nudge(-latencyDraft);
  }

  function onVolume(e) {
    if (session) session.setVolume(+e.target.value);
  }
</script>

<div class="party">
  {#each $bg as layer (layer.id)}
    <div class="bg" style={`background-image:${cssUrl(layer.src)}`} in:fade={{ duration: 420 }}></div>
  {/each}
  <div class="scrim"></div>

  <div class="frame">
    <header class="top">
      <span class="brand"><Icon name="party" size={18} /> Listen party</span>
      {#if phase === "live"}
        <button class="leave" on:click={leave} aria-label="Quitter la party"><Icon name="logOut" size={17} /> Quitter</button>
      {/if}
    </header>

    {#if phase === "loading"}
      <div class="center"><span class="spinner" aria-label="Chargement"></span></div>
    {:else if phase === "missing" || phase === "ended"}
      <div class="center msg">
        <span class="big-ic"><Icon name="party" size={30} /></span>
        <h1>{phase === "ended" ? "La party est terminée" : "Cette party n'existe plus"}</h1>
        <p class="muted">
          {phase === "ended"
            ? "L'hôte l'a arrêtée. Merci d'avoir écouté."
            : "Le lien a expiré, ou l'hôte l'a arrêtée. Demandez-lui un nouveau lien."}
        </p>
      </div>
    {:else if phase === "unsupported"}
      <div class="center msg">
        <h1>Navigateur non pris en charge</h1>
        <p class="muted">Ouvrez ce lien dans un navigateur récent (Chrome, Firefox, Safari).</p>
      </div>
    {:else if phase === "left"}
      <div class="center msg">
        <span class="big-ic"><Icon name="party" size={30} /></span>
        <h1>Vous avez quitté la party</h1>
        <button class="primary" on:click={rejoin}><Icon name="party" size={18} /> Rejoindre à nouveau</button>
      </div>
    {:else}
      <main class="stage" class:landing={phase === "landing"}>
        <div class="art">
          {#if track && !artFailed}
            <img src={track.cover} alt="" on:error={() => (artFailed = true)} />
          {:else}
            <div class="art-ph"><Icon name="music" size={48} /></div>
          {/if}
        </div>

        <div class="meta">
          {#if phase === "landing"}
            <p class="invite"><strong>{peek.host}</strong> vous invite à écouter{listeners ? ` avec ${listeners} ${listeners > 1 ? "autres personnes" : "autre personne"}` : ""}</p>
          {:else}
            <p class="live"><span class="dot" class:paused={!st || !st.playing}></span>En direct avec {st ? st.host : ""}{listeners > 1 ? ` · ${listeners} à l'écoute` : ""}</p>
          {/if}
          <h1 class="title">{track ? track.title : "Rien en lecture pour l'instant"}</h1>
          {#if track && track.artist}<p class="artist">{track.artist}</p>{/if}
        </div>

        {#if phase === "landing"}
          <form class="join" on:submit|preventDefault={join}>
            <label class="field">
              <span class="muted">Votre prénom (visible par l'hôte)</span>
              <input bind:value={name} maxlength="32" placeholder="Invité" autocomplete="given-name" />
            </label>
            <button class="primary big" type="submit"><Icon name="party" size={20} /> Rejoindre l'écoute</button>
            <p class="hint muted">Le son démarre calé sur celui de {peek.host}. Gardez l'écran allumé : un téléphone verrouillé coupe le son.</p>
          </form>
        {:else}
          <div class="progress">
            <div class="bar"><span style={`width:${pct}%`}></span></div>
            <div class="times"><span>{fmtDuration(pos)}</span><span>{fmtDuration(dur)}</span></div>
          </div>

          <p class="status {status.tone}">
            {#if status.tone === "wait"}<span class="mini-spin"></span>{/if}
            {status.text}
          </p>

          {#if st && st.next && st.next.track}
            <p class="next muted"><span>Ensuite</span> {st.next.track.title}{st.next.track.artist ? ` — ${st.next.track.artist}` : ""}</p>
          {/if}

          <div class="controls">
            <label class="vol">
              <Icon name="volume" size={18} />
              <input type="range" min="0" max="1" step="0.01" value={$view ? $view.volume : 1} on:input={onVolume} aria-label="Volume" />
            </label>
            <button class="ghost" class:on={showLatency} on:click={() => (showLatency = !showLatency)}>
              <Icon name="timer" size={16} /> Décalage{latencyDraft ? ` ${latencyDraft > 0 ? "+" : ""}${latencyDraft} ms` : ""}
            </button>
          </div>

          {#if showLatency}
            <div class="latency" transition:fade={{ duration: 120 }}>
              <p class="muted">
                Cet appareil sonne en retard sur les autres (enceinte Bluetooth, barre de son) ? Avancez-le.
                En avance ? Retardez-le. Réglez à l'oreille, pièce silencieuse, deux appareils côte à côte.
              </p>
              <div class="steps">
                <button on:click={() => nudge(-10)} aria-label="Retarder de 10 ms">−10</button>
                <button on:click={() => nudge(-1)} aria-label="Retarder de 1 ms"><Icon name="minus" size={16} /></button>
                <span class="val">{latencyDraft > 0 ? "+" : ""}{latencyDraft} ms</span>
                <button on:click={() => nudge(1)} aria-label="Avancer de 1 ms"><Icon name="plus" size={16} /></button>
                <button on:click={() => nudge(10)} aria-label="Avancer de 10 ms">+10</button>
              </div>
              <div class="presets">
                <button on:click={resetLatency} disabled={!latencyDraft}>Remettre à zéro</button>
                <button on:click={() => nudge(150 - latencyDraft)}>Bluetooth (~150 ms)</button>
              </div>
            </div>
          {/if}
        {/if}
      </main>
    {/if}
  </div>

  {#if $view && $view.suspended && phase === "live"}
    <button class="resume" on:click={() => session && session.resume()} transition:fade={{ duration: 150 }}>
      <Icon name="play" size={28} />
      <span>Touchez pour reprendre le son</span>
    </button>
  {/if}
</div>

<style>
  .party {
    position: fixed;
    inset: 0;
    overflow: hidden;
    background: var(--bg);
    color: var(--text);
  }
  .bg {
    position: absolute;
    inset: 0;
    background-size: cover;
    background-position: center;
    filter: blur(60px) saturate(1.4) brightness(0.55);
    transform: scale(1.3);
  }
  .scrim {
    position: absolute;
    inset: 0;
    background: linear-gradient(180deg, rgba(15, 13, 19, 0.35) 0%, rgba(15, 13, 19, 0.8) 70%, var(--bg) 100%);
  }
  .frame {
    position: relative;
    height: 100%;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    padding: max(16px, env(safe-area-inset-top)) 20px max(24px, env(safe-area-inset-bottom));
  }
  .top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    max-width: 960px;
    width: 100%;
    margin: 0 auto;
    min-height: 40px;
  }
  .brand {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-weight: 800;
    letter-spacing: -0.01em;
  }
  .leave {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 8px 14px;
    border-radius: 999px;
    color: var(--text);
    background: rgba(255, 255, 255, 0.08);
    font-weight: 600;
    font-size: 0.88rem;
  }
  .leave:hover {
    background: rgba(255, 255, 255, 0.14);
  }

  .center {
    flex: 1;
    display: grid;
    place-items: center;
    align-content: center;
    gap: 14px;
    text-align: center;
  }
  .msg h1 {
    margin: 0;
    font-size: 1.5rem;
    font-weight: 800;
  }
  .msg p {
    margin: 0;
    max-width: 32ch;
    line-height: 1.5;
  }
  .big-ic {
    width: 64px;
    height: 64px;
    border-radius: 20px;
    display: grid;
    place-items: center;
    color: #fff;
    background: linear-gradient(135deg, var(--accent), var(--accent-2));
  }

  .stage {
    flex: 1;
    width: 100%;
    max-width: 440px;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 22px;
    padding: 18px 0;
  }
  .art {
    width: min(78vw, 340px, 42vh);
    aspect-ratio: 1;
    margin: 0 auto;
    border-radius: 18px;
    overflow: hidden;
    background: var(--bg-card);
    box-shadow: 0 30px 70px rgba(0, 0, 0, 0.55);
  }
  .art img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .art-ph {
    width: 100%;
    height: 100%;
    display: grid;
    place-items: center;
    color: var(--text-dim);
    background: radial-gradient(120% 90% at 30% 20%, rgba(162, 56, 255, 0.22), transparent 60%),
      radial-gradient(100% 80% at 80% 90%, rgba(255, 0, 146, 0.16), transparent 60%), var(--bg-card);
  }
  /* The landing leads with the invitation and the button, so the art gives
     way first on a short phone rather than pushing "Rejoindre" off screen. */
  .landing .art {
    width: min(62vw, 280px, 34vh);
  }
  .meta {
    text-align: center;
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
  }
  .invite,
  .live {
    margin: 0 0 4px;
    font-size: 0.92rem;
    color: var(--text-dim);
  }
  .invite strong {
    color: var(--text);
  }
  .live {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #ff3b6b;
    animation: pulse 1.8s ease-out infinite;
  }
  .dot.paused {
    background: var(--text-dim);
    animation: none;
  }
  @keyframes pulse {
    0% {
      box-shadow: 0 0 0 0 rgba(255, 59, 107, 0.6);
    }
    70% {
      box-shadow: 0 0 0 7px rgba(255, 59, 107, 0);
    }
    100% {
      box-shadow: 0 0 0 0 rgba(255, 59, 107, 0);
    }
  }
  .title {
    margin: 0;
    font-size: clamp(1.3rem, 5vw, 1.7rem);
    font-weight: 800;
    letter-spacing: -0.02em;
    line-height: 1.2;
    overflow-wrap: anywhere;
  }
  .artist {
    margin: 0;
    font-size: 1rem;
    color: var(--text-dim);
  }

  .join {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: 0.82rem;
  }
  .field input {
    padding: 13px 14px;
    border-radius: 12px;
    border: 1px solid rgba(255, 255, 255, 0.12);
    background: rgba(0, 0, 0, 0.3);
    color: var(--text);
    font-size: 1rem;
  }
  .field input:focus {
    outline: none;
    border-color: var(--accent);
  }
  .hint {
    margin: 0;
    font-size: 0.8rem;
    line-height: 1.45;
    text-align: center;
  }
  .primary {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    padding: 12px 22px;
    border-radius: 999px;
    font-weight: 800;
    color: #fff;
    background: linear-gradient(90deg, var(--accent), var(--accent-2));
    box-shadow: 0 12px 30px rgba(162, 56, 255, 0.35);
  }
  .primary.big {
    min-height: 54px;
    font-size: 1.05rem;
  }
  .primary:hover {
    filter: brightness(1.08);
  }

  .progress {
    display: flex;
    flex-direction: column;
    gap: 7px;
  }
  .bar {
    height: 5px;
    border-radius: 3px;
    background: rgba(255, 255, 255, 0.16);
    overflow: hidden;
  }
  .bar span {
    display: block;
    height: 100%;
    border-radius: 3px;
    background: linear-gradient(90deg, var(--accent), var(--accent-2));
    transition: width 0.25s linear;
  }
  .times {
    display: flex;
    justify-content: space-between;
    font-size: 0.75rem;
    color: var(--text-dim);
    font-variant-numeric: tabular-nums;
  }
  .status {
    margin: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    font-size: 0.88rem;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    min-height: 1.4em;
  }
  .status.ok {
    color: #3ddc97;
  }
  .status.wait {
    color: var(--text-dim);
  }
  .status.warn {
    color: #ffc857;
  }
  .mini-spin {
    width: 12px;
    height: 12px;
    border-radius: 50%;
    border: 2px solid rgba(255, 255, 255, 0.2);
    border-top-color: var(--text);
    animation: spin 0.8s linear infinite;
  }
  .next {
    margin: -8px 0 0;
    text-align: center;
    font-size: 0.84rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .next span {
    font-size: 0.7rem;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    margin-right: 6px;
  }

  .controls {
    display: flex;
    align-items: center;
    gap: 16px;
  }
  .vol {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 10px;
    color: var(--text-dim);
  }
  .vol input {
    flex: 1;
    -webkit-appearance: none;
    appearance: none;
    height: 4px;
    border-radius: 2px;
    background: rgba(255, 255, 255, 0.2);
  }
  .vol input::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: #fff;
  }
  .vol input::-moz-range-thumb {
    width: 16px;
    height: 16px;
    border: none;
    border-radius: 50%;
    background: #fff;
  }
  .ghost {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 9px 14px;
    border-radius: 999px;
    border: 1px solid rgba(255, 255, 255, 0.14);
    color: var(--text);
    font-size: 0.85rem;
    font-weight: 600;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }
  .ghost.on,
  .ghost:hover {
    background: rgba(255, 255, 255, 0.08);
  }

  .latency {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 14px;
    border-radius: 14px;
    background: rgba(0, 0, 0, 0.3);
    border: 1px solid rgba(255, 255, 255, 0.08);
  }
  .latency p {
    margin: 0;
    font-size: 0.82rem;
    line-height: 1.45;
  }
  .steps {
    display: grid;
    grid-template-columns: 52px 44px 1fr 44px 52px;
    align-items: center;
    gap: 8px;
  }
  .steps button {
    height: 44px;
    border-radius: 12px;
    background: rgba(255, 255, 255, 0.08);
    color: var(--text);
    font-weight: 700;
    display: grid;
    place-items: center;
  }
  .steps button:hover {
    background: rgba(255, 255, 255, 0.14);
  }
  .val {
    text-align: center;
    font-weight: 800;
    font-size: 1.05rem;
    font-variant-numeric: tabular-nums;
  }
  .presets {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  .presets button {
    padding: 7px 12px;
    border-radius: 999px;
    font-size: 0.8rem;
    color: var(--text-dim);
    border: 1px solid rgba(255, 255, 255, 0.12);
  }
  .presets button:hover:not(:disabled) {
    color: var(--text);
  }
  .presets button:disabled {
    opacity: 0.4;
  }

  .resume {
    position: fixed;
    inset: 0;
    display: grid;
    place-items: center;
    align-content: center;
    gap: 14px;
    background: rgba(8, 6, 12, 0.78);
    backdrop-filter: blur(8px);
    color: #fff;
    font-weight: 700;
    font-size: 1.05rem;
    z-index: 5;
  }
  .spinner {
    width: 28px;
    height: 28px;
    border-radius: 50%;
    border: 3px solid rgba(255, 255, 255, 0.15);
    border-top-color: var(--accent);
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  /* Wide screens: art beside the controls, the way a desktop now-playing reads. */
  @media (min-width: 900px) {
    .stage:not(.landing) {
      max-width: 880px;
      display: grid;
      grid-template-columns: minmax(0, 380px) 1fr;
      grid-template-rows: auto;
      column-gap: 48px;
      row-gap: 18px;
      align-content: center;
      align-items: start;
    }
    .stage:not(.landing) .art {
      grid-row: 1 / span 7;
      width: 100%;
      max-width: 380px;
    }
    .stage:not(.landing) .meta {
      text-align: left;
    }
    .stage:not(.landing) .live {
      justify-content: flex-start;
    }
    .stage:not(.landing) .status,
    .stage:not(.landing) .next {
      justify-content: flex-start;
      text-align: left;
    }
  }
</style>
