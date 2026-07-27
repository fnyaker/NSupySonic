<script>
  import { onMount } from "svelte";
  import { push } from "svelte-spa-router";
  import {
    user,
    downloadQuality,
    downloads,
    downloadsSize,
    playCacheLimit,
    playCacheSize,
    prefetchEnabled,
    offlineOnlyDownloaded,
    toasts,
  } from "../lib/stores.js";
  import { api } from "../lib/api.js";
  import { listDownloads, removeTrack, clearAll } from "../lib/offline.js";
  import { clearPlayCache, enforce } from "../lib/playcache.js";
  import { bytes as fmtBytes, duration as fmtDuration, artistLine } from "../lib/format.js";
  import { logsEnabled, logCount, clearLog, downloadLog, copyLog } from "../lib/log.js";
  import Icon from "../components/Icon.svelte";
  import Cover from "../components/Cover.svelte";
  import AudioEffects from "../components/AudioEffects.svelte";

  const QUALITIES = [
    { id: "FLAC", label: "FLAC", hint: "Sans perte — lourd" },
    { id: "OPUS_320", label: "Opus 320", hint: "Haute qualité (recommandé)" },
    { id: "OPUS_256", label: "Opus 256", hint: "Haute qualité" },
    { id: "OPUS_192", label: "Opus 192", hint: "Bon compromis" },
    { id: "OPUS_128", label: "Opus 128", hint: "Standard, léger" },
    { id: "OPUS_64", label: "Opus 64", hint: "Données réduites" },
  ];
  // Size caps for the playback cache (the prefetch buffer, not downloads).
  const CACHE_LIMITS = [
    { v: 256 * 1024 ** 2, label: "256 Mo" },
    { v: 512 * 1024 ** 2, label: "512 Mo" },
    { v: 1 * 1024 ** 3, label: "1 Go" },
    { v: 2 * 1024 ** 3, label: "2 Go" },
    { v: 4 * 1024 ** 3, label: "4 Go" },
  ];

  // The page had grown into one long scroll, so it's split into tabs. Sound
  // effects lead because they're what gets tweaked most often outside the
  // player; quality/storage and account sit behind their own tabs.
  const TABS = [
    { id: "fx", label: "Effets sonores" },
    { id: "quality", label: "Qualité sonore" },
    { id: "account", label: "Compte" },
  ];
  let tab = "fx";

  // -- diagnostic log ---------------------------------------------------------
  // The count is re-read whenever the panel could have changed, rather than
  // subscribed to: the logger is deliberately a plain module (no store on the
  // hot path) so that logging costs one boolean read when it is switched off.
  let logLines = logCount();
  let copied = false;
  $: if ($logsEnabled !== undefined) logLines = logCount();
  function saveLog() {
    if (!downloadLog()) toasts.push("Téléchargement refusé par le navigateur", "error");
  }
  async function copyLogToClipboard() {
    copied = await copyLog();
    toasts.push(copied ? "Journal copié" : "Copie impossible", copied ? undefined : "error");
    if (copied) setTimeout(() => (copied = false), 2000);
  }
  function wipeLog() {
    clearLog();
    logLines = 0;
  }

  let items = [];
  async function refresh() {
    items = await listDownloads();
  }
  onMount(refresh);

  // Admin-only: per-user upload quota (GB) applied to non-admin accounts.
  let quotaGb = null;
  let quotaSaving = false;
  onMount(async () => {
    if (!$user?.admin) return;
    try {
      quotaGb = (await api.getSettings()).upload_quota_gb;
    } catch {
      /* leave the card hidden if it can't load */
    }
  });
  async function saveQuota() {
    const v = Number(quotaGb);
    if (!Number.isFinite(v) || v < 0) {
      toasts.push("Valeur de quota invalide", "error");
      return;
    }
    quotaSaving = true;
    try {
      quotaGb = (await api.setSettings({ upload_quota_gb: v })).upload_quota_gb;
      toasts.push(v === 0 ? "Quota d'upload désactivé (illimité)" : `Quota d'upload réglé à ${quotaGb} Go`);
    } catch {
      toasts.push("Échec de l'enregistrement du quota", "error");
    } finally {
      quotaSaving = false;
    }
  }
  // Reload the list whenever the downloaded set changes (add / remove).
  $: $downloads, refresh();

  $: qualityLabel = (id) => QUALITIES.find((q) => q.id === id)?.label || id;
  $: cachePct = $playCacheLimit ? Math.min(100, ($playCacheSize / $playCacheLimit) * 100) : 0;

  function setCacheLimit(v) {
    playCacheLimit.set(v);
    enforce(v); // lowering the cap trims the cache right away
  }
  async function wipeCache() {
    await clearPlayCache();
    toasts.push("Cache de lecture vidé");
  }

  async function remove(id, title) {
    await removeTrack(id);
    toasts.push(`« ${title} » retiré des téléchargements`);
  }
  async function wipe() {
    if (!items.length) return;
    if (!window.confirm("Supprimer tous les titres téléchargés ?")) return;
    await clearAll();
    toasts.push("Téléchargements supprimés");
  }

  // The sidebar (desktop) is the usual logout entry point, but it's hidden on
  // phones — so Settings carries the only mobile-reachable Déconnexion.
  async function logout() {
    try {
      await api.logout();
    } catch {
      /* ignore — clear the local session regardless */
    }
    user.set(null);
  }
</script>

<div class="head">
  <h1>Réglages</h1>
</div>

<div class="tabs" role="tablist" aria-label="Sections des réglages">
  {#each TABS as t}
    <button class="tab" class:sel={tab === t.id} role="tab" aria-selected={tab === t.id} on:click={() => (tab = t.id)}>{t.label}</button>
  {/each}
</div>

{#if tab === "fx"}
  <AudioEffects />
{/if}

{#if tab === "quality"}
<section class="card">
  <h2>Qualité de téléchargement par défaut</h2>
  <p class="muted sub">Utilisée pour les nouveaux téléchargements (modifiable au cas par cas).</p>
  <div class="quality">
    {#each QUALITIES as q}
      <button class="q" class:sel={$downloadQuality === q.id} on:click={() => downloadQuality.set(q.id)}>
        <span class="qn">{q.label}</span>
        <span class="qh muted">{q.hint}</span>
        {#if $downloadQuality === q.id}<span class="tick"><Icon name="check" size={16} /></span>{/if}
      </button>
    {/each}
  </div>
</section>

<section class="card">
  <h2>Stockage des téléchargements</h2>
  <p class="muted sub">Vos téléchargements sont permanents : ils restent disponibles hors-ligne jusqu'à ce que vous les retiriez vous-même. Ce n'est pas un cache — rien n'est supprimé automatiquement.</p>

  <div class="gauge-txt">
    <span><strong>{fmtBytes($downloadsSize)}</strong> utilisés sur cet appareil</span>
    <span class="muted">{items.length} titre{items.length > 1 ? "s" : ""}</span>
  </div>

  <button class="toggle" role="switch" aria-checked={$offlineOnlyDownloaded} on:click={() => offlineOnlyDownloaded.set(!$offlineOnlyDownloaded)}>
    <span class="tg-txt">
      <span class="tg-title">Hors-ligne : ne lire que les titres téléchargés</span>
      <span class="tg-hint muted">Lancer une playlist hors-ligne ne met en file que ce qui est dispo sur l'appareil, sans sauter les manquants. Désactivez pour tenter de tout lire.</span>
    </span>
    <span class="sw" class:on={$offlineOnlyDownloaded}><span class="knob"></span></span>
  </button>
</section>

<section class="card">
  <div class="dl-head">
    <h2>Cache de lecture</h2>
    {#if $playCacheSize > 0}
      <button class="wipe" on:click={wipeCache}><Icon name="trash" size={16} /> Vider</button>
    {/if}
  </div>
  <p class="muted sub">Pendant la lecture, le titre suivant est préchargé ici (audio + pochette). La lecture est vérifiée d'abord en local, donc une coupure réseau ne l'interrompt pas. C'est un cache : les plus anciens sont supprimés automatiquement au-delà de la limite.</p>

  <button class="toggle" role="switch" aria-checked={$prefetchEnabled} on:click={() => prefetchEnabled.set(!$prefetchEnabled)}>
    <span class="tg-txt">
      <span class="tg-title">Précharger le titre suivant</span>
      <span class="tg-hint muted">Désactivez pour économiser les données mobiles.</span>
    </span>
    <span class="sw" class:on={$prefetchEnabled}><span class="knob"></span></span>
  </button>

  <div class="gauge">
    <div class="bar"><span style={`width:${cachePct}%`} class:warn={cachePct > 90}></span></div>
    <div class="gauge-txt">
      <span>{fmtBytes($playCacheSize)} en cache</span>
      <span class="muted">limite {fmtBytes($playCacheLimit)}</span>
    </div>
  </div>

  <div class="limits">
    {#each CACHE_LIMITS as l}
      <button class="lim" class:sel={$playCacheLimit === l.v} on:click={() => setCacheLimit(l.v)}>{l.label}</button>
    {/each}
  </div>
</section>

<section class="card">
  <div class="dl-head">
    <h2>Titres téléchargés <span class="count muted">({items.length})</span></h2>
    {#if items.length}
      <button class="wipe" on:click={wipe}><Icon name="trash" size={16} /> Tout effacer</button>
    {/if}
  </div>

  {#if !items.length}
    <p class="muted hint">Aucun titre téléchargé. Utilisez le bouton de téléchargement sur un titre, un album ou une playlist pour les rendre disponibles hors-ligne.</p>
  {:else}
    <div class="list">
      {#each items as m (m.id)}
        <div class="row">
          <div class="thumb"><Cover src={m.track?.album?.cover} alt={m.track?.title} size={40} kind="track" fallbackId={m.track?.deezer_id} /></div>
          <div class="meta">
            <div class="t">{m.track?.title}</div>
            <div class="a muted">{artistLine(m.track)}</div>
          </div>
          <span class="q-badge">{qualityLabel(m.quality)}</span>
          <span class="sz muted">{fmtBytes(m.size)}</span>
          <button class="rm" on:click={() => remove(m.id, m.track?.title)} aria-label="Retirer" title="Retirer du cache"><Icon name="trash" size={17} /></button>
        </div>
      {/each}
    </div>
  {/if}
</section>
{/if}

{#if tab === "account"}
<section class="card">
  <h2>Compte</h2>
  <div class="acct">
    <div class="acct-info">
      <span class="acct-name">{$user?.name}</span>
      <span class="muted acct-sub">{$user?.admin ? "Administrateur" : "Utilisateur"}</span>
    </div>
    <button class="logout" on:click={logout}><Icon name="user" size={16} /> Déconnexion</button>
  </div>
</section>

{#if $user?.admin && quotaGb !== null}
  <section class="card">
    <h2>Quota d'upload (utilisateurs non-admin)</h2>
    <p class="muted sub">Limite l'espace total que chaque utilisateur non-administrateur peut occuper avec ses fichiers importés. Les administrateurs ne sont pas limités. Mettez 0 pour désactiver la limite.</p>
    <div class="quota-row">
      <input class="quota-input" type="number" min="0" step="1" bind:value={quotaGb} />
      <span class="muted">Go / utilisateur</span>
      <button class="save" on:click={saveQuota} disabled={quotaSaving}>
        {quotaSaving ? "Enregistrement…" : "Enregistrer"}
      </button>
    </div>
  </section>
{/if}

<section class="card">
  <h2>Diagnostic</h2>
  <p class="muted sub">
    Enregistre ce que fait l'application (lecture, reprise de session, erreurs
    audio) dans un journal local, à joindre à un rapport de bug. Désactivé par
    défaut&nbsp;: rien n'est enregistré ni envoyé tant que vous ne l'activez pas,
    et le journal ne quitte jamais l'appareil.
  </p>
  <label class="dbg-toggle">
    <input type="checkbox" checked={$logsEnabled} on:change={(e) => logsEnabled.set(e.target.checked)} />
    <span>Enregistrer le journal</span>
  </label>
  {#if $logsEnabled}
    <p class="muted sub logline">
      {logLines} ligne{logLines > 1 ? "s" : ""} enregistrée{logLines > 1 ? "s" : ""}.
      Le journal survit à la fermeture de l'application&nbsp;: reproduisez le
      problème, puis revenez ici le récupérer.
    </p>
    <div class="logbtns">
      <button class="save" on:click={saveLog} disabled={!logLines}>
        <Icon name="download" size={16} /> Télécharger (.txt)
      </button>
      <button class="ghost" on:click={copyLogToClipboard} disabled={!logLines}>
        <Icon name="share" size={16} /> {copied ? "Copié" : "Copier"}
      </button>
      <button class="ghost" on:click={wipeLog} disabled={!logLines}>
        <Icon name="trash" size={16} /> Vider
      </button>
    </div>
  {/if}
</section>
{/if}

<style>
  .head h1 {
    margin-bottom: 18px;
  }
  .tabs {
    display: flex;
    gap: 8px;
    margin-bottom: 18px;
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
    scrollbar-width: none;
  }
  .tabs::-webkit-scrollbar {
    display: none;
  }
  .tab {
    flex: none;
    padding: 9px 16px;
    border-radius: 999px;
    background: var(--bg-card);
    border: 1px solid var(--bg-hover);
    color: var(--text-dim);
    font-weight: 600;
    font-size: 0.9rem;
    white-space: nowrap;
  }
  .tab:hover {
    color: var(--text);
  }
  .tab.sel {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
  }
  .acct {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }
  .acct-info {
    display: flex;
    flex-direction: column;
  }
  .acct-name {
    font-weight: 700;
  }
  .acct-sub {
    font-size: 0.82rem;
  }
  .logout {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 9px 15px;
    border-radius: 999px;
    background: var(--bg);
    border: 1px solid var(--bg-hover);
    color: var(--text);
    font-weight: 600;
    font-size: 0.9rem;
  }
  .logout:hover {
    border-color: var(--accent-2);
    color: var(--accent-2);
  }
  .card {
    background: var(--bg-card);
    border-radius: var(--radius);
    padding: 18px 20px;
    margin-bottom: 18px;
  }
  .card h2 {
    font-size: 1.05rem;
  }
  .quota-row {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
  }
  .quota-input {
    width: 90px;
    padding: 9px 12px;
    border-radius: 10px;
    border: 1px solid var(--bg-hover);
    background: var(--bg);
    color: var(--text);
    font-weight: 600;
    font-size: 0.95rem;
  }
  .save {
    padding: 9px 16px;
    border-radius: 999px;
    background: var(--accent);
    color: #fff;
    font-weight: 600;
    font-size: 0.9rem;
  }
  .save:disabled {
    opacity: 0.6;
    cursor: default;
  }
  .sub {
    font-size: 0.85rem;
    margin: 4px 0 14px;
  }
  .dbg-toggle {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    cursor: pointer;
    font-weight: 600;
    user-select: none;
  }
  .dbg-toggle input {
    width: 18px;
    height: 18px;
    accent-color: var(--accent);
    cursor: pointer;
  }
  .logline {
    margin: 14px 0 12px;
  }
  .logbtns {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
  }
  .logbtns .save,
  .ghost {
    display: inline-flex;
    align-items: center;
    gap: 7px;
  }
  .ghost {
    padding: 9px 16px;
    border-radius: 999px;
    border: 1px solid var(--bg-hover);
    color: var(--text-dim);
    font-weight: 600;
    font-size: 0.9rem;
  }
  .ghost:hover:not(:disabled) {
    color: var(--text);
    border-color: var(--text-dim);
  }
  .ghost:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .quality {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    gap: 8px;
  }
  .q {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 1px;
    padding: 10px 12px;
    border-radius: 10px;
    border: 1px solid var(--bg-hover);
    background: var(--bg);
    position: relative;
    text-align: left;
  }
  .q.sel {
    border-color: var(--accent);
  }
  .qn {
    font-weight: 700;
  }
  .qh {
    font-size: 0.72rem;
  }
  .tick {
    position: absolute;
    top: 10px;
    right: 10px;
    color: var(--accent);
  }
  .gauge {
    margin-bottom: 14px;
  }
  .bar {
    height: 8px;
    border-radius: 4px;
    background: var(--bg-hover);
    overflow: hidden;
  }
  .bar span {
    display: block;
    height: 100%;
    background: var(--accent);
    transition: width 0.25s ease;
  }
  .bar span.warn {
    background: var(--accent-2);
  }
  .gauge-txt {
    display: flex;
    justify-content: space-between;
    font-size: 0.85rem;
    margin-top: 6px;
  }
  .limits {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .lim {
    padding: 7px 14px;
    border-radius: 999px;
    background: var(--bg);
    border: 1px solid var(--bg-hover);
    color: var(--text-dim);
    font-weight: 600;
    font-size: 0.85rem;
  }
  .lim.sel {
    background: #fff;
    color: #111;
    border-color: #fff;
  }
  .toggle {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    width: 100%;
    text-align: left;
    padding: 4px 0 16px;
  }
  .tg-txt {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .tg-title {
    font-weight: 600;
  }
  .tg-hint {
    font-size: 0.78rem;
  }
  .sw {
    flex: none;
    width: 44px;
    height: 26px;
    border-radius: 999px;
    background: var(--bg-hover);
    position: relative;
    transition: background 0.15s ease;
  }
  .sw.on {
    background: var(--accent);
  }
  .knob {
    position: absolute;
    top: 3px;
    left: 3px;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: #fff;
    transition: transform 0.15s ease;
  }
  .sw.on .knob {
    transform: translateX(18px);
  }
  .dl-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }
  .count {
    font-weight: 400;
    font-size: 0.9rem;
  }
  .wipe {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--text-dim);
    font-size: 0.85rem;
  }
  .wipe:hover {
    color: var(--accent-2);
  }
  .hint {
    margin-top: 8px;
  }
  .list {
    display: flex;
    flex-direction: column;
    margin-top: 8px;
  }
  .row {
    display: grid;
    grid-template-columns: 40px 1fr auto auto 32px;
    align-items: center;
    gap: 12px;
    padding: 6px 4px;
    border-radius: 8px;
  }
  .row:hover {
    background: var(--bg-hover);
  }
  .thumb {
    width: 40px;
  }
  .meta {
    min-width: 0;
  }
  .t {
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .a {
    font-size: 0.82rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .q-badge {
    font-size: 0.72rem;
    font-weight: 700;
    color: var(--text-dim);
    border: 1px solid var(--bg-hover);
    border-radius: 6px;
    padding: 2px 7px;
  }
  .sz {
    font-size: 0.82rem;
    font-variant-numeric: tabular-nums;
  }
  .rm {
    color: var(--text-dim);
    display: flex;
    justify-content: center;
  }
  .rm:hover {
    color: var(--accent-2);
  }
</style>
