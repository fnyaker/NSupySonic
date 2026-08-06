<script>
  // Persistent, actionable notices — the things a toast is too fleeting for:
  // an expired Deezer credential, a downloaded update waiting to be applied, a
  // newer Android build. They sit above the content, stack quietly, and stay
  // until resolved or dismissed.
  import { fly } from "svelte/transition";
  import { notices } from "../lib/stores.js";
  import Icon from "./Icon.svelte";

  const ICONS = { info: "info", warn: "alert", error: "alert" };

  function run(n) {
    try {
      n.action && n.action();
    } finally {
      // An acted-on notice has said what it had to say.
      if (n.action) notices.dismiss(n.id);
    }
  }
</script>

{#if $notices.length}
  <div class="notices" role="status" aria-live="polite">
    {#each $notices as n (n.id)}
      <div class="notice {n.kind}" transition:fly={{ y: -12, duration: 220 }}>
        <span class="ico"><Icon name={ICONS[n.kind] || "info"} size={17} /></span>
        <span class="msg">{n.message}</span>
        {#if n.action}
          <button class="act" on:click={() => run(n)}>{n.actionLabel || "Ouvrir"}</button>
        {/if}
        {#if n.dismissible !== false}
          <button class="x" on:click={() => notices.dismiss(n.id)} aria-label="Masquer">
            <Icon name="close" size={16} />
          </button>
        {/if}
      </div>
    {/each}
  </div>
{/if}

<style>
  /* Sticky, so a notice stays reachable when you're deep in a long list — with
     an opaque backdrop, otherwise the content scrolling underneath shows
     through the gaps around the cards. */
  .notices {
    position: sticky;
    top: 0;
    z-index: 60;
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 6px 0 10px;
    background: var(--bg);
  }
  .notice {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 11px 12px 11px 14px;
    border-radius: var(--radius);
    background: linear-gradient(180deg, var(--bg-card), var(--bg-elev));
    border: 1px solid var(--bg-hover);
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
    font-size: 0.9rem;
    line-height: 1.35;
  }
  .ico {
    display: grid;
    place-items: center;
    width: 28px;
    height: 28px;
    flex: none;
    border-radius: 8px;
    background: var(--bg-hover);
    color: var(--text-dim);
  }
  .notice.warn .ico,
  .notice.error .ico {
    background: rgba(255, 0, 146, 0.16);
    color: #ff77c1;
  }
  .msg {
    flex: 1;
    min-width: 0;
  }
  .act {
    flex: none;
    padding: 7px 14px;
    border-radius: 999px;
    font-size: 0.83rem;
    font-weight: 700;
    background: var(--accent);
    color: #fff;
    white-space: nowrap;
  }
  .act:hover {
    filter: brightness(1.08);
  }
  .x {
    flex: none;
    display: grid;
    place-items: center;
    width: 30px;
    height: 30px;
    border-radius: 50%;
    color: var(--text-dim);
  }
  .x:hover {
    background: var(--bg-hover);
    color: var(--text);
  }
  @media (max-width: 700px) {
    .notice {
      flex-wrap: wrap;
      row-gap: 8px;
    }
    .msg {
      flex-basis: calc(100% - 84px);
    }
    .act {
      margin-left: 40px;
    }
  }
</style>
