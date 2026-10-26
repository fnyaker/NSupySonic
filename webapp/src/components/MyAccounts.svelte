<script>
  // Réglages → Sources → Mes comptes: the person's own Deezer / YouTube Music,
  // and what each brings into THEIR library (lot P2). Each item is imported
  // once; one unticked in the picker is never imported. Nothing is written to
  // the account. ONE account is the default platform: only its favourites are
  // synced every day. An import runs on the server; this screen only reads its
  // progress (which list, how many of how many) and says when it is done.
  import { onDestroy, onMount } from "svelte";
  import { api, failureCause } from "../lib/api.js";
  import { toasts } from "../lib/stores.js";
  import { invalidatePlaylists, loadFavorites } from "../lib/actions.js";
  import { nativeDeezerLogin, nativeDeezerLoginAvailable } from "../lib/nativeDeezer.js";
  import Icon from "./Icon.svelte";
  import AccountPicker from "./AccountPicker.svelte";

  const KIND_LABEL = {
    artists: "Artistes suivis",
    tracks: "Titres aimés",
    albums: "Albums",
    playlists: "Playlists",
  };
  const COUNT_LABEL = { artists: "artiste", tracks: "titre", albums: "album", playlists: "playlist" };

  let data = null;
  let failed = "";
  let busy = false;
  let linking = false; // the ARL form is open
  let arl = "";
  let picker = null; // account the picker is open on
  let poll = null;
  const native = nativeDeezerLoginAvailable();

  let watching = new Set(); // accounts seen running: their end is announced

  function adopt(next) {
    for (const a of next?.accounts || []) {
      if (a.running) watching.add(a.id);
      else if (watching.has(a.id)) {
        watching.delete(a.id);
        announce(a);
      }
    }
    data = next;
  }

  async function load() {
    try {
      adopt(await api.myAccounts());
      failed = "";
    } catch (e) {
      // Keep what is on screen: a poll lost on a weak link is not a failure
      // worth replacing the accounts with an error.
      if (!data) failed = failureCause(e) || "cause inconnue";
    }
    schedule();
  }

  // While an import runs, its progress is read every 1.5 s, and not at all
  // while the page is hidden (it carries on on the server either way).
  function schedule() {
    clearTimeout(poll);
    if (document.hidden) return;
    if (data?.accounts?.some((a) => a.running)) poll = setTimeout(load, 1500);
  }
  function onVisible() {
    if (!document.hidden && data?.accounts?.some((a) => a.running)) load();
  }
  onMount(() => {
    load();
    document.addEventListener("visibilitychange", onVisible);
  });
  onDestroy(() => {
    clearTimeout(poll);
    document.removeEventListener("visibilitychange", onVisible);
  });

  function announce(a) {
    const last = a.last;
    if (!last) return;
    if (Object.values(last.added || {}).some((n) => n > 0)) {
      // What came in shows everywhere at once: the favourites, the sidebar.
      invalidatePlaylists();
      loadFavorites(true);
    }
    if (last.reason === "auth") toasts.push(`${a.name} refuse la connexion : reliez le compte à nouveau`, "error");
    else if (last.reason === "network") toasts.push(`${a.name} ne répond pas : l'import reprendra dans l'heure`, "error");
    else if (last.error) toasts.push(`Import ${a.name} interrompu : ${last.error}`, "error");
    else toasts.push(`Import ${a.name} terminé : ${counts(last.added)}`);
  }

  $: accounts = data?.accounts || [];
  $: hasDeezer = accounts.some((a) => a.provider === "deezer");
  $: hasYoutube = accounts.some((a) => a.provider === "youtube");

  function ago(iso) {
    const t = Date.parse(iso);
    if (!t) return "";
    const s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 90) return "à l'instant";
    if (s < 3600) return `il y a ${Math.round(s / 60)} min`;
    if (s < 86400 * 1.5) return `il y a ${Math.round(s / 3600)} h`;
    return `il y a ${Math.round(s / 86400)} j`;
  }

  function counts(added) {
    const parts = Object.entries(added || {})
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${n} ${COUNT_LABEL[k] || k}${n > 1 ? "s" : ""}`);
    return parts.length ? parts.join(", ") + " ajoutés" : "rien de nouveau";
  }

  const nf = new Intl.NumberFormat("fr-FR");
  // What the import is doing, in words, and how far it is (null: not known yet).
  function progress(r) {
    const what = r.kind ? KIND_LABEL[r.kind] : "";
    if (r.phase === "import" && r.total) {
      return { text: `${what} : ${nf.format(r.done || 0)} sur ${nf.format(r.total)}`, share: (r.done || 0) / r.total };
    }
    if (r.phase === "list") return { text: `${what} : lecture de la liste du compte…`, share: null };
    if (r.phase === "import") return { text: `${what} : rien de nouveau`, share: 1 };
    return { text: "Connexion au compte…", share: null };
  }

  function statusLine(a) {
    if (a.running) return "";
    if (a.status === "auth") return "Le compte refuse la connexion : reliez-le à nouveau.";
    if (a.status === "broken") return `Compte illisible sur le serveur (${a.error}) : déliez-le puis reliez-le.`;
    const last = a.last;
    if (!last) return "Pas encore importé";
    if (last.reason === "network") return `Service injoignable ${ago(last.at)} : nouvel essai dans l'heure`;
    if (last.error) return `Dernier import ${ago(last.at)} : échec (${last.error})`;
    const kept = Object.values(last.kept || {}).reduce((x, n) => x + n, 0);
    if (kept) return `Dernier import ${ago(last.at)} : ${counts(last.added)} · ${nf.format(kept)} déjà traités ici, laissés tels quels`;
    return `Dernier import ${ago(last.at)} : ${counts(last.added)}`;
  }

  let choosing = false;
  async function chooseDefault(id) {
    if (choosing || id === (data?.default ?? null)) return;
    choosing = true;
    const before = data.default;
    data.default = id; // instant; rolled back below on refusal
    for (const a of accounts) a.default = a.id === id;
    data = data;
    try {
      adopt(await api.setDefaultAccount(id));
      const a = (data?.accounts || []).find((x) => x.id === id);
      toasts.push(a ? `${a.name} est votre plateforme par défaut : import de ses favoris` : "Aucune plateforme ne synchronise plus vos favoris");
      schedule();
    } catch (e) {
      data.default = before;
      for (const a of accounts) a.default = a.id === before;
      data = data;
      toasts.push(e?.message || "Échec", "error");
    }
    choosing = false;
  }

  // Lot P3: what this account is used for, besides the import.
  function useLine(a) {
    if (a.provider !== "deezer" || a.server || a.status === "auth" || a.status === "broken") return "";
    if (a.lossless === false)
      return "Vos recherches et vos pages Deezer passent par ce compte. Sans FLAC (offre gratuite), la musique est récupérée par un autre compte.";
    return "Vos recherches, vos pages et votre musique Deezer passent par ce compte.";
  }

  const title = (a) => (a.server ? `${a.name} · compte du serveur` : a.name);

  async function toggleAuto(a, kind) {
    if (busy) return;
    const next = !a.auto[kind];
    a.auto[kind] = next; // instant; rolled back below on refusal
    data = data;
    try {
      const r = await api.setAccountAuto(a.id, { [kind]: next });
      Object.assign(a, r.account);
      data = data;
    } catch (e) {
      a.auto[kind] = !next;
      data = data;
      toasts.push(e?.message || "Échec", "error");
    }
  }

  async function importNow(a) {
    if (busy || a.running) return;
    busy = true;
    a.running = { phase: "connect" }; // the answer can take a while on a weak link
    data = data;
    try {
      const r = await api.importAccount(a.id);
      Object.assign(a, r.account);
      if (!a.running) a.running = { phase: "connect" };
      watching.add(a.id);
      data = data;
      schedule();
    } catch (e) {
      a.running = null;
      data = data;
      toasts.push(e?.message || "Échec", "error");
    }
    busy = false;
  }

  async function link(mode = "arl", value = arl) {
    const v = (value || "").trim();
    if (!v || busy) return;
    busy = true;
    try {
      await api.linkDeezer(v, mode);
      arl = "";
      linking = false;
      await load();
      const dz = (data?.accounts || []).find((x) => x.provider === "deezer");
      toasts.push(
        dz?.default
          ? "Compte Deezer relié : import de vos artistes et titres aimés"
          : "Compte Deezer relié. Vos favoris restent synchronisés avec votre plateforme par défaut",
      );
    } catch (e) {
      toasts.push(e?.message || "Échec", "error");
    }
    busy = false;
  }

  async function linkNative() {
    try {
      const got = await nativeDeezerLogin();
      await link("browser", got);
    } catch (e) {
      if (!e?.cancelled) toasts.push(e?.message || "Échec", "error");
    }
  }

  let confirmUnlink = null;
  async function unlink(a) {
    if (busy) return;
    if (confirmUnlink !== a.id) {
      confirmUnlink = a.id;
      setTimeout(() => confirmUnlink === a.id && (confirmUnlink = null), 4000);
      return;
    }
    confirmUnlink = null;
    busy = true;
    try {
      await api.unlinkAccount(a.id);
      toasts.push("Compte délié : ce qui a été importé reste dans votre bibliothèque");
      await load();
    } catch (e) {
      toasts.push(e?.message || "Échec", "error");
    }
    busy = false;
  }

  const glyph = (p) => (p === "youtube" ? "youtube" : "music");
</script>

<section class="card">
  <h2>Mes comptes</h2>
  <p class="muted sub">
    Reliez votre propre compte pour retrouver ici vos artistes suivis (ils alimentent
    Nouveautés), vos titres aimés, vos albums et vos playlists. Chaque élément n'est importé
    qu'une fois&nbsp;: ce que vous retirez ici n'est jamais remis, et rien n'est jamais écrit
    sur votre compte.
  </p>

  {#if failed}
    <p class="muted" role="alert">Impossible de lire vos comptes&nbsp;: {failed}. <button class="link" on:click={load}>Réessayer</button></p>
  {:else if !data}
    <p class="muted">Chargement…</p>
  {:else}
    {#if accounts.length}
      <div class="default">
        <span class="cap muted" id="def-cap">Plateforme par défaut</span>
        <div class="seg" role="radiogroup" aria-labelledby="def-cap">
          {#each accounts as a (a.id)}
            <button type="button" role="radio" class="opt" class:sel={a.default} aria-checked={a.default}
              disabled={choosing || a.status === "auth" || a.status === "broken"} on:click={() => chooseDefault(a.id)}>
              <Icon name={glyph(a.provider)} size={15} /><span>{a.name}</span>
            </button>
          {/each}
          <button type="button" role="radio" class="opt" class:sel={!data.default} aria-checked={!data.default}
            disabled={choosing} on:click={() => chooseDefault(null)}>
            <span>Aucune</span>
          </button>
        </div>
        <p class="fine muted hint">
          {#if data.default}
            Ses favoris sont relus chaque jour et ce qui est nouveau est ajouté. Les autres comptes
            ne sont importés que lorsque vous le demandez.
          {:else}
            Aucun compte n'est relu automatiquement&nbsp;: vous importez quand vous le demandez.
          {/if}
        </p>
      </div>
    {/if}

    {#each accounts as a (a.id)}
      <article class="acc">
        <header>
          <span class="glyph"><Icon name={glyph(a.provider)} size={18} /></span>
          <span class="txt">
            <span class="nm">
              {title(a)}{#if a.label && !a.server}<span class="who muted">{a.label}</span>{/if}
              {#if a.default}<span class="badge">Par défaut</span>{/if}
            </span>
            {#if !a.running}
              <span class="muted st" class:warn={a.status === "auth" || a.status === "broken"}>{statusLine(a)}</span>
            {/if}
            {#if useLine(a)}<span class="muted st">{useLine(a)}</span>{/if}
          </span>
        </header>

        {#if a.running}
          {@const p = progress(a.running)}
          <div class="run" role="status" aria-live="polite">
            <div class="bar" class:busy={p.share === null}
              role="progressbar" aria-label="Avancement de l'import"
              aria-valuemin="0" aria-valuemax="100" aria-valuenow={p.share === null ? undefined : Math.round(p.share * 100)}>
              <span style="width:{p.share === null ? 100 : Math.max(2, p.share * 100)}%"></span>
            </div>
            <span class="st">{p.text}</span>
            <span class="fine muted">L'import continue sur le serveur si vous quittez cette page.</span>
          </div>
        {/if}

        <span class="cap muted" id="cap-{a.id}">{a.default ? "Synchronisé chaque jour" : "Importé quand vous le demandez"}</span>
        <div class="kinds" role="group" aria-labelledby="cap-{a.id}">
          {#each a.kinds as k (k)}
            <button type="button" class="kind" class:on={a.auto[k]} role="switch" aria-checked={a.auto[k]} on:click={() => toggleAuto(a, k)}>
              <span class="box">{#if a.auto[k]}<Icon name="check" size={13} />{/if}</span>
              <span>{KIND_LABEL[k]}</span>
            </button>
          {/each}
        </div>

        <div class="actions">
          <button class="ghost-btn main" disabled={busy || !!a.running || a.status === "auth" || a.status === "broken"} on:click={() => importNow(a)}>
            <Icon name="download" size={16} /><span>{a.running ? "Import en cours…" : "Importer maintenant"}</span>
          </button>
          <button class="ghost-btn" disabled={a.status === "auth" || a.status === "broken"} on:click={() => (picker = a)}>
            <Icon name="users" size={16} /><span>Choisir les artistes…</span>
          </button>
          {#if !a.server}
            {#if confirmUnlink === a.id}
              <button class="ghost-btn danger" on:click={() => unlink(a)}>Délier ?</button>
            {:else}
              <button class="ghost-btn quiet" on:click={() => unlink(a)}>Délier</button>
            {/if}
          {/if}
        </div>
      </article>
    {/each}

    {#if !hasDeezer && data.can_link?.deezer}
      <article class="acc add">
        <header>
          <span class="glyph"><Icon name="music" size={18} /></span>
          <span class="txt">
            <span class="nm">Deezer</span>
            <span class="muted st">Votre compte, pour vos favoris et vos playlists à vous.</span>
          </span>
          {#if !linking}
            <button class="pill" on:click={() => (native ? linkNative() : (linking = true))}>Relier</button>
          {/if}
        </header>
        {#if linking}
          <form class="arl" on:submit|preventDefault={() => link()}>
            <input
              type="password"
              bind:value={arl}
              autocomplete="off"
              spellcheck="false"
              placeholder="ARL de votre session Deezer"
              aria-label="ARL de votre session Deezer" />
            <button class="pill" type="submit" disabled={busy || !arl.trim()}>{busy ? "Vérification…" : "Relier"}</button>
            <button class="ghost-btn quiet" type="button" on:click={() => ((linking = false), (arl = ""))}>Annuler</button>
          </form>
          <p class="fine muted">
            L'ARL est le cookie <code>arl</code> de deezer.com une fois connecté (outils de développement
            du navigateur → Stockage → Cookies). C'est la clé de votre compte : il reste chiffré sur le
            serveur et n'est montré à personne.
          </p>
        {/if}
      </article>
    {/if}

    {#if !hasYoutube}
      <p class="fine muted yt">
        <Icon name="youtube" size={15} />
        <span>YouTube Music&nbsp;: reliez votre session dans Compte → Services de streaming&nbsp;; elle sert aussi à l'import.</span>
      </p>
    {/if}
  {/if}
</section>

{#if picker}
  <AccountPicker account={picker} onclose={() => ((picker = null), load())} />
{/if}

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
  .acc {
    padding: 16px 0 18px;
    border-top: 1px solid var(--bg-hover);
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .acc:first-of-type {
    border-top: none;
    padding-top: 4px;
  }
  header {
    display: flex;
    align-items: center;
    gap: 12px;
    min-height: 44px;
  }
  .glyph {
    flex: none;
    width: 36px;
    height: 36px;
    border-radius: 10px;
    display: grid;
    place-items: center;
    background: var(--bg-hover);
    color: var(--accent);
  }
  .txt {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .nm {
    font-weight: 600;
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 4px 8px;
    min-width: 0;
  }
  .who {
    font-weight: 500;
    font-size: 0.82rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .st {
    font-size: 0.8rem;
    line-height: 1.4;
  }
  .st.warn {
    color: #ff8a65;
  }
  .cap {
    font-size: 0.74rem;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    margin-bottom: -6px;
  }
  .kinds {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .kind {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    min-height: 38px;
    padding: 7px 14px 7px 9px;
    border-radius: 999px;
    border: 1px solid var(--bg-hover);
    color: var(--text-dim);
    font-size: 0.84rem;
    font-weight: 600;
  }
  .kind:hover {
    color: var(--text);
  }
  .kind.on {
    color: var(--text);
    border-color: color-mix(in srgb, var(--accent) 55%, transparent);
    background: color-mix(in srgb, var(--accent) 10%, transparent);
  }
  .box {
    width: 18px;
    height: 18px;
    border-radius: 5px;
    display: grid;
    place-items: center;
    border: 1.5px solid var(--text-dim);
    color: #fff;
  }
  .kind.on .box {
    background: var(--accent);
    border-color: var(--accent);
  }
  .default {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding-bottom: 16px;
    border-bottom: 1px solid var(--bg-hover);
  }
  .default .cap {
    margin-bottom: 0;
  }
  .hint {
    margin: 0;
  }
  .seg {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .opt {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    min-height: 40px;
    padding: 8px 16px;
    border-radius: 999px;
    border: 1px solid var(--bg-hover);
    color: var(--text-dim);
    font-size: 0.86rem;
    font-weight: 600;
  }
  .opt:hover:not(:disabled) {
    color: var(--text);
  }
  .opt.sel {
    color: var(--text);
    border-color: var(--accent);
    background: color-mix(in srgb, var(--accent) 16%, transparent);
  }
  .opt:disabled {
    opacity: 0.55;
    cursor: default;
  }
  .opt.sel:disabled {
    opacity: 1;
  }
  .badge {
    flex: none;
    font-size: 0.68rem;
    font-weight: 700;
    letter-spacing: 0.03em;
    text-transform: uppercase;
    padding: 2px 8px;
    border-radius: 999px;
    color: var(--accent);
    background: color-mix(in srgb, var(--accent) 14%, transparent);
  }
  .run {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .run .fine {
    margin: 0;
  }
  .bar {
    height: 6px;
    border-radius: 999px;
    background: var(--bg-hover);
    overflow: hidden;
  }
  .bar span {
    display: block;
    height: 100%;
    border-radius: inherit;
    background: var(--accent);
    transition: width 0.4s ease;
  }
  .bar.busy span {
    width: 35% !important;
    animation: slide 1.4s ease-in-out infinite;
  }
  @keyframes slide {
    from {
      transform: translateX(-100%);
    }
    to {
      transform: translateX(290%);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .bar.busy span {
      animation: none;
      width: 100% !important;
      opacity: 0.45;
    }
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    align-items: center;
  }
  .pill {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    flex: none;
  }
  .pill:disabled,
  .ghost-btn:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .ghost-btn {
    flex: none;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 8px 15px;
    min-height: 38px;
    border-radius: 999px;
    border: 1px solid var(--bg-hover);
    color: var(--text-dim);
    font-weight: 600;
    font-size: 0.85rem;
    white-space: nowrap;
  }
  .ghost-btn:hover:not(:disabled) {
    color: var(--text);
    border-color: var(--text-dim);
  }
  .ghost-btn.main {
    color: var(--accent);
    border-color: color-mix(in srgb, var(--accent) 55%, transparent);
    background: color-mix(in srgb, var(--accent) 10%, transparent);
  }
  .ghost-btn.main:hover:not(:disabled) {
    color: var(--text);
    border-color: var(--accent);
  }
  .ghost-btn.quiet {
    border-color: transparent;
  }
  .ghost-btn.danger {
    color: #ff6b6b;
    border-color: #ff6b6b;
  }
  .arl {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
  }
  .arl input {
    flex: 1 1 240px;
    min-width: 0;
    background: var(--bg);
    color: var(--text);
    border: 1px solid var(--bg-hover);
    border-radius: 10px;
    padding: 10px 12px;
    font-size: 0.9rem;
  }
  .arl input:focus {
    outline: none;
    border-color: var(--accent);
  }
  .add .fine {
    margin: 0;
  }
  .yt {
    display: flex;
    align-items: center;
    gap: 8px;
    padding-top: 14px;
    border-top: 1px solid var(--bg-hover);
  }
  .yt :global(.icon) {
    flex: none;
  }
  @media (max-width: 480px) {
    .opt {
      flex: 1 1 auto;
      justify-content: center;
      padding: 8px 12px;
    }
    .opt:last-child {
      flex-grow: 0; /* "Aucune" is the way out, never the widest choice */
    }
    .actions .ghost-btn:not(.quiet):not(.danger) {
      flex: 1 1 auto;
      justify-content: center;
    }
  }
</style>
