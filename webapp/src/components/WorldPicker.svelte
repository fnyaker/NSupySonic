<script>
  // Which world the smart engine draws: "auto" (the genre decides, through
  // lib/viz/skins.js) or one world pinned whatever is playing.
  //
  // Names, not thumbnails, on purpose. The page this sits on is built around a
  // LIVE preview driven by the actual track, and a still of a scene that exists
  // to move says less than the scene itself one tap away — so picking a world
  // swaps the preview, and hovering (or focusing) one names what it will look
  // like underneath the grid. Forty-seven stills would also be a megabyte the
  // service worker precaches for every visitor.
  import { createEventDispatcher } from "svelte";
  import Icon from "./Icon.svelte";

  export let value = "auto";
  export let groups = [];
  export let meta = {};
  // What "auto" resolved to right now, and the genre that chose it — both
  // optional: nothing is playing, or the analysis is off.
  export let resolved = "";
  export let genre = "";

  const dispatch = createEventDispatcher();
  let focus = null;

  $: byGroup = groups
    .map((g) => ({
      ...g,
      worlds: Object.entries(meta)
        .filter(([, m]) => m.group === g.id)
        .map(([id, m]) => ({ id, ...m })),
    }))
    .filter((g) => g.worlds.length);
  $: count = Object.keys(meta).length;
  $: shown = focus || (value !== "auto" ? value : resolved);
  $: detail = shown && meta[shown] ? meta[shown] : null;

  function pick(id) {
    dispatch("pick", id);
  }
</script>

<div class="wp">
  <button class="auto" class:sel={value === "auto"} on:click={() => pick("auto")} aria-pressed={value === "auto"}>
    <span class="auto-ic"><Icon name="sparkles" size={18} /></span>
    <span class="auto-txt">
      <span class="auto-t">Auto — le genre choisit</span>
      <span class="auto-h">
        {#if value === "auto" && resolved && meta[resolved]}
          En ce moment : <strong>{meta[resolved].label}</strong>{#if genre}&nbsp;· {genre}{/if}
        {:else}
          Le style reconnu choisit parmi les {count} mondes, et les habille à ses couleurs.
        {/if}
      </span>
    </span>
  </button>

  <p class="detail" aria-live="polite">
    {#if detail}
      <span class="detail-t">{detail.label}</span>
      <span class="detail-b">{detail.blurb}</span>
    {:else}
      <span class="detail-b muted">Survolez un monde pour savoir ce qu'il montre ; touchez-le pour l'épingler.</span>
    {/if}
  </p>

  <div class="groups">
    {#each byGroup as g (g.id)}
      <div class="grp">
        <span class="grp-t">{g.label}</span>
        <div class="chips">
          {#each g.worlds as w (w.id)}
            <button
              class="chip"
              class:sel={value === w.id}
              class:now={value === "auto" && resolved === w.id}
              aria-pressed={value === w.id}
              title={w.blurb}
              on:click={() => pick(w.id)}
              on:mouseenter={() => (focus = w.id)}
              on:mouseleave={() => (focus = null)}
              on:focus={() => (focus = w.id)}
              on:blur={() => (focus = null)}
            >
              {#if value === w.id}<Icon name="pin" size={13} />{/if}
              {w.label}
            </button>
          {/each}
        </div>
      </div>
    {/each}
  </div>
</div>

<style>
  .wp {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .auto {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    text-align: left;
    padding: 12px 14px;
    border-radius: 12px;
    background: var(--bg);
    border: 1px solid var(--bg-hover);
    color: var(--text-dim);
    cursor: pointer;
    transition:
      border-color 0.16s ease,
      background 0.16s ease;
  }
  .auto:hover {
    background: var(--bg-hover);
  }
  .auto.sel {
    border-color: var(--accent);
    background: color-mix(in srgb, var(--accent) 14%, var(--bg));
  }
  .auto-ic {
    display: grid;
    place-items: center;
    flex: none;
    width: 36px;
    height: 36px;
    border-radius: 10px;
    color: var(--accent-2);
    background: color-mix(in srgb, var(--accent-2) 14%, transparent);
  }
  .auto-txt {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .auto-t {
    font-weight: 650;
    color: var(--text);
  }
  .auto-h {
    font-size: 0.78rem;
    line-height: 1.4;
  }
  .auto-h strong {
    color: var(--text);
    font-weight: 650;
  }
  /* One line that always says what the world under the pointer (or the one
     chosen) looks like, at a fixed height so the grid below never jumps. */
  .detail {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-height: 2.9em;
    margin: 0;
    padding: 0 2px;
  }
  .detail-t {
    font-weight: 650;
    font-size: 0.86rem;
  }
  .detail-b {
    font-size: 0.8rem;
    line-height: 1.45;
    color: var(--text-dim);
  }
  .muted {
    color: var(--text-dim);
  }
  .groups {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
    gap: 14px 22px;
  }
  .grp {
    display: flex;
    flex-direction: column;
    gap: 7px;
  }
  .grp-t {
    font-size: 0.68rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-dim);
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 7px;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    min-height: 34px;
    padding: 6px 13px;
    border-radius: 999px;
    background: var(--bg);
    border: 1px solid var(--bg-hover);
    color: var(--text-dim);
    font-weight: 600;
    font-size: 0.84rem;
    cursor: pointer;
    transition:
      background 0.14s ease,
      border-color 0.14s ease,
      color 0.14s ease;
  }
  .chip:hover,
  .chip:focus-visible {
    color: var(--text);
    border-color: color-mix(in srgb, var(--accent) 45%, var(--bg-hover));
  }
  /* What auto is drawing right now: outlined, not filled — it is information,
     not a choice the user made. */
  .chip.now {
    color: var(--text);
    border-color: var(--accent-2);
  }
  .chip.sel {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
  }
</style>
