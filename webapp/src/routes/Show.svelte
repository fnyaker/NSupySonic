<script>
  import { trackKey } from "../lib/trackkey.js";
  import { push } from "svelte-spa-router";
  import { REMOTE, CAN_KEEP, CAN_ADMIN, CAN_BROWSE } from "../lib/remote/mode.js";
  import { api } from "../lib/api.js";
  import { player, currentId, playing, isAdmin, toasts, seekTo, openMenu, openExport } from "../lib/stores.js";
  import { podcastProgress, setResumePoint } from "../lib/podcastProgress.js";
  import { episodeMarkers, loadShowMarkers, removeMarker } from "../lib/markers.js";
  import { buildTrackMenu } from "../lib/actions.js";
  import { downloadTrack } from "../lib/offline.js";
  import { duration as fmtDuration } from "../lib/format.js";
  import { onDestroy } from "svelte";
  import Cover from "../components/Cover.svelte";
  import GradientHeader from "../components/GradientHeader.svelte";
  import Skeleton from "../components/Skeleton.svelte";
  import Icon from "../components/Icon.svelte";

  export let params = {};

  let id = null;
  let data = null;
  let loading = true;
  let expanded = new Set();

  $: if (params.id && params.id !== id) {
    id = params.id;
    load(id);
  }

  let loadSeq = 0;
  async function load(pid) {
    const mine = ++loadSeq;
    archiving = false; // another show: its own count, not this one's
    clearTimeout(pollTimer);
    loading = true;
    data = null;
    loadShowMarkers(pid); // fail-soft, fills the markers store as it lands
    try {
      const r = await api.podcast(pid);
      if (mine === loadSeq) data = r;
    } catch {
      if (mine === loadSeq) data = null;
    }
    if (mine === loadSeq) loading = false;
  }

  $: episodes = data?.episodes || [];

  // -- "Archiver automatiquement les nouveaux épisodes" ------------------------
  // The show's own switch (Pocket Casts' per-podcast auto-download, design S16).
  // The click answers at once; the server then queues what this show is missing
  // on its background archiver (one file at a time, behind anything played), and
  // the line under the switch counts it in: "12 sur 40 épisodes archivés". While
  // that count moves, the page re-reads the show every few seconds — and stops
  // as soon as it is complete, stalls, or the page is hidden.
  let autoBusy = false;
  async function toggleAuto() {
    if (autoBusy || !data) return;
    const on = !data.auto_archive;
    const before = data;
    data = { ...data, auto_archive: on };
    autoBusy = true;
    try {
      const r = await api.setPodcastAutoArchive(data.id, on);
      if (data?.id === r.id) data = { ...data, auto_archive: r.auto_archive, archived_count: r.archived_count };
      if (on && r.queued) {
        toasts.push(`${r.queued} épisode${r.queued > 1 ? "s" : ""} en file d'archivage`);
        watchArchive();
      }
    } catch (e) {
      data = before;
      toasts.push(e?.message || "Réglage non enregistré", "error");
    } finally {
      autoBusy = false;
    }
  }

  const POLL_MS = 6000;
  const STALL_POLLS = 5; // ~30 s without a new file: stop asking
  let pollTimer = null;
  let stalled = 0;
  let archiving = false;
  function watchArchive() {
    clearTimeout(pollTimer);
    stalled = 0;
    archiving = true;
    pollTimer = setTimeout(pollArchive, POLL_MS);
  }
  async function pollArchive() {
    pollTimer = null;
    if (!data || !archiving) return;
    if (document.visibilityState === "hidden") {
      pollTimer = setTimeout(pollArchive, POLL_MS);
      return;
    }
    const pid = data.id;
    const was = data.archived_count;
    try {
      const r = await api.podcast(pid);
      if (data?.id !== pid) return;
      data = r;
      stalled = r.archived_count > was ? 0 : stalled + 1;
    } catch {
      stalled++;
    }
    const done = !data.auto_archive || data.archived_count >= reachable(data);
    if (done || stalled >= STALL_POLLS) archiving = false;
    else pollTimer = setTimeout(pollArchive, POLL_MS);
  }
  // Episodes Deezer no longer serves cannot be archived: they don't count
  // against "complete".
  function reachable(d) {
    const gone = (d?.episodes || []).filter((e) => e.unavailable && !e.archived).length;
    return Math.max(0, (d?.episode_count || 0) - gone);
  }
  onDestroy(() => clearTimeout(pollTimer));

  function playFrom(i) {
    if (episodes.length) player.playQueue(episodes, i, { kind: "podcast", id });
  }
  function playAll() {
    playFrom(0);
  }
  function toggle(i, ep) {
    if ($currentId === trackKey(ep)) player.toggle();
    else playFrom(i);
  }

  // Jump straight to a position inside an episode (a marker tap): the playing
  // episode just seeks; another episode records the target as its resume point
  // first, so the player's load lands exactly there.
  function playAt(i, ep, position) {
    if ($currentId === trackKey(ep)) {
      seekTo.set(position);
      player.play();
      return;
    }
    setResumePoint(trackKey(ep), position, ep.duration || 0);
    playFrom(i);
  }

  function episodeMenu(e, ep) {
    e.preventDefault();
    e.stopPropagation();
    const coords = { clientX: e.clientX, clientY: e.clientY, preventDefault() {}, stopPropagation() {} };
    openMenu(coords, buildTrackMenu(ep, push));
  }

  // Download every episode to the device, one at a time. Sequential on purpose:
  // an episode is tens of megabytes, and a show can hold hundreds of them —
  // firing them all at once would saturate the connection and the server's
  // archiver both. Already-downloaded episodes are skipped by downloadTrack.
  let dlBusy = false;
  let dlDone = 0;
  async function downloadAll() {
    if (dlBusy || !episodes.length) return;
    dlBusy = true;
    dlDone = 0;
    let failed = 0;
    try {
      for (const ep of episodes) {
        try {
          await downloadTrack(ep, null);
        } catch {
          failed++;
        }
        dlDone++;
      }
      toasts.push(
        failed
          ? `${episodes.length - failed} épisode(s) téléchargé(s), ${failed} en échec`
          : `${episodes.length} épisode(s) disponibles hors-ligne`,
        failed ? "error" : undefined
      );
    } finally {
      dlBusy = false;
    }
  }

  function toggleExpand(eid) {
    const n = new Set(expanded);
    n.has(eid) ? n.delete(eid) : n.add(eid);
    expanded = n;
  }

  async function unsubscribe() {
    if (!window.confirm("Se désabonner de ce podcast ?")) return;
    try {
      await api.unsubscribePodcast(id);
      toasts.push("Désabonné");
      push("/library/podcasts");
    } catch (e) {
      toasts.push(e?.message || "Échec", "error");
    }
  }

  // Resume state for an episode: fraction played (0..1), seconds remaining and
  // whether it was heard to the end. null when there's nothing to show.
  function resumeOf(ep) {
    const p = $podcastProgress[trackKey(ep)];
    if (!p || (!p.t && !p.done)) return null;
    if (p.done) return { done: true, pct: 1, left: 0 };
    const dur = p.d || ep.duration || 0;
    if (!dur) return { done: false, pct: 0, left: 0 };
    return {
      done: false,
      pct: Math.min(1, p.t / dur),
      left: Math.max(0, Math.round(dur - p.t)),
    };
  }

  function fmtDate(ts) {
    if (!ts) return "";
    try {
      return new Date(ts * 1000).toLocaleDateString("fr-FR", {
        day: "numeric",
        month: "short",
        year: "numeric",
      });
    } catch {
      return "";
    }
  }
</script>

{#if loading}
  <Skeleton kind="header" />
  <Skeleton kind="list" />
{:else if !data}
  <p class="muted">Podcast introuvable.</p>
{:else}
  <div class="fade-in">
    <GradientHeader cover={data.cover}>
      <div class="art"><Cover src={data.cover} alt={data.title} kind="podcast" fallbackId={data.id} eager /></div>
      <div class="meta">
        <span class="kind">Podcast{#if data.local} · Local{/if}</span>
        <h1>{data.title}</h1>
        <div class="sub muted">
          {episodes.length} épisode{episodes.length > 1 ? "s" : ""}
          {#if data.local}
            · {data.archived_count} archivé{data.archived_count > 1 ? "s" : ""} sur le serveur
          {/if}
        </div>
        {#if data.local}
          <p class="localnote">
            Ce podcast n'existe plus sur Deezer. Tout ce qui a été archivé reste
            ici, jouable et téléchargeable comme avant — c'est désormais un
            podcast local.
          </p>
        {/if}
        {#if data.description}<p class="desc">{data.description}</p>{/if}
      </div>
    </GradientHeader>

    <div class="row actions">
      <button class="pill" on:click={playAll} disabled={!episodes.length}>
        <Icon name="play" size={18} /> Lire
      </button>
      <button class="ghost-btn" on:click={downloadAll} disabled={!episodes.length || dlBusy}
              title="Télécharger tous les épisodes sur cet appareil (écoute hors-ligne)">
        <Icon name={dlBusy ? "downloaded" : "download"} size={17} />
        {dlBusy ? `${dlDone}/${episodes.length}…` : "Tout télécharger"}
      </button>
      {#if CAN_KEEP}
        <button class="ghost-btn" on:click={() => openExport("podcast", id, data.title)}
                disabled={!episodes.length} title="Exporter en ZIP (clé USB, autre lecteur…)">
          <Icon name="archive" size={17} /> Exporter
        </button>
      {/if}
      {#if $isAdmin && CAN_KEEP}
        <button class="icon-btn" on:click={unsubscribe} aria-label="Se désabonner" title="Se désabonner">
          <Icon name="trash" size={22} />
        </button>
      {/if}
    </div>

    {#if $isAdmin && CAN_ADMIN && !data.local}
      <button
        class="auto"
        role="switch"
        aria-checked={!!data.auto_archive}
        disabled={autoBusy}
        on:click={toggleAuto}
      >
        <span class="auto-ico"><Icon name="archive" size={18} /></span>
        <span class="auto-txt">
          <span class="auto-title">Archiver automatiquement les nouveaux épisodes</span>
          <span class="auto-hint muted">
            {data.auto_archive ? (archiving ? "Archivage en cours" : "Activé") : "Désactivé"}
            · {Math.min(data.archived_count, data.episode_count)} sur {data.episode_count} épisode{data.episode_count > 1 ? "s" : ""} archivé{data.archived_count > 1 ? "s" : ""} sur le serveur
          </span>
          {#if data.auto_archive && data.episode_count}
            <span class="auto-bar" aria-hidden="true">
              <span style={`width:${Math.min(100, (data.archived_count / data.episode_count) * 100)}%`}></span>
            </span>
          {/if}
        </span>
        <span class="sw" class:on={data.auto_archive}><span class="knob"></span></span>
      </button>
    {/if}

    {#if !episodes.length}
      <p class="muted">Aucun épisode disponible.</p>
    {:else}
      <ul class="episodes">
        {#each episodes as ep, i (trackKey(ep))}
          {@const active = $currentId === trackKey(ep)}
          {@const resume = resumeOf(ep)}
          {@const marks = $episodeMarkers[trackKey(ep)] || []}
          <li class:active>
            <button class="pl" on:click={() => toggle(i, ep)} aria-label="Lire l'épisode">
              <Icon name={active && $playing ? "pause" : "play"} size={18} />
            </button>
            <div class="body">
              <div class="top">
                <span class="etitle" class:on={active}>{ep.title}</span>
                <span class="side-r">
                  <span class="when muted">{fmtDate(ep.published)}</span>
                  <button class="emenu" on:click={(e) => episodeMenu(e, ep)} aria-label="Options de l'épisode">
                    <Icon name="moreVertical" size={17} />
                  </button>
                </span>
              </div>
              {#if ep.description}
                <button
                  type="button"
                  class="edesc"
                  class:clamped={!expanded.has(trackKey(ep))}
                  on:click={() => toggleExpand(trackKey(ep))}
                >
                  {ep.description}
                </button>
              {/if}
              <div class="foot muted">
                {#if resume?.done}
                  <span class="doneb"><Icon name="check" size={13} /> Terminé</span>
                {:else if resume}
                  <span class="resume">Reprendre · il reste {fmtDuration(resume.left)}</span>
                {:else}
                  {fmtDuration(ep.duration)}
                {/if}
                {#if ep.status === "completed"}· <Icon name="downloaded" size={14} />{/if}
                {#if ep.unavailable}
                  · <span class="gone"><Icon name="alert" size={13} /> non archivé</span>
                {/if}
              </div>
              {#if resume && !resume.done}
                <div class="ebar"><span style={`width:${resume.pct * 100}%`}></span></div>
              {/if}
              {#if marks.length}
                <div class="marks">
                  {#each marks as m (m.id)}
                    <span class="mark">
                      <button
                        class="mjump"
                        on:click={() => playAt(i, ep, m.position)}
                        title={"Lire à " + fmtDuration(m.position)}
                      >
                        <Icon name="bookmarkFilled" size={12} />
                        <span class="mt">{fmtDuration(m.position)}</span>
                        {#if m.label}<span class="ml">{m.label}</span>{/if}
                      </button>
                      <button class="mdel" on:click={() => removeMarker(m)} aria-label="Supprimer le marqueur">
                        <Icon name="close" size={12} />
                      </button>
                    </span>
                  {/each}
                </div>
              {/if}
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
{/if}

<style>
  /* The show's archive switch: a row of its own under the actions, the same
     switch as Réglages, with what it has done said under its name. */
  .auto {
    display: flex;
    align-items: center;
    gap: 14px;
    width: 100%;
    margin: 4px 0 18px;
    padding: 12px 16px;
    border-radius: var(--radius);
    background: var(--bg-card);
    text-align: left;
    color: var(--text);
  }
  .auto:hover:not(:disabled) {
    background: var(--bg-hover);
  }
  .auto-ico {
    flex: none;
    display: grid;
    place-items: center;
    width: 36px;
    height: 36px;
    border-radius: 10px;
    background: color-mix(in srgb, var(--accent) 16%, transparent);
    color: var(--accent);
  }
  .auto-txt {
    display: flex;
    flex-direction: column;
    gap: 3px;
    flex: 1;
    min-width: 0;
  }
  .auto-title {
    font-weight: 650;
  }
  .auto-hint {
    font-size: 0.82rem;
  }
  .auto-bar {
    display: block;
    height: 3px;
    margin-top: 4px;
    border-radius: 2px;
    background: var(--bg-hover);
    overflow: hidden;
  }
  .auto-bar span {
    display: block;
    height: 100%;
    background: var(--accent);
    transition: width 0.4s ease;
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

  .localnote {
    margin: 10px 0 0;
    max-width: 60ch;
    font-size: 0.85rem;
    line-height: 1.45;
    color: var(--text-dim);
  }
  .gone {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    color: var(--accent-2);
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
  }
  .kind {
    font-size: 0.8rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  h1 {
    font-size: clamp(1.6rem, 4.5vw, 2.6rem);
  }
  .desc {
    color: var(--text-dim);
    font-size: 0.9rem;
    max-width: 60ch;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .actions {
    margin: 16px 0 18px;
    gap: 12px;
    align-items: center;
    flex-wrap: wrap;
  }
  /* Same secondary action as the library/playlist pages, so "Tout télécharger"
     and "Exporter" read identically wherever they appear. */
  .ghost-btn {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 9px 15px;
    border-radius: 999px;
    border: 1px solid var(--bg-hover);
    color: var(--text-dim);
    font-weight: 600;
    font-size: 0.9rem;
    white-space: nowrap;
  }
  .ghost-btn:hover:not(:disabled) {
    color: var(--text);
    border-color: var(--text-dim);
  }
  .ghost-btn:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .icon-btn {
    color: var(--text-dim);
    margin-left: auto;
  }
  .icon-btn:hover {
    color: var(--text);
  }
  .episodes {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
  }
  .episodes li {
    display: flex;
    gap: 14px;
    padding: 14px 10px;
    border-top: 1px solid var(--bg-hover);
    align-items: flex-start;
  }
  .episodes li.active {
    background: var(--bg-hover);
    border-radius: var(--radius);
  }
  .pl {
    width: 40px;
    height: 40px;
    flex: none;
    border-radius: 50%;
    background: var(--bg-card);
    color: var(--text);
    display: grid;
    place-items: center;
    margin-top: 2px;
  }
  .pl:hover {
    background: linear-gradient(90deg, var(--accent), var(--accent-2));
    color: #fff;
  }
  .body {
    min-width: 0;
    flex: 1;
  }
  .top {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    align-items: baseline;
  }
  .etitle {
    font-weight: 700;
  }
  .etitle.on {
    color: var(--accent-2);
  }
  .side-r {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: none;
  }
  .when {
    font-size: 0.8rem;
    white-space: nowrap;
    flex: none;
  }
  .emenu {
    color: var(--text-dim);
    display: grid;
    place-items: center;
    padding: 2px;
    border-radius: 6px;
  }
  .emenu:hover {
    color: var(--text);
    background: var(--bg-hover);
  }
  .edesc {
    font-size: 0.88rem;
    color: var(--text-dim);
    margin: 6px 0;
    cursor: pointer;
    text-align: left;
    display: block;
    width: 100%;
    background: none;
    border: none;
    padding: 0;
    font-family: inherit;
  }
  .edesc.clamped {
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .foot {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 0.82rem;
  }
  .resume {
    color: var(--accent);
    font-weight: 600;
  }
  .doneb {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    color: var(--text-dim);
    font-weight: 600;
  }
  .ebar {
    margin-top: 8px;
    height: 3px;
    border-radius: 2px;
    background: var(--bg-hover);
    overflow: hidden;
    max-width: 320px;
  }
  .ebar span {
    display: block;
    height: 100%;
    background: var(--accent);
  }
  .marks {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 10px;
  }
  .mark {
    display: inline-flex;
    align-items: center;
    background: var(--bg-card);
    border: 1px solid var(--bg-hover);
    border-radius: 999px;
    overflow: hidden;
  }
  .mjump {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px 4px 10px;
    color: var(--text-dim);
    font-size: 0.78rem;
    max-width: 240px;
  }
  .mjump:hover {
    color: var(--text);
    background: var(--bg-hover);
  }
  .mjump :global(svg) {
    color: var(--accent);
    flex: none;
  }
  .mt {
    font-variant-numeric: tabular-nums;
    font-weight: 600;
  }
  .ml {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .mdel {
    display: grid;
    place-items: center;
    padding: 4px 8px 4px 4px;
    color: var(--text-dim);
  }
  .mdel:hover {
    color: var(--text);
  }
  @media (max-width: 640px) {
    .art {
      width: 150px;
    }
  }
</style>
