<script>
  // The items of one of the person's own accounts — its followed artists, its
  // albums, its playlists — to tick or untick one by one (lot P2). Unticked:
  // never imported, and an artist is no longer followed. Ticked: imported now.
  // The list is windowed: an account can follow thousands of artists.
  import { onMount } from "svelte";
  import { api } from "../lib/api.js";
  import { toasts } from "../lib/stores.js";
  import Icon from "./Icon.svelte";
  import Cover from "./Cover.svelte";
  import VirtualList from "./VirtualList.svelte";

  export let account;
  export let onclose = null;

  const TABS = { artists: "Artistes", albums: "Albums", playlists: "Playlists" };
  const NOTE = {
    artists: "Décoché : l'artiste n'est plus suivi et ne sera jamais réimporté.",
    albums: "Décoché : l'album sort de vos favoris et ne sera jamais réimporté.",
    playlists: "Décochée : jamais importée. Une playlist déjà importée reste la vôtre.",
  };
  const kinds = (account.pickable || ["artists"]).filter((k) => TABS[k]);
  let kind = kinds[0];
  let lists = {}; // kind -> items
  let errors = {};
  let loading = false;
  let q = "";
  let pending = new Set(); // refs whose change is in flight

  async function fetchKind(k, fresh = false) {
    loading = true;
    errors[k] = null;
    try {
      const r = await api.accountLibrary(account.id, k, fresh);
      lists[k] = r.items || [];
    } catch (e) {
      errors[k] = e?.message || "Impossible de lire ce compte.";
    }
    loading = false;
  }
  onMount(() => fetchKind(kind));

  function pick(k) {
    kind = k;
    q = "";
    if (!lists[k] && !errors[k]) fetchKind(k);
  }

  const fold = (s) =>
    String(s || "")
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase();

  $: all = lists[kind] || [];
  $: needle = fold(q.trim());
  $: shown = needle ? all.filter((i) => fold(i.name || i.title).includes(needle)) : all;
  $: onCount = all.filter((i) => i.on).length;

  // One request for any number of items: the change shows at once and is
  // put back if the server refuses it.
  async function change(items, on) {
    items = items.filter((i) => i.on !== on && !pending.has(i.ref));
    if (!items.length) return;
    const before = items.map((i) => [i, i.in_library]);
    for (const i of items) {
      i.on = on;
      if (!on) i.in_library = false;
    }
    pending = new Set([...pending, ...items.map((i) => i.ref)]);
    lists = lists;
    try {
      const r = await api.setAccountItems(account.id, kind, items.map((i) => i.ref), on);
      if (on && r.imported) for (const i of items) i.in_library = true;
    } catch (e) {
      for (const [i, was] of before) {
        i.on = !on;
        i.in_library = was;
      }
      toasts.push(e?.message || "Échec", "error");
    }
    const done = new Set(items.map((i) => i.ref));
    pending = new Set([...pending].filter((r) => !done.has(r)));
    lists = lists;
  }
  const toggle = (item) => change([item], !item.on);
  const setAll = (on) => change(shown, on);

  const sub = (i) => {
    if (kind === "albums") return (i.artists || []).map((a) => a.name).join(", ");
    if (kind === "playlists") return i.tracks_count ? `${i.tracks_count} titres` : "";
    return "";
  };

  function onKey(e) {
    if (e.key === "Escape") onclose?.();
  }
</script>

<svelte:window on:keydown={onKey} />

<!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
<div class="backdrop" on:click={() => onclose?.()}>
  <div class="sheet" on:click|stopPropagation role="dialog" tabindex="-1" aria-label="Choisir ce qui est importé">
    <header>
      <div class="hd">
        <h2>Choisir ce qui est importé</h2>
        <span class="muted from">{account.server ? account.name + " · compte du serveur" : account.name}{account.label && !account.server ? " · " + account.label : ""}</span>
      </div>
      <button class="close" on:click={() => onclose?.()} aria-label="Fermer"><Icon name="close" size={20} /></button>
    </header>

    {#if kinds.length > 1}
      <div class="tabs" role="tablist">
        {#each kinds as k (k)}
          <button class="tab" class:sel={k === kind} role="tab" aria-selected={k === kind} on:click={() => pick(k)}>{TABS[k]}</button>
        {/each}
      </div>
    {/if}

    <div class="tools">
      <div class="searchbox">
        <Icon name="search" size={16} />
        <input type="search" bind:value={q} placeholder="Filtrer" aria-label="Filtrer la liste" />
      </div>
      {#if all.length}
        <span class="muted cnt">{onCount} / {all.length}</span>
      {/if}
    </div>

    <div class="results">
      {#if errors[kind]}
        <p class="hint muted">{errors[kind]} <button class="link" on:click={() => fetchKind(kind, true)}>Réessayer</button></p>
      {:else if !lists[kind]}
        <p class="hint muted">{loading ? "Lecture du compte…" : ""}</p>
      {:else if !all.length}
        <p class="hint muted">Rien dans ce compte.</p>
      {:else if !shown.length}
        <p class="hint muted">Aucun résultat.</p>
      {:else}
        <VirtualList items={shown} estimateHeight={60} key={(it) => it.ref} let:item>
          <button
            type="button"
            class="row"
            class:off={!item.on}
            role="switch"
            aria-checked={item.on}
            disabled={pending.has(item.ref)}
            on:click={() => toggle(item)}>
            <span class="thumb"><Cover src={item.cover_url} kind={kind === "artists" ? "artist" : kind === "albums" ? "album" : "playlist"} round={kind === "artists"} size={44} /></span>
            <span class="meta">
              <span class="t">{item.name || item.title || "Sans titre"}</span>
              <span class="s muted">
                {#if item.in_library}<span class="here"><Icon name="check" size={12} />Dans votre bibliothèque</span>{/if}{#if item.in_library && sub(item)}{" · "}{/if}{sub(item)}
              </span>
            </span>
            <span class="box">{#if item.on}<Icon name="check" size={14} />{/if}</span>
          </button>
        </VirtualList>
      {/if}
    </div>

    <footer>
      <p class="muted note">{NOTE[kind]}</p>
      {#if shown.length > 1}
        <div class="bulk">
          <button class="ghost-btn" on:click={() => setAll(true)}>Tout cocher</button>
          <button class="ghost-btn" on:click={() => setAll(false)}>Tout décocher</button>
        </div>
      {/if}
    </footer>
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 400;
    background: rgba(0, 0, 0, 0.55);
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .sheet {
    background: var(--bg-elev);
    width: min(600px, 92vw);
    height: min(720px, 84vh);
    border-radius: 16px;
    display: flex;
    flex-direction: column;
    box-shadow: 0 24px 70px rgba(0, 0, 0, 0.6);
    overflow: hidden;
  }
  header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    padding: 18px 18px 10px;
  }
  .hd {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  header h2 {
    font-size: 1.1rem;
    margin: 0;
  }
  .from {
    font-size: 0.82rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .close {
    flex: none;
    width: 36px;
    height: 36px;
    display: grid;
    place-items: center;
    border-radius: 50%;
    color: var(--text-dim);
  }
  .close:hover {
    color: var(--text);
    background: var(--bg-hover);
  }
  .tabs {
    display: flex;
    gap: 6px;
    padding: 0 18px 10px;
  }
  .tab {
    padding: 7px 14px;
    min-height: 36px;
    border-radius: 999px;
    background: var(--bg-card);
    color: var(--text-dim);
    font-weight: 600;
    font-size: 0.85rem;
  }
  .tab.sel {
    background: var(--text);
    color: var(--bg);
  }
  .tools {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 0 18px 8px;
  }
  .searchbox {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    background: var(--bg-card);
    border: 1px solid transparent;
    border-radius: 999px;
    padding: 9px 14px;
    color: var(--text-dim);
  }
  .searchbox:focus-within {
    border-color: var(--accent);
    color: var(--text);
  }
  .searchbox input {
    border: none;
    background: none;
    outline: none;
    color: var(--text);
    width: 100%;
    font-size: 0.9rem;
  }
  .cnt {
    flex: none;
    font-size: 0.82rem;
    font-variant-numeric: tabular-nums;
  }
  .results {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 4px 10px 8px;
  }
  .hint {
    padding: 28px 18px;
    text-align: center;
  }
  .link {
    color: var(--accent);
    font-weight: 600;
  }
  .row {
    width: 100%;
    height: 60px;
    display: grid;
    grid-template-columns: 44px 1fr 24px;
    align-items: center;
    gap: 12px;
    padding: 0 10px 0 8px;
    border-radius: 10px;
    text-align: left;
  }
  .row:hover {
    background: var(--bg-hover);
  }
  .row.off .thumb,
  .row.off .t {
    opacity: 0.5;
  }
  .thumb {
    width: 44px;
    height: 44px;
  }
  .meta {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .t {
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .s {
    font-size: 0.78rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .here {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    color: var(--accent);
  }
  .box {
    width: 22px;
    height: 22px;
    border-radius: 6px;
    display: grid;
    place-items: center;
    border: 1.5px solid var(--text-dim);
    color: #fff;
  }
  .row:not(.off) .box {
    background: var(--accent);
    border-color: var(--accent);
  }
  footer {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 18px 16px;
    border-top: 1px solid var(--bg-hover);
  }
  .note {
    flex: 1;
    min-width: 0;
    font-size: 0.78rem;
    line-height: 1.45;
    margin: 0;
  }
  .bulk {
    flex: none;
    display: flex;
    gap: 6px;
  }
  .ghost-btn {
    display: inline-flex;
    align-items: center;
    padding: 7px 12px;
    min-height: 36px;
    border-radius: 999px;
    border: 1px solid var(--bg-hover);
    color: var(--text-dim);
    font-weight: 600;
    font-size: 0.8rem;
    white-space: nowrap;
  }
  .ghost-btn:hover {
    color: var(--text);
    border-color: var(--text-dim);
  }
  @media (max-width: 640px) {
    .backdrop {
      align-items: flex-end;
    }
    .sheet {
      width: 100vw;
      height: 88vh;
      border-radius: 16px 16px 0 0;
    }
    footer {
      flex-direction: column;
      align-items: stretch;
    }
    .bulk .ghost-btn {
      flex: 1;
      justify-content: center;
    }
  }
</style>
