<script>
  // Import a playlist somebody shared: paste the link, the server reads it and
  // finds each title (your library first, then Deezer, then YouTube), and the
  // result plays at once. It is TEMPORARY until "Enregistrer" makes it one of
  // your playlists. See supysonic/webui/playlist_import.py.
  import { onDestroy } from "svelte";
  import { push } from "svelte-spa-router";
  import { api } from "../lib/api.js";
  import { player, isAdmin, toasts } from "../lib/stores.js";
  import { invalidatePlaylists, upsertPlaylistLocal } from "../lib/actions.js";
  import { rememberScreen, recallScreen } from "../lib/nav.js";
  import { duration as fmtDuration } from "../lib/format.js";
  import { CAN_KEEP } from "../lib/remote/mode.js";
  import { playlistLink } from "../lib/linkimport.js";
  import Cover from "../components/Cover.svelte";
  import GradientHeader from "../components/GradientHeader.svelte";
  import TrackBrowser from "../components/TrackBrowser.svelte";
  import Icon from "../components/Icon.svelte";
  import VirtualList from "../components/VirtualList.svelte";

  export let params = {};

  const POLL_MS = 700;
  const RUNNING = new Set(["reading", "matching", "saving"]);
  const VIA = { local: "dans ta bibliothèque", deezer: "sur Deezer", youtube: "sur YouTube" };

  const saved = recallScreen();
  let link = saved?.link ?? "";
  let jobId = saved?.jobId ?? null;
  let job = saved?.job ?? null;
  let error = "";
  let starting = false;
  let timer = null;
  let alive = true;

  // Keeping it: the name field opens under the header.
  let keeping = false;
  let title = "";

  $: rememberScreen({ link, jobId, job });

  // #/import/<url>: the search box (or a share target) handed us a link.
  let appliedParam = saved ? params.url : null;
  $: if (params.url && params.url !== appliedParam) {
    appliedParam = params.url;
    let url = params.url;
    try {
      url = decodeURIComponent(url);
    } catch {
      /* keep it as it came */
    }
    link = url;
    start();
  }
  // A restored screen whose job was still running: follow it again.
  if (job && RUNNING.has(job.state)) schedule(0);

  $: recognised = playlistLink(link);

  async function start() {
    const url = link.trim();
    if (!url || starting) return;
    starting = true;
    error = "";
    keeping = false;
    job = null;
    jobId = null;
    try {
      const r = await api.importPlaylist(url);
      jobId = r.id;
      job = { state: "reading", done: 0, total: 0 };
      schedule(0);
    } catch (e) {
      error = e?.message && e.message !== "network" ? e.message : "Le serveur ne répond pas";
    } finally {
      starting = false;
    }
  }

  function schedule(ms) {
    clearTimeout(timer);
    timer = setTimeout(poll, ms);
  }

  async function poll() {
    if (!alive || !jobId) return;
    const mine = jobId;
    try {
      const r = await api.importStatus(mine);
      if (!alive || mine !== jobId) return;
      // A save's polls carry no item list (it does not change while saving):
      // keep the one on screen rather than re-render it every poll.
      job = r.items || !job ? r : { ...r, items: job.items };
      if (RUNNING.has(r.state)) schedule(POLL_MS);
      else if (r.state === "saved") onSaved(r);
    } catch (e) {
      if (!alive || mine !== jobId) return;
      if (e?.status === 404) {
        // The server restarted, or the import sat unsaved for hours.
        job = null;
        jobId = null;
        error = "Cet import a expiré : relance-le.";
      } else {
        schedule(POLL_MS * 3);
      }
    }
  }

  onDestroy(() => {
    alive = false;
    clearTimeout(timer);
  });

  $: items = job?.items || [];
  $: tracks = items.filter((i) => i.track).map((i) => i.track);
  $: missing = items.filter((i) => !i.track);
  $: unsure = items.filter((i) => i.track && !i.sure);
  $: total = tracks.reduce((s, t) => s + (t.duration || 0), 0);
  $: ctx = { kind: "import", id: jobId };
  $: progress = job?.total ? Math.min(1, (job.done || 0) / job.total) : 0;
  $: canKeep = $isAdmin && CAN_KEEP;

  function playAll() {
    if (tracks.length) player.playQueue(tracks, 0, ctx);
  }
  function shufflePlay() {
    if (tracks.length) player.shufflePlay(tracks, ctx);
  }

  function openKeep() {
    title = job?.name || "";
    keeping = true;
  }

  async function keep() {
    if (!jobId) return;
    try {
      await api.importSave(jobId, title.trim() || job?.name || "");
      job = { ...job, state: "saving" };
      keeping = false;
      schedule(0);
    } catch (e) {
      toasts.push(e?.message || "Impossible d'enregistrer la playlist", "error");
    }
  }

  function onSaved(r) {
    upsertPlaylistLocal({ id: r.playlist_id, title: title.trim() || r.name, nb_tracks: tracks.length });
    invalidatePlaylists();
    toasts.push("Playlist enregistrée dans ta bibliothèque");
  }

  function searchFor(line) {
    const q = [line.artists?.[0], line.title].filter(Boolean).join(" ");
    push("/search/" + encodeURIComponent(q));
  }

  function onKey(e) {
    if (e.key === "Enter") start();
  }

  function artists(line) {
    return (line.artists || []).join(", ");
  }
</script>

{#if !job || job.state === "error" || error}
  <div class="intro fade-in">
    <h1>Importer une playlist</h1>
    <p class="muted lead">
      Colle le lien d'une playlist qu'on t'a partagée : Deezer, Spotify, YouTube ou Apple Music. Chaque titre est
      retrouvé (ta bibliothèque d'abord), tu l'écoutes tout de suite, et tu la gardes seulement si tu veux.
    </p>
    <div class="bar">
      <input
        type="url"
        inputmode="url"
        enterkeyhint="go"
        placeholder="https://open.spotify.com/playlist/…"
        bind:value={link}
        on:keydown={onKey}
        aria-label="Lien de la playlist"
      />
      <button class="pill go" on:click={start} disabled={!link.trim() || starting}>
        <Icon name="link" size={17} /> {starting ? "…" : "Importer"}
      </button>
    </div>
    {#if recognised && !error && !(job?.state === "error")}
      <p class="detected muted">Lien {recognised.label} reconnu.</p>
    {/if}
    {#if error || job?.state === "error"}
      <p class="err" role="alert"><Icon name="alert" size={16} /> {error || job.error}</p>
    {/if}
    <ul class="sources muted">
      <li>Deezer</li>
      <li>Spotify</li>
      <li>YouTube et YouTube Music</li>
      <li>Apple Music</li>
    </ul>
  </div>
{:else if RUNNING.has(job.state) && job.state !== "saving"}
  <div class="working fade-in" aria-live="polite">
    {#if job.cover}
      <div class="wart"><Cover src={job.cover} alt="" kind="playlist" eager /></div>
    {/if}
    <div class="wmeta">
      <span class="kind">{job.source_label || "Import"}</span>
      <h1>{job.name || "Lecture de la playlist…"}</h1>
      {#if job.state === "reading"}
        <p class="muted">Lecture de la playlist…</p>
        <div class="track indeterminate"><span></span></div>
      {:else}
        <p class="muted">
          Recherche des titres · {job.done} / {job.total}
          {#if job.matched}<span class="dot">·</span> {job.matched} trouvés{/if}
        </p>
        <div class="track"><span style={`transform:scaleX(${progress})`}></span></div>
      {/if}
    </div>
  </div>
{:else}
  <div class="fade-in">
    <GradientHeader cover={job.cover}>
      <div class="art"><Cover src={job.cover || tracks[0]?.album?.cover} alt={job.name} kind="playlist" eager /></div>
      <div class="meta">
        <span class="kind">
          {job.state === "saved" ? "Playlist enregistrée" : "Playlist importée"} · {job.source_label}
        </span>
        <h1>{job.name}</h1>
        <span class="muted">
          {tracks.length} titre{tracks.length > 1 ? "s" : ""} sur {items.length} · {fmtDuration(total)}
        </span>
        {#if job.counts}
          <span class="chips">
            {#each Object.entries(job.counts) as [via, n]}
              <span class="chip">{n} {VIA[via] || via}</span>
            {/each}
            {#if missing.length}<span class="chip warn">{missing.length} introuvable{missing.length > 1 ? "s" : ""}</span>{/if}
          </span>
        {/if}
      </div>
    </GradientHeader>

    <div class="row actions">
      <button class="pill" on:click={playAll} disabled={!tracks.length}><Icon name="play" size={18} /> Lire</button>
      <button class="icon-btn" on:click={shufflePlay} disabled={!tracks.length} aria-label="Lecture aléatoire">
        <Icon name="shuffle" />
      </button>
      {#if job.state === "saved"}
        <button class="ghost" on:click={() => push("/playlist/" + job.playlist_id)}>
          <Icon name="check" size={17} /> Ouvrir la playlist
        </button>
      {:else if job.state === "saving"}
        <span class="muted saving">Enregistrement…</span>
      {:else if canKeep && tracks.length && !keeping}
        <button class="ghost" on:click={openKeep}><Icon name="plus" size={17} /> Enregistrer</button>
      {/if}
      <button class="ghost subtle" title="Importer un autre lien" aria-label="Importer un autre lien" on:click={() => { job = null; jobId = null; link = ""; }}>
        <Icon name="link" size={16} /> <span class="label">Autre lien</span>
      </button>
    </div>

    {#if keeping}
      <form class="keep" on:submit|preventDefault={keep}>
        <!-- svelte-ignore a11y-autofocus -->
        <input bind:value={title} maxlength="200" placeholder="Nom de la playlist" aria-label="Nom de la playlist" autofocus />
        <button class="pill" type="submit">Enregistrer</button>
        <button class="ghost" type="button" on:click={() => (keeping = false)}>Annuler</button>
      </form>
    {:else if job.state === "done"}
      <p class="note muted">
        Temporaire : elle reste ici tant que tu ne l'enregistres pas. Les titres se téléchargent quand tu les écoutes.
      </p>
    {/if}
    {#if job.error && job.state !== "error"}
      <p class="err small"><Icon name="info" size={15} /> {job.error}</p>
    {/if}
    {#if job.truncated}
      <p class="note muted">Seuls les {items.length} premiers titres de la playlist ont pu être lus.</p>
    {/if}

    {#if tracks.length}
      <TrackBrowser {tracks} context={ctx} />
    {/if}

    {#if unsure.length}
      <h2 class="sec">À vérifier <span class="count">{unsure.length}</span></h2>
      <p class="muted small">Retrouvés à peu près : même artiste, titre très proche.</p>
      <div class="lines">
        <VirtualList items={unsure} estimateHeight={64} key={(it, i) => i} let:item={it}>
          <div class="li">
            <span class="l-main">
              <span class="l-title">{it.line.title}</span>
              <span class="muted l-sub">{artists(it.line)}</span>
            </span>
            <span class="arrow muted" aria-hidden="true">→</span>
            <span class="l-main">
              <span class="l-title">{it.track.title}</span>
              <span class="muted l-sub">{it.track.display_artist || it.track.artist?.name || ""} · {VIA[it.via]}</span>
            </span>
          </div>
        </VirtualList>
      </div>
    {/if}

    {#if missing.length}
      <h2 class="sec">Introuvables <span class="count">{missing.length}</span></h2>
      <p class="muted small">Aucune version sûre de ces titres. Touche-en un pour le chercher toi-même.</p>
      <div class="lines">
        <VirtualList items={missing} estimateHeight={52} key={(it, i) => i} let:item={it}>
          <div class="li">
            <button class="l-btn" on:click={() => searchFor(it.line)}>
              <span class="l-main">
                <span class="l-title">{it.line.title}</span>
                <span class="muted l-sub">{artists(it.line)}{it.line.album ? " · " + it.line.album : ""}</span>
              </span>
              {#if it.line.duration}<span class="muted dur">{fmtDuration(it.line.duration)}</span>{/if}
              <Icon name="search" size={16} />
            </button>
          </div>
        </VirtualList>
      </div>
    {/if}
  </div>
{/if}

<style>
  .intro {
    max-width: 640px;
    padding-top: 8px;
  }
  h1 {
    font-size: clamp(1.8rem, 5vw, 3rem);
    overflow-wrap: anywhere;
  }
  .lead {
    margin: 10px 0 22px;
    line-height: 1.5;
  }
  .bar {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
  }
  .bar input,
  .keep input {
    flex: 1 1 220px;
    min-width: 0;
    padding: 14px 18px;
    border-radius: 999px;
    border: 1px solid transparent;
    background: var(--bg-card);
    color: var(--text);
    outline: none;
    font-size: 1rem;
  }
  .bar input:focus,
  .keep input:focus {
    border-color: var(--accent);
  }
  .go {
    gap: 8px;
    min-height: 48px;
    padding: 0 22px;
  }
  .pill:disabled {
    opacity: 0.5;
  }
  .detected {
    margin: 10px 4px 0;
    font-size: 0.88rem;
  }
  .err {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 14px 4px 0;
    color: var(--danger, #ff6b6b);
  }
  .err.small {
    font-size: 0.88rem;
    color: var(--text-dim);
  }
  .sources {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    list-style: none;
    padding: 0;
    margin: 26px 0 0;
  }
  .sources li {
    padding: 6px 12px;
    border-radius: 999px;
    background: var(--bg-card);
    font-size: 0.85rem;
  }

  .working {
    display: flex;
    align-items: center;
    gap: 28px;
    padding: 24px 0;
    max-width: 720px;
  }
  .wart {
    width: 160px;
    flex: none;
    border-radius: var(--radius);
    overflow: hidden;
    box-shadow: 0 16px 40px rgba(0, 0, 0, 0.45);
  }
  .wmeta {
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-width: 0;
    flex: 1;
  }
  .wmeta p {
    margin: 0;
  }
  .dot {
    margin: 0 2px;
  }
  .track {
    height: 6px;
    border-radius: 999px;
    background: var(--bg-card);
    overflow: hidden;
    max-width: 420px;
  }
  .track span {
    display: block;
    height: 100%;
    background: var(--accent);
    transform-origin: left;
    transition: transform 0.35s ease;
  }
  .track.indeterminate span {
    width: 35%;
    animation: slide 1.2s ease-in-out infinite;
  }
  @keyframes slide {
    from {
      transform: translateX(-100%);
    }
    to {
      transform: translateX(300%);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .track.indeterminate span {
      animation: none;
      width: 100%;
      opacity: 0.4;
    }
  }

  .art {
    width: 200px;
    flex: none;
    box-shadow: 0 16px 40px rgba(0, 0, 0, 0.5);
    border-radius: var(--radius);
    overflow: hidden;
  }
  .meta {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
    max-width: 60ch;
  }
  .kind {
    font-size: 0.8rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .chip {
    padding: 3px 10px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.1);
    font-size: 0.8rem;
  }
  .chip.warn {
    background: rgba(255, 170, 60, 0.18);
  }
  .actions {
    margin: 16px 0 12px;
    gap: 14px;
    flex-wrap: wrap;
    align-items: center;
  }
  .pill {
    gap: 8px;
  }
  .icon-btn {
    color: var(--text-dim);
  }
  .icon-btn:hover {
    color: var(--text);
  }
  .ghost {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    min-height: 40px;
    padding: 0 16px;
    border-radius: 999px;
    background: var(--bg-card);
    color: var(--text);
    font-weight: 600;
    font-size: 0.9rem;
  }
  .ghost:hover {
    background: var(--bg-hover);
  }
  .ghost.subtle {
    background: transparent;
    color: var(--text-dim);
  }
  .ghost.subtle:hover {
    color: var(--text);
  }
  .saving {
    font-size: 0.9rem;
  }
  .keep {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
    align-items: center;
    margin: 0 0 18px;
    max-width: 640px;
  }
  .note {
    margin: 0 0 16px;
    font-size: 0.88rem;
  }
  .small {
    font-size: 0.88rem;
  }
  .sec {
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 30px 0 4px;
    font-size: 1.25rem;
  }
  .count {
    font-size: 0.8rem;
    font-weight: 600;
    padding: 2px 9px;
    border-radius: 999px;
    background: var(--bg-card);
    color: var(--text-dim);
  }
  .lines {
    margin: 10px 0 0;
  }
  .lines .li {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 12px;
    border-radius: 10px;
  }
  .lines .li:hover {
    background: var(--bg-hover);
  }
  .lines .li:has(.l-btn) {
    padding: 0;
  }
  .l-btn {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    min-height: 52px;
    padding: 8px 12px;
    text-align: left;
    color: var(--text-dim);
    background: none;
  }
  .l-main {
    display: flex;
    flex-direction: column;
    min-width: 0;
    flex: 1;
  }
  .l-title {
    color: var(--text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .l-sub {
    font-size: 0.85rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .arrow {
    flex: none;
  }
  .dur {
    font-size: 0.85rem;
    font-variant-numeric: tabular-nums;
  }
  @media (max-width: 640px) {
    .art {
      width: 150px;
    }
    .ghost.subtle {
      padding: 0 12px;
    }
    .ghost.subtle .label {
      display: none;
    }
    .working {
      flex-direction: column;
      align-items: flex-start;
      gap: 18px;
    }
    .wart {
      width: 120px;
    }
  }
</style>
