<script>
  // Réglages → Sources → Ordre des sources: the main source, then the
  // fallbacks in the order they are asked (server: webui/sourcesapi.py, the
  // rules in providers/registry.py). Everybody sees it; the admin changes it.
  // Every other screen reads the names and places from lib/sources.js, so
  // what is chosen here is what they say at once.
  import { onMount } from "svelte";
  import { failureCause } from "../lib/api.js";
  import { iconOf, loadSources, saveSources } from "../lib/sources.js";
  import { toasts } from "../lib/stores.js";
  import Icon from "./Icon.svelte";

  let data = null;
  let failed = "";
  let saving = false;

  async function load() {
    try {
      data = await loadSources();
      failed = "";
    } catch (e) {
      if (!data) failed = failureCause(e) || "cause inconnue";
    }
  }
  onMount(load);

  $: list = data?.sources || [];
  $: admin = !!data?.admin;
  $: main = list.find((s) => s.place === "main") || null;
  $: fallbacks = list.filter((s) => s.place === "fallback").sort((a, b) => a.rank - b.rank);
  $: off = list.filter((s) => s.place === "off");
  $: rows = [...(main ? [main] : []), ...fallbacks, ...off];
  // The sources that can lead (a whole catalogue) and are ready to.
  $: leaders = list.filter((s) => s.can_lead && s.configured && s.enabled);

  // Best quality first; equal notes keep their order (Array.sort is stable).
  const better = (a, b) => b.quality.class - a.quality.class || b.quality.kbps - a.quality.kbps;
  $: byQuality = fallbacks.slice().sort(better);
  $: inQualityOrder = byQuality.every((s, i) => s.id === fallbacks[i]?.id);

  // The sources as they will be once `lead` and `fbs` are saved: drawn at
  // once, the server's answer replaces it (or the old one comes back).
  function arranged(lead, fbs) {
    const at = new Map(fbs.map((s, i) => [s.id, i + 1]));
    return {
      ...data,
      main: lead?.id || null,
      sources: list.map((s) =>
        lead && s.id === lead.id
          ? { ...s, place: "main", rank: 0 }
          : at.has(s.id)
            ? { ...s, place: "fallback", rank: at.get(s.id) }
            : s
      ),
    };
  }
  const orderOf = (lead, fbs) => [...(lead ? [lead.id] : []), ...fbs.map((s) => s.id), ...off.map((s) => s.id)];

  async function save(change, preview) {
    if (saving || !admin) return;
    saving = true;
    const before = data;
    if (preview) data = preview;
    try {
      data = await saveSources(change);
    } catch (e) {
      data = before;
      toasts.push(e?.message || "Ordre non enregistré", "error");
    }
    saving = false;
  }

  function move(i, step) {
    const fbs = fallbacks.slice();
    const j = i + step;
    if (j < 0 || j >= fbs.length) return;
    [fbs[i], fbs[j]] = [fbs[j], fbs[i]];
    save({ order: orderOf(main, fbs) }, arranged(main, fbs));
  }

  function byBestQuality() {
    save({ order: orderOf(main, byQuality) }, arranged(main, byQuality));
  }

  function lead(s) {
    if (!main || s.id === main.id) return;
    // The old main becomes the first fallback: it still has its catalogue.
    const fbs = [main, ...fallbacks.filter((x) => x.id !== s.id)];
    save({ order: orderOf(s, fbs) }, arranged(s, fbs));
  }

  function toggle(s) {
    const on = !s.enabled;
    const preview = { ...data, sources: list.map((x) => (x.id === s.id ? { ...x, enabled: on } : x)) };
    save({ enabled: { [s.id]: on } }, preview);
  }

  const names = (xs) =>
    xs.length <= 1 ? xs.map((x) => x.name).join("") : `${xs.slice(0, -1).map((x) => x.name).join(", ")} et ${xs[xs.length - 1].name}`;

  function placeLabel(s) {
    if (s.place === "main") return "Principale";
    if (s.place === "fallback") return `Secours ${s.rank}`;
    return s.configured ? "Coupée" : "Indisponible";
  }

  function statusLine(s) {
    if (!s.configured) return s.setup || "Pas encore configurée sur ce serveur.";
    if (s.resting)
      return `A refusé ou n'a pas répondu : laissée tranquille encore ${Math.max(1, Math.ceil(s.resting / 60))} min.`;
    if (s.place === "main") return "Recherche, pages et musique. Toujours interrogée en premier.";
    if (s.place === "fallback") {
      const before = [...(main ? [main] : []), ...fallbacks.filter((x) => x.rank < s.rank)];
      const verb = before.length > 1 ? "n'ont" : "n'a";
      return before.length ? `Interrogée quand ${names(before)} ${verb} pas un titre.` : "Interrogée quand aucune autre source n'a un titre.";
    }
    return "Coupée : ce qui en est déjà archivé reste lisible.";
  }

  const qualityText = (q) => (q?.label ? `${q.label}${q.lossless ? " · sans perte" : ""}` : "");
</script>

<section class="card">
  <h2>Ordre des sources</h2>
  <p class="muted sub">
    La source principale sert la recherche, les pages et la musique. Quand elle n'a pas un
    titre, les sources de secours sont interrogées dans l'ordre ci-dessous. Entre deux
    propositions aussi proches d'un titre, la meilleure qualité passe devant&nbsp;; à qualité
    égale, cet ordre départage. Ce qui est déjà archivé reste lisible quoi qu'il arrive.
  </p>

  {#if failed}
    <p class="muted" role="alert">Impossible de lire les sources&nbsp;: {failed}. <button class="link" on:click={load}>Réessayer</button></p>
  {:else if !data}
    <p class="muted">Chargement…</p>
  {:else if !list.length}
    <p class="muted">Aucune source de musique n'est installée sur ce serveur&nbsp;: seule la bibliothèque est lisible.</p>
  {:else}
    {#if admin && leaders.length > 1}
      <div class="lead">
        <span class="cap muted" id="lead-cap">Source principale</span>
        <div class="seg" role="radiogroup" aria-labelledby="lead-cap">
          {#each leaders as s (s.id)}
            <button type="button" role="radio" class="opt" class:sel={s.place === "main"} aria-checked={s.place === "main"}
              disabled={saving} on:click={() => lead(s)}>
              <Icon name={iconOf(s.id)} size={15} /><span>{s.name}</span>
            </button>
          {/each}
        </div>
      </div>
    {/if}

    <ol class="rows">
      {#each rows as s (s.id)}
        {@const fi = fallbacks.indexOf(s)}
        <li class="src" class:main={s.place === "main"} class:off={s.place === "off"}>
          <span class="pos" class:accent={s.place === "main"}>{placeLabel(s)}</span>
          <span class="glyph"><Icon name={iconOf(s.id)} size={18} /></span>
          <span class="txt">
            <span class="nm">
              {s.name}
              {#if qualityText(s.quality)}<span class="q" class:ll={s.quality.lossless}>{qualityText(s.quality)}</span>{/if}
            </span>
            <span class="muted st" class:warn={!s.configured || s.resting}>{statusLine(s)}</span>
          </span>
          {#if admin}
            <span class="ctl">
              {#if s.place === "fallback" && fallbacks.length > 1}
                <button class="arrow" disabled={saving || fi === 0} on:click={() => move(fi, -1)}
                  aria-label="Monter {s.name}" title="Interroger plus tôt"><Icon name="chevronUp" size={18} /></button>
                <button class="arrow" disabled={saving || fi === fallbacks.length - 1} on:click={() => move(fi, 1)}
                  aria-label="Descendre {s.name}" title="Interroger plus tard"><Icon name="chevronDown" size={18} /></button>
              {/if}
              {#if s.switchable}
                <button class="sw" class:on={s.enabled} role="switch" aria-checked={s.enabled}
                  aria-label="{s.enabled ? 'Couper' : 'Activer'} {s.name}"
                  disabled={saving || !s.configured} on:click={() => toggle(s)}><span class="knob"></span></button>
              {/if}
            </span>
          {/if}
        </li>
      {/each}
    </ol>

    {#if admin && fallbacks.length > 1 && !inQualityOrder}
      <button class="ghost-btn" disabled={saving} on:click={byBestQuality}>
        <Icon name="sort" size={16} /> Classer les secours par qualité
      </button>
    {/if}
    {#if !admin}
      <p class="fine muted">Réglé par l'administrateur du serveur.</p>
    {/if}
  {/if}
</section>

<style>
  .card {
    background: var(--bg-card);
    border-radius: var(--radius);
    padding: 20px;
    margin-bottom: 18px;
  }
  .card h2 {
    margin-top: 0;
    font-size: 1.05rem;
  }
  .sub {
    font-size: 0.85rem;
    line-height: 1.5;
    margin: 4px 0 14px;
  }
  .fine {
    font-size: 0.78rem;
    line-height: 1.5;
    margin: 10px 0 0;
  }
  .link {
    color: var(--accent);
    font-weight: 600;
  }
  .lead {
    margin: 0 0 14px;
  }
  .cap {
    display: block;
    font-size: 0.72rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 8px;
  }
  .seg {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .opt {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    min-height: 40px;
    padding: 0 14px;
    border-radius: 999px;
    background: var(--bg);
    border: 1px solid var(--bg-hover);
    color: var(--text-dim);
    font-weight: 600;
    font-size: 0.85rem;
  }
  .opt.sel {
    background: #fff;
    color: #111;
    border-color: #fff;
  }
  .rows {
    list-style: none;
    margin: 0 0 12px;
    padding: 0;
  }
  .src {
    display: grid;
    grid-template-columns: 84px 36px minmax(0, 1fr) auto;
    align-items: center;
    gap: 12px;
    padding: 12px 0;
    border-top: 1px solid var(--bg-hover);
  }
  .src:first-child {
    border-top: none;
    padding-top: 2px;
  }
  .src.off .glyph,
  .src.off .nm {
    opacity: 0.55;
  }
  .pos {
    font-size: 0.68rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-dim);
    border: 1px solid var(--bg-hover);
    border-radius: 6px;
    padding: 3px 6px;
    text-align: center;
    white-space: nowrap;
  }
  .pos.accent {
    color: var(--accent);
    border-color: color-mix(in srgb, var(--accent) 45%, transparent);
    background: color-mix(in srgb, var(--accent) 10%, transparent);
  }
  .glyph {
    width: 36px;
    height: 36px;
    border-radius: 10px;
    display: grid;
    place-items: center;
    background: var(--bg-hover);
    color: var(--accent);
  }
  .txt {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .nm {
    font-weight: 600;
    display: inline-flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
  }
  .q {
    font-size: 0.7rem;
    font-weight: 700;
    color: var(--text-dim);
    background: var(--bg-hover);
    border-radius: 5px;
    padding: 2px 6px;
  }
  .q.ll {
    color: var(--accent);
    background: color-mix(in srgb, var(--accent) 12%, transparent);
  }
  .st {
    font-size: 0.8rem;
    line-height: 1.4;
  }
  .st.warn {
    color: #ff8a65;
  }
  .ctl {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
  .arrow {
    width: 40px;
    height: 40px;
    border-radius: 10px;
    display: grid;
    place-items: center;
    color: var(--text-dim);
  }
  .arrow:hover:not(:disabled) {
    background: var(--bg-hover);
    color: var(--text);
  }
  .arrow:disabled {
    opacity: 0.3;
  }
  .sw {
    flex: none;
    margin-left: 6px;
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
  .sw:disabled {
    opacity: 0.45;
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
  .ghost-btn {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 8px 15px;
    min-height: 40px;
    border-radius: 999px;
    border: 1px solid var(--bg-hover);
    color: var(--text-dim);
    font-weight: 600;
    font-size: 0.85rem;
  }
  .ghost-btn:hover:not(:disabled) {
    color: var(--text);
    border-color: var(--text-dim);
  }
  /* A phone: the place and the controls share the top line, so the name and
     what the source does get the whole width below. */
  @media (max-width: 560px) {
    .src {
      grid-template-columns: 36px minmax(0, 1fr) auto;
      grid-template-areas: "pos pos ctl" "glyph txt txt";
      row-gap: 6px;
    }
    .ctl {
      justify-self: end;
    }
    .pos {
      grid-area: pos;
      justify-self: start;
    }
    .glyph {
      grid-area: glyph;
    }
    .txt {
      grid-area: txt;
    }
    .ctl {
      grid-area: ctl;
    }
  }
</style>
