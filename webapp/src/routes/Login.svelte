<script>
  import { user } from "../lib/stores.js";
  import { api } from "../lib/api.js";

  let username = "";
  let password = "";
  let error = "";
  let busy = false;

  async function submit(e) {
    e.preventDefault();
    error = "";
    busy = true;
    try {
      const r = await api.login(username, password);
      user.set(r.user);
    } catch (err) {
      error = err.status === 401 ? "Identifiants invalides" : err.message || "Erreur";
    } finally {
      busy = false;
    }
  }
</script>

<div class="wrap">
  <form on:submit={submit}>
    <div class="brand"><span class="dot"></span> NSupySonic</div>
    <h1>Connexion</h1>
    <input placeholder="Utilisateur" bind:value={username} autocomplete="username" />
    <input
      type="password"
      placeholder="Mot de passe"
      bind:value={password}
      autocomplete="current-password"
    />
    {#if error}<p class="err">{error}</p>{/if}
    <button class="pill" type="submit" disabled={busy}>
      {busy ? "…" : "Se connecter"}
    </button>
  </form>
</div>

<style>
  .wrap {
    display: grid;
    place-items: center;
    height: 100vh;
    background: radial-gradient(circle at 30% 20%, #2a1640, var(--bg) 60%);
  }
  form {
    background: var(--bg-elev);
    padding: 32px;
    border-radius: 16px;
    width: 320px;
    display: flex;
    flex-direction: column;
    gap: 14px;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 8px;
    font-weight: 800;
  }
  .dot {
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: linear-gradient(90deg, var(--accent), var(--accent-2));
  }
  h1 {
    margin: 0;
    font-size: 1.4rem;
  }
  input {
    padding: 12px;
    border-radius: var(--radius);
    border: 1px solid transparent;
    background: var(--bg-card);
    color: var(--text);
    outline: none;
  }
  input:focus {
    border-color: var(--accent);
  }
  .err {
    color: var(--accent-2);
    margin: 0;
    font-size: 0.9rem;
  }
  .pill {
    justify-content: center;
    border: none;
  }
  .pill:disabled {
    opacity: 0.6;
  }
</style>
