<script>
  // Réglages → Découverte: the titles the person said they do not like, each
  // with "Retirer" (Deezer's "Manage my dislikes"). Read once when the card
  // opens; a removal is optimistic and puts the row back if the server says no.
  import { onMount } from "svelte";
  import { api } from "../lib/api.js";
  import { disliked, toasts } from "../lib/stores.js";
  import { trackKey, trackRef } from "../lib/trackkey.js";
  import { artistLine } from "../lib/format.js";
  import Cover from "./Cover.svelte";
  import Icon from "./Icon.svelte";

  const PAGE = 30;
  let tracks = null;
  let failed = false;
  let shown = PAGE;

  async function load() {
    failed = false;
    try {
      tracks = (await api.myDislikes()).tracks || [];
    } catch {
      failed = true;
    }
  }

  async function remove(t) {
    const i = tracks.indexOf(t);
    tracks = tracks.filter((x) => x !== t);
    disliked.remove(trackKey(t));
    try {
      await api.dislike(trackRef(t), false);
    } catch {
      tracks = [...tracks.slice(0, i), t, ...tracks.slice(i)];
      disliked.add(trackKey(t));
      toasts.push("Échec, réessayez", "error");
    }
  }

  onMount(load);
</script>

<section class="card">
  <h2>Titres que vous n'aimez pas</h2>
  <p class="muted sub">
    Ils ne reviennent plus dans le Flow, les radios et les mixes, ni les titres qui sonnent
    presque pareil&nbsp;; les plus lointains sont seulement moins souvent proposés. Vous pouvez
    toujours les chercher et les écouter vous-même.
  </p>
  {#if failed}
    <div class="state">
      <span class="muted">Liste indisponible pour l'instant.</span>
      <button class="ghost-btn" on:click={load}><Icon name="refresh" size={15} /> Réessayer</button>
    </div>
  {:else if tracks === null}
    <div class="state"><span class="muted">Chargement…</span></div>
  {:else if !tracks.length}
    <div class="state empty">
      <Icon name="thumbsDown" size={18} />
      <span class="muted">Aucun pour l'instant. Touchez <strong>Je n'aime pas</strong> dans le lecteur ou le menu d'un titre.</span>
    </div>
  {:else}
    <ul class="list">
      {#each tracks.slice(0, shown) as t (trackKey(t))}
        <li>
          <span class="cov"><Cover src={t.album?.cover} alt={t.title} kind="album" /></span>
          <span class="txt">
            <span class="t">{t.title}</span>
            <span class="a muted">{artistLine(t)}</span>
          </span>
          <button class="ghost-btn rm" on:click={() => remove(t)} aria-label="Retirer {t.title} de « Je n'aime pas »">
            Retirer
          </button>
        </li>
      {/each}
    </ul>
    {#if tracks.length > shown}
      <button class="ghost-btn more" on:click={() => (shown += PAGE)}>
        Afficher {Math.min(PAGE, tracks.length - shown)} de plus
      </button>
    {/if}
  {/if}
</section>

<style>
  .card {
    background: var(--bg-card);
    border-radius: var(--radius);
    padding: 20px;
    margin-bottom: 18px;
  }
  .card h2 {
    margin-top: 0;
    font-size: 1.05rem;
  }
  .sub {
    font-size: 0.85rem;
    line-height: 1.5;
    margin: 4px 0 12px;
  }
  .ghost-btn {
    flex: none;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 8px 15px;
    min-height: 36px;
    border-radius: 999px;
    border: 1px solid var(--bg-hover);
    color: var(--text-dim);
    font-weight: 600;
    font-size: 0.85rem;
    white-space: nowrap;
  }
  .ghost-btn:hover {
    color: var(--text);
    border-color: var(--text-dim);
  }
  .state {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
    padding: 6px 0 2px;
  }
  .state.empty {
    color: var(--text-dim);
    align-items: flex-start;
  }
  .list {
    list-style: none;
    margin: 4px 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
  }
  li {
    display: flex;
    align-items: center;
    gap: 12px;
    min-height: 56px;
    padding: 6px 0;
    border-top: 1px solid var(--bg-hover);
  }
  li:first-child {
    border-top: none;
  }
  .cov {
    width: 44px;
    height: 44px;
    flex: none;
    border-radius: 6px;
    overflow: hidden;
  }
  .txt {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .t,
  .a {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .t {
    font-weight: 600;
  }
  .a {
    font-size: 0.85rem;
  }
  .rm {
    flex: none;
  }
  .more {
    margin-top: 10px;
  }
</style>
