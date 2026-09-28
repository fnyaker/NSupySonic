<script>
  // Opening a remote-control link (#/rc/<token>): claim it, then reload into
  // the app as a remote control. Whoever opens it may have no account here at
  // all, so this renders before — and without — the login and the layout.
  import { onMount } from "svelte";
  import { api } from "../lib/api.js";
  import { rememberRemote, reloadHome, LEVEL_INFO } from "../lib/remote/mode.js";
  import Icon from "../components/Icon.svelte";

  export let token;

  let phase = "claiming"; // claiming | ok | invalid | offline
  let info = null;

  onMount(claim);

  async function claim() {
    phase = "claiming";
    try {
      const r = await api.remoteClaim(token);
      info = r.remote;
      rememberRemote(r.remote);
      phase = "ok";
      // A breath, so "Connecté" is seen rather than flashed; then the app,
      // rebuilt as a remote control from the first store up.
      setTimeout(reloadHome, 450);
    } catch (e) {
      phase = e && e.offline ? "offline" : "invalid";
    }
  }
</script>

<div class="claim">
  <div class="card">
    <span class="badge" class:ok={phase === "ok"}><Icon name="remote" size={28} /></span>
    {#if phase === "claiming"}
      <h1>Connexion au lecteur…</h1>
      <span class="spin" aria-hidden="true"></span>
    {:else if phase === "ok"}
      <h1>Vous pilotez le lecteur de {info.owner}</h1>
      <p class="muted">
        {LEVEL_INFO[info.level].name}{#if info.device} · {info.device}{/if}
      </p>
    {:else if phase === "offline"}
      <h1>Pas de connexion</h1>
      <p class="muted">Le serveur est injoignable pour l'instant.</p>
      <button class="primary" on:click={claim}><Icon name="refresh" size={17} /> Réessayer</button>
    {:else}
      <h1>Ce lien n'est plus valide</h1>
      <p class="muted">Il a été coupé ou il a expiré. Demandez-en un nouveau à la personne qui vous l'a envoyé.</p>
      <button class="ghost" on:click={() => reloadHome()}><Icon name="home" size={17} /> Ouvrir l'app</button>
    {/if}
  </div>
</div>

<style>
  .claim {
    min-height: 100dvh;
    display: grid;
    place-items: center;
    padding: 24px;
    background:
      radial-gradient(120% 80% at 50% 0%, rgba(31, 163, 255, 0.14), transparent 60%),
      var(--bg);
  }
  .card {
    width: min(420px, 100%);
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    gap: 14px;
  }
  .badge {
    width: 64px;
    height: 64px;
    border-radius: 20px;
    display: grid;
    place-items: center;
    color: var(--text);
    background: var(--bg-card);
    border: 1px solid var(--bg-hover);
    transition: background 0.2s ease;
  }
  .badge.ok {
    color: #fff;
    border-color: transparent;
    background: linear-gradient(135deg, #2bd4a4, #1fa3ff);
    box-shadow: 0 10px 30px rgba(31, 163, 255, 0.3);
  }
  h1 {
    margin: 6px 0 0;
    font-size: 1.35rem;
    font-weight: 800;
    letter-spacing: -0.01em;
  }
  p {
    margin: 0;
    font-size: 0.95rem;
    line-height: 1.5;
  }
  .spin {
    width: 22px;
    height: 22px;
    border-radius: 50%;
    border: 2.5px solid var(--bg-hover);
    border-top-color: #2bd4a4;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  .primary,
  .ghost {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    min-height: 44px;
    padding: 10px 20px;
    border-radius: 999px;
    font-weight: 750;
    margin-top: 6px;
  }
  .primary {
    color: #06140f;
    background: linear-gradient(90deg, #2bd4a4, #1fa3ff);
  }
  .ghost {
    color: var(--text);
    border: 1px solid var(--bg-hover);
  }
</style>
