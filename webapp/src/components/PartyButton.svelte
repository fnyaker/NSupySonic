<script>
  // The way into the listen party, wherever the player is. While a party is on
  // it becomes the live indicator too — the one thing on screen that says other
  // people are hearing this right now, and how many.
  import { openPartySheet } from "../lib/stores.js";
  import { partyHost } from "../lib/party/hostbridge.js";
  import Icon from "./Icon.svelte";

  export let size = 18;

  $: live = !!$partyHost;
  $: n = live ? $partyHost.listeners.length : 0;
  $: label = live
    ? `Listen party en direct — ${n} ${n > 1 ? "personnes" : "personne"} à l'écoute`
    : "Listen party";
</script>

<button class="pb" class:live on:click|stopPropagation={openPartySheet} title={label} aria-label={label}>
  <Icon name="party" {size} />
  {#if live}
    <span class="n">{n}</span>
  {/if}
</button>

<style>
  .pb {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    color: var(--text-dim);
    padding: 4px;
    border-radius: 999px;
    line-height: 1;
  }
  .pb:hover {
    color: var(--text);
  }
  .pb.live {
    color: #fff;
    padding: 4px 9px 4px 7px;
    background: linear-gradient(90deg, var(--accent), var(--accent-2));
    box-shadow: 0 4px 14px rgba(162, 56, 255, 0.35);
  }
  .n {
    font-size: 0.78rem;
    font-weight: 800;
    font-variant-numeric: tabular-nums;
  }
</style>
