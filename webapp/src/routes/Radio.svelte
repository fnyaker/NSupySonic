<script>
  // A radio by style: pick one or several genres (a family means all of it),
  // say how far to wander, press play. The queue is built on the server from
  // the library's genre / tempo / artist verdicts and the listener's own stars
  // and plays, so it differs every time and only ever holds music already here.
  import { onMount } from "svelte";
  import { api } from "../lib/api.js";
  import { player, toasts, user } from "../lib/stores.js";
  import Icon from "../components/Icon.svelte";

  let genres = [];
  let loading = true;
  let failed = "";
  let open = null; // the family whose sub-genres are showing
  let picked = []; // genre names
  let level = 1; // index in LEVELS
  let busy = false;
  let explorer = null;
  let savingExplorer = null;

  async function saveExplorer() {
    clearTimeout(savingExplorer);
    savingExplorer = setTimeout(async () => {
      try {
        explorer = await api.radioExplorer({
          enabled: explorer.enabled,
          archive: explorer.archive,
          pool: explorer.pool,
        });
      } catch (e) {
        toasts.push(e?.message || "enregistrement impossible", "error");
      }
    }, 300);
  }

  const LEVELS = [
    { id: "home", label: "Mes habitudes", hint: "Ce que vous écoutez déjà dans ce style", value: 0.1 },
    { id: "near", label: "Un peu plus loin", hint: "Des cousins du style, des titres peu écoutés", value: 0.45 },
    { id: "far", label: "Aventure", hint: "Les genres voisins, surtout du jamais entendu", value: 0.9 },
  ];

  $: byParent = genres.reduce((m, g) => {
    (m[g.parent || ""] ||= []).push(g);
    return m;
  }, {});
  // Top-level families; "Électronique" is too wide to be one, its children are.
  $: families = [
    ...(byParent[""] || []).filter((g) => g.name !== "Électronique"),
    ...(byParent["Électronique"] || []),
  ]
    .filter((g) => g.branch > 0)
    .sort((a, b) => b.branch - a.branch);
  $: subs = open ? flat(open) : [];
  $: total = picked.length;

  // Every genre under a family that the library actually has tracks for.
  function flat(name) {
    const out = [];
    const walk = (n) => {
      for (const g of byParent[n] || []) {
        if (g.branch > 0) {
          out.push(g);
          walk(g.name);
        }
      }
    };
    walk(name);
    return out;
  }

  function toggle(name) {
    picked = picked.includes(name) ? picked.filter((n) => n !== name) : [...picked, name].slice(-8);
  }

  async function start() {
    if (!picked.length || busy) return;
    busy = true;
    try {
      const r = await api.radioGenre({ seeds: picked, discovery: LEVELS[level].value, count: 60 });
      if (!r.tracks?.length) {
        toasts.push("Rien à jouer pour ce style pour l'instant", "error");
        return;
      }
      player.playQueue(r.tracks, 0, { kind: "radio", id: picked.join(",") });
    } catch (e) {
      toasts.push(e?.message || "radio impossible", "error");
    } finally {
      busy = false;
    }
  }

  onMount(async () => {
    try {
      genres = (await api.radioGenres()).genres || [];
    } catch (e) {
      failed = e?.message || "impossible de charger les genres";
    } finally {
      loading = false;
    }
    if ($user?.admin) {
      try {
        explorer = await api.radioExplorer();
      } catch {
        /* the switches simply stay hidden */
      }
    }
  });
</script>

<div class="page">
  <h1>Radio</h1>
  <p class="lead">Choisissez un style, puis jusqu'où on s'éloigne.</p>

  {#if loading}
    <p class="dim">Chargement…</p>
  {:else if failed}
    <p class="dim">{failed}</p>
  {:else if !families.length}
    <div class="empty">
      <Icon name="activity" size={28} />
      <p>La radio a besoin de titres analysés.</p>
      <p class="dim">Lancez l'analyse de la bibliothèque dans le studio de genres.</p>
    </div>
  {:else}
    <section>
      <h2>1 · Le style</h2>
      <div class="chips">
        {#each families as f (f.name)}
          <button
            class="chip"
            class:sel={picked.includes(f.name)}
            class:open={open === f.name}
            on:click={() => {
              open = open === f.name ? null : f.name;
            }}
          >
            {f.name}<span class="n">{f.branch}</span>
          </button>
        {/each}
      </div>

      {#if open}
        <div class="subs">
          <button class="chip all" class:sel={picked.includes(open)} on:click={() => toggle(open)}>
            <Icon name={picked.includes(open) ? "check" : "play"} size={14} /> Tout {open}
          </button>
          {#each subs as g (g.name)}
            <button class="chip sm" class:sel={picked.includes(g.name)} on:click={() => toggle(g.name)}>
              {g.name}<span class="n">{g.tracks || g.branch}</span>
            </button>
          {/each}
        </div>
      {/if}

      {#if picked.length}
        <p class="picked">
          {#each picked as p}
            <button class="tag" on:click={() => toggle(p)}>{p} <Icon name="close" size={12} /></button>
          {/each}
        </p>
      {/if}
    </section>

    <section>
      <h2>2 · Découverte</h2>
      <div class="levels" role="radiogroup">
        {#each LEVELS as l, i}
          <button class="lvl" class:sel={level === i} role="radio" aria-checked={level === i} on:click={() => (level = i)}>
            <span class="dots" aria-hidden="true">
              {#each [0, 1, 2] as d}<i class:on={d <= i}></i>{/each}
            </span>
            <strong>{l.label}</strong>
            <span class="dim">{l.hint}</span>
          </button>
        {/each}
      </div>
    </section>

    {#if explorer}
      <section class="explorer">
        <h2>Exploration automatique</h2>
        <label class="sw">
          <input type="checkbox" bind:checked={explorer.enabled} on:change={saveExplorer} />
          <span>
            <strong>Chercher de nouveaux sons en arrière-plan</strong>
            <span class="dim">
              Seulement des genres que l'analyseur sait reconnaître, vérifiés sur un extrait de 30 s,
              jamais pendant que vous écoutez.
            </span>
          </span>
        </label>
        <label class="sw">
          <input type="checkbox" bind:checked={explorer.archive} on:change={saveExplorer} disabled={!explorer.enabled} />
          <span>
            <strong>Archiver tout ce qui est trouvé</strong>
            <span class="dim">Par défaut non : un titre n'est archivé que si vous l'écoutez ou l'aimez.</span>
          </span>
        </label>
        <p class="dim stat">
          {explorer.pool_now} découverte{explorer.pool_now > 1 ? "s" : ""} en réserve
          {#if explorer.running}· recherche en cours{/if}
          {#if explorer.last_error}· <span class="warn">{explorer.last_error}</span>{/if}
        </p>
      </section>
    {/if}

    <button class="go" on:click={start} disabled={!total || busy}>
      <Icon name="play" size={18} />
      {busy ? "Mélange…" : total ? "Lancer la radio" : "Choisissez un style"}
    </button>
  {/if}
</div>

<style>
  .page { max-width: 760px; margin: 0 auto; padding: 8px 16px 140px; }
  h1 { margin: 18px 0 4px; letter-spacing: -0.02em; }
  h2 { font-size: 0.82rem; text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-dim); margin: 28px 0 12px; }
  .lead, .dim { color: var(--text-dim); }
  .lead { margin: 0; }
  .chips, .subs { display: flex; flex-wrap: wrap; gap: 8px; }
  .subs { margin-top: 14px; padding: 14px; background: var(--bg-card); border-radius: 16px; }
  .chip {
    display: inline-flex; align-items: center; gap: 8px; min-height: 42px; padding: 8px 14px;
    border-radius: 999px; border: 1px solid transparent; background: var(--bg-card); color: var(--text);
    font: inherit; font-weight: 600; cursor: pointer;
  }
  .chip.sm { min-height: 36px; font-weight: 500; font-size: 0.9rem; background: var(--bg-elev); }
  .chip.open { border-color: var(--accent); }
  .chip.sel { background: var(--accent); color: #fff; }
  .chip .n { font-size: 0.75rem; opacity: 0.65; font-variant-numeric: tabular-nums; }
  .picked { display: flex; flex-wrap: wrap; gap: 6px; margin: 16px 0 0; }
  .tag { display: inline-flex; align-items: center; gap: 6px; border: 0; border-radius: 8px; padding: 4px 8px; background: var(--bg-hover); color: var(--text); font: inherit; font-size: 0.82rem; cursor: pointer; }
  .levels { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 10px; }
  .lvl {
    display: grid; gap: 6px; text-align: left; padding: 16px; border-radius: 16px; font: inherit;
    border: 1px solid transparent; background: var(--bg-card); color: var(--text); cursor: pointer;
  }
  .lvl.sel { border-color: var(--accent); background: var(--bg-hover); }
  .lvl .dim { font-size: 0.82rem; line-height: 1.35; }
  .dots { display: flex; gap: 5px; }
  .dots i { width: 9px; height: 9px; border-radius: 50%; background: var(--bg-hover); }
  .lvl.sel .dots i.on { background: var(--accent); }
  .go {
    position: sticky; bottom: 90px; margin-top: 32px; width: 100%; min-height: 54px; border: 0; border-radius: 16px;
    display: flex; align-items: center; justify-content: center; gap: 10px; font: inherit; font-weight: 700; font-size: 1.02rem;
    color: #fff; background: linear-gradient(90deg, var(--accent), var(--accent-2)); cursor: pointer;
  }
  .go:disabled { opacity: 0.45; cursor: default; }
  .empty { display: grid; justify-items: center; gap: 6px; padding: 48px 0; text-align: center; }
  .explorer { margin-top: 28px; padding: 18px; background: var(--bg-card); border-radius: 16px; }
  .explorer h2 { margin-top: 0; }
  .sw { display: flex; gap: 12px; align-items: flex-start; padding: 8px 0; cursor: pointer; }
  .sw input { width: 20px; height: 20px; margin-top: 2px; accent-color: var(--accent); flex: none; }
  .sw span { display: grid; gap: 2px; }
  .sw .dim { font-size: 0.82rem; line-height: 1.4; }
  .stat { margin: 8px 0 0; font-size: 0.84rem; }
  .warn { color: #fbbf24; }
</style>
