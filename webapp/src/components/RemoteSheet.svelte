<script>
  // Remote control, the owner's side: make a link that lets someone drive THIS
  // player, hand it over (a QR code for the person across the room, the share
  // sheet for everyone else), see who is on which link, and cut any of them.
  //
  // A link drives the device it was made on. Four levels, each a superset of
  // the one before — the server holds the line (supysonic/webui/remote.py);
  // this sheet only says plainly what each one lends.
  import { onDestroy } from "svelte";
  import { remoteSheet, closeRemoteSheet, isAdmin, toasts } from "../lib/stores.js";
  import { api } from "../lib/api.js";
  import { LEVELS, LEVEL_INFO } from "../lib/remote/mode.js";
  import { deviceId, deviceName } from "../lib/remote/device.js";
  import { remoteHost, startHosting, cutAll } from "../lib/remote/hoststate.js";
  import Icon from "./Icon.svelte";

  const DURATIONS = [
    { id: "1h", label: "1 heure", ttl: 3600 },
    { id: "1d", label: "1 jour", ttl: 86400 },
    { id: "7d", label: "7 jours", ttl: 7 * 86400 },
    { id: "none", label: "Sans limite", ttl: null },
  ];

  let level = "queue";
  let duration = "1d";
  let label = "";
  let busy = false;
  let links = [];
  let loaded = false;
  let invite = null; // the link whose QR is on screen
  let qrPath = "";
  let qrSize = 0;
  let qrFor = null;
  let confirmAll = false;
  let refresh = null;

  const device = deviceId();
  const here = deviceName();

  $: open = $remoteSheet;
  $: levels = LEVELS.filter((l) => l !== "admin" || $isAdmin);
  $: if (open) start();
  $: if (!open) stop();
  $: live = $remoteHost.active ? $remoteHost.controllers.length : 0;
  $: if (invite && linkOf(invite) !== qrFor) makeQr(linkOf(invite));

  function linkOf(l) {
    // Relative to where the app is served, like the party's: a deployment under
    // a path prefix still hands out a working link.
    return new URL(`../rc/${l.token}`, window.location.origin + window.location.pathname).href;
  }

  function start() {
    if (refresh) return;
    load();
    // Who is connected changes while the sheet is open; a light re-read.
    refresh = setInterval(load, 4000);
  }
  function stop() {
    clearInterval(refresh);
    refresh = null;
    invite = null;
    confirmAll = false;
  }
  onDestroy(stop);

  async function load() {
    try {
      const r = await api.remoteLinks(device);
      links = r.links || [];
      if (invite) invite = links.find((l) => l.id === invite.id) || null;
    } catch {
      /* keep what is shown; the next read may land */
    } finally {
      loaded = true;
    }
  }

  async function create() {
    if (busy) return;
    busy = true;
    try {
      const d = DURATIONS.find((x) => x.id === duration);
      const r = await api.remoteCreate({
        level,
        device,
        device_name: here,
        label: label.trim() || null,
        ttl: d ? d.ttl : 86400,
      });
      links = [r.link, ...links];
      invite = r.link;
      label = "";
      // This device is lent from now on: start answering.
      startHosting();
    } catch (e) {
      toasts.push(e && e.message ? `Lien impossible : ${e.message}` : "Lien impossible", "error");
    } finally {
      busy = false;
    }
  }

  async function cut(l) {
    try {
      await api.remoteRevoke(l.id);
      links = links.filter((x) => x.id !== l.id);
      if (invite && invite.id === l.id) invite = null;
      toasts.push(l.label ? `Lien de ${l.label} coupé` : "Lien coupé");
    } catch {
      toasts.push("Impossible de couper ce lien", "error");
    }
  }

  async function cutEverything() {
    if (!confirmAll) {
      confirmAll = true;
      return;
    }
    try {
      await cutAll();
      links = [];
      invite = null;
      toasts.push("Contrôle à distance coupé");
    } catch {
      toasts.push("Impossible de tout couper", "error");
    } finally {
      confirmAll = false;
    }
  }

  // The QR library is only needed here, so it is only loaded here.
  async function makeQr(link) {
    qrFor = link;
    try {
      const { default: qrcode } = await import("qrcode-generator");
      const qr = qrcode(0, "M");
      qr.addData(link);
      qr.make();
      const n = qr.getModuleCount();
      let d = "";
      for (let r = 0; r < n; r++)
        for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`;
      if (qrFor !== link) return;
      qrSize = n;
      qrPath = d;
    } catch {
      qrPath = "";
    }
  }

  async function copy(l) {
    try {
      await navigator.clipboard.writeText(linkOf(l));
      toasts.push("Lien copié");
    } catch {
      toasts.push("Copie impossible — sélectionnez le lien", "error");
    }
  }

  async function share(l) {
    const data = {
      title: "Piloter ma musique",
      text: `Tu peux piloter ma musique (${LEVEL_INFO[l.level].name.toLowerCase()}) :`,
      url: linkOf(l),
    };
    if (navigator.share) {
      try {
        await navigator.share(data);
        return;
      } catch (e) {
        if (e && e.name === "AbortError") return;
      }
    }
    copy(l);
  }

  function expiry(l) {
    if (!l.expires) return "Sans limite";
    const ms = new Date(l.expires).getTime() - Date.now();
    if (!(ms > 0)) return "Expiré";
    const h = ms / 3600e3;
    if (h < 1) return `Expire dans ${Math.max(1, Math.round(ms / 60e3))} min`;
    if (h < 48) return `Expire dans ${Math.round(h)} h`;
    return `Expire dans ${Math.round(h / 24)} j`;
  }

  function onKey(e) {
    if (open && e.key === "Escape") closeRemoteSheet();
  }
</script>

<svelte:window on:keydown={onKey} />

{#if open}
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div class="backdrop" on:click={closeRemoteSheet}>
    <div class="sheet" role="dialog" aria-label="Contrôle à distance" tabindex="-1" on:click|stopPropagation>
      <header>
        <div class="title">
          <span class="badge" class:live={live > 0}><Icon name="remote" size={20} /></span>
          <div class="txt">
            <h2>Contrôle à distance</h2>
            {#if live > 0}
              <span class="live-line"><span class="dot"></span>{live === 1 ? "1 appareil pilote ce lecteur" : `${live} appareils pilotent ce lecteur`}</span>
            {:else}
              <span class="muted sub">Confiez ce lecteur à quelqu'un : il le pilote depuis son téléphone, avec la même app.</span>
            {/if}
          </div>
        </div>
        <button class="ic" on:click={closeRemoteSheet} aria-label="Fermer"><Icon name="close" size={20} /></button>
      </header>

      {#if invite}
        <div class="invite">
          <div class="qr" aria-label="QR code du lien">
            {#if qrPath}
              <svg viewBox={`-2 -2 ${qrSize + 4} ${qrSize + 4}`} shape-rendering="crispEdges" role="img" aria-label="QR code">
                <rect x="-2" y="-2" width={qrSize + 4} height={qrSize + 4} fill="#fff" />
                <path d={qrPath} fill="#0f0d13" />
              </svg>
            {:else}
              <span class="qr-ph"></span>
            {/if}
          </div>
          <div class="linkcol">
            <span class="lvl">
              <Icon name={LEVEL_INFO[invite.level].icon} size={15} />
              {LEVEL_INFO[invite.level].name}{#if invite.label} · pour {invite.label}{/if}
            </span>
            <span class="lbl muted">Scannez, ou envoyez le lien. {expiry(invite)}.</span>
            <button class="link" on:click={() => copy(invite)} title="Copier le lien">
              <span class="url">{linkOf(invite).replace(/^https?:\/\//, "")}</span>
              <Icon name="copy" size={16} />
            </button>
            <div class="actions">
              <button class="primary" on:click={() => share(invite)}><Icon name="share" size={16} /> Partager</button>
              <button class="ghost" on:click={() => (invite = null)}><Icon name="check" size={16} /> Terminé</button>
            </div>
          </div>
        </div>
      {:else}
        <section class="new">
          <h3>Nouveau lien</h3>
          <div class="levels" role="radiogroup" aria-label="Ce que le lien permet">
            {#each levels as l}
              <button
                class="level"
                class:sel={level === l}
                class:warn={l === "admin"}
                role="radio"
                aria-checked={level === l}
                on:click={() => (level = l)}
              >
                <span class="li"><Icon name={LEVEL_INFO[l].icon} size={18} /></span>
                <span class="lt">
                  <span class="ln">{LEVEL_INFO[l].name}</span>
                  <span class="lb">{LEVEL_INFO[l].blurb}</span>
                </span>
                <span class="tick" aria-hidden="true">{#if level === l}<Icon name="check" size={14} />{/if}</span>
              </button>
            {/each}
          </div>

          <div class="row">
            <span class="rl">Durée</span>
            <div class="seg" role="radiogroup" aria-label="Durée du lien">
              {#each DURATIONS as d}
                <button role="radio" aria-checked={duration === d.id} class:sel={duration === d.id} on:click={() => (duration = d.id)}>{d.label}</button>
              {/each}
            </div>
          </div>
          <label class="row">
            <span class="rl">Pour</span>
            <input type="text" maxlength="40" placeholder="Prénom, pour s'y retrouver (facultatif)" bind:value={label} />
          </label>

          <footer>
            <button class="primary" on:click={create} disabled={busy}>
              {#if busy}<span class="spin"></span> Création…{:else}<Icon name="link" size={17} /> Créer le lien{/if}
            </button>
          </footer>
        </section>
      {/if}

      <section class="links">
        <h3>Liens actifs</h3>
        {#if !loaded}
          <p class="muted empty">…</p>
        {:else if !links.length}
          <p class="muted empty">Aucun lien sur ce lecteur. Celui que vous créez apparaît ici, avec qui s'en sert.</p>
        {:else}
          <ul>
            {#each links as l (l.id)}
              <li>
                <span class="av" class:on={l.controllers > 0}><Icon name={LEVEL_INFO[l.level].icon} size={16} /></span>
                <span class="meta">
                  <span class="name">{l.label || LEVEL_INFO[l.level].name}</span>
                  <span class="sub2">
                    {#if l.label}{LEVEL_INFO[l.level].short} · {/if}{expiry(l)}{#if l.controllers > 0} · <b class="ok">{l.controllers === 1 ? "connecté" : `${l.controllers} connectés`}</b>{/if}
                  </span>
                </span>
                <button class="mini" on:click={() => (invite = l)} title="Afficher le QR code" aria-label="Afficher le QR code"><Icon name="share" size={16} /></button>
                <button class="mini danger" on:click={() => cut(l)} title="Couper ce lien" aria-label="Couper ce lien"><Icon name="close" size={16} /></button>
              </li>
            {/each}
          </ul>
        {/if}
      </section>

      <footer class="endrow">
        <span class="muted here"><Icon name="monitor" size={14} /> Ce lecteur : {here}</span>
        {#if links.length}
          <button class="danger" class:armed={confirmAll} on:click={cutEverything}>
            <Icon name="logOut" size={16} />
            {confirmAll ? "Confirmer : tout le monde est déconnecté" : "Tout couper"}
          </button>
        {/if}
      </footer>
    </div>
  </div>
{/if}

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 300;
    background: rgba(8, 6, 12, 0.62);
    backdrop-filter: blur(6px);
    display: grid;
    place-items: center;
    padding: 18px;
  }
  .sheet {
    width: min(600px, 100%);
    max-height: calc(100dvh - 36px);
    overflow-y: auto;
    background: var(--bg-elev);
    border: 1px solid var(--bg-hover);
    border-radius: 18px;
    box-shadow: 0 30px 80px rgba(0, 0, 0, 0.55);
    padding: 20px 22px 22px;
    display: flex;
    flex-direction: column;
    gap: 20px;
  }
  header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
  }
  .title {
    display: flex;
    align-items: center;
    gap: 14px;
    min-width: 0;
  }
  .badge {
    width: 44px;
    height: 44px;
    border-radius: 14px;
    display: grid;
    place-items: center;
    flex: none;
    color: var(--text);
    background: var(--bg-card);
    border: 1px solid var(--bg-hover);
  }
  .badge.live {
    color: #fff;
    border-color: transparent;
    background: linear-gradient(135deg, #2bd4a4, #1fa3ff);
    box-shadow: 0 8px 24px rgba(31, 163, 255, 0.3);
  }
  .txt {
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
  }
  h2 {
    margin: 0;
    font-size: 1.15rem;
    font-weight: 800;
    letter-spacing: -0.01em;
  }
  .sub {
    font-size: 0.86rem;
    line-height: 1.4;
  }
  .live-line {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    font-size: 0.86rem;
    color: var(--text-dim);
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #2bd4a4;
    animation: pulse 1.8s ease-out infinite;
  }
  @keyframes pulse {
    0% {
      box-shadow: 0 0 0 0 rgba(43, 212, 164, 0.55);
    }
    70% {
      box-shadow: 0 0 0 7px rgba(43, 212, 164, 0);
    }
    100% {
      box-shadow: 0 0 0 0 rgba(43, 212, 164, 0);
    }
  }
  .ic {
    color: var(--text-dim);
    display: grid;
    place-items: center;
    padding: 6px;
    border-radius: 10px;
  }
  .ic:hover {
    color: var(--text);
    background: var(--bg-hover);
  }
  h3 {
    margin: 0 0 12px;
    font-size: 0.78rem;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-dim);
  }

  /* -- levels -------------------------------------------------------------- */
  .levels {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
  }
  .level {
    position: relative;
    display: grid;
    grid-template-columns: 34px 1fr;
    gap: 12px;
    align-items: start;
    text-align: left;
    padding: 14px 14px 14px 12px;
    border-radius: 14px;
    background: var(--bg-card);
    border: 1px solid var(--bg-hover);
    color: var(--text);
    transition:
      border-color 0.15s ease,
      background 0.15s ease;
  }
  .level:hover {
    border-color: rgba(255, 255, 255, 0.18);
  }
  .level.sel {
    border-color: #2bd4a4;
    background: linear-gradient(180deg, rgba(43, 212, 164, 0.09), rgba(43, 212, 164, 0.02)), var(--bg-card);
    box-shadow: 0 0 0 3px rgba(43, 212, 164, 0.12);
  }
  .level.warn.sel {
    border-color: #ffc857;
    background: linear-gradient(180deg, rgba(255, 200, 87, 0.1), rgba(255, 200, 87, 0.02)), var(--bg-card);
    box-shadow: 0 0 0 3px rgba(255, 200, 87, 0.12);
  }
  .li {
    width: 34px;
    height: 34px;
    border-radius: 10px;
    display: grid;
    place-items: center;
    background: var(--bg);
    color: var(--text-dim);
  }
  .level.sel .li {
    color: #2bd4a4;
  }
  .level.warn.sel .li {
    color: #ffc857;
  }
  .lt {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
    padding-right: 16px;
  }
  .ln {
    font-weight: 750;
    font-size: 0.93rem;
  }
  .lb {
    font-size: 0.8rem;
    line-height: 1.4;
    color: var(--text-dim);
  }
  .tick {
    position: absolute;
    top: 12px;
    right: 12px;
    width: 18px;
    height: 18px;
    display: grid;
    place-items: center;
    border-radius: 50%;
    color: #0f0d13;
    background: transparent;
  }
  .level.sel .tick {
    background: #2bd4a4;
  }
  .level.warn.sel .tick {
    background: #ffc857;
  }

  .row {
    display: grid;
    grid-template-columns: 64px 1fr;
    align-items: center;
    gap: 12px;
    margin-top: 14px;
  }
  .rl {
    font-size: 0.85rem;
    color: var(--text-dim);
    font-weight: 600;
  }
  .seg {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    padding: 3px;
    border-radius: 12px;
    background: var(--bg);
    border: 1px solid var(--bg-hover);
    gap: 2px;
  }
  .seg button {
    min-height: 36px;
    border-radius: 9px;
    font-size: 0.82rem;
    font-weight: 650;
    color: var(--text-dim);
    white-space: nowrap;
  }
  .seg button.sel {
    color: var(--text);
    background: var(--bg-hover);
  }
  input[type="text"] {
    min-height: 42px;
    padding: 0 12px;
    border-radius: 12px;
    background: var(--bg);
    border: 1px solid var(--bg-hover);
    color: var(--text);
    font: inherit;
    font-size: 0.9rem;
    min-width: 0;
  }
  input[type="text"]:focus {
    outline: none;
    border-color: #2bd4a4;
  }
  .new footer {
    margin-top: 16px;
  }

  /* -- invite -------------------------------------------------------------- */
  .invite {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 18px;
    align-items: center;
    padding: 14px;
    border-radius: 16px;
    background: var(--bg-card);
    border: 1px solid var(--bg-hover);
  }
  .qr {
    width: 156px;
    height: 156px;
    border-radius: 12px;
    overflow: hidden;
    background: #fff;
  }
  .qr svg {
    width: 100%;
    height: 100%;
    display: block;
  }
  .qr-ph {
    display: block;
    width: 100%;
    height: 100%;
    background: linear-gradient(90deg, #eee 0%, #fafafa 50%, #eee 100%);
  }
  .linkcol {
    display: flex;
    flex-direction: column;
    gap: 9px;
    min-width: 0;
  }
  .lvl {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    font-weight: 750;
    font-size: 0.92rem;
    color: #2bd4a4;
  }
  .lbl {
    font-size: 0.8rem;
  }
  .link {
    display: flex;
    align-items: center;
    gap: 10px;
    justify-content: space-between;
    padding: 10px 12px;
    border-radius: 10px;
    background: var(--bg);
    border: 1px solid var(--bg-hover);
    color: var(--text);
    text-align: left;
    min-width: 0;
  }
  .link:hover {
    border-color: #2bd4a4;
  }
  .url {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.78rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }
  .actions {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }

  /* -- links --------------------------------------------------------------- */
  .empty {
    margin: 0;
    font-size: 0.88rem;
    line-height: 1.45;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  li {
    display: grid;
    grid-template-columns: 36px 1fr auto auto;
    align-items: center;
    gap: 10px;
    padding: 8px 4px;
    border-radius: 12px;
  }
  .av {
    width: 36px;
    height: 36px;
    border-radius: 11px;
    display: grid;
    place-items: center;
    color: var(--text-dim);
    background: var(--bg-card);
    border: 1px solid var(--bg-hover);
  }
  .av.on {
    color: #fff;
    border-color: transparent;
    background: linear-gradient(135deg, #2bd4a4, #1fa3ff);
  }
  .meta {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .name {
    font-weight: 650;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .sub2 {
    font-size: 0.78rem;
    color: var(--text-dim);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .ok {
    color: #3ddc97;
    font-weight: 700;
  }
  .mini {
    width: 40px;
    height: 40px;
    border-radius: 12px;
    display: grid;
    place-items: center;
    color: var(--text-dim);
    border: 1px solid var(--bg-hover);
  }
  .mini:hover {
    color: var(--text);
    background: var(--bg-hover);
  }
  .mini.danger:hover {
    color: #ff5c7a;
    border-color: rgba(255, 92, 122, 0.5);
    background: rgba(255, 92, 122, 0.08);
  }

  footer {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
  }
  footer.endrow {
    justify-content: space-between;
    align-items: center;
    flex-wrap: wrap;
  }
  .here {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 0.8rem;
  }
  button.primary,
  button.ghost,
  button.danger {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 10px 18px;
    border-radius: 999px;
    font-weight: 700;
    font-size: 0.9rem;
    min-height: 42px;
  }
  .primary {
    background: linear-gradient(90deg, #2bd4a4, #1fa3ff);
    color: #06140f;
  }
  .primary:hover:not(:disabled) {
    filter: brightness(1.08);
  }
  .ghost {
    color: var(--text);
    border: 1px solid var(--bg-hover);
  }
  .ghost:hover {
    background: var(--bg-hover);
  }
  .danger {
    color: var(--text-dim);
    border: 1px solid var(--bg-hover);
  }
  .danger.armed {
    color: #ff5c7a;
    border-color: rgba(255, 92, 122, 0.5);
    background: rgba(255, 92, 122, 0.08);
  }
  @media (hover: hover) {
    .danger:hover {
      color: #ff5c7a;
      border-color: rgba(255, 92, 122, 0.5);
      background: rgba(255, 92, 122, 0.08);
    }
  }
  button:disabled {
    opacity: 0.6;
  }
  .spin {
    width: 14px;
    height: 14px;
    border-radius: 50%;
    border: 2px solid rgba(6, 20, 15, 0.35);
    border-top-color: #06140f;
    animation: spin 0.7s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  @media (max-width: 640px) {
    .backdrop {
      place-items: end center;
      padding: 0;
    }
    .sheet {
      border-radius: 20px 20px 0 0;
      border-bottom: none;
      max-height: 94dvh;
      padding: 18px 16px max(22px, env(safe-area-inset-bottom));
    }
    .levels {
      grid-template-columns: 1fr;
    }
    .row {
      grid-template-columns: 1fr;
      gap: 8px;
    }
    .seg button {
      font-size: 0.78rem;
    }
    .invite {
      grid-template-columns: 1fr;
      justify-items: center;
      text-align: center;
    }
    .qr {
      width: min(62vw, 240px);
      height: min(62vw, 240px);
    }
    .linkcol {
      width: 100%;
      align-items: center;
    }
    .link {
      width: 100%;
    }
    .actions {
      width: 100%;
      justify-content: center;
    }
    .actions button {
      flex: 1;
    }
    .new footer button {
      width: 100%;
    }
    footer.endrow {
      flex-direction: column-reverse;
      align-items: stretch;
      gap: 12px;
    }
    .here {
      justify-content: center;
    }
  }
</style>
