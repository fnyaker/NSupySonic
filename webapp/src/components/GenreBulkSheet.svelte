<script>
  // Tag a whole album, playlist or artist at once — after a REVIEW.
  //
  // A Frenchcore album is Frenchcore from its first track to its last, nearly
  // always; "nearly" is the intro, the collab with a hardstyle producer, the
  // ballad at the end. A bulk tag that labels those too teaches the model the
  // very confusion it is meant to learn out of. So: pick the genre, then the
  // server says for every track what it already wears and what the model
  // thinks (/genre/bulk/preview), the disagreements come unticked, and only
  // the tracks kept are tagged (/genre/bulk).
  //
  // Admin-only, like every write in the studio.
  import { fade, scale } from "svelte/transition";
  import { api } from "../lib/api.js";
  import { genreBulkSheet, closeGenreBulk, toasts } from "../lib/stores.js";
  import Icon from "./Icon.svelte";
  import Cover from "./Cover.svelte";
  import VirtualList from "./VirtualList.svelte";

  const KIND = { album: "l'album", playlist: "la playlist", artist: "l'artiste" };

  let tags = [];
  let loadingTags = false;
  let query = "";
  let step = "pick"; // pick | review
  let tag = null;
  let preview = null;
  let loadingPreview = false;
  let applying = false;
  let picked = {};
  let onlyDisagree = false;
  let openedFor = null;

  $: scope = $genreBulkSheet;
  $: if (scope && openedFor !== scope) open(scope);
  $: if (!scope && openedFor) reset();
  $: shown = filter(tags, query);
  $: rows = preview ? (onlyDisagree ? preview.tracks.filter((r) => r.disagree) : preview.tracks) : [];
  $: selected = preview ? preview.tracks.filter((r) => picked[key(r)] && !r.same) : [];

  const key = (r) => String(r.deezer_id || r.id);

  function filter(list, q) {
    const needle = (q || "").trim().toLowerCase();
    if (!needle) return list;
    return list.filter((t) => (t.name || "").toLowerCase().includes(needle));
  }

  function reset() {
    openedFor = null;
    step = "pick";
    tag = null;
    preview = null;
    picked = {};
    query = "";
    onlyDisagree = false;
    applying = false;
    loadingPreview = false;
  }

  async function open(s) {
    reset();
    openedFor = s;
    loadingTags = true;
    try {
      tags = (await api.genreStatus())?.tags || [];
    } catch (e) {
      toasts.push(e?.message || "Impossible de lire les genres", "error");
      tags = [];
    } finally {
      loadingTags = false;
    }
  }

  function scopeBody(s) {
    if (s.kind === "artist" && s.artist) return { artist: s.artist };
    return { tracks: (s.tracks || []).map((t) => t.deezer_id || t.id).filter(Boolean) };
  }

  async function choose(t) {
    if (loadingPreview || !scope) return;
    tag = t;
    step = "review";
    loadingPreview = true;
    const mine = scope;
    try {
      const p = await api.genreBulkPreview(scopeBody(scope), t.id);
      if (mine !== $genreBulkSheet) return;
      preview = p;
      const next = {};
      for (const r of p.tracks) next[key(r)] = !r.disagree && !r.same;
      picked = next;
      onlyDisagree = false;
    } catch (e) {
      toasts.push(e?.message || "Aperçu impossible", "error");
      step = "pick";
    } finally {
      loadingPreview = false;
    }
  }

  function toggle(r) {
    if (r.same) return;
    picked = { ...picked, [key(r)]: !picked[key(r)] };
  }

  function setAll(on) {
    const next = {};
    for (const r of preview.tracks) next[key(r)] = on && !r.same;
    picked = next;
  }

  async function apply() {
    if (applying || !selected.length || !tag) return;
    applying = true;
    try {
      const res = await api.genreBulk(selected.map(key), tag.id);
      toasts.push(`${res.applied} titre${res.applied > 1 ? "s" : ""} étiqueté${res.applied > 1 ? "s" : ""} ${tag.name}`);
      closeGenreBulk();
    } catch (e) {
      toasts.push(e?.message || "Étiquetage impossible", "error");
      applying = false;
    }
  }

  function why(r) {
    if (r.disagree === "tag") return `déjà ${r.current}`;
    if (r.disagree === "model") return `le modèle entend ${r.model.label} (${Math.round(r.model.conf * 100)} %)`;
    return "";
  }

  function onKey(e) {
    if (e.key === "Escape" && scope) closeGenreBulk();
  }
</script>

<svelte:window on:keydown={onKey} />

{#if scope}
  <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
  <div class="overlay" transition:fade={{ duration: 150 }} on:click|self={closeGenreBulk}>
    <div class="sheet" transition:scale={{ duration: 160, start: 0.97 }}>
      <header>
        <div class="thumb">
          <Cover src={scope.cover} alt={scope.title} size={48} kind={scope.kind === "artist" ? "artist" : "album"} />
        </div>
        <div class="ttl">
          <h2>
            {#if step === "review" && tag}Étiqueter {tag.name}{:else}Donner un genre à {KIND[scope.kind] || "la sélection"}{/if}
          </h2>
          <p class="muted">« {scope.title} »</p>
        </div>
        <button class="close" on:click={closeGenreBulk} aria-label="Fermer">
          <Icon name="close" size={20} />
        </button>
      </header>

      {#if step === "pick"}
        <div class="body">
          {#if loadingTags}
            <p class="muted pad">Chargement des genres…</p>
          {:else if !tags.length}
            <p class="muted pad">
              Aucun genre dans le vocabulaire. Créez-en d'abord dans le studio
              (Bibliothèque&nbsp;→&nbsp;Genres).
            </p>
          {:else}
            <input class="q" type="text" placeholder="Filtrer…" bind:value={query} autocomplete="off" />
            <div class="grid">
              {#each shown as t (t.id)}
                <button class="chip" style={t.color ? `--chip:${t.color}` : ""} on:click={() => choose(t)}>
                  {t.name}
                </button>
              {/each}
              {#if !shown.length}
                <p class="muted pad">Aucun genre ne correspond.</p>
              {/if}
            </div>
          {/if}
        </div>
        <footer>
          <p class="muted hint">
            Rien n'est étiqueté à ce stade : vous verrez d'abord, titre par titre, ce
            que chacun porte déjà et ce qu'en pense le modèle.
          </p>
        </footer>
      {:else}
        <div class="summary">
          {#if loadingPreview || !preview}
            <p class="muted">Lecture des titres et de l'avis du modèle…</p>
          {:else}
            {@const c = preview.counts}
            <p>
              <strong>{c.tracks}</strong> titre{c.tracks > 1 ? "s" : ""} dans la bibliothèque{#if c.same}, dont {c.same} déjà {tag.name}{/if}.
              {#if c.other_tag + c.model}
                <span class="warn">{c.other_tag + c.model} en désaccord</span>, laissé{c.other_tag + c.model > 1 ? "s" : ""} de côté par défaut.
              {/if}
            </p>
            {#if c.missing}
              <p class="muted small">
                {c.missing} titre{c.missing > 1 ? "s ne sont" : " n'est"} pas encore dans la bibliothèque (ajoutez
                {KIND[scope.kind] || "la sélection"} aux favoris pour les archiver, puis recommencez).
              </p>
            {/if}
            {#if !preview.model.active}
              <p class="muted small">Pas encore de modèle entraîné : seules les étiquettes existantes sont comparées.</p>
            {:else if !preview.model.knows}
              <p class="muted small">Le modèle actif ne connaît pas encore {tag.name} : son avis est indiqué, sans compter comme un désaccord.</p>
            {/if}
            {#if c.no_vector || c.unjudged}
              <p class="muted small">
                {c.no_vector + c.unjudged} titre{c.no_vector + c.unjudged > 1 ? "s" : ""} sans avis du modèle (pas encore mesuré{c.no_vector + c.unjudged > 1 ? "s" : ""}).
              </p>
            {/if}
            <div class="tools">
              <button class="link" on:click={() => setAll(true)}>Tout cocher</button>
              <button class="link" on:click={() => setAll(false)}>Tout décocher</button>
              {#if c.other_tag + c.model}
                <label class="only">
                  <input type="checkbox" bind:checked={onlyDisagree} /> Seulement les désaccords
                </label>
              {/if}
            </div>
          {/if}
        </div>
        <div class="body list">
          {#if preview}
            <VirtualList items={rows} estimateHeight={56} key={(r) => key(r)} let:item>
              <button
                class="row"
                class:off={!picked[key(item)] && !item.same}
                class:same={item.same}
                class:flag={item.disagree}
                on:click={() => toggle(item)}>
                <span class="box" class:on={picked[key(item)] || item.same} aria-hidden="true">
                  {#if picked[key(item)] || item.same}<Icon name="check" size={14} />{/if}
                </span>
                <span class="txt">
                  <span class="t">{item.title}</span>
                  <span class="s">
                    {#if item.same}
                      {item.artist} · déjà {tag.name}
                    {:else if item.disagree}
                      {item.artist} · <span class="warn">{why(item)}</span>
                    {:else if item.model && item.model.label !== tag.name}
                      <!-- An opinion that is not a disagreement: a family the
                           tag belongs to, or a head that never learnt the tag. -->
                      {item.artist} · le modèle entend {item.model.label}
                    {:else}
                      {item.artist}
                    {/if}
                  </span>
                </span>
              </button>
            </VirtualList>
          {/if}
        </div>
        <footer class="actions">
          <button class="ghost" on:click={() => (step = "pick")} disabled={applying}>Autre genre</button>
          <button class="primary" on:click={apply} disabled={applying || loadingPreview || !selected.length}>
            {#if applying}Étiquetage…{:else if !selected.length}Aucun titre coché{:else}Étiqueter {selected.length} titre{selected.length > 1 ? "s" : ""}{/if}
          </button>
        </footer>
      {/if}
    </div>
  </div>
{/if}

<style>
  .overlay {
    position: fixed;
    inset: 0;
    z-index: 320;
    background: rgba(0, 0, 0, 0.6);
    display: grid;
    place-items: center;
    padding: 20px;
    backdrop-filter: blur(2px);
  }
  .sheet {
    width: min(560px, 100%);
    max-height: min(84vh, 760px);
    display: flex;
    flex-direction: column;
    background: var(--bg-card);
    border: 1px solid var(--bg-hover);
    border-radius: 16px;
    box-shadow: 0 24px 70px rgba(0, 0, 0, 0.55);
    overflow: hidden;
  }
  header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 16px 16px 10px;
  }
  .thumb {
    width: 48px;
    flex: none;
  }
  .ttl {
    min-width: 0;
    flex: 1;
  }
  .ttl h2 {
    margin: 0 0 2px;
    font-size: 1.05rem;
  }
  .ttl p {
    margin: 0;
    font-size: 0.85rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .close {
    display: grid;
    place-items: center;
    width: 34px;
    height: 34px;
    border-radius: 50%;
    color: var(--text-dim);
    flex: none;
  }
  .close:hover {
    background: var(--bg-hover);
    color: var(--text);
  }
  .body {
    overflow-y: auto;
    padding: 0 16px 10px;
    flex: 1;
    min-height: 0;
  }
  .body.list {
    padding: 0 8px 8px;
  }
  .q {
    width: 100%;
    padding: 9px 12px;
    margin-bottom: 10px;
    border-radius: 10px;
    background: var(--bg-elev);
    border: 1px solid var(--bg-hover);
    color: var(--text);
  }
  .q:focus {
    outline: none;
    border-color: var(--accent);
  }
  .grid {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    padding-bottom: 8px;
  }
  .chip {
    padding: 7px 14px;
    border-radius: 999px;
    border: 1px solid var(--bg-hover);
    background: var(--bg-elev);
    color: var(--text);
    font-weight: 600;
    font-size: 0.85rem;
  }
  .chip:hover {
    border-color: var(--chip, var(--accent));
  }
  .summary {
    padding: 0 16px 8px;
    font-size: 0.88rem;
    line-height: 1.45;
  }
  .summary p {
    margin: 0 0 6px;
  }
  .small {
    font-size: 0.8rem;
  }
  .warn {
    color: var(--warn, #f5b041);
    font-weight: 600;
  }
  .tools {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px 16px;
    margin-top: 6px;
  }
  .link {
    color: var(--accent);
    font-weight: 600;
    font-size: 0.82rem;
    padding: 4px 0;
  }
  .only {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 0.82rem;
    color: var(--text-dim);
    cursor: pointer;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    height: 56px;
    padding: 0 8px;
    border-radius: 10px;
    text-align: left;
    color: var(--text);
  }
  .row:hover {
    background: var(--bg-hover);
  }
  .row.off .txt {
    opacity: 0.55;
  }
  .row.same {
    cursor: default;
  }
  .row.same .txt {
    opacity: 0.7;
  }
  .box {
    width: 20px;
    height: 20px;
    flex: none;
    display: grid;
    place-items: center;
    border-radius: 6px;
    border: 1.5px solid var(--text-dim);
    color: var(--bg-card);
  }
  .box.on {
    background: var(--accent);
    border-color: var(--accent);
  }
  .row.same .box.on {
    background: var(--bg-hover);
    border-color: var(--bg-hover);
    color: var(--text-dim);
  }
  .txt {
    min-width: 0;
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .t,
  .s {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .t {
    font-weight: 600;
    font-size: 0.9rem;
  }
  .s {
    font-size: 0.78rem;
    color: var(--text-dim);
  }
  .pad {
    padding: 16px 4px 20px;
    font-size: 0.9rem;
  }
  footer {
    padding: 10px 16px 16px;
    border-top: 1px solid var(--bg-hover);
  }
  footer.actions {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
  }
  .hint {
    margin: 0;
    font-size: 0.78rem;
    line-height: 1.4;
  }
  .primary,
  .ghost {
    padding: 10px 18px;
    border-radius: 999px;
    font-weight: 700;
    font-size: 0.88rem;
  }
  .primary {
    background: var(--accent);
    color: var(--bg-card);
  }
  .primary:disabled {
    opacity: 0.5;
  }
  .ghost {
    color: var(--text-dim);
    border: 1px solid var(--bg-hover);
  }
  .ghost:hover {
    color: var(--text);
  }
</style>
