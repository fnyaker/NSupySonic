<script>
  import { onDestroy, onMount } from "svelte";
  import { api } from "../lib/api.js";
  import { toasts } from "../lib/stores.js";
  import Icon from "./Icon.svelte";
  import JobFailures from "./JobFailures.svelte";

  // Who wrote, composed and produced each track: kept in the database as a
  // track is archived, imported or completed by MusicBrainz. The library
  // archived before that is completed once, on its own after the update —
  // from the files first, then from Deezer fifty titles per request, always
  // behind what is playing. This bar shows that run and can start another.
  let job = null;
  let timer = null;
  let force = false;
  let watching = false;

  $: pct =
    job && job.total ? Math.min(100, Math.round(((job.done + job.failed) / job.total) * 100)) : 0;
  $: c = job?.counts || {};

  function poll() {
    clearTimeout(timer);
    watching = true;
    timer = setTimeout(async () => {
      try {
        job = await api.creditsBackfillStatus();
      } catch {
        job = null;
        return;
      }
      if (job?.running) poll();
      else if (watching) {
        watching = false;
        if (job?.failed) toasts.push(`${job.failed} titre${job.failed > 1 ? "s" : ""} en échec`, "error");
        else toasts.push("Crédits à jour");
      }
    }, 1500);
  }

  async function start() {
    try {
      job = await api.creditsBackfill(force);
      if (job?.running) poll();
    } catch (e) {
      toasts.push(e?.message || "Impossible de lancer le rattrapage", "error");
    }
  }

  onMount(async () => {
    try {
      job = await api.creditsBackfillStatus();
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
      {#if c.deezer}<span class="sep">·</span><span>{c.deezer} par Deezer</span>{/if}
      {#if c.local}<span class="sep">·</span><span>{c.local} depuis les fichiers</span>{/if}
      {#if job.failed}<span class="sep">·</span><span class="bad">{job.failed} en échec</span>{/if}
    </div>
  {:else}
    <button class="ghost" on:click={start}>
      <Icon name="users" size={16} /> Compléter les crédits
    </button>
    <label class="check">
      <input type="checkbox" bind:checked={force} />
      Tout recommencer
    </label>
    <span class="muted small">
      {#if job?.tracks}
        {job.tracks} titre{job.tracks > 1 ? "s" : ""} ont leurs crédits (compositeur, auteur, producteur…).
        {job.completed ? "La bibliothèque archivée avant a été complétée." : "La bibliothèque archivée avant sera complétée au prochain démarrage."}
      {:else}
        Compositeur, auteur, producteur de chaque titre, gardés en base pour le lecteur plein écran, sans
        jamais ralentir la lecture.
      {/if}
    </span>
  {/if}
</div>
{#if job?.error}
  <div class="banner bad"><Icon name="alert" size={16} /><span>{job.error}</span></div>
{/if}
<JobFailures {job} label="crédits" />

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
  .bar button {
    display: inline-flex;
    align-items: center;
    gap: 8px;
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
