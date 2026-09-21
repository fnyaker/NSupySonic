<script>
  // What a library job actually FAILED on, per track and with the reason.
  //
  // WHY THIS EXISTS. The analysis and embedding backfills used to report a
  // counter and one line of prose ("<file>: analysis failed"). That is enough
  // to know something is wrong and nowhere near enough to do anything about
  // it: the cause was in the container log, which the person running the app
  // from a phone cannot read. So the server now keeps a bounded ledger of
  // failures with the reason each one gave, and this is the way out — folded
  // away by default (a healthy run should not shout), one tap to open, and one
  // tap to copy the lot into a bug report.
  import { toasts } from "../lib/stores.js";
  import { copyText } from "../lib/log.js";
  import Icon from "./Icon.svelte";

  /** The job's status payload (`/analysis/backfill`, `/genre/embed`). */
  export let job = null;
  /** What the job measures, for the summary line. */
  export let label = "analyse";

  let open = false;

  $: failed = job?.failed || 0;
  $: items = job?.failures || [];
  // The server tallies reasons as they arrive, so this names the cause that
  // dominates the run even when the per-track sample was capped.
  $: reasons = Object.entries(job?.failure_reasons || {}).sort((a, b) => b[1] - a[1]);
  // A sample is capped; say so rather than letting the list imply it is whole.
  $: hidden = Math.max(0, failed - items.length);

  function asText() {
    const head = `NSupySonic — ${label} : ${failed} en échec`;
    const tally = reasons.map(([r, n]) => `  ${n}x ${r}`);
    const rows = items.map((f) => `  ${f.track || "?"} — ${f.reason}`);
    const more = hidden ? [`  … et ${hidden} autre${hidden > 1 ? "s" : ""}`] : [];
    return [head, "", ...tally, "", ...rows, ...more].join("\n");
  }

  async function copy() {
    const ok = await copyText(asText());
    toasts.push(ok ? "Détail copié" : "Copie impossible", ok ? undefined : "error");
  }
</script>

{#if failed > 0}
  <div class="failures">
    <button class="head" on:click={() => (open = !open)} aria-expanded={open}>
      <Icon name={open ? "chevronUp" : "chevronDown"} size={15} />
      <span
        >{failed} titre{failed > 1 ? "s" : ""} en échec{#if reasons.length > 1},
          {reasons.length} causes{/if}</span
      >
    </button>

    {#if open}
      {#if reasons.length}
        <ul class="tally">
          {#each reasons as [reason, n] (reason)}
            <li><b>{n}×</b> <code>{reason}</code></li>
          {/each}
        </ul>
      {/if}

      <ul class="rows">
        {#each items as f, i (f.id || f.path || i)}
          <li>
            <span class="name" title={f.path || ""}>{f.track || "?"}</span>
            <code class="why">{f.reason}</code>
          </li>
        {/each}
      </ul>

      {#if hidden}
        <p class="muted small more">
          … et {hidden} autre{hidden > 1 ? "s" : ""} non détaillé{hidden > 1 ? "s" : ""}
          (le serveur en garde un échantillon).
        </p>
      {/if}

      <button class="copy" on:click={copy}>
        <Icon name="download" size={14} /> Copier le détail
      </button>
    {/if}
  </div>
{/if}

<style>
  .failures {
    margin-top: 10px;
    border: 1px solid #7f1d1d;
    border-radius: 14px;
    background: var(--bg-elev);
    overflow: hidden;
  }

  .head {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 11px 13px;
    background: none;
    border: none;
    color: #fca5a5;
    font: inherit;
    font-size: 0.86rem;
    font-weight: 600;
    text-align: left;
    cursor: pointer;
  }

  ul {
    margin: 0;
    padding: 0 13px;
    list-style: none;
  }

  .tally {
    padding-bottom: 10px;
    border-bottom: 1px solid #3a2020;
  }

  .tally li {
    font-size: 0.8rem;
    line-height: 1.6;
    color: var(--text-dim);
  }

  .tally b {
    color: #fca5a5;
  }

  /* Bounded on purpose: a run can fail on dozens of tracks and the card must
     not push the rest of the studio off the screen. */
  .rows {
    max-height: 258px;
    overflow-y: auto;
    padding-top: 8px;
    -webkit-overflow-scrolling: touch;
  }

  .rows li {
    padding: 7px 0;
  }

  .rows li + li {
    border-top: 1px solid #2a2538;
  }

  .name {
    display: block;
    font-size: 0.83rem;
    color: var(--text);
    overflow-wrap: anywhere;
  }

  code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.74rem;
    color: var(--text-dim);
    overflow-wrap: anywhere;
  }

  .why {
    display: block;
    margin-top: 2px;
  }

  .more {
    margin: 8px 0 0;
    padding: 0 13px;
  }

  .copy {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 12px 13px 13px;
    padding: 8px 13px;
    background: var(--bg-hover);
    border: 1px solid #2a2538;
    border-radius: 10px;
    color: var(--text-dim);
    font: inherit;
    font-size: 0.78rem;
    cursor: pointer;
  }

  .copy:hover {
    color: var(--text);
  }

  .small {
    font-size: 0.78rem;
  }

  .muted {
    color: var(--text-dim);
  }
</style>
