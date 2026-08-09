<script>
  // Give a dead track a stand-in.
  //
  // A Deezer track can stop being playable at any time — and when it does, it is
  // still sitting in your playlists, silently poisoning them. This sheet finds
  // the closest matches (or takes a file of your own), lets you LISTEN before
  // committing, and then swaps the track everywhere it appears in one go. The
  // rewrite runs on the server, so it survives closing the app.
  import { fade, scale } from "svelte/transition";
  import { onDestroy } from "svelte";
  import { api } from "../lib/api.js";
  import {
    replaceSheet,
    closeReplace,
    toasts,
    clearUnavailable,
    quality,
    normalization,
  } from "../lib/stores.js";
  import { invalidatePlaylists, loadFavorites } from "../lib/actions.js";
  import { duration as fmtDuration, artistLine } from "../lib/format.js";
  import Icon from "./Icon.svelte";
  import Cover from "./Cover.svelte";

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

  async function load(t) {
    loadedFor = t;
    loading = true;
    candidates = [];
    stopPreview();
    try {
      const r = await api.replacementCandidates(t.deezer_id);
      candidates = r.candidates || [];
      query = r.query || "";
    } catch (e) {
      toasts.push(e?.message || "Impossible de chercher un remplaçant", "error");
    } finally {
      loading = false;
    }
  }

  // -- preview ---------------------------------------------------------------
  // Same pipeline as the player: the /api/stream URL at the quality you listen
  // at, and the same loudness normalization, so what you audition is what you
  // will get. Deliberately its OWN element — auditioning a replacement must not
  // hijack (or be hijacked by) whatever is playing.
  let previewEl = null;
  let previewId = null;

  function preview(track) {
    if (previewId === track.deezer_id) {
      stopPreview();
      return;
    }
    stopPreview();
    const el = new Audio();
    el.src = api.streamUrl(track.deezer_id, $quality);
    el.preload = "auto";
    // Match the player's static normalization so a candidate doesn't merely
    // sound louder than the rest of your library and win on that.
    el.volume = 1;
    if ($normalization !== "off" && typeof track.gain === "number")
      el.volume = Math.max(0, Math.min(1, Math.pow(10, track.gain / 20)));
    el.addEventListener("ended", stopPreview);
    el.addEventListener("error", () => {
      toasts.push("Lecture impossible pour ce titre", "error");
      stopPreview();
    });
    el.play().catch(() => {
      toasts.push("Lecture impossible pour ce titre", "error");
      stopPreview();
    });
    previewEl = el;
    previewId = track.deezer_id;
  }

  function stopPreview() {
    if (previewEl) {
      try {
        previewEl.pause();
        previewEl.removeAttribute("src");
        previewEl.load();
      } catch {
        /* ignore */
      }
    }
    previewEl = null;
    previewId = null;
  }

  function teardown() {
    stopPreview();
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
    stopPreview();
    try {
      const r = await api.replaceTrack(target.deezer_id, candidate.deezer_id);
      // The dead track is gone from your library, so drop its badge; the
      // stand-in is playable, so make sure it doesn't inherit one.
      clearUnavailable(target.deezer_id);
      invalidatePlaylists();
      loadFavorites(true);
      toasts.push(`« ${candidate.title} » remplace le titre indisponible`);
      closeReplace();
      if (r?.job) watch(r.job);
    } catch (e) {
      toasts.push(e?.message || "Le remplacement a échoué", "error");
      busy = false;
    }
  }

  // The rewrite runs server-side; poll just long enough to report the outcome.
  async function watch(job, failure = "Le remplacement a échoué côté serveur") {
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      let s;
      try {
        s = await api.replaceStatus(job);
      } catch {
        return;
      }
      if (s.running) continue;
      if (s.ok) {
        const bits = [];
        if (s.playlists) bits.push(`${s.playlists} playlist${s.playlists > 1 ? "s" : ""}`);
        if (s.favorites) bits.push("favoris");
        if (bits.length) toasts.push("Mis à jour dans " + bits.join(" et "));
        invalidatePlaylists();
      } else {
        toasts.push(failure, "error");
      }
      return;
    }
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
      const r = await api.deleteTrack(target.deezer_id);
      clearUnavailable(target.deezer_id);
      invalidatePlaylists();
      loadFavorites(true);
      toasts.push(`« ${target.title} » retiré de la bibliothèque`);
      closeReplace();
      if (r?.job) watch(r.job, "La suppression a échoué côté serveur");
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

      <div class="body">
        {#if loading}
          <p class="muted pad">Recherche de titres proches…</p>
        {:else if !candidates.length}
          <p class="muted pad">
            Aucun titre proche trouvé{query ? ` pour « ${query} »` : ""}. Vous pouvez
            importer votre propre fichier ci-dessous.
          </p>
        {:else}
          <ul class="list">
            {#each candidates as c (c.deezer_id)}
              <li class="cand" class:playing={previewId === c.deezer_id}>
                <button
                  class="prev"
                  on:click={() => preview(c)}
                  aria-label={previewId === c.deezer_id ? "Arrêter l'écoute" : "Écouter"}
                  title="Écouter avant de remplacer">
                  <Icon name={previewId === c.deezer_id ? "pause" : "play"} size={15} />
                </button>
                <div class="thumb">
                  <Cover src={c.album?.cover} alt={c.title} size={40} kind="track" fallbackId={c.deezer_id} />
                </div>
                <div class="meta">
                  <div class="t">
                    {#if c.local}<span class="local" title="Fichier local"><Icon name="cloudOff" size={12} /></span>{/if}
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
