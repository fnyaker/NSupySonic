<script>
  import { current, player } from "../lib/stores.js";
  import { api } from "../lib/api.js";

  let lyrics = null;
  let loadingFor = null;
  let activeIdx = -1;

  // Fetch lyrics whenever the current track changes.
  $: if ($current && $current.deezer_id !== loadingFor) {
    loadingFor = $current.deezer_id;
    lyrics = null;
    activeIdx = -1;
    api
      .lyrics($current.deezer_id)
      .then((r) => {
        if (loadingFor === $current?.deezer_id) lyrics = r.lyrics;
      })
      .catch(() => (lyrics = null));
  }

  // Track the active synced line from playback position.
  $: if (lyrics && lyrics.synced && lyrics.synced.length) {
    const ms = ($player.currentTime || 0) * 1000;
    let idx = -1;
    for (let i = 0; i < lyrics.synced.length; i++) {
      if (lyrics.synced[i].time <= ms) idx = i;
      else break;
    }
    activeIdx = idx;
  }
</script>

<div class="lyrics">
  {#if !lyrics}
    <p class="muted">Paroles indisponibles.</p>
  {:else if lyrics.synced && lyrics.synced.length}
    <ul class="synced">
      {#each lyrics.synced as line, i}
        <li class:active={i === activeIdx}>{line.text || "• • •"}</li>
      {/each}
    </ul>
  {:else}
    <pre class="plain">{lyrics.text}</pre>
  {/if}
</div>

<style>
  .lyrics {
    height: 100%;
    overflow-y: auto;
    padding: 8px 4px;
  }
  .synced {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .synced li {
    color: var(--text-dim);
    font-size: 1.1rem;
    font-weight: 600;
    transition: color 0.2s;
  }
  .synced li.active {
    color: var(--text);
    font-size: 1.3rem;
  }
  .plain {
    white-space: pre-wrap;
    font-family: inherit;
    color: var(--text-dim);
    line-height: 1.6;
  }
</style>
