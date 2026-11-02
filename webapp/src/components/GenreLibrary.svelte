<script>
  // The library's upkeep at a glance: how much is up to date, what is not and
  // at which step, one button, and the nightly window. The server does the work
  // behind a gate that stops it whenever somebody listens (workload.Throttle),
  // so nothing here is a speed dial — only "now" or "tonight".
  import { createEventDispatcher, onDestroy, onMount } from "svelte";
  import { api } from "../lib/api.js";
  import { toasts } from "../lib/stores.js";
  import Icon from "./Icon.svelte";
  import JobFailures from "./JobFailures.svelte";
  import GenreExtractor from "./GenreExtractor.svelte";
  import SimilarRebuild from "./SimilarRebuild.svelte";
  import { clientJob } from "../lib/analysis/runner.js";

  /** `status.extractor` from /genre/status. */
  export let extractor = { available: false };
  const dispatch = createEventDispatcher();

  let plan = null;
  let job = null;
  let schedule = { enabled: true, at: "03:00", hours: 6 };
  let workers = 0;
  let workersAuto = 1;
  let force = false;
  let timer = null;
  let explorer = null;
  let explorerSave = null;
  let wasRunning = false;
  let dead = false;
  // Who measures: the server (ffmpeg there) or this computer (webapp/measure, WebAssembly).
  let where = "server";
  let clientRun = null;
  $: onClient = where === "client";
  $: cj = $clientJob;
  $: cpct = cj.total ? Math.min(100, Math.round(((cj.done + cj.failed) / cj.total) * 100)) : 0;

  const STAGES = { measure: "Mesure", embed: "Empreintes", decide: "Classement" };
  const WHY = {
    listening: "quelqu'un écoute de la musique",
    download: "un téléchargement est en cours",
    load: "le serveur est occupé",
  };

  $: running = !!job?.running;
  $: total = plan?.total || 0;
  $: current = plan?.current || 0;
  $: never = plan?.unmeasured || 0;
  $: stale = Math.max(0, total - current - never);
  $: share = (n) => (total ? (n / total) * 100 : 0);
  // One row per step of the pipeline. A track never measured is behind on every
  // step; the stale counts are rows behind on that step only.
  $: steps = plan
    ? [
        { id: "measure", name: "Mesure", hint: "tempo, style", late: never + plan.stale_measure },
        {
          id: "embed",
          name: "Empreinte",
          hint: plan.extractor ? "ce que le modèle écoute" : "extracteur absent",
          late: plan.extractor ? never + plan.stale_embed : 0,
          off: !plan.extractor,
        },
        { id: "decide", name: "Classement", hint: "genre retenu", late: never + plan.stale_decide },
      ]
    : [];
  $: pct = job?.total ? Math.min(100, Math.round((job.scanned / job.total) * 100)) : 0;

  async function load() {
    const [p, j] = await Promise.allSettled([api.analysisPlan(), api.analysisBackfillStatus()]);
    if (dead) return;
    if (p.status === "fulfilled" && p.value) {
      plan = p.value;
      if (p.value.schedule) schedule = p.value.schedule;
      if (p.value.where && !cj.running) where = p.value.where;
    }
    if (j.status === "fulfilled" && j.value) {
      job = j.value;
      if (typeof job.workers_setting === "number") workers = job.workers_setting;
      if (job.workers_auto) workersAuto = job.workers_auto;
    }
    if (wasRunning && !job?.running) {
      // The pass just ended: newly measured tracks can now be tagged.
      dispatch("change");
      if (job?.error) toasts.push(job.error, "error");
    }
    wasRunning = !!job?.running;
    clearTimeout(timer);
    timer = setTimeout(load, job?.running ? 1500 : 15000);
  }

  async function start() {
    try {
      job = await api.analysisBackfill(force, workers);
      force = false;
    } catch (e) {
      toasts.push(e?.message || "lancement impossible", "error");
      return;
    }
    wasRunning = true;
    load();
  }

  async function setWhere(w) {
    if (w === where || cj.running) return;
    const before = where;
    where = w;
    try {
      await api.analysisWhere(w);
    } catch (e) {
      where = before;
      toasts.push(e?.message || "choix impossible", "error");
    }
  }

  async function startClient() {
    // Loaded on demand: the WebAssembly core and its worker are not part of the first screen.
    clientRun ||= (await import("../lib/analysis/client.js")).clientAnalysis();
    await clientRun.run();
    dispatch("change");
    load();
  }

  async function stopJob() {
    try {
      job = await api.analysisBackfillStop();
    } catch (e) {
      toasts.push(e?.message || "arrêt impossible", "error");
    }
  }

  let saving = null;
  function saveSchedule() {
    clearTimeout(saving);
    saving = setTimeout(async () => {
      try {
        const r = await api.analysisSchedule(schedule);
        schedule = r.schedule;
      } catch (e) {
        toasts.push(e?.message || "enregistrement impossible", "error");
      }
    }, 400);
  }

  function saveExplorer() {
    clearTimeout(explorerSave);
    explorerSave = setTimeout(async () => {
      try {
        explorer = await api.explorer({ enabled: explorer.enabled, archive: explorer.archive, pool: explorer.pool });
      } catch (e) {
        toasts.push(e?.message || "enregistrement impossible", "error");
      }
    }, 300);
  }

  onMount(async () => {
    load();
    try {
      explorer = await api.explorer();
    } catch {
      /* the card simply stays hidden */
    }
  });
  onDestroy(() => {
    dead = true;
    clearTimeout(timer);
    clearTimeout(saving);
    clearTimeout(explorerSave);
  });

  const n = (v) => (v || 0).toLocaleString("fr-FR");
</script>

<section class="st-card hero">
  {#if !plan}
    <p class="st-dim">Chargement…</p>
  {:else}
    <div class="top">
      <div class="big">
        <span class="num">{n(current)}</span>
        <span class="of st-dim">sur {n(total)} titres à jour</span>
      </div>
      {#if onClient && cj.running}
        <button class="st-btn" on:click={() => clientRun?.stop()}>
          <Icon name="pause" size={16} />Arrêter
        </button>
      {:else if onClient}
        <button class="st-btn primary" on:click={startClient} disabled={!plan.todo}>
          <Icon name={plan.todo ? "play" : "check"} size={16} />
          {plan.todo ? "Analyser ici" : "Tout est à jour"}
        </button>
      {:else if running}
        <button class="st-btn" on:click={stopJob} disabled={job.cancel}>
          <Icon name="pause" size={16} />{job.cancel ? "Arrêt…" : "Arrêter"}
        </button>
      {:else}
        <button class="st-btn primary" on:click={start} disabled={!plan.todo && !force}>
          <Icon name={plan.todo ? "play" : "check"} size={16} />
          {plan.todo ? "Analyser maintenant" : "Tout est à jour"}
        </button>
      {/if}
    </div>

    <div class="where" role="group" aria-label="Où analyser">
      <button class:on={!onClient} disabled={cj.running} on:click={() => setWhere("server")}>
        <Icon name="server" size={15} />Serveur
      </button>
      <button class:on={onClient} disabled={cj.running} on:click={() => setWhere("client")}>
        <Icon name="monitor" size={15} />Cet ordinateur
      </button>
    </div>

    <div class="stack" role="img" aria-label={`${current} à jour, ${stale} à remettre à jour, ${never} jamais analysés`}>
      <i class="ok" style={`width:${share(current)}%`}></i>
      <i class="old" style={`width:${share(stale)}%`}></i>
      <i class="new" style={`width:${share(never)}%`}></i>
    </div>
    <div class="legend st-dim">
      <span><b class="dot ok"></b>À jour</span>
      {#if stale}<span><b class="dot old"></b>{n(stale)} à remettre à jour</span>{/if}
      {#if never}<span><b class="dot new"></b>{n(never)} jamais analysés</span>{/if}
    </div>

    {#if onClient && (cj.running || cj.done || cj.failed || cj.error)}
      <div class="live">
        <div class="bar"><i style={`width:${cpct}%`}></i></div>
        <p class="st-dim">
          <strong>{cj.running ? "Mesure sur cet ordinateur" : cj.stopped ? "Arrêtée" : "Terminée"}</strong>
          · {n(cj.done)} analysés{#if cj.total} sur {n(cj.total)}{/if}
          {#if cj.failed}· <span class="bad">{cj.failed} en échec</span>{/if}
        </p>
        {#if cj.current.length}<p class="st-dim line">{cj.current.join(", ")}</p>{/if}
        {#if cj.error}<div class="st-note bad"><Icon name="alert" size={16} /><span>{cj.error}</span></div>{/if}
      </div>
    {:else if !onClient && running}
      <div class="live">
        <div class="bar"><i style={`width:${pct}%`}></i></div>
        <p class="st-dim">
          <strong>{STAGES[job.stage] || "Analyse"}</strong>
          · {n(job.scanned)} / {n(job.total)} parcourus · {n(job.done)} analysés
          {#if job.failed}· <span class="bad">{job.failed} en échec</span>{/if}
        </p>
        {#if job.paused}
          <p class="pause"><Icon name="moon" size={14} /> En pause : {WHY[job.paused] || job.paused}. Reprend toute seule.</p>
        {/if}
      </div>
    {:else if !onClient && plan.todo && schedule.enabled}
      <p class="st-dim line"><Icon name="moon" size={14} /> Prochaine analyse automatique à {schedule.at}, pendant {schedule.hours} h au plus.</p>
    {/if}
    {#if job?.error && !running}
      <div class="st-note bad"><Icon name="alert" size={16} /><span>{job.error}</span></div>
    {/if}
    <JobFailures job={onClient ? cj : job} label="analyse" />
  {/if}
</section>

{#if plan}
  <section class="st-card">
    <h2>Les trois étapes</h2>
    <ol class="steps">
      {#each steps as s, i}
        {@const done = Math.max(0, total - s.late)}
        <li class:off={s.off} class:active={running && job.stage === s.id}>
          <span class="idx">{i + 1}</span>
          <div class="body">
            <div class="line2">
              <strong>{s.name}</strong>
              <span class="st-dim">{s.hint}</span>
              <span class="cnt">
                {#if s.off}—{:else if s.late}{n(s.late)} à faire{:else}<Icon name="check" size={14} />{/if}
              </span>
            </div>
            <div class="mini"><i style={`width:${s.off ? 0 : share(done)}%`}></i></div>
          </div>
        </li>
      {/each}
    </ol>
    <p class="st-dim foot">
      Un nouveau modèle ne refait que l'étape 3, sans toucher au fichier audio.
    </p>
  </section>

  <section class="st-card">
    <h2><Icon name="moon" size={18} /> Analyse automatique</h2>
    <div class="sched">
      <label class="switch">
        <input type="checkbox" bind:checked={schedule.enabled} on:change={saveSchedule} />
        <span>Chaque nuit</span>
      </label>
      <label class="fld" class:dim={!schedule.enabled}>
        à <input type="time" bind:value={schedule.at} on:change={saveSchedule} disabled={!schedule.enabled} />
      </label>
      <label class="fld" class:dim={!schedule.enabled}>
        pendant
        <select bind:value={schedule.hours} on:change={saveSchedule} disabled={!schedule.enabled}>
          {#each [1, 2, 3, 4, 6, 8, 10, 12] as h}<option value={h}>{h} h</option>{/each}
        </select>
      </label>
    </div>
    <p class="st-dim foot">
      L'analyse s'efface devant vous : elle se met en pause dès qu'on écoute de la musique ou
      que le serveur est chargé, et reprend après.
    </p>
  </section>

  {#if explorer}
    <section class="st-card">
      <h2><Icon name="compass" size={18} /> Exploration automatique</h2>
      <label class="switch top">
        <input type="checkbox" bind:checked={explorer.enabled} on:change={saveExplorer} />
        <span>
          <strong>Chercher de nouveaux sons en arrière-plan</strong>
          <span class="st-dim sw-sub">
            Uniquement des genres que l'analyseur sait reconnaître, vérifiés sur l'extrait de 30 s,
            jamais pendant que vous écoutez. Le Flow et les radios les proposent comme découvertes.
          </span>
        </span>
      </label>
      <label class="switch top" class:dim={!explorer.enabled}>
        <input type="checkbox" bind:checked={explorer.archive} on:change={saveExplorer} disabled={!explorer.enabled} />
        <span>
          <strong>Archiver tout ce qui est trouvé</strong>
          <span class="st-dim sw-sub">Par défaut non : un titre n'est archivé que si vous l'écoutez ou l'aimez.</span>
        </span>
      </label>
      <p class="st-dim foot">
        {explorer.pool_now} découverte{explorer.pool_now > 1 ? "s" : ""} en réserve
        {#if explorer.running}· recherche en cours{/if}
        {#if explorer.paused}· en pause : {WHY[explorer.paused] || explorer.paused}{/if}
        {#if explorer.last_error}· <span class="bad">{explorer.last_error}</span>{/if}
      </p>
    </section>
  {/if}

  <details class="st-card adv">
    <summary>Avancé</summary>
    <div class="adv-body">
      <label class="fld">
        Titres en parallèle
        <input type="number" min="0" max="8" bind:value={workers} />
        <span class="st-dim">{workers > 0 ? "fixé" : `auto · ${workersAuto}`}</span>
      </label>
      <label class="switch">
        <input type="checkbox" bind:checked={force} />
        <span>Tout remesurer, même ce qui est à jour</span>
      </label>
      <h3>Voisins sonores</h3>
      <SimilarRebuild />
      <h3>Extracteur</h3>
      <GenreExtractor {extractor} on:change />
    </div>
  </details>
{/if}

<style>
  .hero .top { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
  .big { display: grid; gap: 2px; }
  .num { font-size: 2.4rem; font-weight: 800; letter-spacing: -0.03em; line-height: 1; font-variant-numeric: tabular-nums; }
  .of { font-size: 0.86rem; }
  .stack { display: flex; height: 12px; border-radius: 6px; overflow: hidden; background: var(--surface-2, #1b1d21); margin: 18px 0 8px; }
  .stack i { display: block; height: 100%; transition: width 0.4s; }
  .stack .ok, .dot.ok { background: var(--accent, #22d3ee); }
  .stack .old, .dot.old { background: #f59e0b; }
  .stack .new, .dot.new { background: #64748b; }
  .legend { display: flex; flex-wrap: wrap; gap: 6px 16px; font-size: 0.8rem; }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; }
  .live { margin-top: 16px; }
  .bar { height: 5px; background: var(--surface-2, #1b1d21); border-radius: 3px; overflow: hidden; }
  .bar i { display: block; height: 100%; background: var(--accent, #22d3ee); transition: width 0.3s; }
  .live p, .line, .foot { font-size: 0.84rem; margin: 8px 0 0; }
  .line { display: flex; align-items: center; gap: 7px; margin-top: 14px; }
  .pause { display: flex; align-items: center; gap: 7px; color: #fbbf24; }
  .bad { color: #f87171; }

  .steps { list-style: none; margin: 0; padding: 0; display: grid; gap: 16px; }
  .steps li { display: flex; gap: 14px; align-items: flex-start; }
  .steps li.off { opacity: 0.5; }
  .idx { flex: none; width: 28px; height: 28px; border-radius: 50%; display: grid; place-items: center; font-weight: 700; font-size: 0.85rem; background: var(--surface-2, #1b1d21); }
  .steps li.active .idx { background: var(--accent, #22d3ee); color: #05171b; }
  .body { flex: 1; min-width: 0; }
  .line2 { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
  .line2 .cnt { margin-left: auto; font-variant-numeric: tabular-nums; font-size: 0.86rem; display: inline-flex; align-items: center; gap: 4px; }
  .mini { height: 6px; border-radius: 3px; background: var(--surface-2, #1b1d21); margin-top: 8px; overflow: hidden; }
  .mini i { display: block; height: 100%; background: var(--accent, #22d3ee); transition: width 0.4s; }
  .foot { margin-top: 16px; }

  .where { display: inline-flex; gap: 4px; padding: 4px; margin: 4px 0 14px; border-radius: 12px; background: rgba(255,255,255,0.06); }
  .where button { display: inline-flex; align-items: center; gap: 8px; min-height: 40px; padding: 0 16px; border: 0; border-radius: 9px; background: transparent; color: inherit; font: inherit; cursor: pointer; }
  .where button.on { background: var(--accent, #22d3ee); color: #04141a; font-weight: 600; }
  .where button:disabled { cursor: default; opacity: 0.6; }
  .sched { display: flex; align-items: center; gap: 14px 22px; flex-wrap: wrap; }
  .switch { display: inline-flex; align-items: center; gap: 10px; cursor: pointer; min-height: 40px; }
  .switch input { width: 18px; height: 18px; accent-color: var(--accent, #22d3ee); }
  .switch.top { align-items: flex-start; padding: 6px 0; }
  .switch.top input { margin-top: 3px; flex: none; }
  .switch.top > span { display: grid; gap: 2px; }
  .sw-sub { font-size: 0.82rem; line-height: 1.4; }
  .switch.dim { opacity: 0.5; }
  .fld { display: inline-flex; align-items: center; gap: 8px; }
  .fld.dim { opacity: 0.45; }
  .fld input, .fld select { font: inherit; color: inherit; background: var(--surface-2, #1b1d21); border: 1px solid var(--border, #2a2d33); border-radius: 10px; padding: 8px 10px; min-height: 40px; }
  .fld input[type="number"] { width: 70px; }

  .adv summary { cursor: pointer; font-weight: 600; min-height: 28px; }
  .adv-body { display: grid; gap: 14px; margin-top: 14px; }
  .adv h3 { margin: 6px 0 0; font-size: 0.95rem; }
</style>
