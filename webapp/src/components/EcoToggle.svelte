<script>
  // The eco switch, as a small icon button.
  //
  // Deliberately NOT a prominent control: it lives in the footer clusters of the
  // full-screen player, next to the quality chip, where it is one tap away
  // without taking a place in the transport row — nothing about it should
  // compete with play/pause.
  import { ecoMode, toasts } from "../lib/stores.js";
  import Icon from "./Icon.svelte";

  export let size = 19;

  function toggle() {
    const on = !$ecoMode;
    ecoMode.set(on);
    toasts.push(
      on ? "Mode éco activé — aucune animation" : "Mode éco désactivé",
      on ? undefined : "info"
    );
  }
</script>

<button
  class="eco"
  class:on={$ecoMode}
  role="switch"
  aria-checked={$ecoMode}
  on:click={toggle}
  aria-label="Mode éco (aucune animation)"
  title={$ecoMode ? "Mode éco actif — aucune animation" : "Mode éco : couper toutes les animations"}
>
  <Icon name="leaf" {size} />
</button>

<style>
  .eco {
    display: grid;
    place-items: center;
    background: none;
    border: none;
    padding: 4px;
    color: rgba(255, 255, 255, 0.55);
    cursor: pointer;
    transition: color 0.16s ease;
  }
  .eco:hover {
    color: rgba(255, 255, 255, 0.9);
  }
  .eco.on {
    color: #5fd39b;
  }
</style>
