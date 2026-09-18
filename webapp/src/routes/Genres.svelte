<script>
  // The genre studio: your own vocabulary, your own labels, your own model.
  //
  // The whole point of this screen is that tagging is CONFIRMING, not typing.
  // Every candidate arrives with what the current model already believes, the
  // keyboard is the interface (Entrée confirms, 1..9 correct, → skips), and the
  // preview jumps straight into the middle of the track — nobody judges a genre
  // from the intro. Two hundred tracks tagged in fifteen minutes is the target;
  // a form you fill in one field at a time is how a feature like this dies at
  // twenty.
  //
  // Training runs in a Web Worker (lib/genre/trainer.js) because it is seconds
  // of solid arithmetic, and a frozen tab is not a progress bar.
  import { onMount, onDestroy } from "svelte";
  import { pop } from "svelte-spa-router";
  import { api } from "../lib/api.js";
  import { user, toasts, player, downloadQuality } from "../lib/stores.js";
  import { decodeEmbedding, encodeHead } from "../lib/genre/train.js";
  import { train, release } from "../lib/genre/trainer.js";
  import Icon from "../components/Icon.svelte";
  import Cover from "../components/Cover.svelte";

  const ARCHETYPES = [
    { id: "", label: "—" },
    { id: "sustain", label: "Nappes" },
    { id: "voice", label: "Voix" },
    { id: "groove", label: "Groove" },
    { id: "hard", label: "Hard" },
    { id: "rock", label: "Rock" },
  ];
  // Enough distinct hues that a vocabulary of a dozen genres never repeats one,
  // and all of them legible on the dark chrome this app is.
  const SWATCHES = [
    "#f43f5e", "#f97316", "#eab308", "#84cc16", "#10b981", "#06b6d4",
    "#3b82f6", "#8b5cf6", "#d946ef", "#ec4899", "#64748b", "#14b8a6",
  ];
  const TABS = [
    { id: "vocab", label: "Genres" },
    { id: "tag", label: "Étiquetage" },
    { id: "model", label: "Modèle" },
  ];

  let tab = "tag";
  let status = null;
  let loading = true;
  let error = "";

  // -- vocabulary -------------------------------------------------------------
  let newName = "";
  let newColor = SWATCHES[0];
  let newArchetype = "";
  let busyTag = 0;

  // -- tagging ----------------------------------------------------------------
  let candidates = [];
  let cursor = 0;
  let tagging = false;
  let noMore = false;
  let candidatesLoaded = false;
  $: current = candidates[cursor] || null;
  $: tags = status?.tags || [];
  $: counts = status?.counts || {};
  $: labelled = status?.labelled || 0;
  $: extractor = status?.extractor || { available: false };
  $: suggestion = current?.predicted
    ? tags.find((t) => t.name === current.predicted)
    : null;

  // -- preview ----------------------------------------------------------------
  let audio = null;
  let previewing = false;
  let previewId = null;

  // -- training ---------------------------------------------------------------
  let mode = "linear";
  let training = false;
  let progress = 0;
  let progressStage = "";
  let head = null;
  let sending = false;
  let trainError = "";

  $: eligible = tags.filter((t) => (counts[t.name] || 0) >= 2);
  $: trainable = eligible.length >= 2 && labelled >= eligible.length * 3;
  $: thin = tags.filter((t) => (counts[t.name] || 0) > 0 && (counts[t.name] || 0) < 8);

  async function refresh() {
    try {
      status = await api.genreStatus();
      error = "";
    } catch (e) {
      error = e?.message || "impossible de charger le studio";
    } finally {
      loading = false;
    }
  }

  async function loadCandidates() {
    if (tagging) return;
    tagging = true;
    try {
      const res = await api.genreCandidates(40);
      candidates = res.candidates || [];
      cursor = 0;
      noMore = candidates.length === 0;
      candidatesLoaded = true;
    } catch (e) {
      toasts.push(e?.message || "chargement impossible", "error");
    } finally {
      tagging = false;
    }
  }

  // -- vocabulary actions -----------------------------------------------------
  async function addTag() {
    const name = newName.trim();
    if (!name) return;
    busyTag = -1;
    try {
      await api.genreTagCreate(name, newColor, newArchetype || null);
      newName = "";
      // Step the swatch on, so a vocabulary built in one sitting comes out with
      // twelve different colours instead of twelve red ones.
      newColor = SWATCHES[(SWATCHES.indexOf(newColor) + 1) % SWATCHES.length];
      await refresh();
    } catch (e) {
      toasts.push(e?.message || "création impossible", "error");
    } finally {
      busyTag = 0;
    }
  }

  async function patchTag(tag, patch) {
    busyTag = tag.id;
    try {
      await api.genreTagEdit(tag.id, patch);
      await refresh();
    } catch (e) {
      toasts.push(e?.message || "modification impossible", "error");
    } finally {
      busyTag = 0;
    }
  }

  async function removeTag(tag) {
    const n = counts[tag.name] || 0;
    const msg = n
      ? `Supprimer « ${tag.name} » et ses ${n} étiquette${n > 1 ? "s" : ""} ?`
      : `Supprimer « ${tag.name} » ?`;
    if (!window.confirm(msg)) return;
    busyTag = tag.id;
    try {
      await api.genreTagDelete(tag.id);
      await refresh();
      await loadCandidates();
    } catch (e) {
      toasts.push(e?.message || "suppression impossible", "error");
    } finally {
      busyTag = 0;
    }
  }

  // -- tagging actions --------------------------------------------------------
  async function label(tag) {
    const track = current;
    if (!track) return;
    stopPreview();
    // Optimistic: the row leaves at once and the count moves with it. A tagging
    // pass is a rhythm, and a round trip per track breaks it.
    candidates = candidates.filter((c) => c.id !== track.id);
    if (cursor >= candidates.length) cursor = Math.max(0, candidates.length - 1);
    if (status) {
      status.counts = { ...status.counts, [tag.name]: (status.counts[tag.name] || 0) + 1 };
      status.labelled = (status.labelled || 0) + 1;
      status = status;
    }
    try {
      await api.genreLabel(track.deezer_id || track.id, tag.id);
    } catch (e) {
      toasts.push(e?.message || "étiquetage impossible", "error");
      await refresh();
    }
    if (candidates.length === 0) await loadCandidates();
  }

  function skip() {
    stopPreview();
    if (cursor < candidates.length - 1) cursor += 1;
    else loadCandidates();
  }
  function back() {
    stopPreview();
    if (cursor > 0) cursor -= 1;
  }
  function confirmSuggestion() {
    if (suggestion) label(suggestion);
  }

  // -- preview ----------------------------------------------------------------
  // A dedicated element rather than the real player: previewing a hundred
  // candidates must not touch the queue, the history or the play counts. It
  // does pause the player, because two things playing at once is nobody's
  // intent.
  function togglePreview() {
    if (!current) return;
    if (previewing && previewId === current.id) {
      stopPreview();
      return;
    }
    if (!audio) return;
    player.pause();
    previewId = current.id;
    audio.src = api.streamUrl(current.deezer_id || current.id, $downloadQuality);
    audio.currentTime = 0;
    const jump = () => {
      // A third of the way in: past the intro, into whatever the track actually
      // is. A genre judged from the first eight bars is a genre judged wrong.
      if (audio.duration && isFinite(audio.duration))
        audio.currentTime = audio.duration * 0.33;
      audio.removeEventListener("loadedmetadata", jump);
    };
    audio.addEventListener("loadedmetadata", jump);
    audio.play().then(
      () => (previewing = true),
      () => (previewing = false)
    );
  }
  function stopPreview() {
    if (!audio) return;
    audio.pause();
    previewing = false;
    previewId = null;
  }

  // -- training ---------------------------------------------------------------
  async function buildMatrix() {
    const res = await api.genreLabelled();
    const rows = res.labelled || [];
    const names = [];
    const keep = [];
    for (const r of rows) {
      if (!r.tag) continue;
      keep.push(r);
      if (!names.includes(r.tag.name)) names.push(r.tag.name);
    }
    names.sort();
    if (names.length < 2) throw new Error("il faut au moins deux genres étiquetés");

    // Embeddings in batches: /genre/embeddings never extracts, so a track whose
    // vector is missing is simply left out rather than making the whole run wait.
    const ids = keep.map((r) => r.deezer_id || r.id);
    const vectors = new Map();
    const BATCH = 200;
    for (let i = 0; i < ids.length; i += BATCH) {
      progressStage = "vecteurs";
      progress = (0.25 * i) / Math.max(1, ids.length);
      const part = await api.genreEmbeddings(ids.slice(i, i + BATCH));
      for (const [k, v] of Object.entries(part.embeddings || {}))
        vectors.set(k, decodeEmbedding(v));
    }
    const usable = keep.filter((r) => vectors.has(String(r.deezer_id || r.id)));
    if (!usable.length)
      throw new Error("aucun vecteur disponible — lancez « supysonic-cli deezer embed »");
    const d = vectors.get(String(usable[0].deezer_id || usable[0].id)).length;
    const X = new Float32Array(usable.length * d);
    const y = new Int32Array(usable.length);
    usable.forEach((r, i) => {
      X.set(vectors.get(String(r.deezer_id || r.id)), i * d);
      y[i] = names.indexOf(r.tag.name);
    });
    return { X, y, n: usable.length, d, labels: names, skipped: keep.length - usable.length };
  }

  async function runTraining() {
    if (training) return;
    training = true;
    trainError = "";
    head = null;
    progress = 0;
    progressStage = "préparation";
    try {
      const data = await buildMatrix();
      const skipped = data.skipped;
      progressStage = mode === "deep" ? "entraînement approfondi" : "entraînement";
      const trained = await train(
        data,
        mode,
        (stage, pct) => {
          progressStage = stage === "done" ? "terminé" : progressStage;
          progress = 0.25 + 0.75 * (pct || 0);
        },
        {}
      );
      trained.skipped = skipped;
      head = trained;
      progress = 1;
    } catch (e) {
      trainError = e?.message || "entraînement impossible";
    } finally {
      training = false;
    }
  }

  async function sendModel() {
    if (!head || sending) return;
    sending = true;
    try {
      await api.genreModelPut({
        labels: head.labels,
        weights: encodeHead(head),
        dim: head.dim,
        kind: head.kind || "linear",
        hidden: head.hidden || 0,
        metrics: head.metrics,
      });
      toasts.push("Modèle envoyé au serveur");
      await refresh();
    } catch (e) {
      toasts.push(e?.message || "envoi impossible", "error");
    } finally {
      sending = false;
    }
  }

  async function disableModel() {
    if (!window.confirm("Désactiver le modèle actif ?")) return;
    try {
      await api.genreModelDelete();
      await refresh();
    } catch (e) {
      toasts.push(e?.message || "opération impossible", "error");
    }
  }

  // -- keyboard ---------------------------------------------------------------
  function onKey(ev) {
    if (tab !== "tag" || !current) return;
    const t = ev.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable))
      return;
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    const n = parseInt(ev.key, 10);
    if (n >= 1 && n <= 9 && tags[n - 1]) {
      ev.preventDefault();
      label(tags[n - 1]);
    } else if (ev.key === "Enter" && suggestion) {
      ev.preventDefault();
      confirmSuggestion();
    } else if (ev.key === "ArrowRight" || ev.key === "s") {
      ev.preventDefault();
      skip();
    } else if (ev.key === "ArrowLeft") {
      ev.preventDefault();
      back();
    } else if (ev.key === " ") {
      ev.preventDefault();
      togglePreview();
    }
  }

  onMount(async () => {
    await refresh();
    // Unconditionally: the extractor is what MEASURES a track, and tagging only
    // needs what was already measured. An archive carried over from a server
    // that had onnxruntime is a perfectly good training set on one that does
    // not, and gating this on the extractor left that library untaggable.
    await loadCandidates();
  });
  onDestroy(() => {
    stopPreview();
    release();
  });

  const pct = (v) => Math.round((v || 0) * 100);
  const heat = (v) =>
    v <= 0 ? "transparent" : `color-mix(in srgb, var(--accent) ${Math.round(v * 100)}%, transparent)`;
</script>

<svelte:window on:keydown={onKey} />
<audio bind:this={audio} on:ended={stopPreview} preload="none"></audio>

<div class="page">
  <header class="head">
    <button class="icon-btn" on:click={() => pop()} aria-label="Retour">
      <Icon name="prev" size={20} />
    </button>
    <div class="titles">
      <h1>Studio de genres</h1>
      <p class="muted sub-line">
        Votre vocabulaire, vos étiquettes, votre modèle — entraîné dans ce navigateur.
      </p>
    </div>
  </header>

  {#if loading}
    <p class="muted pad">Chargement…</p>
  {:else if error}
    <div class="banner bad"><Icon name="alert" size={16} /><span>{error}</span></div>
  {:else if !$user?.admin}
    <div class="banner bad">
      <Icon name="alert" size={16} />
      <span>Le studio est réservé à l'administrateur : il n'y a qu'un modèle.</span>
    </div>
  {:else}
    {#if !extractor.available && tab !== "tag"}
      <div class="banner">
        <Icon name="info" size={16} />
        <div>
          <strong>L'extracteur n'est pas disponible.</strong>
          <p class="muted">
            {extractor.reason || "onnxruntime et le modèle d'empreintes sont nécessaires."}
            Les empreintes déjà calculées restent utilisables : vous pouvez étiqueter
            et entraîner normalement, mais aucun nouveau titre ne sera mesuré.
          </p>
        </div>
      </div>
    {/if}

    <nav class="tabs">
      {#each TABS as t}
        <button class="tab" class:sel={tab === t.id} on:click={() => (tab = t.id)}>
          {t.label}
          {#if t.id === "tag" && labelled}<span class="pill">{labelled}</span>{/if}
        </button>
      {/each}
    </nav>

    {#if tab === "vocab"}
      <section class="card">
        <h2><Icon name="sort" size={18} /> Vocabulaire</h2>
        <p class="sub muted">
          Les genres que <em>vous</em> distinguez. Le modèle n'apprendra jamais une
          nuance qui n'a pas de nom ici — et chaque genre veut au moins huit titres
          pour valoir quelque chose.
        </p>

        <div class="tag-list">
          {#each tags as tag (tag.id)}
            <div class="tag-row" class:busy={busyTag === tag.id}>
              <span class="dot" style={`background:${tag.color || "var(--accent)"}`}></span>
              <input
                class="tname"
                value={tag.name}
                on:change={(e) =>
                  e.target.value.trim() && e.target.value !== tag.name
                    ? patchTag(tag, { name: e.target.value.trim() })
                    : null}
              />
              <div class="swatches">
                {#each SWATCHES as c}
                  <button
                    class="sw-dot"
                    class:sel={tag.color === c}
                    style={`background:${c}`}
                    aria-label={`Couleur ${c}`}
                    on:click={() => patchTag(tag, { color: c })}
                  ></button>
                {/each}
              </div>
              <select
                class="arch"
                value={tag.archetype || ""}
                on:change={(e) => patchTag(tag, { archetype: e.target.value || null })}
              >
                {#each ARCHETYPES as a}<option value={a.id}>{a.label}</option>{/each}
              </select>
              <span class="count" class:thin={(counts[tag.name] || 0) < 8}>
                {counts[tag.name] || 0}
              </span>
              <button class="icon-btn danger" on:click={() => removeTag(tag)} aria-label="Supprimer">
                <Icon name="trash" size={16} />
              </button>
            </div>
          {/each}
          {#if !tags.length}
            <p class="muted empty">Aucun genre. Commencez par en créer quelques-uns.</p>
          {/if}
        </div>

        <form class="add" on:submit|preventDefault={addTag}>
          <span class="dot" style={`background:${newColor}`}></span>
          <input placeholder="Nouveau genre (hardtekk, zaag, uptempo…)" bind:value={newName} />
          <select bind:value={newArchetype}>
            {#each ARCHETYPES as a}<option value={a.id}>{a.label}</option>{/each}
          </select>
          <button class="primary" disabled={!newName.trim() || busyTag === -1}>
            <Icon name="plus" size={16} /> Ajouter
          </button>
        </form>
        <p class="hint muted">
          L'archétype dit aux animations à quoi ce genre <em>ressemble</em> : c'est ce
          que le moteur mélange, pas le nom du genre.
        </p>
      </section>
    {/if}

    {#if tab === "tag"}
      <section class="card tagger">
        <div class="tag-head">
          <h2><Icon name="mic" size={18} /> Étiquetage</h2>
          <div class="stats">
            <span><strong>{labelled}</strong> étiquetés</span>
            <span class="sep">·</span>
            <span>{candidates.length - cursor} en file</span>
          </div>
        </div>

        {#if !tags.length}
          <p class="muted empty">
            Créez d'abord quelques genres dans l'onglet « Genres ».
          </p>
        {:else if noMore}
          <div class="empty-state">
            <Icon name="check" size={28} />
            {#if labelled}
              <p>Plus rien à étiqueter pour l'instant.</p>
            {:else}
              <p>Aucun titre ne porte encore d'empreinte.</p>
              <p class="small">
                Lancez <code>supysonic-cli deezer embed</code> sur le serveur pour
                en calculer.
              </p>
            {/if}
            <button class="ghost" on:click={loadCandidates}>
              <Icon name="refresh" size={16} /> Recharger
            </button>
          </div>
        {:else if current}
          <div class="candidate">
            <button class="art" on:click={togglePreview} aria-label="Écouter un extrait">
              <Cover
                src={current.cover}
                alt={current.title}
                kind="track"
                fallbackId={current.deezer_id || current.id}
                size={120}
                eager
              />
              <span class="play-badge" class:on={previewing && previewId === current.id}>
                <Icon name={previewing && previewId === current.id ? "pause" : "play"} size={18} />
              </span>
            </button>
            <div class="meta">
              <h3>{current.title}</h3>
              <p class="who">{current.artist}</p>
              {#if current.album}<p class="muted small">{current.album}</p>{/if}
              {#if current.predicted}
                <div class="guess" style={`--c:${suggestion?.color || "var(--accent)"}`}>
                  <span class="guess-k">Proposition</span>
                  <div class="guess-line">
                    <span class="guess-v">{current.predicted}</span>
                    <span class="guess-c">{pct(current.confidence)} %</span>
                  </div>
                  <span class="guess-bar">
                    <i style={`width:${pct(current.confidence)}%`}></i>
                  </span>
                </div>
              {:else}
                <p class="muted small guess-none">
                  Aucun modèle ne s'est encore prononcé sur ce titre.
                </p>
              {/if}
            </div>
          </div>

          <div class="choices">
            {#each tags as tag, i}
              <button
                class="choice"
                class:sugg={suggestion && suggestion.id === tag.id}
                style={`--c:${tag.color || "var(--accent)"}`}
                on:click={() => label(tag)}
              >
                {#if i < 9}<kbd>{i + 1}</kbd>{/if}
                <span>{tag.name}</span>
              </button>
            {/each}
          </div>

          <div class="tag-actions">
            <button class="ghost" on:click={back} disabled={cursor === 0}>
              <Icon name="prev" size={16} /> Précédent
            </button>
            {#if suggestion}
              <button class="primary confirm" on:click={confirmSuggestion}>
                <Icon name="check" size={16} />
                <span class="confirm-label">Confirmer « {suggestion.name} »</span>
                <kbd>↵</kbd>
              </button>
            {/if}
            <button class="ghost" on:click={skip}>
              Passer <kbd>→</kbd>
            </button>
          </div>
          <p class="hint muted">
            <kbd>1</kbd>…<kbd>9</kbd> choisir · <kbd>↵</kbd> confirmer ·
            <kbd>espace</kbd> écouter · <kbd>→</kbd> passer
          </p>
        {:else if !candidatesLoaded}
          <p class="muted empty">Chargement…</p>
        {:else}
          <div class="empty-state">
            <Icon name="refresh" size={28} />
            <p>Rien à afficher.</p>
            <button class="ghost" on:click={loadCandidates}>Recharger</button>
          </div>
        {/if}
      </section>
    {/if}

    {#if tab === "model"}
      <section class="card">
        <h2><Icon name="activity" size={18} /> Entraînement</h2>
        <p class="sub muted">
          Le gros modèle ne bouge pas : il transforme chaque titre en vecteur, une
          fois. Ce qui s'entraîne ici est la petite tête qui va de ce vecteur à
          <em>vos</em> genres — quelques secondes, dans cet onglet, sans rien installer.
        </p>

        {#if thin.length}
          <div class="banner soft">
            <Icon name="info" size={16} />
            <span>
              Peu d'exemples pour {thin.map((t) => t.name).join(", ")} — huit par genre
              est le minimum pour un chiffre qui veut dire quelque chose.
            </span>
          </div>
        {/if}

        <div class="modes">
          <button class="mode" class:sel={mode === "linear"} on:click={() => (mode = "linear")}>
            <strong>Rapide</strong>
            <span class="muted">Tête linéaire. Une seconde. Le bon choix par défaut.</span>
          </button>
          <button class="mode" class:sel={mode === "deep"} on:click={() => (mode = "deep")}>
            <strong>Approfondi</strong>
            <span class="muted">
              Réseau à couche cachée, compilé en WebAssembly. Quelques secondes, pour
              les genres que le mode rapide n'arrive pas à séparer.
            </span>
          </button>
        </div>

        <div class="run">
          <button class="primary big" on:click={runTraining} disabled={training || !trainable}>
            {#if training}
              <Icon name="refresh" size={16} /> {progressStage}…
            {:else}
              <Icon name="play" size={16} /> Entraîner
            {/if}
          </button>
          {#if !trainable}
            <span class="muted">
              Il faut au moins deux genres et trois titres par genre.
            </span>
          {/if}
        </div>

        {#if training}
          <div class="progress"><i style={`width:${pct(progress)}%`}></i></div>
        {/if}
        {#if trainError}
          <div class="banner bad"><Icon name="alert" size={16} /><span>{trainError}</span></div>
        {/if}

        {#if head}
          <div class="results">
            <div class="scores">
              <div class="score">
                <span class="k">Justesse équilibrée</span>
                <span class="v">{pct(head.metrics.balanced)} %</span>
                <span class="muted small">moyenne des rappels, chaque genre à poids égal</span>
              </div>
              <div class="score">
                <span class="k">Justesse brute</span>
                <span class="v">{pct(head.metrics.accuracy)} %</span>
                <span class="muted small">
                  validation croisée {head.metrics.folds} plis · {head.metrics.examples} titres
                </span>
              </div>
            </div>

            <table class="per-class">
              <thead>
                <tr><th>Genre</th><th>Titres</th><th>Rappel</th><th>Précision</th></tr>
              </thead>
              <tbody>
                {#each head.metrics.perClass as c}
                  <tr class:weak={c.recall < 0.6}>
                    <td>{c.label}</td>
                    <td class="num">{c.examples}</td>
                    <td class="num">{pct(c.recall)} %</td>
                    <td class="num">{pct(c.precision)} %</td>
                  </tr>
                {/each}
              </tbody>
            </table>

            <div class="confusion">
              <h3>Confusions</h3>
              <p class="muted small">
                Une ligne par genre réel, une colonne par genre prédit. Ce qui sort de
                la diagonale est ce qu'il reste à étiqueter.
              </p>
              <div class="grid" style={`--n:${head.labels.length}`}>
                <span class="corner"></span>
                {#each head.labels as l}<span class="col-h" title={l}>{l.slice(0, 3)}</span>{/each}
                {#each head.metrics.confusion as row, i}
                  <span class="row-h" title={head.labels[i]}>{head.labels[i]}</span>
                  {#each row as v, j}
                    {@const total = row.reduce((a, b) => a + b, 0) || 1}
                    <span
                      class="cell"
                      class:diag={i === j}
                      style={`background:${heat(v / total)}`}
                      title={`${head.labels[i]} → ${head.labels[j]} : ${v}`}
                    >{v || ""}</span>
                  {/each}
                {/each}
              </div>
            </div>

            {#if head.skipped}
              <p class="muted small">
                {head.skipped} titre{head.skipped > 1 ? "s" : ""} ignoré{head.skipped > 1 ? "s" : ""} :
                pas encore de vecteur.
              </p>
            {/if}

            <button class="primary big" on:click={sendModel} disabled={sending}>
              <Icon name="upload" size={16} />
              {sending ? "Envoi…" : "Envoyer au serveur"}
            </button>
          </div>
        {/if}
      </section>

      <section class="card">
        <h2><Icon name="archive" size={18} /> Modèle actif</h2>
        {#if status.model}
          <div class="active">
            <div>
              <strong>Version {status.model.version}</strong>
              <p class="muted small">
                {status.model.labels.length} genres ·
                {#if status.model.metrics?.balanced}
                  {pct(status.model.metrics.balanced)} % équilibré ·
                {/if}
                {new Date(status.model.created).toLocaleString("fr-FR")}
              </p>
              {#if !status.model.usable}
                <p class="bad small">Le serveur ne parvient pas à le relire.</p>
              {/if}
            </div>
            <button class="ghost danger" on:click={disableModel}>
              <Icon name="close" size={16} /> Désactiver
            </button>
          </div>
          <div class="chips">
            {#each status.model.labels as l}<span class="chip">{l}</span>{/each}
          </div>
        {:else}
          <p class="muted empty">Aucun modèle actif — l'analyse utilise ses règles par défaut.</p>
        {/if}
      </section>
    {/if}
  {/if}
</div>

<style>
  .page {
    max-width: 920px;
    margin: 0 auto;
    padding: 0 16px 120px;
  }
  .head {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding: 20px 0 8px;
  }
  .titles h1 {
    margin: 0;
    font-size: 1.5rem;
    letter-spacing: -0.02em;
  }
  .titles p {
    margin: 4px 0 0;
    font-size: 0.86rem;
  }
  .muted {
    color: var(--text-dim, #9aa0a6);
  }
  .small {
    font-size: 0.8rem;
  }
  .pad {
    padding: 24px 0;
  }
  .bad {
    color: #f87171;
  }

  .banner {
    display: flex;
    gap: 10px;
    align-items: flex-start;
    background: var(--surface-2, #1b1d21);
    border: 1px solid var(--border, #2a2d33);
    border-radius: 14px;
    padding: 12px 14px;
    margin: 12px 0;
    font-size: 0.88rem;
  }
  .banner p {
    margin: 4px 0 0;
  }
  .banner.bad {
    border-color: #7f1d1d;
    color: #fca5a5;
  }
  .banner.soft {
    background: transparent;
  }

  .tabs {
    display: flex;
    gap: 6px;
    margin: 16px 0 18px;
    border-bottom: 1px solid var(--border, #2a2d33);
    /* A phone has room for exactly these three words and no padding to spare;
       the scroll is the safety net for a longer label or a bigger font. */
    overflow-x: auto;
    scrollbar-width: none;
  }
  .tabs::-webkit-scrollbar {
    display: none;
  }
  .tab {
    flex: none;
  }
  .tab {
    background: none;
    border: 0;
    color: var(--text-dim, #9aa0a6);
    padding: 10px 14px;
    font: inherit;
    font-weight: 600;
    cursor: pointer;
    border-bottom: 2px solid transparent;
    margin-bottom: -1px;
    display: flex;
    align-items: center;
    gap: 7px;
  }
  .tab.sel {
    color: var(--text, #f2f3f5);
    border-bottom-color: var(--accent, #22d3ee);
  }
  .pill {
    background: var(--surface-2, #1b1d21);
    border-radius: 999px;
    padding: 1px 7px;
    font-size: 0.74rem;
    font-weight: 700;
  }

  .card {
    background: var(--surface, #141517);
    border: 1px solid var(--border, #2a2d33);
    border-radius: 18px;
    padding: 20px;
    margin-bottom: 18px;
  }
  .card h2 {
    display: flex;
    align-items: center;
    gap: 9px;
    margin: 0 0 6px;
    font-size: 1.04rem;
  }
  .sub {
    margin: 0 0 16px;
    font-size: 0.86rem;
    line-height: 1.5;
  }
  .empty {
    padding: 18px 0;
    text-align: center;
  }
  .hint {
    margin: 12px 0 0;
    font-size: 0.8rem;
  }

  /* -- vocabulary ---------------------------------------------------------- */
  .tag-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .tag-row {
    display: grid;
    grid-template-columns: 14px minmax(110px, 1fr) auto auto 40px 34px;
    align-items: center;
    gap: 10px;
    background: var(--surface-2, #1b1d21);
    border-radius: 12px;
    padding: 8px 10px;
    transition: opacity 0.15s;
  }
  .tag-row.busy {
    opacity: 0.5;
    pointer-events: none;
  }
  .dot {
    width: 12px;
    height: 12px;
    border-radius: 50%;
    display: inline-block;
  }
  .tname,
  .add input {
    background: transparent;
    border: 1px solid transparent;
    border-radius: 8px;
    color: inherit;
    font: inherit;
    font-weight: 600;
    padding: 6px 8px;
    min-width: 0;
  }
  .tname:focus,
  .add input:focus {
    border-color: var(--border, #2a2d33);
    outline: none;
    background: var(--surface, #141517);
  }
  .swatches {
    display: flex;
    gap: 3px;
    flex-wrap: wrap;
    max-width: 170px;
  }
  .sw-dot {
    width: 14px;
    height: 14px;
    border-radius: 50%;
    border: 2px solid transparent;
    padding: 0;
    cursor: pointer;
  }
  .sw-dot.sel {
    border-color: var(--text, #f2f3f5);
  }
  .arch,
  .add select {
    background: var(--surface, #141517);
    border: 1px solid var(--border, #2a2d33);
    border-radius: 8px;
    color: inherit;
    font: inherit;
    font-size: 0.84rem;
    padding: 5px 8px;
  }
  .count {
    text-align: right;
    font-variant-numeric: tabular-nums;
    font-weight: 700;
    font-size: 0.86rem;
  }
  .count.thin {
    color: #fbbf24;
  }
  .add {
    display: grid;
    grid-template-columns: 14px 1fr auto auto;
    align-items: center;
    gap: 10px;
    margin-top: 14px;
  }

  /* -- tagging ------------------------------------------------------------- */
  .tag-head {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 12px;
    margin-bottom: 14px;
  }
  .tag-head h2 {
    margin: 0;
  }
  .stats {
    font-size: 0.84rem;
    white-space: nowrap;
    color: var(--text-dim, #9aa0a6);
  }
  .sep {
    margin: 0 6px;
  }
  .candidate {
    display: flex;
    gap: 18px;
    align-items: center;
    background: var(--surface-2, #1b1d21);
    border-radius: 16px;
    padding: 18px;
  }
  .art {
    position: relative;
    width: 120px;
    height: 120px;
    flex: none;
    border: 0;
    padding: 0;
    background: none;
    border-radius: 12px;
    overflow: hidden;
    cursor: pointer;
  }
  /* Always visible, never hover-only: a touch device has no hover, and a
     control you cannot see is a control that does not exist. */
  .play-badge {
    position: absolute;
    right: 7px;
    bottom: 7px;
    width: 34px;
    height: 34px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    background: rgba(8, 8, 10, 0.72);
    backdrop-filter: blur(6px);
    color: #fff;
    transition: transform 0.16s, background 0.16s;
  }
  .art:hover .play-badge,
  .art:focus-visible .play-badge {
    transform: scale(1.08);
    background: rgba(8, 8, 10, 0.88);
  }
  .play-badge.on {
    background: var(--accent, #22d3ee);
    color: #05171b;
  }
  .meta {
    min-width: 0;
    flex: 1;
  }
  .meta h3 {
    margin: 0 0 4px;
    font-size: 1.32rem;
    letter-spacing: -0.02em;
  }
  .meta p {
    margin: 0;
    font-size: 0.88rem;
  }
  .who {
    color: var(--text, #f2f3f5);
    font-weight: 600;
  }
  /* The proposition is what you confirm four times out of five — it gets the
     weight, not the small print. */
  .guess {
    margin-top: 14px;
    max-width: 360px;
  }
  /* Label above, value and confidence on the row under it. On a phone the
     metadata column is 158px wide and "Proposition zaag 100 %" needs 179 — one
     line could only ever be one line by truncating the genre, which is the one
     word the row exists to show. */
  .guess-line {
    display: flex;
    align-items: baseline;
    gap: 10px;
    margin-top: 2px;
  }
  .guess-k {
    display: block;
    font-size: 0.78rem;
    letter-spacing: 0.02em;
    text-transform: uppercase;
    color: var(--text-dim, #9aa0a6);
  }
  .guess-v {
    flex: 1 1 auto;
    min-width: 0;
    font-weight: 700;
    font-size: 1.06rem;
    color: var(--c);
  }
  .guess-c {
    margin-left: auto;
    flex: none;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
    color: var(--text-dim, #9aa0a6);
  }
  .guess-v {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .guess-bar {
    display: block;
    height: 4px;
    margin-top: 6px;
    border-radius: 2px;
    background: var(--surface-3, #24262b);
    overflow: hidden;
  }
  .guess-bar i {
    display: block;
    height: 100%;
    background: var(--c);
    transition: width 0.25s;
  }
  .guess-none {
    margin-top: 12px;
  }

  .choices {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin: 16px 0 4px;
  }
  .choice {
    display: flex;
    align-items: center;
    gap: 8px;
    background: var(--surface-2, #1b1d21);
    border: 1px solid var(--border, #2a2d33);
    border-left: 3px solid var(--c);
    border-radius: 11px;
    color: inherit;
    font: inherit;
    font-weight: 600;
    padding: 9px 13px;
    cursor: pointer;
    transition: transform 0.12s, background 0.12s;
  }
  .choice:hover {
    background: var(--surface-3, #24262b);
    transform: translateY(-1px);
  }
  .choice.sugg {
    box-shadow: 0 0 0 1px var(--c) inset;
  }
  kbd {
    background: rgba(255, 255, 255, 0.08);
    border-radius: 5px;
    padding: 1px 6px;
    font: inherit;
    font-size: 0.74rem;
    font-weight: 700;
    color: var(--text-dim, #9aa0a6);
  }
  .tag-actions {
    display: flex;
    gap: 10px;
    align-items: center;
    flex-wrap: wrap;
    margin-top: 14px;
  }
  .confirm {
    /* Shrinks if it must, never stretches: a 560px-wide button on a desktop
       card reads as a banner, not as something to click. */
    flex: 0 1 auto;
    justify-content: center;
    min-width: 0;
    max-width: 420px;
  }
  .confirm-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .empty-state code {
    background: var(--surface-2, #1b1d21);
    border-radius: 6px;
    padding: 1px 6px;
    font-size: 0.86em;
  }
  .empty-state {
    display: grid;
    justify-items: center;
    gap: 10px;
    padding: 34px 0;
    color: var(--text-dim, #9aa0a6);
  }

  /* -- training ------------------------------------------------------------ */
  .modes {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
    gap: 10px;
    margin: 14px 0;
  }
  .mode {
    display: grid;
    gap: 5px;
    text-align: left;
    background: var(--surface-2, #1b1d21);
    border: 1px solid var(--border, #2a2d33);
    border-radius: 14px;
    padding: 13px 15px;
    color: inherit;
    font: inherit;
    cursor: pointer;
  }
  .mode span {
    font-size: 0.82rem;
    line-height: 1.45;
  }
  .mode.sel {
    border-color: var(--accent, #22d3ee);
    box-shadow: 0 0 0 1px var(--accent, #22d3ee) inset;
  }
  .run {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
    font-size: 0.84rem;
  }
  .progress {
    height: 5px;
    background: var(--surface-2, #1b1d21);
    border-radius: 3px;
    overflow: hidden;
    margin: 14px 0;
  }
  .progress i {
    display: block;
    height: 100%;
    background: var(--accent, #22d3ee);
    transition: width 0.25s;
  }

  .results {
    margin-top: 18px;
    display: grid;
    gap: 18px;
  }
  .scores {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
    gap: 10px;
  }
  .score {
    display: grid;
    gap: 2px;
    background: var(--surface-2, #1b1d21);
    border-radius: 14px;
    padding: 14px 16px;
  }
  .score .k {
    font-size: 0.8rem;
    color: var(--text-dim, #9aa0a6);
  }
  .score .v {
    font-size: 1.6rem;
    font-weight: 700;
    letter-spacing: -0.02em;
    font-variant-numeric: tabular-nums;
  }
  .per-class {
    width: 100%;
    max-width: 520px;
    border-collapse: collapse;
    font-size: 0.86rem;
  }
  .per-class th:first-child,
  .per-class td:first-child {
    width: 100%;
  }
  .per-class th:not(:first-child),
  .per-class td:not(:first-child) {
    white-space: nowrap;
    padding-left: 22px;
  }
  .per-class th {
    text-align: left;
    color: var(--text-dim, #9aa0a6);
    font-weight: 600;
    padding: 6px 8px;
    border-bottom: 1px solid var(--border, #2a2d33);
  }
  .per-class td {
    padding: 7px 8px;
    border-bottom: 1px solid var(--border, #2a2d33);
  }
  .per-class .num {
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .per-class tr.weak td {
    color: #fbbf24;
  }

  .confusion h3 {
    margin: 0 0 3px;
    font-size: 0.94rem;
  }
  .confusion .grid {
    display: grid;
    grid-template-columns: minmax(64px, 130px) repeat(var(--n), minmax(28px, 54px));
    gap: 3px;
    margin-top: 10px;
    font-size: 0.72rem;
    justify-content: start;
    overflow-x: auto;
  }
  .col-h,
  .row-h {
    color: var(--text-dim, #9aa0a6);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .col-h {
    text-align: center;
  }
  .row-h {
    text-align: right;
    padding-right: 6px;
    align-self: center;
  }
  .cell {
    display: grid;
    place-items: center;
    min-height: 34px;
    border-radius: 6px;
    background: var(--surface-2, #1b1d21);
    font-variant-numeric: tabular-nums;
  }
  .cell.diag {
    outline: 1px solid var(--border, #2a2d33);
  }

  .active {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 14px;
    flex-wrap: wrap;
  }
  .active p {
    margin: 3px 0 0;
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 12px;
  }
  .chip {
    background: var(--surface-2, #1b1d21);
    border-radius: 999px;
    padding: 3px 10px;
    font-size: 0.78rem;
  }

  /* -- buttons ------------------------------------------------------------- */
  .icon-btn {
    background: var(--surface-2, #1b1d21);
    border: 0;
    border-radius: 10px;
    color: inherit;
    width: 36px;
    height: 36px;
    display: grid;
    place-items: center;
    cursor: pointer;
    flex: none;
  }
  .icon-btn.danger:hover {
    color: #f87171;
  }
  .primary,
  .ghost {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    border-radius: 11px;
    font: inherit;
    font-weight: 600;
    padding: 9px 15px;
    cursor: pointer;
    border: 1px solid var(--border, #2a2d33);
  }
  .primary {
    background: var(--accent, #22d3ee);
    border-color: transparent;
    color: #05171b;
  }
  .primary.big {
    padding: 11px 20px;
  }
  .primary:disabled,
  .ghost:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .ghost {
    background: var(--surface-2, #1b1d21);
    color: inherit;
  }
  .ghost.danger:hover {
    color: #f87171;
  }

  @media (max-width: 620px) {
    /* Tagging is a rhythm, and on a phone the card has to be ON SCREEN when the
       tab opens — not one scroll below a header explaining what the page is. */
    .head {
      padding: 14px 0 4px;
    }
    .titles h1 {
      font-size: 1.28rem;
    }
    .sub-line {
      display: none;
    }
    .tabs {
      margin: 12px 0 14px;
    }
    .card {
      padding: 16px 14px;
    }
    .tab {
      padding: 10px 10px;
      font-size: 0.92rem;
    }
    .tag-row {
      grid-template-columns: 14px 1fr 34px;
      grid-template-areas: "dot name del" "sw sw sw" "arch arch count";
    }
    .tag-row .dot {
      grid-area: dot;
    }
    .tname {
      grid-area: name;
    }
    .swatches {
      grid-area: sw;
      max-width: none;
    }
    .arch {
      grid-area: arch;
    }
    .count {
      grid-area: count;
    }
    .add {
      grid-template-columns: 14px 1fr;
    }
    .candidate {
      gap: 14px;
      padding: 14px;
    }
    .art {
      width: 88px;
      height: 88px;
    }
    .meta h3 {
      font-size: 1.1rem;
    }
    .guess {
      margin-top: 10px;
    }
    /* Confirm on its own line and full width — it is the one target the thumb
       aims at, over and over. */
    .tag-head {
      display: block;
    }
    .stats {
      margin-top: 2px;
    }
    .tag-actions {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
    }
    .confirm {
      grid-column: 1 / -1;
      order: -1;
      max-width: none;
      padding: 13px 16px;
    }
    .tag-actions .ghost {
      justify-content: center;
    }
  }
</style>
