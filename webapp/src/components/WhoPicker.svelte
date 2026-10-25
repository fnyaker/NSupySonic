<script>
  // Who may use an account, or one of its features (plan multi-provider §15).
  // `value` is the server's list of subjects ("all", "g:<id>", "u:<id>"), or
  // null for "as the whole account" when `inherit` is offered. Every choice is
  // dispatched at once: the caller saves it.
  import { createEventDispatcher } from "svelte";
  import Icon from "./Icon.svelte";

  export let value = null;
  export let inherit = false;
  export let groups = [];
  export let users = [];
  export let holder = null; // the account's holder: always has it, not offered
  export let disabled = false;
  export let label = "Qui peut s'en servir";

  const dispatch = createEventDispatcher();

  $: mode =
    value == null ? "inherit" : value.includes("all") ? "all" : value.length ? "some" : "none";
  // "Certains" stays open while it is being filled, even before a first pick.
  let picking = false;
  $: if (mode !== "none") picking = false;
  $: shown = picking ? "some" : mode;
  $: people = users.filter((u) => u.id !== holder);

  function choose(next) {
    if (disabled) return;
    if (next === "some") {
      picking = mode !== "some";
      if (mode === "some") return;
      if (mode === "all" || mode === "inherit") dispatch("change", []);
      return;
    }
    picking = false;
    dispatch("change", next === "inherit" ? null : next === "all" ? ["all"] : []);
  }

  function toggle(subject) {
    if (disabled) return;
    const cur = (value || []).filter((s) => s !== "all");
    dispatch("change", cur.includes(subject) ? cur.filter((s) => s !== subject) : [...cur, subject]);
  }

  $: options = [
    ...(inherit ? [{ id: "inherit", label: "Comme le compte" }] : []),
    { id: "all", label: "Tout le monde" },
    { id: "some", label: "Certains" },
    { id: "none", label: holder ? "Seulement le titulaire" : "Personne" },
  ];
</script>

<div class="who" class:off={disabled}>
  <div class="seg" role="radiogroup" aria-label={label}>
    {#each options as o}
      <button
        type="button"
        role="radio"
        aria-checked={shown === o.id}
        class:sel={shown === o.id}
        {disabled}
        on:click={() => choose(o.id)}>{o.label}</button>
    {/each}
  </div>
  {#if shown === "some"}
    <div class="chips">
      {#each groups as g (g.id)}
        {@const s = "g:" + g.id}
        <button type="button" class="chip" class:on={value?.includes(s)} aria-pressed={!!value?.includes(s)} {disabled} on:click={() => toggle(s)}>
          <Icon name="users" size={14} /><span>{g.name}</span>
        </button>
      {/each}
      {#each people as u (u.id)}
        {@const s = "u:" + u.id}
        <button type="button" class="chip" class:on={value?.includes(s)} aria-pressed={!!value?.includes(s)} {disabled} on:click={() => toggle(s)}>
          <Icon name="user" size={14} /><span>{u.name}</span>
        </button>
      {/each}
      {#if !groups.length && !people.length}
        <span class="muted none">Aucun groupe ni personne à choisir.</span>
      {/if}
    </div>
  {/if}
</div>

<style>
  .who {
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-width: 0;
  }
  .off {
    opacity: 0.6;
  }
  .seg {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    padding: 4px;
    border-radius: 12px;
    background: var(--bg);
    width: fit-content;
    max-width: 100%;
  }
  .seg button {
    padding: 8px 14px;
    min-height: 36px;
    border-radius: 9px;
    font-size: 0.84rem;
    font-weight: 600;
    color: var(--text-dim);
    white-space: nowrap;
    flex: 1 1 auto;
    transition: background 0.15s, color 0.15s;
  }
  @media (max-width: 480px) {
    .seg {
      width: 100%;
    }
    .seg button {
      padding: 8px 6px;
      font-size: 0.8rem;
    }
  }
  .seg button:hover:not(:disabled) {
    color: var(--text);
  }
  .seg button.sel {
    background: var(--bg-hover);
    color: var(--text);
  }
  .seg button:disabled {
    cursor: default;
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 7px 13px;
    min-height: 36px;
    border-radius: 999px;
    border: 1px solid var(--bg-hover);
    color: var(--text-dim);
    font-size: 0.84rem;
    font-weight: 600;
    max-width: 100%;
  }
  .chip span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .chip:hover:not(:disabled) {
    color: var(--text);
    border-color: var(--text-dim);
  }
  .chip.on {
    color: var(--accent);
    border-color: var(--accent);
    background: color-mix(in srgb, var(--accent) 12%, transparent);
  }
  .none {
    font-size: 0.82rem;
    padding: 6px 2px;
  }
</style>
