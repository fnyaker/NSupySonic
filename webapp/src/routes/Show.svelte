<script>
  import { push } from "svelte-spa-router";
  import { api } from "../lib/api.js";
  import { player, currentId, playing, isAdmin, toasts, seekTo, openMenu, openExport } from "../lib/stores.js";
  import { podcastProgress, setResumePoint } from "../lib/podcastProgress.js";
  import { episodeMarkers, loadShowMarkers, removeMarker } from "../lib/markers.js";
  import { buildTrackMenu } from "../lib/actions.js";
  import { downloadTrack } from "../lib/offline.js";
  import { duration as fmtDuration } from "../lib/format.js";
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

  function playFrom(i) {
    if (episodes.length) player.playQueue(episodes, i, { kind: "podcast", id });
  }
  function playAll() {
    playFrom(0);
  }
  function toggle(i, ep) {
    if ($currentId === ep.deezer_id) player.toggle();
    else playFrom(i);
  }

  // Jump straight to a position inside an episode (a marker tap): the playing
  // episode just seeks; another episode records the target as its resume point
  // first, so the player's load lands exactly there.
  function playAt(i, ep, position) {
    if ($currentId === ep.deezer_id) {
      seekTo.set(position);
      player.play();
      return;
    }
    setResumePoint(ep.deezer_id, position, ep.duration || 0);
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
      push("/podcasts");
    } catch (e) {
      toasts.push(e?.message || "Échec", "error");
    }
  }

  // Resume state for an episode: fraction played (0..1), seconds remaining and
  // whether it was heard to the end. null when there's nothing to show.
  function resumeOf(ep) {
    const p = $podcastProgress[ep.deezer_id];
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
      <button class="ghost-btn" on:click={() => openExport("podcast", id, data.title)}
              disabled={!episodes.length} title="Exporter en ZIP (clé USB, autre lecteur…)">
        <Icon name="archive" size={17} /> Exporter
      </button>
      {#if $isAdmin}
        <button class="icon-btn" on:click={unsubscribe} aria-label="Se désabonner" title="Se désabonner">
          <Icon name="trash" size={22} />
        </button>
      {/if}
    </div>

    {#if !episodes.length}
      <p class="muted">Aucun épisode disponible.</p>
    {:else}
      <ul class="episodes">
        {#each episodes as ep, i (ep.deezer_id)}
          {@const active = $currentId === ep.deezer_id}
          {@const resume = resumeOf(ep)}
          {@const marks = $episodeMarkers[ep.deezer_id] || []}
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
                  class:clamped={!expanded.has(ep.deezer_id)}
                  on:click={() => toggleExpand(ep.deezer_id)}
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
