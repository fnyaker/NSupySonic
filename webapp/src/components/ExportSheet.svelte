<script>
  // Export a playlist / album / your favorites: as AUDIO (one ZIP, in a format
  // you pick — a USB stick, another player, a car radio), to one of your
  // accounts on another SERVICE (Spotify, YouTube Music, the server's Deezer),
  // or as a LIST file (CSV for TuneMyMusic/Soundiiz — the way to Apple Music —,
  // XSPF for desktop players). The ZIP is a normal browser download; the
  // service export is a job on the server, followed here.
  import { onDestroy } from "svelte";
  import { fade, scale } from "svelte/transition";
  import { push } from "svelte-spa-router";
  import { api } from "../lib/api.js";
  import { exportSheet, closeExport, toasts } from "../lib/stores.js";
  import { services, loadServices, linkSpotify, jobSummary } from "../lib/services.js";
  import { online } from "../lib/net.js";
  import Icon from "./Icon.svelte";

  let formats = [];
  let fmt = null;
  let loading = true;
  let started = false;
  let loadedFor = null;

  // Remembered for the session: whoever exports to Spotify once does it again.
  let mode = "audio";
  let service = null;
  let listFmt = "csv";
  let name = "";
  let isPublic = false;
  let job = null;
  let jobId = null;
  let poll = null;
  let sending = false;
  let showMissing = false;

  $: target = $exportSheet;
  $: if (target && loadedFor !== target) open(target);
  $: if (!target) started = false;
  $: listable = target && target.kind !== "podcast";

  function open(t) {
    loadedFor = t;
    started = false;
    name = t.title || "";
    if (!job || !job.running) resetJob();
    if (t.kind === "podcast") mode = "audio";
    loadFormats();
    if (t.kind !== "podcast") loadServices(true);
  }

  async function loadFormats() {
    loading = true;
    try {
      const r = await api.exportFormats();
      formats = r.formats || [];
      // Keep the user's previous pick when the server still offers it.
      if (!fmt || !formats.some((f) => f.id === fmt)) fmt = r.default || formats[0]?.id;
    } catch {
      formats = [];
    }
    loading = false;
  }

  // Navigating to the URL hands the transfer to the browser's own download
  // manager — the right tool for something that can be several GB and take
  // minutes. A fetch+Blob would have to hold the whole archive in memory first.
  function start() {
    if (!fmt || !target) return;
    started = true;
    window.location.href = api.exportUrl(target.kind, target.id, fmt);
    toasts.push("Export lancé — voir les téléchargements du navigateur");
    setTimeout(closeExport, 1200);
  }

  function downloadList() {
    if (!target) return;
    window.location.href = api.listFileUrl(target.kind, target.id, listFmt);
  }

  // -- to a service --

  $: svcList = ($services?.services || []).filter((s) => s.id !== "apple");
  $: usable = svcList.filter((s) => s.linked);
  $: if (usable.length && !usable.some((s) => s.id === service)) service = usable[0].id;
  $: chosen = svcList.find((s) => s.id === service);

  function resetJob() {
    clearTimeout(poll);
    job = null;
    jobId = null;
    showMissing = false;
  }

  async function send() {
    if (!chosen || !target || sending) return;
    sending = true;
    resetJob();
    try {
      const r = await api.exportToService(chosen.id, target.kind, target.id, name.trim(), isPublic);
      jobId = r.job;
      job = { running: true, stage: "match", total: 0, done: 0, matched: 0 };
      follow();
    } catch (e) {
      toasts.push(e?.message || "Export impossible");
      if (e?.status === 409) loadServices(true);
    }
    sending = false;
  }

  async function follow() {
    if (!jobId) return;
    try {
      job = await api.serviceExportJob(jobId);
    } catch {
      /* a missed poll: the next one catches up */
    }
    if (job?.running) poll = setTimeout(follow, 800);
    else if (job?.relink) loadServices(true);
  }

  onDestroy(() => clearTimeout(poll));

  function copyMissing() {
    const text = (job?.missing || []).map((m) => [m.artist, m.title].filter(Boolean).join(" - ")).join("\n");
    navigator.clipboard?.writeText(text).then(
      () => toasts.push("Liste copiée"),
      () => {},
    );
  }

  function toSettings() {
    closeExport();
    push("/settings");
  }

  async function connectSpotify() {
    try {
      await linkSpotify();
    } catch (e) {
      toasts.push(e?.message || "Spotify indisponible");
    }
  }

  function onKey(e) {
    if (e.key === "Escape") closeExport();
  }

  $: label =
    target?.kind === "album"
      ? "cet album"
      : target?.kind === "favorites"
        ? "vos favoris"
        : target?.kind === "podcast"
          ? "ce podcast"
          : "cette playlist";
  $: pct = job && job.total ? Math.round((100 * job.done) / job.total) : 0;
  $: listFormats = $services?.formats || [
    { id: "csv", label: "CSV (TuneMyMusic, Soundiiz…)", ext: "csv" },
    { id: "xspf", label: "XSPF (VLC, lecteurs)", ext: "xspf" },
    { id: "txt", label: "Texte « Artiste - Titre »", ext: "txt" },
  ];
</script>

<svelte:window on:keydown={onKey} />

{#if target}
  <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
  <div class="overlay" transition:fade={{ duration: 150 }} on:click|self={closeExport}>
    <div class="sheet" transition:scale={{ duration: 160, start: 0.97 }}>
      <header>
        <div class="ttl">
          <h2>Exporter</h2>
          <p class="muted">{label[0].toUpperCase() + label.slice(1)}{target.title ? ` — « ${target.title} »` : ""}</p>
        </div>
        <button class="close" on:click={closeExport} aria-label="Fermer"><Icon name="close" size={20} /></button>
      </header>

      {#if listable}
        <div class="seg" role="tablist">
          <button role="tab" aria-selected={mode === "service"} class:sel={mode === "service"} on:click={() => (mode = "service")}>Service</button>
          <button role="tab" aria-selected={mode === "audio"} class:sel={mode === "audio"} on:click={() => (mode = "audio")}>Audio (ZIP)</button>
          <button role="tab" aria-selected={mode === "list"} class:sel={mode === "list"} on:click={() => (mode = "list")}>Liste</button>
        </div>
      {/if}

      <div class="body">
      {#if mode === "audio" || !listable}
        {#if loading}
          <p class="muted pad">Chargement des formats…</p>
        {:else if !formats.length}
          <p class="muted pad">Aucun format d'export disponible sur ce serveur.</p>
        {:else}
          <div class="fmts">
            {#each formats as f (f.id)}
              <button class="fmt" class:sel={fmt === f.id} on:click={() => (fmt = f.id)}>
                <span class="fname">{f.label}</span>
                <span class="fext muted">.{f.ext}</span>
                {#if fmt === f.id}<span class="tick"><Icon name="check" size={15} /></span>{/if}
              </button>
            {/each}
          </div>
          <p class="muted note">
            <Icon name="download" size={14} />
            Un fichier ZIP avec un fichier par titre (numérotés, « Artiste - Titre ») et
            une playlist .m3u. Les titres pas encore archivés sont récupérés au
            passage, donc un gros export peut prendre un moment — le téléchargement
            démarre immédiatement et se poursuit en arrière-plan.
          </p>
        {/if}
      {:else if mode === "list"}
        <div class="fmts">
          {#each listFormats as f (f.id)}
            <button class="fmt" class:sel={listFmt === f.id} on:click={() => (listFmt = f.id)}>
              <span class="fname">{f.label}</span>
              <span class="fext muted">.{f.ext}</span>
              {#if listFmt === f.id}<span class="tick"><Icon name="check" size={15} /></span>{/if}
            </button>
          {/each}
        </div>
        <p class="muted note">
          <Icon name="info" size={14} />
          Le nom des titres, pas leur son. Pour Apple Music, Tidal ou Amazon Music
          (qui n'ouvrent pas leur API)&nbsp;: importez le CSV sur TuneMyMusic ou
          Soundiiz, qui le recréent là-bas — l'ISRC qu'il contient rend la
          correspondance exacte.
        </p>
      {:else}
        {#if !$services}
          <p class="muted pad">Chargement des services…</p>
        {:else if job}
          <div class="job">
            <div class="jhead">
              <span class="jname">{chosen?.name || ""}</span>
              {#if job.running}
                <span class="muted">{job.stage === "create" ? "Création de la playlist…" : `Recherche ${job.done} / ${job.total}`}</span>
              {/if}
            </div>
            {#if job.running}
              <div class="bar" role="progressbar" aria-valuenow={pct} aria-valuemin="0" aria-valuemax="100"><span style="width:{job.stage === "create" ? 100 : pct}%"></span></div>
              <p class="muted small">{job.matched} trouvé{job.matched > 1 ? "s" : ""} pour l'instant. Vous pouvez fermer : l'export continue sur le serveur.</p>
            {:else}
              <p class:err={job.error} class="result">
                <Icon name={job.error ? "alert" : "check"} size={16} />
                <span>{jobSummary(job)}</span>
              </p>
              {#if job.url}
                <a class="pill open" href={job.url} target="_blank" rel="noopener noreferrer"><Icon name="open" size={16} /> Ouvrir sur {chosen?.name}</a>
              {/if}
              {#if job.missing_count}
                <button class="linkish" on:click={() => (showMissing = !showMissing)}>
                  <Icon name={showMissing ? "chevronUp" : "chevronDown"} size={15} />
                  {showMissing ? "Masquer" : "Voir"} les titres introuvables
                </button>
                {#if showMissing}
                  <ul class="missing">
                    {#each job.missing as m, i (i)}
                      <li><span class="mt">{m.title}</span><span class="muted ma">{m.artist}</span></li>
                    {/each}
                    {#if job.missing_count > job.missing.length}
                      <li class="muted">… et {job.missing_count - job.missing.length} autres</li>
                    {/if}
                  </ul>
                  <button class="linkish" on:click={copyMissing}><Icon name="copy" size={15} /> Copier la liste</button>
                {/if}
              {/if}
            {/if}
          </div>
        {:else}
          <div class="svcs" role="radiogroup" aria-label="Service">
            {#each svcList as s (s.id)}
              {#if s.linked}
                <button class="fmt" role="radio" aria-checked={service === s.id} class:sel={service === s.id} on:click={() => (service = s.id)}>
                  <Icon name={s.id === "youtube" ? "youtube" : "music"} size={17} />
                  <span class="fname">{s.name}</span>
                  <span class="fext muted acc">{s.id === "deezer" ? "compte du serveur" : s.account || ""}</span>
                  {#if service === s.id}<span class="tick"><Icon name="check" size={15} /></span>{/if}
                </button>
              {:else}
                <div class="fmt off">
                  <Icon name={s.id === "youtube" ? "youtube" : "music"} size={17} />
                  <span class="fname">{s.name}</span>
                  {#if s.id === "spotify" && s.ready}
                    <button class="mini" on:click={connectSpotify}>Relier</button>
                  {:else if s.id === "youtube" && s.ready}
                    <button class="mini" on:click={toSettings}>Relier…</button>
                  {:else}
                    <span class="fext muted acc">{s.id === "spotify" ? "pas configuré" : "indisponible"}</span>
                  {/if}
                </div>
              {/if}
            {/each}
            <button class="fmt off as-link" on:click={() => (mode = "list")}>
              <Icon name="music" size={17} />
              <span class="fname">Apple Music, Tidal…</span>
              <span class="fext muted acc">par fichier CSV</span>
            </button>
          </div>
          {#if usable.length}
            <label class="field">
              <span class="muted">Nom de la playlist</span>
              <input type="text" bind:value={name} maxlength="100" placeholder={target.title || "Playlist"} />
            </label>
            <label class="check">
              <input type="checkbox" bind:checked={isPublic} />
              <span>Playlist publique</span>
            </label>
          {/if}
        {/if}
      {/if}
      </div>

      <footer>
        {#if mode === "service" && listable}
          {#if job && !job.running}
            <button class="ghost" on:click={resetJob}>Autre export</button>
            <button class="pill" on:click={closeExport}>Terminé</button>
          {:else}
            <button class="ghost" on:click={closeExport}>{job?.running ? "Fermer" : "Annuler"}</button>
            <button class="pill" on:click={send} disabled={!chosen || !chosen.linked || sending || job?.running || !$online}>
              <Icon name="upload" size={17} />
              Exporter{#if chosen}<span class="to">&nbsp;vers {chosen.name}</span>{/if}
            </button>
          {/if}
        {:else if mode === "list" && listable}
          <button class="ghost" on:click={closeExport}>Annuler</button>
          <button class="pill" on:click={downloadList} disabled={!$online}>
            <Icon name="download" size={17} />
            Télécharger la liste
          </button>
        {:else}
          <button class="ghost" on:click={closeExport}>Annuler</button>
          <button class="pill" on:click={start} disabled={!fmt || loading || started || !$online}>
            <Icon name="download" size={17} />
            {started ? "Démarré…" : "Télécharger le ZIP"}
          </button>
        {/if}
      </footer>
    </div>
  </div>
{/if}

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.6);
    display: grid;
    place-items: center;
    z-index: 300;
    padding: 20px;
  }
  .sheet {
    background: var(--bg-elev);
    border-radius: 16px;
    width: min(460px, 100%);
    max-height: 86vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    box-shadow: 0 30px 80px rgba(0, 0, 0, 0.55);
  }
  header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    padding: 18px 20px 12px;
  }
  .ttl h2 {
    margin: 0;
    font-size: 1.15rem;
  }
  .ttl p {
    margin: 4px 0 0;
    font-size: 0.85rem;
  }
  .close {
    flex: none;
    color: var(--text-dim);
  }
  .close:hover {
    color: var(--text);
  }
  .pad {
    padding: 8px 20px 20px;
  }
  .fmts {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 4px 14px;
    overflow-y: auto;
  }
  .fmt {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    text-align: left;
    padding: 12px 14px;
    border-radius: 10px;
    border: 1px solid transparent;
    background: var(--bg);
    color: var(--text);
  }
  .fmt:hover {
    background: var(--bg-hover);
  }
  .fmt.sel {
    border-color: var(--accent);
    background: var(--bg-hover);
  }
  .fname {
    font-weight: 600;
  }
  .fext {
    font-size: 0.8rem;
    font-variant-numeric: tabular-nums;
  }
  .tick {
    margin-left: auto;
    color: var(--accent);
    display: flex;
  }
  .note {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    font-size: 0.78rem;
    line-height: 1.45;
    margin: 14px 20px 0;
  }
  .note :global(svg) {
    flex: none;
    margin-top: 2px;
  }
  footer {
    display: flex;
    justify-content: flex-end;
    align-items: center;
    gap: 10px;
    padding: 16px 20px;
    margin-top: 6px;
    border-top: 1px solid var(--bg-hover);
  }
  .ghost {
    color: var(--text-dim);
    padding: 8px 12px;
  }
  .ghost:hover {
    color: var(--text);
  }
  .pill {
    gap: 8px;
  }
  .pill:disabled {
    opacity: 0.5;
    cursor: default;
    transform: none;
  }
  .seg {
    display: flex;
    gap: 4px;
    margin: 0 16px 10px;
    padding: 4px;
    background: var(--bg);
    border-radius: 12px;
  }
  .seg button {
    flex: 1 1 0;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    padding: 9px 4px;
    border-radius: 9px;
    font-weight: 600;
    font-size: 0.85rem;
    color: var(--text-dim);
    white-space: nowrap;
  }
  .seg button.sel {
    background: var(--bg-hover);
    color: var(--text);
  }
  footer .pill {
    white-space: nowrap;
  }
  /* A phone's footer holds "Annuler" and one button: the service is already
     ticked right above it, so the button says only what it does. */
  @media (max-width: 440px) {
    .to {
      display: none;
    }
  }
  .body {
    overflow-y: auto;
    min-height: 0;
  }
  .svcs {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 4px 14px;
  }
  .fmt.off {
    color: var(--text-dim);
    cursor: default;
  }
  .fmt.as-link {
    cursor: pointer;
  }
  .acc {
    margin-left: auto;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .fmt .acc + .tick {
    margin-left: 8px;
  }
  .mini {
    margin-left: auto;
    padding: 6px 14px;
    border-radius: 999px;
    border: 1px solid var(--bg-hover);
    font-weight: 600;
    font-size: 0.8rem;
    color: var(--text);
  }
  .mini:hover {
    border-color: var(--text-dim);
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin: 14px 20px 0;
    font-size: 0.8rem;
  }
  .field input {
    background: var(--bg);
    color: var(--text);
    border: 1px solid var(--bg-hover);
    border-radius: 10px;
    padding: 10px 12px;
    font-size: 0.95rem;
  }
  .field input:focus {
    outline: none;
    border-color: var(--accent);
  }
  .check {
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 12px 20px 0;
    font-size: 0.9rem;
    min-height: 32px;
  }
  .job {
    padding: 4px 20px 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .jhead {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 10px;
    font-size: 0.9rem;
  }
  .jname {
    font-weight: 700;
  }
  .bar {
    height: 6px;
    border-radius: 3px;
    background: var(--bg-hover);
    overflow: hidden;
  }
  .bar span {
    display: block;
    height: 100%;
    background: linear-gradient(90deg, var(--accent), var(--accent-2));
    transition: width 0.4s ease;
  }
  .small {
    font-size: 0.78rem;
    margin: 0;
  }
  .result {
    display: flex;
    gap: 8px;
    align-items: flex-start;
    margin: 0;
    font-weight: 600;
    line-height: 1.4;
  }
  .result :global(svg) {
    flex: none;
    margin-top: 2px;
    color: var(--accent);
  }
  .result.err :global(svg) {
    color: #ff6b6b;
  }
  .open {
    align-self: flex-start;
    text-decoration: none;
  }
  .linkish {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    align-self: flex-start;
    color: var(--text-dim);
    font-size: 0.85rem;
    font-weight: 600;
    padding: 4px 0;
  }
  .linkish:hover {
    color: var(--text);
  }
  .missing {
    list-style: none;
    margin: 0;
    padding: 8px 12px;
    background: var(--bg);
    border-radius: 10px;
    max-height: 220px;
    overflow-y: auto;
    font-size: 0.85rem;
  }
  .missing li {
    display: flex;
    flex-direction: column;
    padding: 5px 0;
  }
  .missing li + li {
    border-top: 1px solid var(--bg-hover);
  }
  .mt {
    font-weight: 600;
  }
  .ma {
    font-size: 0.78rem;
  }
</style>
