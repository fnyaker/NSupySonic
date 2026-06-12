<script>
  import { fly } from "svelte/transition";
  import { toasts } from "../lib/stores.js";
</script>

<div class="toasts" role="status" aria-live="polite">
  {#each $toasts as t (t.id)}
    <button type="button" class="toast {t.kind}" transition:fly={{ y: 20, duration: 200 }} on:click={() => toasts.dismiss(t.id)}>
      {t.message}
    </button>
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
</style>
