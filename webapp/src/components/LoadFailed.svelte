<script>
  // What a detail screen shows when it has nothing to show. Two different
  // facts, and they must not read the same: the thing does not exist ("Album
  // introuvable."), or only Deezer has it and Deezer is not answering — then
  // the downloaded library is still all there, and trying again later will
  // work. The client never retries that on its own (the server does the
  // reaching, see lib/api.js); "Réessayer" is the person asking.
  import { createEventDispatcher } from "svelte";
  import { isDeezerDenied, isDeezerUnreachable } from "../lib/api.js";
  import Icon from "./Icon.svelte";

  export let error = null;
  export let notFound = "Introuvable.";

  const dispatch = createEventDispatcher();
  $: down = isDeezerUnreachable(error);
  $: denied = isDeezerDenied(error);
</script>

{#if denied}
  <div class="failed fade-in" role="status">
    <span class="icon"><Icon name="shield" size={28} /></span>
    <h2>Réservé à d'autres comptes</h2>
    <p>
      Cette page n'existe que chez Deezer, et le compte Deezer de ce serveur ne t'est
      pas prêté. Tout ce qui est déjà sur le serveur reste à toi.
    </p>
  </div>
{:else if down}
  <div class="failed fade-in" role="status">
    <span class="icon"><Icon name="cloudOff" size={28} /></span>
    <h2>Deezer est injoignable</h2>
    <p>
      Cette page n'existe que chez Deezer et n'est pas encore dans ta bibliothèque.
      Tout ce que tu as téléchargé reste disponible.
    </p>
    <button class="pill ghost" on:click={() => dispatch("retry")}>
      <Icon name="refresh" size={16} /> Réessayer
    </button>
  </div>
{:else}
  <p class="muted">{notFound}</p>
{/if}

<style>
  .failed {
    max-width: 420px;
    margin: 12vh auto 0;
    padding: 0 16px;
    text-align: center;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
  }
  .icon {
    display: grid;
    place-items: center;
    width: 64px;
    height: 64px;
    border-radius: 50%;
    background: var(--bg-hover);
    color: var(--text-dim);
    margin-bottom: 4px;
  }
  h2 {
    margin: 0;
    font-size: 1.2rem;
  }
  p {
    margin: 0 0 8px;
    color: var(--text-dim);
    line-height: 1.5;
  }
</style>
