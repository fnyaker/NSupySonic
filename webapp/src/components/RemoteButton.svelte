<script>
  // The way into remote control, next to the listen party wherever the player
  // is. While somebody is driving this player it lights up and counts them —
  // the same language as the party button, so the two read as siblings.
  import { openRemoteSheet } from "../lib/stores.js";
  import { remoteHost } from "../lib/remote/hoststate.js";
  import Icon from "./Icon.svelte";

  export let size = 18;

  $: n = $remoteHost.active ? $remoteHost.controllers.length : 0;
  $: live = n > 0;
  $: label = live
    ? `Contrôle à distance — ${n} ${n > 1 ? "appareils connectés" : "appareil connecté"}`
    : "Contrôle à distance";
</script>

<button class="rb" class:live on:click|stopPropagation={openRemoteSheet} title={label} aria-label={label}>
  <Icon name="remote" {size} />
  {#if live}
    <span class="n">{n}</span>
  {/if}
</button>

<style>
  .rb {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    color: var(--text-dim);
    padding: 4px;
    border-radius: 999px;
    line-height: 1;
  }
  .rb:hover {
    color: var(--text);
  }
  .rb.live {
    color: #fff;
    padding: 4px 9px 4px 7px;
    background: linear-gradient(90deg, #2bd4a4, #1fa3ff);
    box-shadow: 0 4px 14px rgba(31, 163, 255, 0.3);
  }
  .n {
    font-size: 0.78rem;
    font-weight: 800;
    font-variant-numeric: tabular-nums;
  }
</style>
