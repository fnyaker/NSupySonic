<script>
  // Transient connectivity notices. Going offline shows a compact pill for a
  // few seconds, then it fades away — the app keeps working offline (downloads,
  // cached pages), so a permanent alarming banner is wrong; state is conveyed
  // contextually (toasts, offline queue filtering). Recovery flashes briefly.
  import { fly } from "svelte/transition";
  import { online, reconnectedAt } from "../lib/net.js";

  let showOffline = false;
  let offTimer = null;
  let justReconnected = false;
  let reTimer = null;

  // Fires only on transitions of the store value, not continuously.
  $: if (!$online) {
    showOffline = true;
    clearTimeout(offTimer);
    offTimer = setTimeout(() => (showOffline = false), 4000);
  } else {
    clearTimeout(offTimer);
    showOffline = false;
  }

  $: if ($reconnectedAt) {
    justReconnected = true;
    clearTimeout(reTimer);
    reTimer = setTimeout(() => (justReconnected = false), 2200);
  }
</script>

{#if !$online && showOffline}
  <div class="net off" role="status" aria-live="polite" transition:fly={{ y: -16, duration: 200 }}>
    <span class="dot"></span>
    Hors ligne — lecture locale disponible
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
    padding: 7px 14px;
    border-radius: 999px;
    font-size: 0.8rem;
    font-weight: 600;
    color: var(--text, #fff);
    background: var(--bg-elev, #221f29);
    border: 1px solid var(--bg-hover, #322e3c);
    box-shadow: 0 8px 30px rgba(0, 0, 0, 0.45);
    pointer-events: none;
    white-space: nowrap;
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #e0a83e;
    animation: pulse 1.1s ease-in-out infinite;
  }
  .dot.ok {
    background: #3fbf6a;
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
