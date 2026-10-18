<script>
  // Réglages → Compte → Services de streaming: which of the user's accounts
  // elsewhere a playlist can be exported to, and (admin) the server's Spotify app.
  import { onMount } from "svelte";
  import { services, loadServices, linkSpotify, unlink } from "../lib/services.js";
  import { api } from "../lib/api.js";
  import { toasts, isAdmin } from "../lib/stores.js";
  import Icon from "./Icon.svelte";
  import YoutubeConnect from "./YoutubeConnect.svelte";

  let openYt = false;
  let clientId = "";
  let savingId = false;
  let clientIdLoaded = false;

  onMount(() => {
    loadServices(true);
    // Back from Spotify's consent page: the callback says how it went.
    const m = /[?&]svc=([a-z-]+)/.exec(window.location.hash);
    if (m) {
      const msg = {
        "spotify-ok": "Compte Spotify relié",
        "spotify-denied": "Autorisation Spotify refusée",
        "spotify-expired": "Lien Spotify expiré : recommencez",
        "spotify-error": "Spotify n'a pas pu être relié",
      }[m[1]];
      if (msg) toasts.push(msg);
      history.replaceState(history.state, "", window.location.hash.replace(/[?&]svc=[a-z-]+/, ""));
    }
  });

  $: list = ($services?.services || []).filter((s) => s.id !== "apple");
  $: spotify = list.find((s) => s.id === "spotify");
  $: if (spotify && !clientIdLoaded && spotify.client_id !== undefined) {
    clientId = spotify.client_id || "";
    clientIdLoaded = true;
  }

  async function connect(s) {
    if (s.id === "spotify") {
      try {
        await linkSpotify();
      } catch (e) {
        toasts.push(e?.message || "Spotify indisponible");
      }
    } else if (s.id === "youtube") openYt = !openYt;
  }

  async function disconnect(s) {
    try {
      await unlink(s.id);
      toasts.push(`${s.name} délié`);
    } catch (e) {
      toasts.push(e?.message || "Échec");
    }
  }

  async function saveClientId() {
    savingId = true;
    try {
      await api.setSpotifyApp(clientId.trim());
      await loadServices(true);
      toasts.push(clientId.trim() ? "Application Spotify enregistrée" : "Spotify désactivé");
    } catch (e) {
      toasts.push(e?.message || "Échec");
    }
    savingId = false;
  }

  function copy(text) {
    navigator.clipboard?.writeText(text).then(
      () => toasts.push("Copié"),
      () => {},
    );
  }

  function status(s) {
    if (s.id === "deezer") return s.ready ? "Le compte Deezer du serveur" : "Proxy Deezer désactivé";
    if (s.linked) return s.account ? `Relié : ${s.account}` : "Relié";
    if (!s.ready)
      return s.id === "spotify" ? "Pas encore configuré sur ce serveur" : "Indisponible sur ce serveur";
    return "Non relié";
  }
</script>

<section class="card">
  <h2>Services de streaming</h2>
  <p class="muted sub">
    Pour envoyer une playlist vers vos propres comptes&nbsp;: chaque titre y est
    recherché (ISRC d'abord, puis titre et artiste) et ceux qui manquent vous sont listés.
  </p>

  {#if !$services}
    <p class="muted">Chargement…</p>
  {:else}
    <ul class="svc">
      {#each list as s (s.id)}
        <li>
          <span class="glyph" class:on={s.linked}><Icon name={s.id === "youtube" ? "youtube" : "music"} size={18} /></span>
          <span class="txt">
            <span class="nm">{s.name}</span>
            <span class="muted st">{status(s)}</span>
          </span>
          {#if s.id !== "deezer"}
            {#if s.linked}
              <button class="ghost-btn" on:click={() => disconnect(s)}>Délier</button>
            {:else if s.ready}
              <button class="ghost-btn" on:click={() => connect(s)}>{s.id === "youtube" && openYt ? "Fermer" : "Relier"}</button>
            {/if}
          {/if}
        </li>
        {#if s.id === "youtube" && openYt && !s.linked}
          <li class="expand"><YoutubeConnect on:linked={() => { openYt = false; toasts.push("YouTube Music relié"); }} /></li>
        {/if}
      {/each}
    </ul>
    <p class="muted fine">
      Apple Music, Tidal, Amazon Music… n'ouvrent leur API qu'aux développeurs
      sous contrat&nbsp;: exportez la liste en CSV depuis la playlist et importez-la
      avec TuneMyMusic ou Soundiiz.
    </p>
  {/if}

  {#if $isAdmin && spotify && spotify.client_id !== undefined}
    <h3>Application Spotify du serveur</h3>
    <p class="muted fine">
      Spotify n'accepte que des applications enregistrées. Sur
      <b>developer.spotify.com</b> → Dashboard → Create app (« Web API »), ajoutez
      l'URI de redirection ci-dessous, puis chaque compte qui exportera dans
      <b>User Management</b> (5 au plus en mode développement, et le propriétaire de
      l'app doit être Premium). Spotify exige une adresse en https (ou 127.0.0.1).
    </p>
    <div class="uri">
      <code>{spotify.redirect_uri}</code>
      <button class="icon-btn" on:click={() => copy(spotify.redirect_uri)} aria-label="Copier l'URI" title="Copier"><Icon name="copy" size={16} /></button>
    </div>
    {#if spotify.redirect_uri && spotify.redirect_uri.startsWith("http://") && !/^http:\/\/127\./.test(spotify.redirect_uri)}
      <p class="warn"><Icon name="alert" size={14} /> Cette adresse est en http : Spotify la refusera. Ouvrez l'app par son adresse https pour relier un compte.</p>
    {/if}
    <div class="cid">
      <input type="text" bind:value={clientId} placeholder="Client ID (32 caractères)" spellcheck="false" autocomplete="off" maxlength="32" aria-label="Client ID Spotify" />
      <button class="pill" on:click={saveClientId} disabled={savingId || clientId.trim() === (spotify.client_id || "")}>Enregistrer</button>
    </div>
  {/if}
</section>

<style>
  .card {
    background: var(--bg-card);
    border-radius: var(--radius);
    padding: 18px 20px;
    margin-bottom: 18px;
  }
  .card h2 {
    font-size: 1.05rem;
  }
  .card h3 {
    font-size: 0.9rem;
    font-weight: 700;
    margin: 20px 0 6px;
  }
  .sub {
    font-size: 0.85rem;
    line-height: 1.5;
    margin: 4px 0 12px;
  }
  .svc {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .svc li {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 4px;
    min-height: 44px;
  }
  .svc li + li:not(.expand) {
    border-top: 1px solid var(--bg-hover);
  }
  .svc li.expand {
    display: block;
    padding: 4px 4px 14px;
  }
  .glyph {
    flex: none;
    width: 36px;
    height: 36px;
    border-radius: 10px;
    display: grid;
    place-items: center;
    background: var(--bg-hover);
    color: var(--text-dim);
  }
  .glyph.on {
    color: var(--accent);
  }
  .txt {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .nm {
    font-weight: 600;
  }
  .st {
    font-size: 0.8rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ghost-btn {
    flex: none;
    display: inline-flex;
    align-items: center;
    padding: 8px 15px;
    min-height: 36px;
    border-radius: 999px;
    border: 1px solid var(--bg-hover);
    color: var(--text-dim);
    font-weight: 600;
    font-size: 0.85rem;
    white-space: nowrap;
  }
  .ghost-btn:hover {
    color: var(--text);
    border-color: var(--text-dim);
  }
  .icon-btn {
    flex: none;
    width: 36px;
    height: 36px;
    display: grid;
    place-items: center;
    border-radius: 8px;
    color: var(--text-dim);
  }
  .icon-btn:hover {
    color: var(--text);
    background: var(--bg-hover);
  }
  .fine {
    font-size: 0.78rem;
    line-height: 1.5;
    margin: 12px 0 0;
  }
  .uri {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 10px;
    background: var(--bg);
    border-radius: 10px;
    padding: 8px 8px 8px 12px;
  }
  .uri code {
    flex: 1;
    min-width: 0;
    font-size: 0.78rem;
    overflow-wrap: anywhere;
  }
  .warn {
    display: flex;
    gap: 6px;
    align-items: flex-start;
    color: #f0b44c;
    font-size: 0.78rem;
    line-height: 1.45;
    margin: 8px 0 0;
  }
  .warn :global(svg) {
    flex: none;
    margin-top: 2px;
  }
  .cid {
    display: flex;
    gap: 10px;
    margin-top: 12px;
    flex-wrap: wrap;
  }
  .cid input {
    flex: 1 1 220px;
    min-width: 0;
    background: var(--bg);
    color: var(--text);
    border: 1px solid var(--bg-hover);
    border-radius: 10px;
    padding: 10px 12px;
    font: 0.85rem ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .cid input:focus {
    outline: none;
    border-color: var(--accent);
  }
  .pill:disabled {
    opacity: 0.5;
    cursor: default;
  }
</style>
