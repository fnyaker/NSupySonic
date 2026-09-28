<script>
  // "Someone is driving this player" — and the button that stops them.
  //
  // Always on screen while a controller is connected, above the player bar on
  // every layout and over the full-screen views too: the owner never has to go
  // looking for a way to take their player back. One tap cuts every link onto
  // this device (the sheet, one tap away on the chip itself, cuts one at a time).
  import { fly } from "svelte/transition";
  import { openRemoteSheet, toasts, immersiveOpen } from "../lib/stores.js";
  import { remoteHost, cutAll } from "../lib/remote/hoststate.js";
  import { LEVEL_INFO } from "../lib/remote/mode.js";
  import Icon from "./Icon.svelte";

  let cutting = false;

  $: people = $remoteHost.active ? $remoteHost.controllers : [];
  $: shown = people.length > 0;
  // Named when we can: "Léa", "Léa et 1 autre", else the level.
  $: who = (() => {
    const named = people.map((c) => c.label).filter(Boolean);
    if (!people.length) return "";
    if (named.length === people.length && named.length <= 2) return named.join(" et ");
    if (named.length) return `${named[0]} et ${people.length - 1} autre${people.length > 2 ? "s" : ""}`;
    return people.length > 1 ? `${people.length} appareils` : "1 appareil";
  })();
  $: level = people.length === 1 ? LEVEL_INFO[people[0].level]?.short : "";

  async function cut() {
    if (cutting) return;
    cutting = true;
    try {
      await cutAll();
      toasts.push("Contrôle à distance coupé");
    } catch {
      toasts.push("Impossible de couper — réessayez", "error");
    } finally {
      cutting = false;
    }
  }
</script>

{#if shown}
  <!-- Over the full-screen views it moves to the top: at the bottom it would
       sit on the transport, exactly where the thumb is. -->
  <div class="chip" class:top={$immersiveOpen} transition:fly={{ y: 12, duration: 180 }} role="status">
    <button class="who" on:click={openRemoteSheet} title="Gérer le contrôle à distance">
      <span class="dot" aria-hidden="true"></span>
      <Icon name="remote" size={15} />
      <span class="txt">
        <span class="l1">Contrôlé par {who}</span>
        {#if level}<span class="l2">{level}</span>{/if}
      </span>
    </button>
    <button class="cut" on:click={cut} disabled={cutting} aria-label="Couper le contrôle à distance">
      <Icon name="close" size={15} />
      <span>Couper</span>
    </button>
  </div>
{/if}

<style>
  .chip {
    position: fixed;
    left: 50%;
    transform: translateX(-50%);
    /* Above the player bar (and the mobile mini player + nav). */
    bottom: calc(var(--player-h, 88px) + 12px);
    z-index: 260;
    display: flex;
    align-items: stretch;
    gap: 2px;
    padding: 4px;
    border-radius: 999px;
    background: rgba(18, 16, 24, 0.92);
    border: 1px solid rgba(43, 212, 164, 0.35);
    box-shadow: 0 12px 34px rgba(0, 0, 0, 0.45), 0 0 0 4px rgba(43, 212, 164, 0.06);
    backdrop-filter: blur(10px);
    max-width: calc(100vw - 24px);
    color: #fff;
  }
  button {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    border-radius: 999px;
    min-height: 40px;
  }
  .who {
    padding: 0 12px 0 12px;
    min-width: 0;
    color: #e9fff8;
  }
  .who:hover {
    background: rgba(255, 255, 255, 0.06);
  }
  .dot {
    width: 8px;
    height: 8px;
    flex: none;
    border-radius: 50%;
    background: #2bd4a4;
    animation: pulse 1.8s ease-out infinite;
  }
  @keyframes pulse {
    0% {
      box-shadow: 0 0 0 0 rgba(43, 212, 164, 0.55);
    }
    70% {
      box-shadow: 0 0 0 7px rgba(43, 212, 164, 0);
    }
    100% {
      box-shadow: 0 0 0 0 rgba(43, 212, 164, 0);
    }
  }
  .txt {
    display: flex;
    flex-direction: column;
    line-height: 1.15;
    min-width: 0;
    text-align: left;
  }
  .l1 {
    font-size: 0.84rem;
    font-weight: 700;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .l2 {
    font-size: 0.72rem;
    color: rgba(233, 255, 248, 0.62);
  }
  .cut {
    flex: none;
    padding: 0 14px 0 11px;
    font-weight: 800;
    font-size: 0.84rem;
    color: #fff;
    background: linear-gradient(90deg, #ff5c7a, #ff3b6b);
    box-shadow: 0 6px 16px rgba(255, 59, 107, 0.3);
  }
  .cut:hover:not(:disabled) {
    filter: brightness(1.08);
  }
  .cut:disabled {
    opacity: 0.6;
  }
  .chip.top {
    bottom: auto;
    top: calc(env(safe-area-inset-top, 0px) + 64px);
  }
  /* Phone: over the mini player + bottom nav. */
  @media (max-width: 640px) {
    .chip:not(.top) {
      bottom: calc(60px + 56px + 10px + env(safe-area-inset-bottom, 0px));
    }
  }
</style>
