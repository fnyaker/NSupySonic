<script>
  // Give a dead track a stand-in.
  //
  // A Deezer track can stop being playable at any time — and when it does, it is
  // still sitting in your playlists, silently poisoning them. This sheet finds
  // the closest matches (or takes a file of your own), lets you LISTEN before
  // committing, and then swaps the track everywhere it appears in one go. The
  // rewrite runs on the server, so it survives closing the app.
  import { trackKey, trackRef } from "../lib/trackkey.js";
  import { fade, scale } from "svelte/transition";
  import { onDestroy } from "svelte";
  import { api } from "../lib/api.js";
  import {
    replaceSheet,
    closeReplace,
    toasts,
    clearUnavailable,
  } from "../lib/stores.js";
  import { invalidatePlaylists, loadFavorites } from "../lib/actions.js";
  import {
    previewing,
    togglePreview,
    stopPreview,
    applyReplacement,
    watchJob,
  } from "../lib/replace.js";
  import { duration as fmtDuration, artistLine } from "../lib/format.js";
  import Icon from "./Icon.svelte";
  import Cover from "./Cover.svelte";
  import { access } from "../lib/access.js";
  import { sources, mainSource, fallbackSources, chain, iconOf, nameOf, sourceTitle } from "../lib/sources.js";

  let candidates = [];
  let query = "";
  let loading = true;
  let loadedFor = null;
  let busy = false;
  let uploading = false;
  let fileInput;

  $: target = $replaceSheet?.track || null;
  $: if (target && loadedFor !== target) load(target);
  $: if (!target) teardown();

  // The fallback sources (Réglages → Sources, in the admin's order): asked
  // when somebody presses for it, and by the server on its own when the main
  // source finds nothing (`fallback_auto`) — the first one with something
  // gives its five closest songs, one search there (cached a day). A hit costs
  // nothing more until it is auditioned or chosen, which is when its audio is
  // archived.
  let yt = "idle"; // idle | loading | done | error
  let ytFound = 0;
  let ytAuto = false;
  let ytFrom = ""; // the fallback that answered
  $: fbs = $fallbackSources.filter((f) => $access.can(f.id, "search"));
  $: fbIds = new Set(fbs.map((f) => f.id));
  $: mainName = $mainSource?.name || "";
  // Where it was looked for, main first: "Deezer, YouTube".
  $: everywhere = $sources.filter((x) => x.place !== "off").map((x) => x.name).join(", ");
  const isFallbackHit = (c) => !!c.source && c.source !== "local" && c.source !== $mainSource?.id;

  // The search box: pre-filled with what the server searched for, and a new
  // query replaces it. `activeQ` is the manual query in effect ("" = the
  // server's own), so "Chercher aussi sur YouTube" asks about the same thing.
  let searchText = "";
  let activeQ = "";
  let seq = 0;

  async function searchFallbacks() {
    const t = target;
    if (!t || yt === "loading") return;
    const mine = seq;
    yt = "loading";
    try {
      const r = await api.replacementCandidates(trackRef(t), { fallbacks: true, q: activeQ });
      if (loadedFor !== t || mine !== seq) return;
      const have = new Set(candidates.map((c) => trackKey(c)));
      const extra = (r.candidates || []).filter((c) => isFallbackHit(c) && !have.has(trackKey(c)));
      ytFound = extra.length;
      ytFrom = extra[0]?.source || "";
      candidates = [...candidates, ...extra];
      yt = "done";
    } catch {
      if (loadedFor === t && mine === seq) yt = "error";
    }
  }

  async function load(t, q = "") {
    const mine = ++seq;
    loadedFor = t;
    activeQ = q;
    loading = true;
    candidates = [];
    yt = "idle";
    ytFound = 0;
    ytAuto = false;
    ytFrom = "";
    stopPreview();
    try {
      const r = await api.replacementCandidates(trackRef(t), { q });
      if (mine !== seq) return; // a newer search is on its way
      candidates = r.candidates || [];
      query = r.query || "";
      if (!q) searchText = query;
      // `youtube_auto`: a server from before the source order.
      const auto = r.fallback_auto || (r.youtube_auto ? "youtube" : null);
      if (auto) {
        ytAuto = true;
        ytFrom = auto;
        ytFound = candidates.filter(isFallbackHit).length;
        yt = "done";
      }
    } catch (e) {
      if (mine === seq) toasts.push(e?.message || "Impossible de chercher un remplaçant", "error");
    } finally {
      if (mine === seq) loading = false;
    }
  }

  function submitSearch() {
    const text = searchText.trim().replace(/\s+/g, " ");
    if (!target || !text) return;
    if (text === (activeQ || query) && !loading) return;
    load(target, text === query && !activeQ ? "" : text);
  }

  // The audition element is shared with the library's inline suggestions
  // (lib/replace.js): starting one stops the other.
  $: previewId = $previewing;
  const preview = togglePreview;

  function teardown() {
    stopPreview();
    seq++;
    searchText = "";
    activeQ = "";
    loadedFor = null;
    candidates = [];
    busy = false;
    uploading = false;
  }
  onDestroy(teardown);

  // -- committing ------------------------------------------------------------

  async function replaceWith(candidate) {
    if (busy || !target) return;
    busy = true;
    if (await applyReplacement(target, candidate)) closeReplace();
    else busy = false;
  }

  // -- your own file ---------------------------------------------------------

  async function onFile(e) {
    const files = [...(e.target.files || [])];
    e.target.value = "";
    if (!files.length || !target) return;
    uploading = true;
    try {
      const r = await api.upload(files);
      const added = (r.imported || [])[0];
      if (!r.count || !added) {
        toasts.push("Fichier refusé (format non géré ou quota atteint)", "error");
        return;
      }
      await replaceWith(added);
    } catch (e) {
      toasts.push(e?.message || "Import impossible", "error");
    } finally {
      uploading = false;
    }
  }

  // -- or simply drop it -----------------------------------------------------
  // The third answer. "Unavailable" here means neither Deezer nor the disk has
  // it — an archived track plays forever whatever Deezer does — so this really
  // is a title with nothing behind it. The server re-checks BOTH sources before
  // removing anything and refuses (409) if either one still has the audio.
  let confirming = false;

  async function removeTrack() {
    if (busy || !target) return;
    if (!confirming) {
      confirming = true;
      return;
    }
    busy = true;
    stopPreview();
    try {
      const r = await api.deleteTrack(trackRef(target));
      clearUnavailable(trackKey(target));
      invalidatePlaylists();
      loadFavorites(true);
      toasts.push(`« ${target.title} » retiré de la bibliothèque`);
      closeReplace();
      if (r?.job) watchJob(r.job, "La suppression a échoué côté serveur");
    } catch (e) {
      // The one error worth spelling out: the track turned out to be playable.
      toasts.push(
        e?.status === 409
          ? "Ce titre est en fait disponible — rien n'a été supprimé"
          : e?.message || "Suppression impossible",
        "error"
      );
      busy = false;
      confirming = false;
    }
  }

  function onKey(e) {
    if (e.key === "Escape") closeReplace();
  }
</script>

<svelte:window on:keydown={onKey} />

{#if target}
  <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
  <div class="overlay" transition:fade={{ duration: 150 }} on:click|self={closeReplace}>
    <div class="sheet" transition:scale={{ duration: 160, start: 0.97 }}>
      <header>
        <div class="ttl">
          <h2>Remplacer le titre</h2>
          <p class="muted">
            « {target.title} » — {artistLine(target)} n'est plus lisible. Choisissez
            un remplaçant&nbsp;: il prendra sa place partout où il apparaît.
          </p>
        </div>
        <button class="close" on:click={closeReplace} aria-label="Fermer"><Icon name="close" size={20} /></button>
      </header>

      <form class="search" on:submit|preventDefault={submitSearch} role="search">
        <Icon name="search" size={16} />
        <input
          type="search"
          bind:value={searchText}
          placeholder="Artiste, titre, album…"
          aria-label="Chercher un autre remplaçant"
          maxlength="200"
          enterkeyhint="search" />
        <button type="submit" class="go" disabled={loading || !searchText.trim()}>Chercher</button>
      </form>

      <div class="body">
        {#if loading}
          <p class="muted pad">Recherche de titres proches…</p>
        {:else if !candidates.length}
          <p class="muted pad">
            Aucun titre proche trouvé{query ? ` pour « ${query} »` : ""}{everywhere ? ` (cherché dans : ${everywhere})` : ""}.
            Essayez une autre recherche, ou importez votre propre fichier ci-dessous.
          </p>
        {:else}
          <ul class="list">
            {#each candidates as c (trackKey(c))}
              <li class="cand" class:playing={previewId === trackKey(c)}>
                <button
                  class="prev"
                  on:click={() => preview(c)}
                  aria-label={previewId === trackKey(c) ? "Arrêter l'écoute" : "Écouter"}
                  title="Écouter avant de remplacer">
                  <Icon name={previewId === trackKey(c) ? "pause" : "play"} size={15} />
                </button>
                <div class="thumb">
                  <Cover src={c.album?.cover} alt={c.title} size={40} kind="track" fallbackId={trackRef(c)} />
                </div>
                <div class="meta">
                  <div class="t">
                    {#if isFallbackHit(c)}<span class="local" title={sourceTitle(c.source)}><Icon name={iconOf(c.source)} size={12} /></span>{:else if c.local}<span class="local" title="Fichier local"><Icon name="cloudOff" size={12} /></span>{/if}
                    {c.title}
                  </div>
                  <div class="a muted">{artistLine(c)} · {c.album?.title || ""}</div>
                </div>
                <span class="dur muted">{fmtDuration(c.duration)}</span>
                <button class="pick" disabled={busy} on:click={() => replaceWith(c)}>
                  Remplacer
                </button>
              </li>
            {/each}
          </ul>
        {/if}
        {#if !loading && fbs.length}
          {@const from = fbs.find((f) => f.id === ytFrom)}
          <div class="yt">
            {#if yt === "done"}
              <p class="muted hint">
                {#if ytAuto}
                  Rien sur {mainName || "la source principale"} : {ytFound > 1 ? `les ${ytFound} titres les plus proches sur ${nameOf(ytFrom)}` : `le titre le plus proche sur ${nameOf(ytFrom)}`},
                  archivés{from?.quality ? ` en ${from.quality}` : ""} à la première écoute.
                {:else}
                  {ytFound
                    ? `${ytFound} titre${ytFound > 1 ? "s" : ""} trouvé${ytFound > 1 ? "s" : ""} sur ${nameOf(ytFrom)}, ajouté${ytFound > 1 ? "s" : ""} à la liste.`
                    : `Rien de proche sur ${chain(fbs)} non plus.`}
                {/if}
              </p>
            {:else}
              <button class="upload" disabled={busy || yt === "loading"} on:click={searchFallbacks}>
                <Icon name={iconOf(fbs[0].id)} size={16} />
                {yt === "loading" ? `Recherche sur ${chain(fbs)}…` : `Chercher aussi sur ${chain(fbs)}`}
              </button>
              <p class="muted hint">
                {#if yt === "error"}
                  {chain(fbs)} n'a pas répondu. Réessayez plus tard.
                {:else}
                  Source{fbs.length > 1 ? "s" : ""} de secours, dans l'ordre choisi dans Réglages → Sources.
                  Un titre trouvé est archivé à la première écoute{fbs[0].quality ? `, en ${fbs[0].quality} au mieux` : ""}.
                {/if}
              </p>
            {/if}
          </div>
        {/if}
      </div>

      <footer>
        <input
          class="hidden-input"
          type="file"
          accept="audio/*,.mp3,.flac,.m4a,.ogg,.opus,.wav"
          bind:this={fileInput}
          on:change={onFile}
        />
        <button class="upload" disabled={busy || uploading} on:click={() => fileInput?.click()}>
          <Icon name="upload" size={16} />
          {uploading ? "Import…" : "Importer mon fichier"}
        </button>
        <p class="muted hint">
          Votre fichier devient un titre local — il ne dépend plus de Deezer et ne
          pourra plus disparaître.
        </p>

        <div class="drop">
          <button
            class="danger"
            disabled={busy}
            on:click={removeTrack}
            on:blur={() => (confirming = false)}>
            <Icon name="trash" size={16} />
            {confirming ? "Confirmer la suppression" : "Supprimer ce titre"}
          </button>
          <p class="muted hint">
            {#if confirming}
              Le titre disparaîtra de vos playlists et de vos favoris. Le serveur
              vérifie d'abord qu'il est bien introuvable des deux côtés.
            {:else}
              Ce titre n'existe plus ni sur Deezer ni sur le disque. Si vous ne
              voulez pas le remplacer, retirez-le de la bibliothèque.
            {/if}
          </p>
        </div>
      </footer>
    </div>
  </div>
{/if}

<style>
  .overlay {
    position: fixed;
    inset: 0;
    z-index: 300;
    background: rgba(0, 0, 0, 0.6);
    display: grid;
    place-items: center;
    padding: 20px;
    backdrop-filter: blur(2px);
  }
  .sheet {
    width: min(560px, 100%);
    max-height: min(78vh, 720px);
    display: flex;
    flex-direction: column;
    background: var(--bg-card);
    border: 1px solid var(--bg-hover);
    border-radius: 16px;
    box-shadow: 0 24px 70px rgba(0, 0, 0, 0.55);
    overflow: hidden;
  }
  header {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding: 18px 18px 12px;
  }
  .ttl h2 {
    margin: 0 0 4px;
    font-size: 1.1rem;
  }
  .ttl p {
    margin: 0;
    font-size: 0.85rem;
    line-height: 1.4;
  }
  .close {
    margin-left: auto;
    display: grid;
    place-items: center;
    width: 34px;
    height: 34px;
    border-radius: 50%;
    color: var(--text-dim);
    flex: none;
  }
  .close:hover {
    background: var(--bg-hover);
    color: var(--text);
  }
  /* The search box sits between the header and the list, outside the
     scroller: it stays in reach whatever has been scrolled. */
  .search {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0 18px 10px;
    padding: 4px 4px 4px 14px;
    border-radius: 999px;
    background: var(--bg);
    border: 1px solid var(--bg-hover);
    color: var(--text-dim);
  }
  .search:focus-within {
    border-color: var(--accent);
    color: var(--text);
  }
  .search input {
    flex: 1;
    min-width: 0;
    border: none;
    background: none;
    outline: none;
    color: var(--text);
    font-size: 0.92rem;
    padding: 7px 0;
  }
  .search input::-webkit-search-cancel-button {
    -webkit-appearance: none;
  }
  .go {
    flex: none;
    padding: 7px 14px;
    border-radius: 999px;
    background: var(--bg-hover);
    color: var(--text);
    font-weight: 700;
    font-size: 0.82rem;
  }
  .go:hover:not(:disabled) {
    background: var(--accent);
    color: #fff;
  }
  .go:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .body {
    overflow-y: auto;
    padding: 0 10px;
    flex: 1;
  }
  .pad {
    padding: 18px 8px 22px;
    font-size: 0.9rem;
  }
  .list {
    list-style: none;
    margin: 0;
    padding: 0 0 8px;
  }
  .cand {
    display: grid;
    grid-template-columns: 34px 40px 1fr auto auto;
    align-items: center;
    gap: 10px;
    padding: 6px 8px;
    border-radius: 10px;
  }
  .cand:hover {
    background: var(--bg-hover);
  }
  .cand.playing {
    background: var(--bg-hover);
  }
  .prev {
    display: grid;
    place-items: center;
    width: 34px;
    height: 34px;
    border-radius: 50%;
    border: 1px solid var(--bg-hover);
    color: var(--text);
  }
  .cand.playing .prev {
    border-color: var(--accent);
    color: var(--accent);
  }
  .thumb {
    width: 40px;
  }
  .meta {
    min-width: 0;
  }
  .t {
    font-weight: 600;
    font-size: 0.92rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .a {
    font-size: 0.8rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .local {
    display: inline-flex;
    vertical-align: -1px;
    color: var(--text-dim);
    margin-right: 3px;
  }
  .dur {
    font-size: 0.8rem;
    font-variant-numeric: tabular-nums;
  }
  .pick {
    padding: 7px 13px;
    border-radius: 999px;
    background: var(--accent);
    color: #fff;
    font-weight: 700;
    font-size: 0.82rem;
    white-space: nowrap;
  }
  .pick:disabled {
    opacity: 0.55;
    cursor: default;
  }
  /* The body is inset 10px: this lines its button up with the footer's. */
  .yt {
    padding: 6px 8px 14px;
  }
  footer {
    padding: 12px 18px 16px;
    border-top: 1px solid var(--bg-hover);
  }
  .hidden-input {
    display: none;
  }
  .upload {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 9px 16px;
    border-radius: 999px;
    border: 1px solid var(--bg-hover);
    color: var(--text);
    font-weight: 600;
    font-size: 0.88rem;
  }
  .upload:hover:not(:disabled) {
    border-color: var(--text-dim);
  }
  /* Set apart by a rule, not by shouting: it is a legitimate third option,
     just the one you cannot undo. */
  .drop {
    margin-top: 16px;
    padding-top: 14px;
    border-top: 1px solid var(--bg-hover);
  }
  .danger {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 9px 16px;
    border-radius: 999px;
    border: 1px solid color-mix(in srgb, #e5484d 45%, transparent);
    color: #e5484d;
    font-weight: 600;
    font-size: 0.88rem;
  }
  .danger:hover:not(:disabled) {
    background: color-mix(in srgb, #e5484d 12%, transparent);
    border-color: #e5484d;
  }
  .danger:disabled {
    opacity: 0.55;
    cursor: default;
  }
  .upload:disabled {
    opacity: 0.55;
    cursor: default;
  }
  .hint {
    margin: 8px 2px 0;
    font-size: 0.8rem;
    line-height: 1.35;
  }
  @media (max-width: 560px) {
    .cand {
      grid-template-columns: 34px 40px 1fr auto;
    }
    /* The duration is the first thing to go when space is tight — the title,
       the artist and the two actions all matter more. */
    .dur {
      display: none;
    }
  }
</style>
