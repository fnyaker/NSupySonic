<script>
  // A quiet, non-blocking pill that appears while we're offline and briefly
  // confirms the recovery — premium feel: no error spam, the player keeps its
  // state and resumes on its own. Driven entirely by the shared `online` store.
  import { fly } from "svelte/transition";
  import { online, reconnectedAt } from "../lib/net.js";

  let justReconnected = false;
  let timer = null;

  // Flash a short "Reconnecté" once we come back, then fade out.
  $: if ($reconnectedAt) {
    justReconnected = true;
    clearTimeout(timer);
    timer = setTimeout(() => (justReconnected = false), 2200);
  }
</script>

{#if !$online}
  <div class="net offline" role="status" aria-live="polite" transition:fly={{ y: -16, duration: 200 }}>
    <span class="dot"></span>
    Hors ligne — reconnexion…
  </div>
{:else if justReconnected}
  <div class="net back" role="status" transition:fly={{ y: -16, duration: 200 }}>
    <span class="dot ok"></span>
    Reconnecté
  </div>
{/if}

<style>
  .net {
    position: fixed;
    top: 14px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 250;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 16px;
    border-radius: 999px;
    font-size: 0.84rem;
    font-weight: 600;
    color: #fff;
    box-shadow: 0 8px 30px rgba(0, 0, 0, 0.45);
    pointer-events: none;
  }
  .offline {
    background: #b23b3b;
  }
  .back {
    background: #2c8a4a;
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: rgba(255, 255, 255, 0.9);
    animation: pulse 1.1s ease-in-out infinite;
  }
  .dot.ok {
    animation: none;
  }
  @keyframes pulse {
    0%,
    100% {
      opacity: 0.35;
    }
    50% {
      opacity: 1;
    }
  }
</style>
