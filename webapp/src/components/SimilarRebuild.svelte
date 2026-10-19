<script>
  import { onDestroy, onMount } from "svelte";
  import { api } from "../lib/api.js";
  import { toasts } from "../lib/stores.js";
  import Icon from "./Icon.svelte";
  import JobFailures from "./JobFailures.svelte";

  // The radio, the flow and the "sounds like" shelves read ONE table: the 50
  // closest tracks of each. It fills itself as vectors arrive; this recomputes
  // it for a library whose vectors were measured before it existed.
  let job = null;
  let timer = null;
  let force = false;

  $: pct =
    job && job.total ? Math.min(100, Math.round(((job.done + job.failed) / job.total) * 100)) : 0;

  function poll() {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      try {
        job = await api.similarStatus();
      } catch {
        job = null;
        return;
      }
      if (job?.running) poll();
      else if (job?.failed) toasts.push(`${job.failed} titre${job.failed > 1 ? "s" : ""} en échec`, "error");
      else toasts.push("Voisins sonores à jour");
    }, 900);
  }

  async function start() {
    try {
      job = await api.similarRebuild(force);
      if (job?.running) poll();
    } catch (e) {
      toasts.push(e?.message || "Impossible de lancer le calcul", "error");
    }
  }

  onMount(async () => {
    try {
      job = await api.similarStatus();
      if (job?.running) poll();
    } catch {
      /* not an admin, or the server is away: the bar simply does not show */
    }
  });
  onDestroy(() => clearTimeout(timer));
</script>

<div class="bar" class:running={job?.running}>
  {#if job?.running}
    <div class="progress"><i style={`width:${pct}%`}></i></div>
    <div class="stats muted small">
      <span>{job.done + job.failed}/{job.total || "?"} titres</span>
      {#if job.failed}<span class="sep">·</span><span class="bad">{job.failed} en échec</span>{/if}
    </div>
  {:else}
    <button class="ghost" on:click={start}>
      <Icon name="activity" size={16} /> Recalculer les voisins sonores
    </button>
    <label class="check">
      <input type="checkbox" bind:checked={force} />
      Tout recommencer
    </label>
    <span class="muted small">
      {#if job?.tracks}
        {job.tracks} titre{job.tracks > 1 ? "s" : ""} ont leurs voisins. Un titre mesuré les reçoit tout seul ; ce bouton
        sert à rattraper une bibliothèque mesurée avant.
      {:else}
        Ce qui fait marcher la radio, le flow et l'accueil : les 50 titres qui sonnent le plus
        comme chacun.
      {/if}
    </span>
  {/if}
</div>
{#if job?.error}
  <div class="banner bad"><Icon name="alert" size={16} /><span>{job.error}</span></div>
{/if}
<JobFailures {job} label="voisins" />

<style>
  .bar {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
    background: var(--surface-2, #1b1d21);
    border-radius: 12px;
    padding: 10px 12px;
    margin: 14px 0;
    font-size: 0.84rem;
  }
  .bar.running {
    display: grid;
    grid-template-columns: 1fr;
    gap: 6px;
  }
  .bar .progress {
    margin: 0;
  }
  .stats {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    font-variant-numeric: tabular-nums;
  }
  .check {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--text-dim, #9aa0a6);
    white-space: nowrap;
  }
  .check input {
    accent-color: var(--accent, #22d3ee);
  }
</style>
