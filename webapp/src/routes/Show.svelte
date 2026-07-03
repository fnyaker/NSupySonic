<script>
  import { push } from "svelte-spa-router";
  import { api } from "../lib/api.js";
  import { player, currentId, playing, isAdmin, toasts } from "../lib/stores.js";
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
      <div class="art"><Cover src={data.cover} alt={data.title} /></div>
      <div class="meta">
        <span class="kind">Podcast</span>
        <h1>{data.title}</h1>
        <div class="sub muted">
          {episodes.length} épisode{episodes.length > 1 ? "s" : ""}
        </div>
        {#if data.description}<p class="desc">{data.description}</p>{/if}
      </div>
    </GradientHeader>

    <div class="row actions">
      <button class="pill" on:click={playAll} disabled={!episodes.length}>
        <Icon name="play" size={18} /> Lire
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
          <li class:active>
            <button class="pl" on:click={() => toggle(i, ep)} aria-label="Lire l'épisode">
              <Icon name={active && $playing ? "pause" : "play"} size={18} />
            </button>
            <div class="body">
              <div class="top">
                <span class="etitle" class:on={active}>{ep.title}</span>
                <span class="when muted">{fmtDate(ep.published)}</span>
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
                {fmtDuration(ep.duration)}
                {#if ep.status === "completed"}· <Icon name="downloaded" size={14} />{/if}
              </div>
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
{/if}

<style>
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
    gap: 18px;
    align-items: center;
  }
  .icon-btn {
    color: var(--text-dim);
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
  .when {
    font-size: 0.8rem;
    white-space: nowrap;
    flex: none;
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
  @media (max-width: 640px) {
    .art {
      width: 150px;
    }
  }
</style>
