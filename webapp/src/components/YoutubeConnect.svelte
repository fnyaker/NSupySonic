<script>
  // Link a YouTube Music account by pasting a signed-in tab's request headers
  // (ytmusicapi's "browser" sign-in: the only route without a Google Cloud app,
  // and the one that holds up). Desktop work by nature, so the steps say so.
  import { createEventDispatcher } from "svelte";
  import { linkYoutube } from "../lib/services.js";
  import Icon from "./Icon.svelte";

  const dispatch = createEventDispatcher();
  const PLACEHOLDER = "accept: */*\nauthorization: SAPISIDHASH …\ncookie: …\nx-goog-authuser: 0";
  let headers = "";
  let busy = false;
  let error = "";

  async function submit() {
    if (!headers.trim() || busy) return;
    busy = true;
    error = "";
    try {
      const r = await linkYoutube(headers);
      headers = "";
      dispatch("linked", r);
    } catch (e) {
      error = e?.message || "Impossible de relier ce compte.";
    }
    busy = false;
  }
</script>

<div class="yt">
  <ol class="steps">
    <li>Sur un ordinateur, ouvrez <b>music.youtube.com</b> connecté à votre compte.</li>
    <li>Outils de développement (F12) → onglet <b>Réseau</b>, puis cliquez sur « Bibliothèque ».</li>
    <li>Choisissez une requête <b>browse</b> (méthode POST) → <b>En-têtes de la requête</b> → copiez-les tous.</li>
  </ol>
  <textarea
    bind:value={headers}
    rows="5"
    spellcheck="false"
    autocomplete="off"
    placeholder={PLACEHOLDER}
    aria-label="En-têtes de la requête YouTube Music"
  ></textarea>
  <p class="muted fine">
    <Icon name="shield" size={13} />
    Ces en-têtes valent une session YouTube : ils sont chiffrés sur le serveur et
    ne servent qu'à créer vos playlists. Se déconnecter de ce navigateur les annule.
  </p>
  {#if error}<p class="err">{error}</p>{/if}
  <div class="row">
    <button class="pill" on:click={submit} disabled={busy || !headers.trim()}>
      {busy ? "Vérification…" : "Relier YouTube Music"}
    </button>
  </div>
</div>

<style>
  .yt {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .steps {
    margin: 0;
    padding-left: 20px;
    font-size: 0.85rem;
    line-height: 1.5;
    color: var(--text-dim);
  }
  textarea {
    width: 100%;
    box-sizing: border-box;
    font: 0.78rem/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
    background: var(--bg);
    color: var(--text);
    border: 1px solid var(--bg-hover);
    border-radius: 10px;
    padding: 10px 12px;
    resize: vertical;
    min-height: 96px;
  }
  textarea:focus {
    outline: none;
    border-color: var(--accent);
  }
  .fine {
    display: flex;
    gap: 6px;
    align-items: flex-start;
    font-size: 0.75rem;
    line-height: 1.45;
    margin: 0;
  }
  .fine :global(svg) {
    flex: none;
    margin-top: 2px;
  }
  .err {
    color: #ff6b6b;
    font-size: 0.85rem;
    margin: 0;
  }
  .row {
    display: flex;
    justify-content: flex-end;
  }
  .pill:disabled {
    opacity: 0.5;
    cursor: default;
  }
</style>
