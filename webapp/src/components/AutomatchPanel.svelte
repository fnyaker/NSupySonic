<script>
  // The audio auto-match, for the account owner: on/off, run it over the
  // whole "Indisponibles" list, and — since it replaces tracks WITHOUT asking —
  // always show what it replaced, with the score that justified it.
  //
  // The server does the listening (supysonic/webui/automatch.py): the dead
  // track's Deezer preview against each plausible candidate's audio, 99 % or
  // nothing. This screen only switches, starts, follows and reports.
  import { onDestroy, onMount } from "svelte";
  import { slide } from "svelte/transition";
  import { api } from "../lib/api.js";
  import { toasts, unavailableChanged } from "../lib/stores.js";
  import { invalidatePlaylists, loadFavorites } from "../lib/actions.js";
  import Icon from "./Icon.svelte";
  import { chain, nameOf, sources } from "../lib/sources.js";

  /** How many tracks the list holds (what a run would go through). */
  export let count = 0;

  let status = null;
  let saving = false;
  let starting = false;
  let open = false;
  let timer = null;
  let destroyed = false;

  const STATUS = {
    match: "remplacé",
    no_reference: "sans extrait Deezer",
    no_candidate: "sans candidat",
    no_match: "sous 99\u00a0%",
    error: "en erreur",
    skipped: "déjà réglé",
  };
  // The server names causes in English (they go to the log too): the ones a
  // run is made of, said in French; anything else is shown as it came.
  const REASONS = {
    "Deezer serves no preview for it": "Deezer ne sert plus d'extrait de ce titre",
    "Deezer no longer knows the track": "Deezer ne connaît plus ce titre",
    "nothing with the same title and artist": "aucun titre du même nom et du même artiste",
    "below 99 %": "le plus proche était sous 99\u00a0%",
    "the Deezer proxy is off": "le proxy Deezer est désactivé",
    "no candidate could be heard": "aucun candidat n'a pu être écouté",
  };
  // Where the candidates are looked for: the files, then the sources in their
  // order (Réglages → Sources).
  $: looked = chain($sources.filter((x) => x.place !== "off"));

  function reasonText(r) {
    if (!r) return "";
    const m = /^closest ([\d.]+) %/.exec(r);
    if (m) return `le plus proche\u00a0: ${m[1].replace(".", ",")}\u00a0%`;
    return REASONS[r] || r;
  }
  const pct = (s) => `${(s * 100).toFixed(1).replace(".", ",")}\u00a0%`;

  async function refresh() {
    try {
      status = await api.automatch();
    } catch (e) {
      status = e?.status === 403 ? null : status;
      return;
    }
    schedule();
  }

  function schedule() {
    clearTimeout(timer);
    if (destroyed || !status?.job) return;
    timer = setTimeout(async () => {
      const wasRunning = !!status?.job;
      await refresh();
      if (wasRunning && !status?.job) finished();
    }, 1500);
  }

  function finished() {
    const last = status?.last;
    if (!last) return;
    const n = last.counts?.match || 0;
    unavailableChanged();
    if (n) {
      invalidatePlaylists();
      loadFavorites(true);
    }
    toasts.push(
      last.stopped
        ? "Remplacement automatique interrompu : Deezer est injoignable"
        : n
          ? `${n} titre${n > 1 ? "s" : ""} remplacé${n > 1 ? "s" : ""} automatiquement`
          : "Aucun titre n'a atteint 99 % : rien n'a été remplacé",
      last.stopped ? "error" : undefined
    );
  }

  async function toggle() {
    if (saving || !status) return;
    saving = true;
    try {
      status = await api.automatchSettings(!status.enabled);
    } catch (e) {
      toasts.push(e?.message || "Réglage impossible", "error");
    } finally {
      saving = false;
    }
  }

  async function run() {
    if (starting || status?.job) return;
    starting = true;
    try {
      const r = await api.automatchRun();
      status = { ...status, job: r.job };
      schedule();
    } catch (e) {
      toasts.push(
        e?.status === 409
          ? "Un passage est déjà en cours"
          : /proxy is off/.test(e?.message || "")
            ? "Le proxy Deezer est désactivé : pas d'extrait à comparer"
            : /numpy|ffmpeg/.test(e?.message || "")
              ? "Comparaison audio indisponible sur ce serveur"
              : "Impossible de lancer le remplacement automatique",
        "error"
      );
      if (e?.status === 409) refresh();
    } finally {
      starting = false;
    }
  }

  async function cancel() {
    try {
      status = await api.automatchCancel();
    } catch {
      /* the next poll says where it is */
    }
  }

  onMount(refresh);
  onDestroy(() => {
    destroyed = true;
    clearTimeout(timer);
  });

  $: job = status?.job;
  $: last = status?.last;
  $: recent = status?.recent || [];
  $: summary = last
    ? Object.entries(last.counts || {})
        .sort((a, b) => b[1] - a[1])
        .map(([k, n]) => `${n} ${STATUS[k] || k}${n > 1 && k !== "no_match" && k !== "no_reference" && k !== "no_candidate" ? "s" : ""}`)
        .join(" · ")
    : "";
  $: progress = job && job.total ? job.done / job.total : 0;
</script>

{#if status}
  <section class="am">
    <button class="toggle" role="switch" aria-checked={status.enabled} disabled={saving || !status.available} on:click={toggle}>
      <span class="ic"><Icon name="sparkles" size={18} /></span>
      <span class="txt">
        <span class="title">Remplacement automatique</span>
        <span class="hint">
          {#if !status.available}
            Comparaison audio indisponible sur ce serveur (numpy et ffmpeg sont nécessaires,
            tous deux dans l'image Docker).
          {:else}
            L'extrait du titre perdu, servi par sa source, est comparé à l'audio des candidats
            (fichiers{looked ? `, puis ${looked}` : ""}). À 99&nbsp;% ou plus, c'est le même
            enregistrement : il est remplacé partout, sans rien demander.
          {/if}
        </span>
      </span>
      <span class="sw" class:on={status.enabled}><span class="knob"></span></span>
    </button>

    {#if status.available}
      <div class="run">
        {#if job}
          <div class="prog" aria-live="polite">
            <span class="prog-txt">
              {#if job.total == null}
                Préparation…
              {:else}
                Écoute… {job.done} / {job.total}
                {#if job.counts?.match}· {job.counts.match} remplacé{job.counts.match > 1 ? "s" : ""}{/if}
              {/if}
            </span>
            <span class="bar"><span style={`width:${progress * 100}%`}></span></span>
          </div>
          <button class="ghost" on:click={cancel} disabled={job.cancel}>
            {job.cancel ? "Arrêt…" : "Arrêter"}
          </button>
        {:else}
          <button class="go" on:click={run} disabled={starting || !count}>
            <Icon name="zap" size={15} />
            {starting ? "Lancement…" : `Analyser ${count > 1 ? `les ${count} titres` : "le titre"} maintenant`}
          </button>
          {#if last}
            <span class="last muted">
              Dernier passage : {summary || "rien à faire"}
              {#if last.stopped}· interrompu (Deezer injoignable){/if}
            </span>
          {/if}
        {/if}
      </div>

      {#if (last && (last.replaced?.length || last.failures?.length)) || recent.length}
        <button class="more" on:click={() => (open = !open)} aria-expanded={open}>
          <Icon name={open ? "chevronUp" : "chevronDown"} size={15} />
          {open ? "Masquer le détail" : "Voir le détail"}
          {#if recent.length}<span class="pill">{recent.length} remplacé{recent.length > 1 ? "s" : ""} automatiquement</span>{/if}
        </button>
      {/if}

      {#if open}
        <div class="detail" transition:slide={{ duration: 160 }}>
          {#if recent.length}
            <h3>Remplacés automatiquement</h3>
            <ul>
              {#each recent as r (r.at + r.track.id)}
                <li>
                  <span class="from">{r.track.title}<span class="muted"> — {r.track.artist}</span></span>
                  <Icon name="chevronRight" size={13} />
                  <span class="to">
                    {r.by.album || r.by.title}
                    <span class="muted">· {r.by.source === "local" ? "fichier local" : nameOf(r.by.source)}</span>
                  </span>
                  <span class="score">{pct(r.score)}</span>
                </li>
              {/each}
            </ul>
          {/if}
          {#if last?.failures?.length}
            <h3>Laissés à traiter à la main</h3>
            <ul>
              {#each last.failures as f (f.track?.id)}
                <li>
                  <span class="from">{f.track?.title}<span class="muted"> — {f.track?.artist}</span></span>
                  <span class="why muted">{reasonText(f.reason) || STATUS[f.status] || f.status}</span>
                </li>
              {/each}
            </ul>
          {/if}
        </div>
      {/if}
    {/if}
  </section>
{/if}

<style>
  .am {
    margin: 4px 0 18px;
    padding: 14px 16px;
    border-radius: 14px;
    background: var(--bg-card);
    border: 1px solid var(--bg-hover);
  }
  .toggle {
    display: flex;
    align-items: center;
    gap: 14px;
    width: 100%;
    text-align: left;
    color: var(--text);
  }
  .toggle:disabled {
    cursor: default;
  }
  .ic {
    display: grid;
    place-items: center;
    flex: none;
    width: 36px;
    height: 36px;
    border-radius: 10px;
    color: var(--accent);
    background: color-mix(in srgb, var(--accent) 14%, transparent);
  }
  .txt {
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
    flex: 1;
  }
  .title {
    font-weight: 700;
  }
  .hint {
    font-size: 0.8rem;
    line-height: 1.4;
    color: var(--text-dim);
  }
  .sw {
    flex: none;
    width: 44px;
    height: 26px;
    border-radius: 999px;
    background: var(--bg-hover);
    position: relative;
    transition: background 0.15s ease;
  }
  .sw.on {
    background: var(--accent);
  }
  .knob {
    position: absolute;
    top: 3px;
    left: 3px;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: #fff;
    transition: transform 0.15s ease;
  }
  .sw.on .knob {
    transform: translateX(18px);
  }
  .run {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 10px 14px;
    margin: 14px 0 0 50px;
  }
  .go {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 8px 15px;
    border-radius: 999px;
    border: 1px solid var(--bg-hover);
    color: var(--text);
    font-weight: 600;
    font-size: 0.86rem;
  }
  .go:hover:not(:disabled) {
    border-color: var(--accent);
    color: var(--accent);
  }
  .go:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .last {
    font-size: 0.8rem;
  }
  .prog {
    display: flex;
    flex-direction: column;
    gap: 6px;
    flex: 1;
    min-width: 200px;
    max-width: 420px;
  }
  .prog-txt {
    font-size: 0.85rem;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  .bar {
    height: 6px;
    border-radius: 3px;
    background: var(--bg-hover);
    overflow: hidden;
  }
  .bar span {
    display: block;
    height: 100%;
    background: var(--accent);
    transition: width 0.3s ease;
  }
  .ghost {
    padding: 8px 14px;
    border-radius: 999px;
    color: var(--text-dim);
    font-weight: 600;
    font-size: 0.85rem;
  }
  .ghost:hover:not(:disabled) {
    color: var(--text);
    background: var(--bg-hover);
  }
  .more {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin: 12px 0 0 50px;
    color: var(--text-dim);
    font-size: 0.82rem;
    font-weight: 600;
  }
  .more:hover {
    color: var(--text);
  }
  .pill {
    margin-left: 4px;
    padding: 2px 8px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--accent) 14%, transparent);
    color: var(--accent);
    font-size: 0.74rem;
  }
  .detail {
    margin: 10px 0 0 50px;
  }
  h3 {
    margin: 12px 0 6px;
    font-size: 0.8rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-dim);
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  li {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 5px 0;
    font-size: 0.84rem;
    border-top: 1px solid var(--bg-hover);
    min-width: 0;
  }
  li :global(svg) {
    flex: none;
    color: var(--text-dim);
  }
  .from,
  .to {
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .from {
    flex: 1 1 50%;
  }
  .to {
    flex: 1 1 40%;
  }
  .why {
    flex: none;
    max-width: 50%;
    font-size: 0.78rem;
    text-align: right;
  }
  .score {
    flex: none;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    color: var(--accent);
  }
  @media (max-width: 600px) {
    .run,
    .more,
    .detail {
      margin-left: 0;
    }
  }
</style>
