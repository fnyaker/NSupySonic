<script>
  // The style the Flow plays around: one family, several, or none ("Tout" = the
  // whole taste). Picking a family means ALL of it; its sub-genres open under the
  // row for a finer choice. The Flow then rests on what this person likes inside
  // the style, and the discovery slider decides how far from it the rest strays
  // (supysonic/discover.py#style_taste). Kept on the device, like the energy notch.
  import { onMount } from "svelte";
  import { api } from "../lib/api.js";
  import { startStyles, setStartStyles, STYLES_MAX } from "../lib/flow.js";
  import Icon from "./Icon.svelte";

  let rows = [];
  let open = null; // the family whose sub-genres show
  let failed = false;

  $: byParent = rows.reduce((m, r) => ((m[r.parent || ""] ||= []).push(r), m), {});
  // Families: the roots, and the children of the electronic root (too wide to be one).
  $: families = [...(byParent[""] || []).filter((r) => r.name !== "Électronique"), ...(byParent["Électronique"] || [])]
    .filter((r) => r.branch > 0)
    .sort((a, b) => b.branch - a.branch)
    .slice(0, 16);
  $: subs = open ? flat(open) : [];

  function flat(name, depth = 0) {
    const out = [];
    for (const r of byParent[name] || []) {
      if (r.branch > 0) {
        out.push(r);
        if (depth < 2) out.push(...flat(r.name, depth + 1));
      }
    }
    return out;
  }

  function toggle(name) {
    const cur = $startStyles;
    setStartStyles(cur.includes(name) ? cur.filter((n) => n !== name) : [...cur, name].slice(-STYLES_MAX));
  }

  onMount(async () => {
    try {
      // The cached copy first, the fresh one right after (the list moves slowly).
      await api.swr("/flow/styles", (d) => (rows = d.styles || []));
    } catch {
      failed = true;
    }
  });
</script>

{#if families.length}
  <div class="style-block fade-in">
    <div class="style-row">
      <span class="label">Style</span>
      <div class="chips" role="group" aria-label="Style du Flow">
        <button type="button" class:on={!$startStyles.length} on:click={() => setStartStyles([])}>Tout</button>
        {#each families as f (f.name)}
          <button
            type="button"
            class:on={$startStyles.includes(f.name)}
            class:open={open === f.name}
            on:click={() => (open = open === f.name ? null : f.name)}
            aria-expanded={open === f.name}
          >
            {f.name}
          </button>
        {/each}
      </div>
    </div>
    {#if open}
      <div class="subs">
        <button type="button" class="sub all" class:on={$startStyles.includes(open)} on:click={() => toggle(open)}>
          <Icon name={$startStyles.includes(open) ? "check" : "play"} size={13} /> Tout {open}
        </button>
        {#each subs as g (g.name)}
          <button type="button" class="sub" class:on={$startStyles.includes(g.name)} on:click={() => toggle(g.name)}>
            {g.name}<span class="n">{g.tracks || g.branch}</span>
          </button>
        {/each}
      </div>
    {/if}
    {#if $startStyles.length}
      <p class="chosen">
        Flow autour de
        {#each $startStyles as s}<button type="button" class="tag" on:click={() => toggle(s)}>{s} <Icon name="close" size={11} /></button>{/each}
      </p>
    {/if}
  </div>
{/if}

<style>
  .style-block { margin-top: 10px; min-width: 0; }
  .style-row { display: flex; align-items: center; gap: 12px; min-width: 0; }
  .label { flex: none; font-size: 0.78rem; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-dim); font-weight: 600; }
  .chips { display: flex; gap: 8px; overflow-x: auto; scrollbar-width: none; padding: 2px 0; min-width: 0;
    mask-image: linear-gradient(to right, #000 calc(100% - 24px), transparent);
    -webkit-mask-image: linear-gradient(to right, #000 calc(100% - 24px), transparent); }
  .chips::-webkit-scrollbar { display: none; }
  .chips button, .sub, .tag {
    flex: none; display: inline-flex; align-items: center; gap: 6px; border: 1px solid transparent; border-radius: 999px;
    background: var(--bg-card); color: var(--text); font: inherit; font-size: 0.86rem; font-weight: 600; cursor: pointer;
    padding: 0 14px; min-height: 36px;
  }
  .chips button.on, .sub.on { background: var(--accent); color: #fff; }
  .chips button.open:not(.on) { border-color: var(--accent); }
  .subs { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; padding: 12px; background: var(--bg-card); border-radius: 16px; }
  .sub { background: var(--bg-elev); font-weight: 500; min-height: 34px; }
  .sub.all { font-weight: 700; }
  .sub .n { font-size: 0.72rem; opacity: 0.65; font-variant-numeric: tabular-nums; }
  .chosen { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin: 10px 0 0; font-size: 0.84rem; color: var(--text-dim); }
  .tag { background: var(--bg-hover); font-size: 0.8rem; font-weight: 500; min-height: 28px; padding: 0 10px; }
</style>
