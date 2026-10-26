<script>
  // While the Flow plays: steer it. "Moins / plus comme ça" (Pandora's thumbs,
  // for this session only — the global "Je n'aime pas" is beside the heart)
  // and the energy one notch down or up. Each press answers at once (a toast,
  // the notch name) and the NEXT title is chosen with it (lib/flow.js).
    import { flowLive, flowSession, energyName, moreLikeThis, lessLikeThis, nudgeEnergy } from "../lib/flow.js";
  import Icon from "./Icon.svelte";

  $: aim = $flowSession?.energy ?? null;
  $: low = aim != null && aim <= 0.1;
  $: high = aim != null && aim >= 0.9;
</script>

{#if $flowLive}
  <div class="flowctl" aria-label="Orienter le Flow" role="group">
    <button type="button" class="steer" on:click={lessLikeThis} title="Passer et proposer moins de titres comme celui-ci">
      <Icon name="minus" size={16} /> Moins comme ça
    </button>
    <button type="button" class="steer" on:click={moreLikeThis} title="Proposer plus de titres comme celui-ci">
      <Icon name="plus" size={16} /> Plus comme ça
    </button>
    <div class="energy" aria-live="polite">
      <button type="button" class="step" on:click={() => nudgeEnergy(-1)} disabled={low} aria-label="Plus calme" title="Plus calme">
        <Icon name="chevronDown" size={18} />
      </button>
      <span class="lvl">
        <span class="k">Énergie</span>
        <span class="v">{energyName(aim)}</span>
      </span>
      <button type="button" class="step" on:click={() => nudgeEnergy(1)} disabled={high} aria-label="Plus énergique" title="Plus énergique">
        <Icon name="chevronUp" size={18} />
      </button>
    </div>
  </div>
{/if}

<style>
  .flowctl {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: center;
    gap: 8px 10px;
  }
  .steer,
  .step {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    min-height: 40px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.08);
    color: rgba(255, 255, 255, 0.88);
    font-weight: 600;
    font-size: 0.84rem;
    white-space: nowrap;
    transition: background 0.15s, color 0.15s, transform 0.1s;
  }
  .steer {
    padding: 0 15px;
  }
  .step {
    width: 40px;
    padding: 0;
  }
  .steer:hover,
  .step:hover:not(:disabled) {
    background: rgba(255, 255, 255, 0.16);
    color: #fff;
  }
  .steer:active,
  .step:active:not(:disabled) {
    transform: scale(0.96);
  }
  .step:disabled {
    opacity: 0.35;
    cursor: default;
  }
  .energy {
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }
  .lvl {
    display: inline-flex;
    flex-direction: column;
    align-items: center;
    min-width: 76px;
    line-height: 1.15;
  }
  .k {
    font-size: 0.66rem;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: rgba(255, 255, 255, 0.55);
    font-weight: 600;
  }
  .v {
    font-size: 0.86rem;
    font-weight: 700;
    color: #fff;
  }
</style>
