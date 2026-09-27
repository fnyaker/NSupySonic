<script>
  // The output trim: the latency this device adds that the OS does not report
  // (lib/audio/latency.js). One control, two homes — Réglages → Animations for
  // somebody signed in, and the listen party's own panel for a guest who has
  // no settings at all — so both look and behave the same.
  //
  // Positive means "this device sounds late": the animations and the lyric
  // line wait for it, and a party guest plays early to make up for it.
  import { createEventDispatcher } from "svelte";
  import { TRIM_MAX, TRIM_MIN } from "../lib/audio/latency.js";
  import Icon from "./Icon.svelte";

  export let value = 0;
  // What the OS reports for this device's output, in ms, when it is known.
  export let reported = null;

  const dispatch = createEventDispatcher();
  const clamp = (v) => Math.max(TRIM_MIN, Math.min(TRIM_MAX, Math.round(v)));
  const set = (v) => dispatch("change", clamp(v));

  // A Bluetooth link the OS knows about is already in what it reports (Android
  // reads it from AAudio, macOS from the device), and adding the usual 150 ms
  // on top of that would put this device as far off in the other direction. So
  // the shortcut is only offered where the report is short enough that a
  // Bluetooth link cannot be in it.
  $: offerBluetooth = reported == null || reported < 100;
</script>

<div class="trim">
  <div class="steps">
    <button on:click={() => set(value - 10)} aria-label="Retarder de 10 ms">−10</button>
    <button on:click={() => set(value - 1)} aria-label="Retarder de 1 ms"><Icon name="minus" size={16} /></button>
    <span class="val">{value > 0 ? "+" : ""}{value} ms</span>
    <button on:click={() => set(value + 1)} aria-label="Avancer de 1 ms"><Icon name="plus" size={16} /></button>
    <button on:click={() => set(value + 10)} aria-label="Avancer de 10 ms">+10</button>
  </div>
  <div class="presets">
    <button on:click={() => set(0)} disabled={!value}>Remettre à zéro</button>
    {#if offerBluetooth}
      <button on:click={() => set(150)} disabled={value === 150}>Bluetooth non annoncé (~150 ms)</button>
    {/if}
  </div>
  {#if reported != null}
    <p class="os">
      Le système annonce <b>{reported} ms</b> de latence de sortie pour cet appareil, déjà compensés.
      Ce réglage ne sert qu'à ce qu'il ne voit pas.
    </p>
  {/if}
</div>

<style>
  .trim {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .steps {
    display: grid;
    grid-template-columns: 52px 44px 1fr 44px 52px;
    align-items: center;
    gap: 8px;
    max-width: 420px;
  }
  .steps button {
    height: 44px;
    border-radius: 12px;
    background: var(--trim-btn, rgba(255, 255, 255, 0.08));
    border: 1px solid var(--trim-line, transparent);
    color: var(--text);
    font: inherit;
    font-weight: 700;
    display: grid;
    place-items: center;
    cursor: pointer;
  }
  .steps button:hover {
    background: var(--trim-btn-hover, rgba(255, 255, 255, 0.14));
  }
  .val {
    text-align: center;
    font-weight: 800;
    font-size: 1.05rem;
    font-variant-numeric: tabular-nums;
  }
  .presets {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  .presets button {
    padding: 7px 12px;
    border-radius: 999px;
    font: inherit;
    font-size: 0.8rem;
    color: var(--text-dim);
    background: transparent;
    border: 1px solid var(--trim-line, rgba(255, 255, 255, 0.12));
    cursor: pointer;
  }
  .presets button:hover:not(:disabled) {
    color: var(--text);
  }
  .presets button:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .os {
    margin: 0;
    font-size: 0.78rem;
    line-height: 1.45;
    color: var(--text-dim);
  }
  .os b {
    color: var(--text);
    font-variant-numeric: tabular-nums;
  }
</style>
