<script>
  // The genre hierarchy: who is under whom. A genre may sit under several
  // parents, each link with a weight (1 = a sub-genre outright, less = related),
  // so a genre with two parents shows under both. The list is windowed
  // (VirtualList): a few hundred nodes, but only the rows on screen exist.
  //
  // Reading is for everyone; editing is the admin's. Every edit goes to the
  // server, which moves the tree's version, re-decides the verdicts and tells the
  // devices; the answer is the whole tree, which replaces this copy.
  import { onMount } from "svelte";
  import { api } from "../lib/api.js";
  import { user, toasts } from "../lib/stores.js";
  import { setTree } from "../lib/genretree.js";
  import VirtualList from "./VirtualList.svelte";
  import Icon from "./Icon.svelte";

  let tree = null;
  let loading = true;
  let failed = false;
  let busy = false;
  let query = "";
  let expanded = new Set(); // row paths ("A/B"): one node under two parents opens separately
  let picking = null; // the row whose "Ranger sous…" picker is open
  let pickQuery = "";
  let adding = null; // "parent" | "create"
  let newName = "";
  let newParent = "";
  let weightFor = null; // the row whose link weight is being edited
  let dragging = null;
  let menu = null; // the row whose actions are open (the phone's one "..." button)

  $: admin = !!$user?.admin;

  const fold = (s) =>
    String(s || "")
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase();

  function adopt(data) {
    tree = data;
    setTree(data);
  }

  async function load() {
    loading = true;
    failed = false;
    try {
      adopt(await api.genreTree());
      if (expanded.size === 0) expanded = new Set(tree.roots);
    } catch (e) {
      failed = true;
    } finally {
      loading = false;
    }
  }

  onMount(load);

  // name -> [{child, weight}], name -> [{parent, weight}]
  $: kids = (() => {
    const m = new Map();
    if (!tree) return m;
    for (const e of tree.edges) {
      if (!m.has(e.parent)) m.set(e.parent, []);
      m.get(e.parent).push({ name: e.child, weight: e.weight });
    }
    for (const list of m.values()) list.sort((a, b) => b.weight - a.weight || (a.name < b.name ? -1 : 1));
    return m;
  })();
  $: parentsOf = (() => {
    const m = new Map();
    if (!tree) return m;
    for (const e of tree.edges) {
      if (!m.has(e.child)) m.set(e.child, []);
      m.get(e.child).push({ name: e.parent, weight: e.weight });
    }
    return m;
  })();
  $: byName = new Map((tree?.nodes || []).map((n) => [n.name, n]));

  // What a search keeps: the genres that match, everything under them, and the
  // chain above each so the result sits in its place.
  $: shown = (() => {
    const q = fold(query).trim();
    if (!q || !tree) return null;
    const keep = new Set();
    const down = (n) => {
      if (keep.has(n)) return;
      keep.add(n);
      for (const k of kids.get(n) || []) down(k.name);
    };
    const up = (n, seen = new Set()) => {
      if (seen.has(n)) return;
      seen.add(n);
      keep.add(n);
      for (const p of parentsOf.get(n) || []) up(p.name, seen);
    };
    for (const n of tree.nodes) if (fold(n.name).includes(q)) {
      down(n.name);
      up(n.name);
    }
    return keep;
  })();

  $: rows = (() => {
    if (!tree) return [];
    const out = [];
    const walk = (name, depth, path, parent, weight) => {
      if (shown && !shown.has(name)) return;
      const list = kids.get(name) || [];
      const open = shown ? true : expanded.has(path);
      out.push({ key: path, name, depth, parent, weight, count: list.length, open, multi: (parentsOf.get(name) || []).length > 1 });
      if (open) for (const k of list) walk(k.name, depth + 1, path + "/" + k.name, name, k.weight);
    };
    for (const r of tree.roots) walk(r, 0, r, null, 1);
    return out;
  })();

  function toggle(row) {
    if (!row.count || shown) return;
    const next = new Set(expanded);
    if (next.has(row.key)) next.delete(row.key);
    else next.add(row.key);
    expanded = next;
  }

  function expandAll() {
    const next = new Set();
    const walk = (name, path, seen) => {
      if (seen.has(name)) return;
      next.add(path);
      for (const k of kids.get(name) || []) walk(k.name, path + "/" + k.name, new Set(seen).add(name));
    };
    for (const r of tree.roots) walk(r, r, new Set());
    expanded = next;
  }

  async function run(fn, ok) {
    if (busy) return;
    busy = true;
    try {
      adopt(await fn());
      if (ok) toasts.push(ok, "success");
    } catch (e) {
      const msg = String(e?.message || "");
      toasts.push(/cycle|409/.test(msg) ? "Impossible : ce genre est déjà sous celui-là." : msg || "modification impossible", "error");
    } finally {
      busy = false;
    }
  }

  function under(row) {
    // Every node under the row's node, to keep the picker from offering a cycle.
    const set = new Set();
    const walk = (n) => {
      if (set.has(n)) return;
      set.add(n);
      for (const k of kids.get(n) || []) walk(k.name);
    };
    walk(row.name);
    return set;
  }

  $: choices = (() => {
    if (!picking || !tree) return [];
    const q = fold(pickQuery).trim();
    const bad = under(picking);
    return tree.nodes
      .filter((n) => !bad.has(n.name) && (!q || fold(n.name).includes(q)))
      .slice(0, 40);
  })();

  function moveTo(row, parent) {
    picking = null;
    pickQuery = "";
    run(() => api.genreTreeMove(row.name, parent, row.parent), parent ? `${row.name} rangé sous ${parent}` : `${row.name} est une racine`);
  }

  function addParent(row, parent) {
    picking = null;
    pickQuery = "";
    run(() => api.genreTreeEdge(row.name, parent, 0.5), `${parent} ajouté comme second parent`);
  }

  function setWeight(row, w) {
    if (!row.parent) return;
    run(() => api.genreTreeEdge(row.name, row.parent, w, "PATCH"));
  }

  function cut(row) {
    if (!row.parent) return;
    run(() => api.genreTreeCut(row.name, row.parent), "lien retiré");
  }

  async function rename(row) {
    const tag = byName.get(row.name);
    const name = window.prompt("Nouveau nom", row.name);
    if (!tag?.id || !name || name.trim() === row.name) return;
    await run(async () => {
      await api.genreTagEdit(tag.id, { name: name.trim() });
      return api.genreTree();
    });
  }

  async function remove(row) {
    const tag = byName.get(row.name);
    if (!tag?.id) return;
    const n = row.count;
    const msg = `Supprimer « ${row.name} » ? Ses étiquettes sur les titres disparaissent${n ? `, ses ${n} sous-genres remontent d'un cran` : ""}.`;
    if (!window.confirm(msg)) return;
    await run(async () => {
      await api.genreTagDelete(tag.id);
      return api.genreTree();
    }, "genre supprimé");
  }

  async function create() {
    const name = newName.trim();
    if (!name) return;
    await run(async () => {
      await api.genreTagCreate(name, null, null);
      if (newParent) await api.genreTreeEdge(name, newParent, 1);
      return api.genreTree();
    }, `${name} créé`);
    newName = "";
    newParent = "";
    adding = null;
  }

  function undo() {
    run(() => api.genreTreeUndo(), "dernière modification annulée");
  }

  function reset() {
    if (!window.confirm("Rétablir l'arbre par défaut ? Vos rangements sont perdus ; les genres et les étiquettes restent.")) return;
    run(() => api.genreTreeReset(), "arbre par défaut rétabli");
  }

  // Desktop drag: the row is dropped on the genre it should go under.
  function dragStart(e, row) {
    if (!admin) return;
    dragging = row;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", row.name);
  }
  function dragOver(e, row) {
    if (dragging && !under(dragging).has(row.name)) e.preventDefault();
  }
  function drop(e, row) {
    e.preventDefault();
    const from = dragging;
    dragging = null;
    if (from && from.name !== row.name && !under(from).has(row.name)) moveTo(from, row.name);
  }
</script>

<section class="card tree">
  <div class="head">
    <h2>Arbre des genres</h2>
    {#if admin && tree}
      <div class="tools">
        <button class="btn" on:click={() => (adding = adding ? null : "create")} disabled={busy}>
          <Icon name="plus" size={14} /> Nouveau genre
        </button>
        <button class="btn" on:click={undo} disabled={busy || !tree.can_undo}>Annuler</button>
        <button class="btn" on:click={reset} disabled={busy || tree.default}>Arbre par défaut</button>
      </div>
    {/if}
  </div>
  <p class="sub muted">
    Le frenchcore est un sous-genre du hardcore, qui est plus ou moins sous la techno. Quand le
    modèle hésite entre deux frères, il répond leur parent. Un genre peut avoir plusieurs parents,
    chaque lien avec son poids.
  </p>

  {#if loading}
    <p class="muted">Chargement…</p>
  {:else if failed}
    <p class="muted">L'arbre est injoignable. <button class="btn" on:click={load}>Réessayer</button></p>
  {:else if tree}
    {#if adding === "create" && admin}
      <form class="create" on:submit|preventDefault={create}>
        <input placeholder="Nom du genre" bind:value={newName} maxlength="48" />
        <select bind:value={newParent} aria-label="Sous quel genre">
          <option value="">Sans parent (racine)</option>
          {#each tree.nodes as n}<option value={n.name}>{n.name}</option>{/each}
        </select>
        <button class="btn primary" disabled={busy || !newName.trim()}>Créer</button>
      </form>
    {/if}

    <div class="bar">
      <input class="search" type="search" placeholder="Chercher un genre (avec ses sous-genres)" bind:value={query} />
      {#if !query}
        <button class="btn" on:click={expandAll}>Tout ouvrir</button>
        <button class="btn" on:click={() => (expanded = new Set(tree.roots))}>Tout fermer</button>
      {/if}
    </div>

    <div class="scroll">
      <VirtualList items={rows} estimateHeight={44} key={(r) => r.key} let:item={row}>
        <div
          class="row"
          class:drop={dragging && dragging.name !== row.name}
          style="padding-left: calc(8px + {Math.min(row.depth, 8)} * var(--step))"
          draggable={admin}
          on:dragstart={(e) => dragStart(e, row)}
          on:dragend={() => (dragging = null)}
          on:dragover={(e) => dragOver(e, row)}
          on:drop={(e) => drop(e, row)}
          role="treeitem"
          aria-selected="false"
          aria-expanded={row.count ? row.open : undefined}
        >
          <button class="caret" class:open={row.open} class:none={!row.count} on:click={() => toggle(row)} aria-label={row.open ? "Replier" : "Déplier"} tabindex={row.count ? 0 : -1}></button>
          <span class="dot" style="background: {byName.get(row.name)?.color || 'var(--border, #2a2d33)'}"></span>
          <span class="name">{row.name}</span>
          {#if row.count}<span class="pill">{row.count}</span>{/if}
          {#if row.parent && row.weight < 1}<span class="w" title="Lien partiel">{Math.round(row.weight * 100)} %</span>{/if}
          {#if row.multi}<span class="w multi" title="Ce genre a plusieurs parents">+ parent</span>{/if}
          {#if admin}
            <span class="acts">
              <button class="btn icon-btn" title="Ranger sous…" on:click={() => { picking = picking?.key === row.key ? null : row; pickQuery = ""; }}>Ranger</button>
              {#if row.parent}
                <button class="btn icon-btn" title="Poids du lien" on:click={() => (weightFor = weightFor === row.key ? null : row.key)}>Poids</button>
                <button class="btn icon-btn" title="Retirer ce lien" on:click={() => cut(row)}><Icon name="x" size={13} /></button>
              {:else}
                <span class="ph"></span>
              {/if}
              <button class="btn icon-btn" title="Renommer" on:click={() => rename(row)}><Icon name="edit" size={13} /></button>
              <button class="btn icon-btn" title="Supprimer" on:click={() => remove(row)}><Icon name="trash" size={13} /></button>
            </span>
            <button class="btn icon-btn more" title="Actions" aria-label="Actions" on:click={() => (menu = menu?.key === row.key ? null : row)}><Icon name="more" size={16} /></button>
          {/if}
        </div>
      </VirtualList>
    </div>

    {#if menu && admin}
      <div class="picker menu" role="menu" aria-label="Actions sur {menu.name}">
        <div class="picker-head">
          <strong>{menu.name}</strong>
          <button class="btn icon-btn" on:click={() => (menu = null)}><Icon name="x" size={13} /></button>
        </div>
        <div class="menu-grid">
          <button class="btn" on:click={() => { picking = menu; pickQuery = ""; menu = null; }}>Ranger sous…</button>
          {#if menu.parent}
            <button class="btn" on:click={() => { weightFor = menu.key; menu = null; }}>Poids du lien</button>
            <button class="btn" on:click={() => { cut(menu); menu = null; }}>Retirer le lien</button>
          {/if}
          <button class="btn" on:click={() => { rename(menu); menu = null; }}>Renommer</button>
          <button class="btn" on:click={() => { remove(menu); menu = null; }}>Supprimer</button>
        </div>
      </div>
    {/if}

    {#if picking && admin}
      <div class="picker" role="dialog" aria-label="Ranger {picking.name}">
        <div class="picker-head">
          <strong>Ranger « {picking.name} » sous</strong>
          <button class="btn icon-btn" on:click={() => (picking = null)}><Icon name="x" size={13} /></button>
        </div>
        <input type="search" placeholder="Chercher un genre" bind:value={pickQuery} />
        <ul>
          {#if picking.parent}<li><button on:click={() => moveTo(picking, null)}>Aucun parent (racine)</button></li>{/if}
          {#each choices as n}
            <li>
              <button on:click={() => moveTo(picking, n.name)}>{n.name}</button>
              <button class="btn" title="Ajouter comme second parent, à 50 %" on:click={() => addParent(picking, n.name)}>+ second parent</button>
            </li>
          {/each}
        </ul>
      </div>
    {/if}

    {#if weightFor && admin}
      {@const wr = rows.find((r) => r.key === weightFor)}
      {#if wr}
        <div class="picker">
          <strong>Lien « {wr.name} » → « {wr.parent} »</strong>
          <label class="slider">
            <span>Lié</span>
            <input type="range" min="0.1" max="1" step="0.05" value={wr.weight} on:change={(e) => setWeight(wr, Number(e.currentTarget.value))} />
            <span>Sous-genre franc</span>
          </label>
          <button class="btn" on:click={() => (weightFor = null)}>Fermer</button>
        </div>
      {/if}
    {/if}
  {/if}
</section>

<style>
  .head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
  }
  .tools,
  .bar,
  .create {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
  }
  .bar,
  .create {
    margin: 12px 0;
  }
  .search {
    flex: 1 1 200px;
    min-width: 0;
  }
  .create input,
  .create select {
    flex: 1 1 160px;
    min-width: 0;
  }
  .scroll {
    max-height: min(62vh, 640px);
    overflow-y: auto;
    border: 1px solid var(--border, #2a2d33);
    border-radius: 12px;
  }
  .row {
    --step: 18px;
    display: flex;
    align-items: center;
    gap: 8px;
    height: 44px;
    box-sizing: border-box;
    padding-right: 8px;
    border-bottom: 1px solid color-mix(in srgb, var(--border, #2a2d33) 55%, transparent);
  }
  .row.drop:hover {
    background: color-mix(in srgb, var(--accent, #8b5cf6) 18%, transparent);
  }
  .caret {
    flex: none;
    width: 28px;
    height: 28px;
    padding: 0;
    background: none;
    border: 0;
    border-radius: 8px;
    position: relative;
    cursor: pointer;
  }
  .caret::before {
    content: "";
    position: absolute;
    left: 10px;
    top: 9px;
    border: solid var(--text-muted, #8b8f98);
    border-width: 0 2px 2px 0;
    width: 6px;
    height: 6px;
    transform: rotate(-45deg);
    transition: transform 0.12s;
  }
  .caret.open::before {
    transform: rotate(45deg);
    top: 7px;
  }
  .caret.none {
    cursor: default;
  }
  .caret.none::before {
    display: none;
  }
  .dot {
    flex: none;
    width: 10px;
    height: 10px;
    border-radius: 50%;
  }
  .name {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .pill,
  .w {
    flex: none;
    font-size: 11px;
    color: var(--text-muted, #8b8f98);
    background: color-mix(in srgb, var(--border, #2a2d33) 60%, transparent);
    border-radius: 999px;
    padding: 1px 7px;
  }
  .acts {
    margin-left: auto;
    display: flex;
    gap: 2px;
    flex: none;
  }
  .ph {
    width: 118px;
  }
  .btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    white-space: nowrap;
    min-height: 34px;
    padding: 0 12px;
    font: inherit;
    font-size: 13px;
    color: inherit;
    background: transparent;
    border: 1px solid var(--border, #2a2d33);
    border-radius: 10px;
    cursor: pointer;
  }
  .btn:hover:not(:disabled) {
    background: color-mix(in srgb, var(--text, #fff) 8%, transparent);
  }
  .btn:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .btn.primary {
    background: var(--accent, #8b5cf6);
    border-color: transparent;
    color: #fff;
  }
  .tree input,
  .tree select {
    min-height: 36px;
    padding: 0 12px;
    font: inherit;
    font-size: 14px;
    color: inherit;
    background: color-mix(in srgb, var(--text, #fff) 6%, transparent);
    border: 1px solid var(--border, #2a2d33);
    border-radius: 10px;
  }
  .tree input[type="range"] {
    padding: 0;
    min-height: 0;
    border: 0;
    background: none;
  }
  .btn.icon-btn {
    min-width: 32px;
    min-height: 32px;
    padding: 0 8px;
    border-color: transparent;
    font-size: 12px;
    border-radius: 8px;
  }
  .picker {
    margin-top: 12px;
    padding: 14px;
    border: 1px solid var(--border, #2a2d33);
    border-radius: 14px;
    display: grid;
    gap: 10px;
  }
  .picker-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .picker ul {
    list-style: none;
    margin: 0;
    padding: 0;
    max-height: 240px;
    overflow-y: auto;
  }
  .picker li {
    display: flex;
    gap: 6px;
    align-items: center;
    justify-content: space-between;
  }
  .picker li > button:first-child:not(.btn) {
    flex: 1;
    text-align: left;
    background: none;
    border: 0;
    color: inherit;
    padding: 9px 6px;
    min-height: 40px;
    cursor: pointer;
  }
  .slider {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 12px;
  }
  .slider input {
    flex: 1;
  }
  .more {
    display: none;
    margin-left: auto;
  }
  .menu-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: 8px;
  }
  @media (max-width: 760px) {
    .row {
      --step: 9px;
    }
    .acts,
    .ph {
      display: none;
    }
    .more {
      display: inline-flex;
    }
    .multi {
      display: none;
    }
    .name {
      flex: 1 1 auto;
    }
  }
</style>
