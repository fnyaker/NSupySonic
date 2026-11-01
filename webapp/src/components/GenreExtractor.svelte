<script>
  // The frozen ONNX model that turns a track into its fingerprint. An admin,
  // one-off act: import the .onnx you obtained yourself (it has its own licence,
  // so the server never fetches it), then run the built-in check that proves it
  // measures audio instead of merely loading.
  import { createEventDispatcher, onDestroy, onMount } from "svelte";
  import { api } from "../lib/api.js";
  import { toasts } from "../lib/stores.js";
  import { bytes as fmtBytes } from "../lib/format.js";
  import Icon from "./Icon.svelte";

  /** `status.extractor` from /genre/status. */
  export let extractor = { available: false };
  const dispatch = createEventDispatcher();

  let uploading = false;
  let removing = false;
  let testing = false;
  let result = null;
  let poll = null;
  let fileInput = null;

  const pct = (v) => Math.round((v || 0) * 100);

  async function pick(ev) {
    const file = ev.target.files?.[0];
    if (!file) return;
    if (!/\.onnx$/i.test(file.name)) {
      toasts.push("Il faut un fichier .onnx", "error");
      ev.target.value = "";
      return;
    }
    uploading = true;
    result = null;
    stop();
    try {
      const res = await api.genreExtractorUpload(file);
      toasts.push("Extracteur installé");
      dispatch("change");
      if (res?.extractor?.onnxruntime) await check();
    } catch (e) {
      toasts.push(e?.message || "envoi impossible", "error");
    } finally {
      uploading = false;
      if (fileInput) fileInput.value = "";
    }
  }

  async function remove() {
    if (!window.confirm("Supprimer l'extracteur importé ?")) return;
    removing = true;
    stop();
    result = null;
    try {
      await api.genreExtractorDelete();
      toasts.push("Extracteur supprimé");
      dispatch("change");
    } catch (e) {
      toasts.push(e?.message || "suppression impossible", "error");
    } finally {
      removing = false;
    }
  }

  async function check() {
    testing = true;
    try {
      result = await api.genreExtractorTest();
    } catch (e) {
      testing = false;
      toasts.push(e?.message || "test impossible", "error");
      return;
    }
    follow();
  }

  // Runs server-side on real tracks, so this is a poll: leaving the page is fine,
  // the next visit picks the verdict back up.
  function follow() {
    stop();
    const tick = async () => {
      try {
        result = await api.genreExtractorTestStatus();
      } catch {
        testing = false;
        return;
      }
      if (result?.running) {
        poll = setTimeout(tick, 1200);
      } else {
        testing = false;
        poll = null;
        if (result?.ok) toasts.push("Extracteur vérifié");
      }
    };
    poll = setTimeout(tick, 800);
  }

  function stop() {
    if (poll) clearTimeout(poll);
    poll = null;
  }

  onMount(async () => {
    try {
      const s = await api.genreExtractorTestStatus();
      if (s?.running) {
        result = s;
        testing = true;
        follow();
      } else if (s?.started) {
        result = s;
      }
    } catch {
      /* nothing to resume */
    }
  });
  onDestroy(stop);

  $: r = result?.result;
</script>

<div class="ext">
  {#if !extractor.onnxruntime}
    <div class="st-note bad">
      <Icon name="alert" size={16} />
      <span><code>onnxruntime</code> n'est pas installé sur le serveur (<code>supysonic[embedding]</code>).</span>
    </div>
  {/if}
  {#if extractor.session_error}
    <div class="st-note bad">
      <Icon name="alert" size={16} />
      <span>Le modèle ne se charge pas : {extractor.session_error}</span>
    </div>
  {/if}

  {#if extractor.model}
    <div class="row">
      <div class="info">
        <strong>{extractor.model.filename}</strong>
        <span class="st-dim small">
          {fmtBytes(extractor.model.size)} ·
          {extractor.model.source === "config" ? "défini par embed_model" : "importé sur ce serveur"}
        </span>
      </div>
      <div class="acts">
        {#if extractor.onnxruntime}
          <button class="st-btn sm" on:click={check} disabled={testing}>
            <Icon name={testing ? "refresh" : "check"} size={15} />
            {testing ? "Vérification…" : "Vérifier"}
          </button>
        {/if}
        {#if extractor.uploadable}
          <label class="st-btn sm file" class:off={uploading}>
            <Icon name="upload" size={15} />{uploading ? "Envoi…" : "Remplacer"}
            <input bind:this={fileInput} type="file" accept=".onnx,application/octet-stream" on:change={pick} disabled={uploading} />
          </label>
        {/if}
        {#if extractor.model.source !== "config"}
          <button class="st-btn sm danger" on:click={remove} disabled={removing} aria-label="Supprimer">
            <Icon name="trash" size={15} />
          </button>
        {/if}
      </div>
    </div>

    {#if testing && !r}
      <div class="bar indet"><i></i></div>
    {/if}
    {#if r}
      {#if r.same_track !== undefined}
        <div class="st-note" class:ok={result.ok} class:bad={!result.ok}>
          <Icon name={result.ok ? "check" : "alert"} size={16} />
          <span>
            {#if result.ok}
              Vérifié sur {r.tracks} titres : un même morceau se ressemble à {pct(r.same_track)} %,
              deux morceaux différents à {pct(r.different_tracks)} %.
            {:else}
              {r.reason || result.error || "échec de la vérification"}
            {/if}
          </span>
        </div>
      {:else}
        <div class="st-note"><Icon name="info" size={16} /><span>{r.reason || "vérification impossible pour l'instant"}</span></div>
      {/if}
    {:else if result?.error}
      <div class="st-note bad"><Icon name="alert" size={16} /><span>{result.error}</span></div>
    {/if}
  {:else}
    <div class="empty">
      <Icon name="upload" size={26} />
      <p>Aucun extracteur installé</p>
      {#if extractor.uploadable}
        <label class="st-btn primary file" class:off={uploading}>
          <Icon name="upload" size={16} />{uploading ? "Envoi…" : "Importer le modèle .onnx"}
          <input bind:this={fileInput} type="file" accept=".onnx,application/octet-stream" on:change={pick} disabled={uploading} />
        </label>
        <p class="st-dim small">
          <a href={extractor.model_url} target="_blank" rel="noopener">discogs-effnet-bsdynamic-1.onnx</a>
          (≈ 18 Mo, Essentia). Il reste sur votre serveur.
        </p>
      {:else}
        <p class="small">Configurez <code>cache_dir</code> dans <code>[webapp]</code> pour pouvoir importer un extracteur.</p>
      {/if}
    </div>
  {/if}
</div>

<style>
  .small { font-size: 0.8rem; }
  .row { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; }
  .info { display: grid; gap: 2px; min-width: 0; }
  .info strong { overflow-wrap: anywhere; }
  .acts { display: flex; gap: 8px; flex-wrap: wrap; }
  .file { position: relative; overflow: hidden; }
  .file input { position: absolute; inset: 0; opacity: 0; cursor: pointer; }
  .file.off { opacity: 0.45; pointer-events: none; }
  .empty { display: grid; justify-items: center; gap: 10px; padding: 22px 0; text-align: center; color: var(--text-dim, #9aa0a6); }
  .empty p { margin: 0; }
  code { background: var(--surface-2, #1b1d21); border-radius: 6px; padding: 1px 6px; font-size: 0.86em; }
  .bar { height: 5px; background: var(--surface-2, #1b1d21); border-radius: 3px; overflow: hidden; margin: 14px 0; }
  .bar i { display: block; height: 100%; width: 35%; background: var(--accent, #22d3ee); animation: slide 1.1s ease-in-out infinite; }
  @keyframes slide { 0% { transform: translateX(-100%); } 100% { transform: translateX(300%); } }
</style>
