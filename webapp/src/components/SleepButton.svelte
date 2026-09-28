<script>
  // The sleep timer's button and its menu (a drop-up, like the quality picker).
  //
  // Not offered on a remote control: the timer runs where the audio is, and
  // that is the other device.
  import { onDestroy } from "svelte";
  import { toasts } from "../lib/stores.js";
  import {
    sleepTimer,
    SLEEP_CHOICES,
    sleepIn,
    sleepAtTrackEnd,
    cancelSleep,
    leftLabel,
  } from "../lib/sleep.js";
  import Icon from "./Icon.svelte";

  export let size = 19;
  // Which edge the menu hangs from: a button at the left of a footer opens
  // rightwards, one at the right opens leftwards.
  export let align = "right";

  let open = false;
  let now = Date.now();
  let iv = null;

  // The remaining time is read off the clock once a second, and only while a
  // countdown is on screen.
  $: if ($sleepTimer && $sleepTimer.kind === "minutes") {
    if (iv === null) iv = setInterval(() => (now = Date.now()), 1000);
  } else if (iv !== null) {
    clearInterval(iv);
    iv = null;
  }
  onDestroy(() => iv !== null && clearInterval(iv));

  $: label = leftLabel($sleepTimer, now);

  const name = (m) => (m < 60 ? `${m} minutes` : m === 60 ? "1 heure" : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")}`);

  function pick(m) {
    sleepIn(m);
    now = Date.now();
    open = false;
    toasts.push(`Le lecteur s'arrêtera dans ${name(m)}`, "info");
  }
  function atEnd() {
    sleepAtTrackEnd();
    open = false;
    toasts.push("Le lecteur s'arrêtera à la fin de ce titre", "info");
  }
  function off() {
    cancelSleep();
    open = false;
    toasts.push("Minuteur désactivé", "info");
  }
</script>

<svelte:window on:click={() => (open = false)} on:keydown={(e) => e.key === "Escape" && (open = false)} />

<div class="sl">
  <button
    class="trigger"
    class:on={!!$sleepTimer}
    on:click|stopPropagation={() => (open = !open)}
    aria-haspopup="menu"
    aria-expanded={open}
    aria-label={$sleepTimer ? `Minuteur de sommeil : ${label}` : "Minuteur de sommeil"}
    title={$sleepTimer ? `Minuteur de sommeil : ${label}` : "Minuteur de sommeil"}
  >
    <Icon name="moon" {size} />
    {#if $sleepTimer}<span class="badge">{label}</span>{/if}
  </button>
  {#if open}
    <div class="menu {align}" role="menu" on:click|stopPropagation>
      <div class="mh">Minuteur de sommeil</div>
      {#if $sleepTimer}
        <button role="menuitem" class="off" on:click={off}>
          <span>Désactiver</span>
          <span class="left">{label}</span>
        </button>
      {/if}
      {#each SLEEP_CHOICES as m}
        <button role="menuitem" class:sel={$sleepTimer?.kind === "minutes" && $sleepTimer.minutes === m} on:click={() => pick(m)}>
          <span>{name(m)}</span>
        </button>
      {/each}
      <button role="menuitem" class:sel={$sleepTimer?.kind === "track"} on:click={atEnd}>
        <span>À la fin du titre</span>
      </button>
    </div>
  {/if}
</div>

<style>
  .sl {
    position: relative;
    display: inline-flex;
  }
  .trigger {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 34px;
    min-width: 34px;
    padding: 0 7px;
    justify-content: center;
    color: rgba(255, 255, 255, 0.7);
    background: none;
    border: none;
    border-radius: 999px;
    cursor: pointer;
  }
  .trigger:hover {
    color: #fff;
  }
  .trigger.on {
    color: var(--accent);
    background: color-mix(in srgb, var(--accent) 16%, transparent);
    padding: 0 11px 0 9px;
  }
  .badge {
    font-size: 0.74rem;
    font-weight: 800;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .menu {
    position: absolute;
    bottom: calc(100% + 8px);
    min-width: 214px;
    padding: 6px;
    background: #282433;
    border: 1px solid #3a3448;
    border-radius: 12px;
    box-shadow: 0 16px 44px rgba(0, 0, 0, 0.55);
    z-index: 30;
  }
  .menu.right {
    right: 0;
  }
  .menu.left {
    left: 0;
  }
  .mh {
    padding: 8px 10px 6px;
    font-size: 0.7rem;
    font-weight: 800;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: rgba(255, 255, 255, 0.5);
  }
  .menu button {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    width: 100%;
    padding: 9px 10px;
    border-radius: 8px;
    font-size: 0.88rem;
    color: #fff;
    text-align: left;
  }
  .menu button:hover {
    background: rgba(255, 255, 255, 0.08);
  }
  .menu button.sel {
    color: var(--accent);
  }
  .menu .off {
    color: var(--accent);
    margin-bottom: 4px;
    background: color-mix(in srgb, var(--accent) 12%, transparent);
  }
  .left {
    font-variant-numeric: tabular-nums;
    font-weight: 700;
  }
  @media (max-width: 640px) {
    .menu {
      min-width: 240px;
      padding: 8px;
    }
    .menu button {
      padding: 13px 14px;
      font-size: 0.95rem;
    }
  }
</style>
