<script>
  // What one person wrote, composed or produced among the library's tracks
  // (not what they performed: that is their artist page). A chip per role
  // narrows the list; the list itself is the windowed TrackList, so a
  // songwriter credited on hundreds of titles costs the rows on screen.
  //
  // One request (/credits/person), painted from the device's copy first.
  import { createEventDispatcher } from "svelte";
  import { api } from "../lib/api.js";
  import { player } from "../lib/stores.js";
  import Icon from "./Icon.svelte";
  import LoadFailed from "./LoadFailed.svelte";
  import Skeleton from "./Skeleton.svelte";
  import TrackList from "./TrackList.svelte";

  export let name = "";

  const dispatch = createEventDispatcher();
  let data = null;
  let error = null;
  let role = ""; // "" = every role
  let seq = 0;

  $: load(name);

  async function load(n) {
    const mine = ++seq;
    data = null;
    error = null;
    role = "";
    if (!n) return;
    try {
      await api.swr(api.personCreditsPath(n), (d) => {
        if (mine !== seq) return;
        data = d;
        dispatch("loaded", d);
      });
    } catch (e) {
      if (mine === seq && !data) error = e;
    }
  }

  $: tracks = data?.tracks || [];
  $: shown = role ? tracks.filter((t) => (t.credit_roles || []).includes(role)) : tracks;

  function playAll() {
    if (shown.length) player.playQueue(shown, 0, { kind: "credits", id: name });
  }
</script>

{#if error}
  <LoadFailed {error} on:retry={() => load(name)} />
{:else if !data}
  <Skeleton kind="list" />
{:else if !tracks.length}
  <p class="muted empty">Aucun titre de la bibliothèque ne crédite {data.name || name} pour l'instant.</p>
{:else}
  <div class="bar">
    <button class="pill" on:click={playAll}><Icon name="play" size={18} /> Tout lire</button>
    {#if data.roles?.length > 1}
      <div class="chips" role="tablist" aria-label="Rôle">
        <button class="chip" class:on={!role} role="tab" aria-selected={!role} on:click={() => (role = "")}>
          Tout <span class="n">{tracks.length}</span>
        </button>
        {#each data.roles as r (r.role)}
          <button class="chip" class:on={role === r.role} role="tab" aria-selected={role === r.role} on:click={() => (role = r.role)}>
            {r.label} <span class="n">{r.count}</span>
          </button>
        {/each}
      </div>
    {:else if data.roles?.length === 1}
      <span class="muted only">{data.roles[0].label}</span>
    {/if}
  </div>
  <TrackList tracks={shown} context={{ kind: "credits", id: name }} />
{/if}

<style>
  .bar {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
    margin: 16px 0 14px;
  }
  .pill {
    gap: 8px;
    flex: none;
  }
  .chips {
    display: flex;
    gap: 8px;
    overflow-x: auto;
    scrollbar-width: none;
    min-width: 0;
    flex: 1;
    padding: 2px 0;
  }
  .chips::-webkit-scrollbar {
    display: none;
  }
  .chip {
    flex: none;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 36px;
    padding: 0 14px;
    border-radius: 999px;
    font-size: 0.86rem;
    font-weight: 600;
    background: var(--bg-elev);
    border: 1px solid var(--bg-hover);
    color: var(--text);
  }
  .chip.on {
    background: var(--text);
    border-color: var(--text);
    color: var(--bg);
  }
  .n {
    font-variant-numeric: tabular-nums;
    opacity: 0.6;
    font-weight: 500;
  }
  .only {
    font-size: 0.88rem;
  }
  .empty {
    margin: 18px 2px;
    line-height: 1.5;
  }
</style>
