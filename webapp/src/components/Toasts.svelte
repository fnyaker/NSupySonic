<script>
  import { fly } from "svelte/transition";
  import { toasts } from "../lib/stores.js";

  function act(t) {
    toasts.dismiss(t.id);
    try {
      t.action.run();
    } catch {
      /* the toast is gone either way */
    }
  }
</script>

<div class="toasts" role="status" aria-live="polite">
  {#each $toasts as t (t.id)}
    {#if t.action}
      <div class="toast {t.kind} with-action" transition:fly={{ y: 20, duration: 200 }}>
        <span class="msg">{t.message}</span>
        <button type="button" class="act" on:click={() => act(t)}>{t.action.label}</button>
      </div>
    {:else}
      <button type="button" class="toast {t.kind}" transition:fly={{ y: 20, duration: 200 }} on:click={() => toasts.dismiss(t.id)}>
        {t.message}
      </button>
    {/if}
  {/each}
</div>

<style>
  .toasts {
    position: fixed;
    left: 50%;
    bottom: calc(var(--player-h) + 16px);
    transform: translateX(-50%);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    z-index: 200;
    pointer-events: none;
  }
  .toast {
    pointer-events: auto;
    background: #fff;
    color: #111;
    padding: 10px 18px;
    border-radius: 999px;
    font-weight: 600;
    font-size: 0.9rem;
    box-shadow: 0 8px 30px rgba(0, 0, 0, 0.45);
    cursor: pointer;
    max-width: 80vw;
    text-align: center;
  }
  .toast.error {
    background: var(--accent-2);
    color: #fff;
  }
  .with-action {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 6px 6px 6px 18px;
    cursor: default;
    width: max-content;
    max-width: min(92vw, 520px);
  }
  .msg {
    min-width: 0;
    text-align: left;
  }
  .act {
    flex: none;
    min-height: 36px;
    padding: 0 14px;
    border-radius: 999px;
    background: #111;
    color: #fff;
    font-weight: 700;
    font-size: 0.85rem;
    white-space: nowrap;
  }
  .act:hover {
    background: #333;
  }
</style>
