<script>
  // A person's credits page: what they wrote, composed or produced among the
  // library's tracks. Reached from a name in a track's credits when the library
  // holds no artist page for it (a songwriter, a producer); an artist the
  // library knows has the same list under the "Crédits" tab of its page.
  import GradientHeader from "../components/GradientHeader.svelte";
  import Icon from "../components/Icon.svelte";
  import PersonCredits from "../components/PersonCredits.svelte";

  export let params = {};

  let name = "";
  let shown = "";
  let count = 0;
  $: {
    let n = "";
    try {
      n = decodeURIComponent(params.name || "");
    } catch {
      n = params.name || "";
    }
    if (n !== name) {
      name = n;
      shown = n;
      count = 0;
    }
  }

  function loaded(e) {
    shown = e.detail?.name || name;
    count = e.detail?.tracks?.length || 0;
  }
</script>

<div class="fade-in">
  <GradientHeader>
    <div class="art" aria-hidden="true"><Icon name="users" size={64} /></div>
    <div class="meta">
      <span class="kind">Crédits</span>
      <h1>{shown}</h1>
      {#if count}
        <span class="muted">{count} titre{count > 1 ? "s" : ""} de la bibliothèque</span>
      {/if}
    </div>
  </GradientHeader>
  <PersonCredits {name} on:loaded={loaded} />
</div>

<style>
  .art {
    width: 168px;
    height: 168px;
    flex: none;
    display: grid;
    place-items: center;
    border-radius: 50%;
    color: var(--text-dim);
    background: var(--bg-elev);
    box-shadow: 0 16px 40px rgba(0, 0, 0, 0.5);
  }
  .meta {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
  }
  .kind {
    font-size: 0.8rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  h1 {
    font-size: clamp(1.8rem, 5vw, 3rem);
    overflow-wrap: anywhere;
  }
  @media (max-width: 640px) {
    .art {
      width: 120px;
      height: 120px;
    }
  }
</style>
