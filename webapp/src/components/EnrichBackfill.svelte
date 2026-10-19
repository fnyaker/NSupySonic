<script>
  import { onDestroy, onMount } from "svelte";
  import { api } from "../lib/api.js";
  import { toasts } from "../lib/stores.js";
  import Icon from "./Icon.svelte";
  import JobFailures from "./JobFailures.svelte";

  // MusicBrainz completes a track's facts (first release date, composer,
  // lyricist, producer) on its own, in the background, as titles are archived
  // or uploaded. This button catches up the library that was archived before.
  let job = null;
  let timer = null;
  let force = false;

  const METHODS = { isrc: "ISRC", acoustid: "empreinte", search: "recherche" };

  $: pct =
    job && job.total ? Math.min(100, Math.round(((job.done + job.failed) / job.total) * 100)) : 0;
  $: found = job?.coverage?.found || {};
  $: foundTotal = Object.values(found).reduce((a, b) => a + b, 0);
  $: byMethod = Object.entries(found)
    .map(([m, n]) => `${n} par ${METHODS[m] || m}`)
    .join(", ");

  function poll() {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      try {
        job = await api.enrichStatus();
      } catch {
        job = null;
        return;
      }
      if (job?.running) poll();
      else if (job?.failed) toasts.push(`${job.failed} titre${job.failed > 1 ? "s" : ""} en échec`, "error");
      else toasts.push("Faits à jour");
    }, 1500);
  }

  async function start() {
    try {
      job = await api.enrichBackfill(force);
      if (job?.running) poll();
    } catch (e) {
      toasts.push(e?.message || "Impossible de lancer le rattrapage", "error");
    }
  }

  onMount(async () => {
    try {
      job = await api.enrichStatus();
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
    <button class="ghost" on:click={start} disabled={job && !job.enabled}>
      <Icon name="refresh" size={16} /> Compléter depuis MusicBrainz
    </button>
    <label class="check">
      <input type="checkbox" bind:checked={force} />
      Tout recommencer
    </label>
    <span class="muted small">
      {#if job && !job.enabled}
        Désactivé dans la configuration ([enrich] enabled).
      {:else if job?.coverage?.tried}
        {foundTotal} titre{foundTotal > 1 ? "s" : ""} complété{foundTotal > 1 ? "s" : ""}{byMethod ? ` (${byMethod})` : ""},
        {job.coverage.untried} pas encore essayé{job.coverage.untried > 1 ? "s" : ""}.
        Un titre archivé ou téléversé est complété tout seul, à une requête par seconde.
      {:else}
        Date de première sortie, compositeur, parolier et producteur, sans jamais ralentir la lecture.
      {/if}
      {#if job && !job.acoustid}
        L'empreinte sonore (AcoustID) demande l'outil fpcalc et une clé.
      {/if}
    </span>
  {/if}
</div>
{#if job?.error}
  <div class="banner bad"><Icon name="alert" size={16} /><span>{job.error}</span></div>
{/if}
<JobFailures {job} label="faits" />

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
