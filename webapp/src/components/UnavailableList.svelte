<script>
  // The library's "Indisponibles" list, made for clearing it out.
  //
  // Two ways to get through it faster than one sheet per track:
  // - TICK SEVERAL and delete them in one go. The server re-checks every one
  //   against both sources at the moment it goes (exactly like a single
  //   deletion), and keeps — and says so — whichever turns out to be playable.
  // - On a desktop, each row shows the SAFEST STAND-INS inline (same song, same
  //   artist, same version, about the same length: `?best=2`), so a swap is one
  //   click. Anything less certain stays behind "Autres choix", in the sheet,
  //   where it can be auditioned first. Fetched only for the rows on screen,
  //   two at a time: a 300-row list is not 300 Deezer searches on open.
  import { onDestroy, onMount } from "svelte";
  import { api } from "../lib/api.js";
  import { CAN_KEEP } from "../lib/remote/mode.js";
  import { openReplace, toasts, clearUnavailable, unavailableChanged } from "../lib/stores.js";
  import { invalidatePlaylists, loadFavorites } from "../lib/actions.js";
  import { previewing, togglePreview, applyReplacement, pollJob } from "../lib/replace.js";
  import { artistLine, duration as fmtDuration } from "../lib/format.js";
  import Cover from "./Cover.svelte";
  import Icon from "./Icon.svelte";

  /** The unavailable tracks; rows dealt with here are dropped from it. */
  export let tracks = [];

  const idOf = (t) => String(t.deezer_id);

  // -- desktop: inline suggestions ---------------------------------------------
  const DESKTOP = "(min-width: 1000px) and (hover: hover) and (pointer: fine)";
  let desktop = false;
  let mq = null;
  const onMq = () => (desktop = mq.matches);
  onMount(() => {
    if (!window.matchMedia) return;
    mq = window.matchMedia(DESKTOP);
    desktop = mq.matches;
    mq.addEventListener?.("change", onMq);
  });

  // id → candidates[] | "loading" | "error". Kept for the page's life: the
  // tab is left and re-entered, and the answer has not changed.
  const sugg = new Map();
  let suggVersion = 0;
  const waiting = [];
  let inFlight = 0;
  let destroyed = false;
  const MAX_IN_FLIGHT = 2;

  function want(id) {
    if (!CAN_KEEP || sugg.has(id)) return;
    sugg.set(id, "loading");
    suggVersion++;
    waiting.push(id);
    pump();
  }

  function pump() {
    while (!destroyed && inFlight < MAX_IN_FLIGHT && waiting.length) {
      const id = waiting.shift();
      inFlight++;
      api
        .bestReplacements(id)
        .then((r) => sugg.set(id, r.candidates || []))
        .catch(() => sugg.set(id, "error"))
        .finally(() => {
          inFlight--;
          suggVersion++;
          pump();
        });
    }
  }

  // One observer for every row: a row asks for its suggestions the first time
  // it comes near the viewport, and never again.
  let io = null;
  function visible(node, id) {
    if (typeof IntersectionObserver === "undefined") {
      want(id);
      return {};
    }
    io ??= new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          io.unobserve(e.target);
          want(e.target.dataset.id);
        }
      },
      { rootMargin: "200px 0px" }
    );
    node.dataset.id = id;
    io.observe(node);
    return {
      destroy() {
        io?.unobserve(node);
      },
    };
  }

  onDestroy(() => {
    destroyed = true;
    io?.disconnect();
    mq?.removeEventListener?.("change", onMq);
  });

  // Rows being acted on: id → "replace" | "delete".
  let pending = new Map();
  function setPending(ids, what) {
    for (const id of ids) what ? pending.set(id, what) : pending.delete(id);
    pending = pending;
  }

  async function pick(t, c) {
    const id = idOf(t);
    if (pending.has(id)) return;
    setPending([id], "replace");
    const ok = await applyReplacement(t, c);
    setPending([id], null);
    if (ok) drop([id]);
  }

  function drop(ids) {
    const gone = new Set(ids);
    tracks = tracks.filter((t) => !gone.has(idOf(t)));
    let changed = false;
    for (const id of ids) changed = selected.delete(id) || changed;
    if (changed) selected = selected;
  }

  // -- selection -----------------------------------------------------------------
  let selected = new Set();
  let anchor = null; // the index a shift-click extends from

  // A refetched list may have lost rows: a selection never outlives its row.
  $: {
    const ids = new Set(tracks.map(idOf));
    let changed = false;
    for (const id of selected) if (!ids.has(id)) changed = selected.delete(id) || changed;
    if (changed) selected = selected;
  }

  $: count = selected.size;
  $: allOn = tracks.length > 0 && count === tracks.length;

  function toggle(i, e) {
    const id = idOf(tracks[i]);
    const on = !selected.has(id);
    if (e?.shiftKey && anchor !== null && anchor < tracks.length) {
      const [a, b] = anchor < i ? [anchor, i] : [i, anchor];
      for (let k = a; k <= b; k++) {
        const kid = idOf(tracks[k]);
        if (on) selected.add(kid);
        else selected.delete(kid);
      }
    } else if (on) selected.add(id);
    else selected.delete(id);
    anchor = i;
    selected = selected;
    confirming = false;
  }

  function toggleAll() {
    selected = allOn ? new Set() : new Set(tracks.map(idOf));
    anchor = null;
    confirming = false;
  }

  // -- bulk deletion -----------------------------------------------------------
  const CHUNK = 200; // the server's cap per request
  let confirming = false;
  let progress = null; // { done, total } while a deletion runs

  const KEPT_WHY = {
    archived: "archivé sur le serveur",
    playable: "de nouveau lisible sur Deezer",
  };

  async function deleteSelected() {
    if (!count || progress) return;
    if (!confirming) {
      confirming = true;
      return;
    }
    confirming = false;
    const ids = [...selected];
    setPending(ids, "delete");
    progress = { done: 0, total: ids.length };
    const deleted = [];
    const kept = [];
    let failed = 0;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const part = ids.slice(i, i + CHUNK);
      const base = i;
      try {
        const r = await api.deleteTracks(part);
        const s = await pollJob(r.job, (st) => {
          progress = { done: base + (st.done || 0), total: ids.length };
        }, { every: 700 });
        if (!s || !s.ok) {
          failed += part.length - (s?.deleted?.length || 0);
          deleted.push(...(s?.deleted || []));
          continue;
        }
        deleted.push(...s.deleted);
        kept.push(...s.kept);
        failed += (s.missing || []).length;
      } catch {
        failed += part.length;
      }
      progress = { done: Math.min(ids.length, base + part.length), total: ids.length };
    }
    setPending(ids, null);
    progress = null;

    for (const id of deleted) clearUnavailable(id);
    drop(deleted);
    // Kept ones are no longer selected either: they asked a question and got
    // an answer, and a second press must not silently retry them.
    selected = new Set();
    if (deleted.length) {
      invalidatePlaylists();
      loadFavorites(true);
      toasts.push(
        `${deleted.length} titre${deleted.length > 1 ? "s" : ""} retiré${deleted.length > 1 ? "s" : ""} de la bibliothèque`
      );
    }
    const playable = kept.filter((k) => KEPT_WHY[k.reason]);
    if (playable.length) {
      const why = KEPT_WHY[playable[0].reason];
      toasts.push(
        playable.length === 1
          ? `1 titre conservé : ${why}`
          : `${playable.length} titres conservés : ils sont en fait lisibles`
      );
    }
    const unsure = kept.length - playable.length + failed;
    if (unsure) {
      const off = kept.some((k) => k.reason === "no provider");
      toasts.push(
        `${unsure} titre${unsure > 1 ? "s" : ""} non supprimé${unsure > 1 ? "s" : ""} : ` +
          (off
            ? "le proxy Deezer est désactivé, impossible de vérifier qu'ils ont disparu"
            : "Deezer n'a pas pu confirmer qu'ils ont disparu, réessayez plus tard"),
        "error"
      );
    }
    // The truth, now that the server is done: verdicts it cleared on the way
    // (archived, playable) leave the list on the refetch.
    unavailableChanged();
  }
</script>

{#if CAN_KEEP}
  <div class="bar" class:sel={count > 0}>
    <button
      class="box"
      class:on={allOn}
      class:some={count > 0 && !allOn}
      on:click={toggleAll}
      disabled={!!progress}
      aria-label={allOn ? "Tout désélectionner" : "Tout sélectionner"}
      title={allOn ? "Tout désélectionner" : "Tout sélectionner"}>
      {#if allOn}<Icon name="check" size={14} />{:else if count}<Icon name="minus" size={14} />{/if}
    </button>
    {#if progress}
      <span class="bar-txt">Suppression… {progress.done} / {progress.total}</span>
      <span class="bar-prog"><span style={`width:${(progress.done / progress.total) * 100}%`}></span></span>
    {:else if count}
      <span class="bar-txt">{count} sélectionné{count > 1 ? "s" : ""}</span>
      <div class="bar-actions">
        {#if confirming}
          <button class="ghost" on:click={() => (confirming = false)}>Annuler</button>
        {/if}
        <button class="danger" class:armed={confirming} on:click={deleteSelected}>
          <Icon name="trash" size={16} />
          {confirming ? `Confirmer : supprimer ${count} titre${count > 1 ? "s" : ""}` : "Supprimer"}
        </button>
      </div>
    {:else}
      <span class="bar-txt muted">
        {tracks.length} titre{tracks.length > 1 ? "s" : ""}{desktop ? " · Maj+clic pour une plage" : ""}
      </span>
    {/if}
  </div>
  {#if confirming}
    <p class="muted confirm-note">
      Ils disparaîtront de vos playlists et de vos favoris. Le serveur vérifie
      chacun d'abord : un titre encore lisible quelque part est conservé.
    </p>
  {/if}
{/if}

<ul class="list" class:desktop class:view={!CAN_KEEP}>
  {#each tracks as t, i (idOf(t))}
    {@const id = idOf(t)}
    {@const s = (suggVersion, sugg.get(id))}
    <li class="row" class:checked={selected.has(id)} class:busy={pending.has(id)}>
      {#if CAN_KEEP}
        <button
          class="box"
          class:on={selected.has(id)}
          disabled={!!progress}
          on:click={(e) => toggle(i, e)}
          role="checkbox"
          aria-checked={selected.has(id)}
          aria-label={`Sélectionner « ${t.title} »`}>
          {#if selected.has(id)}<Icon name="check" size={14} />{/if}
        </button>
      {/if}
      <div class="thumb">
        <Cover src={t.album?.cover} alt={t.title} size={44} kind="track" fallbackId={t.deezer_id} />
      </div>
      <div class="meta">
        <div class="t">{t.title}</div>
        <div class="muted a">
          {artistLine(t)}{#if t.duration} · {fmtDuration(t.duration)}{/if}
          {#if t.playlists?.length}
            · dans {t.playlists.map((p) => p.title).join(", ")}
          {/if}
        </div>
      </div>

      {#if desktop && CAN_KEEP}
        <div class="sugs" use:visible={id}>
          {#if pending.get(id) === "replace"}
            <span class="sug-note">Remplacement…</span>
          {:else if pending.get(id) === "delete"}
            <span class="sug-note">Suppression…</span>
          {:else if s === "loading" || s === undefined}
            <span class="sug ghost-sug" aria-hidden="true"></span>
          {:else if Array.isArray(s) && s.length}
            {#each s as c (c.deezer_id)}
              <div class="sug" class:playing={$previewing === c.deezer_id}>
                <button
                  class="sug-prev"
                  on:click={() => togglePreview(c)}
                  aria-label={$previewing === c.deezer_id ? "Arrêter l'écoute" : "Écouter"}
                  title="Écouter avant de remplacer">
                  <Icon name={$previewing === c.deezer_id ? "pause" : "play"} size={13} />
                </button>
                <button
                  class="sug-main"
                  on:click={() => pick(t, c)}
                  title={`Remplacer par « ${c.title} » — ${artistLine(c)} · ${c.album?.title || ""}`}>
                  <span class="sug-txt">
                    <span class="sug-t">
                      {#if c.local}<span class="local" title="Fichier local"><Icon name="cloudOff" size={11} /></span>{/if}
                      {c.album?.title || c.title}
                    </span>
                    <span class="sug-s">{artistLine(c)}{#if c.duration} · {fmtDuration(c.duration)}{/if}</span>
                  </span>
                  <span class="sug-go"><Icon name="check" size={14} /><span class="sug-go-txt">Remplacer</span></span>
                </button>
              </div>
            {/each}
          {:else}
            <span class="sug-note">Pas de correspondance sûre</span>
          {/if}
        </div>
      {/if}

      <button class="more" disabled={pending.has(id)} on:click={() => openReplace(t)}>
        {#if desktop && Array.isArray(s) && s.length}
          Autres choix
        {:else}
          <Icon name="refresh" size={16} /> Remplacer
        {/if}
      </button>
    </li>
  {/each}
</ul>

<style>
  /* -- the selection bar ------------------------------------------------- */
  .bar {
    position: sticky;
    top: 0;
    z-index: 2;
    display: flex;
    align-items: center;
    gap: 12px;
    min-height: 52px;
    padding: 6px 8px;
    margin-bottom: 6px;
    border-radius: 12px;
    background: var(--bg);
    transition: background 0.15s ease;
  }
  .bar.sel {
    background: color-mix(in srgb, var(--accent) 10%, var(--bg-card));
  }
  .bar-txt {
    font-weight: 600;
    font-size: 0.9rem;
    font-variant-numeric: tabular-nums;
  }
  .bar-actions {
    margin-left: auto;
    display: flex;
    gap: 8px;
  }
  .bar-prog {
    flex: 1;
    max-width: 280px;
    height: 6px;
    border-radius: 3px;
    background: var(--bg-hover);
    overflow: hidden;
  }
  .bar-prog span {
    display: block;
    height: 100%;
    background: var(--accent);
    transition: width 0.3s ease;
  }
  .confirm-note {
    margin: -2px 8px 12px;
    font-size: 0.82rem;
    line-height: 1.4;
  }
  .ghost {
    padding: 9px 16px;
    border-radius: 999px;
    color: var(--text-dim);
    font-weight: 600;
    font-size: 0.88rem;
  }
  .ghost:hover {
    color: var(--text);
    background: var(--bg-hover);
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
    white-space: nowrap;
  }
  .danger:hover,
  .danger.armed {
    background: color-mix(in srgb, #e5484d 12%, transparent);
    border-color: #e5484d;
  }
  .danger.armed {
    background: #e5484d;
    color: #fff;
  }

  /* -- the checkbox: a 40px target around an 18px mark ------------------- */
  .box {
    position: relative;
    display: grid;
    place-items: center;
    flex: none;
    width: 40px;
    height: 40px;
    margin: -4px 0;
    border-radius: 10px;
    color: transparent;
  }
  .box::before {
    content: "";
    position: absolute;
    width: 18px;
    height: 18px;
    border-radius: 5px;
    border: 1.5px solid var(--text-dim);
    transition: background 0.12s ease, border-color 0.12s ease;
  }
  .box :global(svg) {
    position: relative;
  }
  .box:hover::before {
    border-color: var(--text);
  }
  .box.on,
  .box.some {
    color: #fff;
  }
  .box.on::before,
  .box.some::before {
    background: var(--accent);
    border-color: var(--accent);
  }
  .box:disabled {
    opacity: 0.5;
    cursor: default;
  }

  /* -- rows -------------------------------------------------------------- */
  .list {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .row {
    display: grid;
    grid-template-columns: auto 44px minmax(0, 1fr) auto;
    align-items: center;
    gap: 12px;
    padding: 8px;
    border-radius: 10px;
    /* A long list costs its rendering only where it is on screen. */
    content-visibility: auto;
    contain-intrinsic-size: auto 60px;
  }
  .list.desktop .row {
    grid-template-columns: auto 44px minmax(150px, 0.8fr) minmax(0, 2.4fr) auto;
    gap: 14px;
  }
  /* Read-only (a remote control below "full"): no box, no suggestions. */
  .list.view .row,
  .list.view.desktop .row {
    grid-template-columns: 44px minmax(0, 1fr) auto;
  }
  .row:hover {
    background: var(--bg-hover);
  }
  .row.checked {
    background: color-mix(in srgb, var(--accent) 9%, transparent);
  }
  .row.busy {
    opacity: 0.55;
    pointer-events: none;
  }
  .thumb {
    width: 44px;
    /* Dimmed, because this one is not music you can play right now. */
    opacity: 0.65;
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
  .more {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 8px 14px;
    border-radius: 999px;
    background: var(--bg-card);
    color: var(--text);
    font-weight: 600;
    font-size: 0.85rem;
    white-space: nowrap;
  }
  .more:hover:not(:disabled) {
    background: color-mix(in srgb, var(--text) 12%, var(--bg-card));
  }

  /* -- inline suggestions (desktop) ------------------------------------ */
  .sugs {
    display: flex;
    gap: 8px;
    min-width: 0;
    min-height: 48px;
    align-items: center;
  }
  .sug {
    position: relative;
    container-type: inline-size;
    flex: 1 1 0;
    min-width: 0;
    max-width: 340px;
    display: flex;
    align-items: center;
    height: 48px;
    border-radius: 12px;
    border: 1px solid var(--bg-hover);
    background: var(--bg-card);
    transition: border-color 0.15s ease, background 0.15s ease;
  }
  .sug:hover,
  .sug.playing {
    border-color: color-mix(in srgb, var(--accent) 60%, transparent);
  }
  .ghost-sug {
    max-width: 260px;
    border-color: transparent;
    background: linear-gradient(90deg, var(--bg-card) 0%, var(--bg-hover) 50%, var(--bg-card) 100%);
    background-size: 200% 100%;
    animation: shimmer 1.2s ease-in-out infinite;
  }
  @keyframes shimmer {
    to {
      background-position: -200% 0;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .ghost-sug {
      animation: none;
    }
  }
  .sug-prev {
    display: grid;
    place-items: center;
    flex: none;
    width: 30px;
    height: 30px;
    margin-left: 8px;
    border-radius: 50%;
    border: 1px solid var(--bg-hover);
    color: var(--text);
  }
  .sug-prev:hover,
  .sug.playing .sug-prev {
    border-color: var(--accent);
    color: var(--accent);
  }
  .sug-main {
    flex: 1;
    min-width: 0;
    height: 100%;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 0 8px 0 8px;
    border-radius: 0 12px 12px 0;
    text-align: left;
    color: var(--text);
  }
  .sug-txt {
    display: flex;
    flex-direction: column;
    min-width: 0;
    flex: 1;
    line-height: 1.25;
  }
  .sug-t {
    font-weight: 600;
    font-size: 0.84rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .sug-s {
    font-size: 0.76rem;
    color: var(--text-dim);
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
  /* The one-click affordance: always readable, lit on hover. */
  .sug-go {
    flex: none;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 6px 11px 6px 9px;
    border-radius: 999px;
    font-weight: 700;
    font-size: 0.76rem;
    color: var(--accent);
    background: color-mix(in srgb, var(--accent) 12%, transparent);
    transition: background 0.15s ease, color 0.15s ease;
  }
  .sug-main:hover .sug-go,
  .sug-main:focus-visible .sug-go {
    background: var(--accent);
    color: #fff;
  }
  /* A narrow chip keeps the words that tell two pressings apart (album,
     length) and lets the action shrink to its mark; the tooltip names it. */
  @container (max-width: 250px) {
    .sug-go {
      padding: 6px;
    }
    .sug-go-txt {
      display: none;
    }
  }
  .sug-note {
    font-size: 0.8rem;
    color: var(--text-dim);
  }
</style>
