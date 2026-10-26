<script>
  // Under the queue while the Flow plays and nothing follows yet: the next
  // title is not missing, it is chosen late on purpose (lib/flow.js).
  import { player } from "../lib/stores.js";
  import { flowLive, PICK_AHEAD } from "../lib/flow.js";
  import Icon from "./Icon.svelte";
</script>

{#if $flowLive && $player.index === $player.queue.length - 1}
  <p class="upnext">
    <Icon name="sparkles" size={16} />
    <span>Le titre suivant est choisi {PICK_AHEAD} s avant la fin, d'après ce que vous écoutez.</span>
  </p>
{/if}

<style>
  .upnext {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    margin: 10px 8px 0;
    padding: 12px 14px;
    border-radius: 12px;
    background: rgba(255, 255, 255, 0.05);
    color: rgba(255, 255, 255, 0.62);
    font-size: 0.84rem;
    line-height: 1.4;
  }
  .upnext :global(svg) {
    flex: none;
    margin-top: 1px;
    color: rgba(255, 255, 255, 0.8);
  }
</style>
