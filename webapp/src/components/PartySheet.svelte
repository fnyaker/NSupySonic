<script>
  // The host's side of a listen party: start it, hand the link out (a QR code
  // for the people in the room, the share sheet for everyone else), see who is
  // listening and how well they are locked, end it.
  import { tick } from "svelte";
  import { partySheet, closePartySheet, current, toasts } from "../lib/stores.js";
  import { partyHost, startParty, endParty } from "../lib/party/host.js";
  import { artistLine } from "../lib/format.js";
  import Cover from "./Cover.svelte";
  import Icon from "./Icon.svelte";

  let busy = false;
  let confirmEnd = false;
  let qrPath = "";
  let qrSize = 0;
  let qrFor = null;

  $: open = $partySheet;
  $: host = $partyHost;
  $: if (open && host && host.link !== qrFor) makeQr(host.link);
  $: if (!open) confirmEnd = false;
  $: count = host ? host.listeners.length : 0;

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

  async function start() {
    if (busy) return;
    busy = true;
    try {
      await startParty();
      await tick();
    } catch {
      toasts.push("Impossible de démarrer la party", "error");
    } finally {
      busy = false;
    }
  }

  async function end() {
    if (!confirmEnd) {
      confirmEnd = true;
      return;
    }
    busy = true;
    try {
      await endParty();
      toasts.push("Party terminée");
      closePartySheet();
    } finally {
      busy = false;
      confirmEnd = false;
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(host.link);
      toasts.push("Lien copié");
    } catch {
      toasts.push("Copie impossible — sélectionnez le lien", "error");
    }
  }

  async function share() {
    const data = {
      title: "Listen party",
      text: "Viens écouter avec moi — même musique, même instant.",
      url: host.link,
    };
    if (navigator.share) {
      try {
        await navigator.share(data);
        return;
      } catch (e) {
        if (e && e.name === "AbortError") return;
      }
    }
    copy();
  }

  function statusOf(l) {
    if (l.st === "sync") return l.q != null ? `En phase · ±${Math.max(0.1, l.q).toFixed(1)} ms` : "En phase";
    if (l.st === "load") return "Chargement…";
    if (l.st === "pause") return "En pause";
    return "Connecté";
  }

  function onKey(e) {
    if (open && e.key === "Escape") closePartySheet();
  }
</script>

<svelte:window on:keydown={onKey} />

{#if open}
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div class="backdrop" on:click={closePartySheet}>
    <div class="sheet" role="dialog" aria-label="Listen party" tabindex="-1" on:click|stopPropagation>
      <header>
        <div class="title">
          <span class="badge" class:live={!!host}><Icon name="party" size={20} /></span>
          <div class="txt">
            <h2>Listen party</h2>
            {#if host}
              <span class="live-line"><span class="dot"></span>En direct · {count === 0 ? "personne à l'écoute" : count === 1 ? "1 personne à l'écoute" : `${count} personnes à l'écoute`}</span>
            {:else}
              <span class="muted sub">La même musique, au même instant, sur chaque appareil.</span>
            {/if}
          </div>
        </div>
        <button class="ic" on:click={closePartySheet} aria-label="Fermer"><Icon name="close" size={20} /></button>
      </header>

      {#if !host}
        <div class="intro">
          <div class="point">
            <Icon name="link" size={18} />
            <p>Partagez un lien. Ceux qui l'ouvrent entendent ce que vous jouez, calé à la milliseconde près — sans compte.</p>
          </div>
          <div class="point">
            <Icon name="users" size={18} />
            <p>Dans une même pièce, chaque téléphone devient une enceinte de plus.</p>
          </div>
          <div class="point">
            <Icon name="music" size={18} />
            <p>Vous gardez la main : ils suivent vos titres, vos pauses et vos enchaînements.</p>
          </div>
        </div>
        {#if $current}
          <div class="now">
            <Cover src={$current.album?.cover} alt={$current.title} size={44} kind={$current.podcast ? "podcast" : "album"} fallbackId={$current.deezer_id} />
            <div class="txt">
              <span class="t">{$current.title}</span>
              <span class="a muted">{artistLine($current)}</span>
            </div>
          </div>
        {/if}
        <footer>
          <button class="primary" on:click={start} disabled={busy}>
            {#if busy}<span class="spin"></span> Démarrage…{:else}<Icon name="party" size={17} /> Démarrer la party{/if}
          </button>
        </footer>
      {:else}
        {#if host.elsewhere}
          <p class="note"><Icon name="info" size={16} /> Cette party est animée depuis un autre onglet : c'est lui qui donne le tempo.</p>
        {/if}
        {#if host.lost}
          <p class="note warn"><Icon name="alert" size={16} /> Le serveur a redémarré et le lien a changé — partagez le nouveau.</p>
        {/if}

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
            <span class="lbl muted">Scannez, ou envoyez le lien</span>
            <button class="link" on:click={copy} title="Copier le lien">
              <span class="url">{host.link.replace(/^https?:\/\//, "")}</span>
              <Icon name="copy" size={16} />
            </button>
            <div class="actions">
              <button class="primary" on:click={share}><Icon name="share" size={16} /> Partager</button>
              <button class="ghost" on:click={copy}><Icon name="copy" size={16} /> Copier</button>
            </div>
          </div>
        </div>

        <section class="people">
          <h3>À l'écoute</h3>
          {#if count === 0}
            <p class="muted empty">Personne pour l'instant. Dès qu'un invité ouvre le lien, il apparaît ici.</p>
          {:else}
            <ul>
              {#each host.listeners as l (l.id)}
                <li>
                  <span class="avatar" aria-hidden="true">{(l.name || "?").trim().charAt(0).toUpperCase()}</span>
                  <span class="name">{l.name}</span>
                  <span class="st" class:ok={l.st === "sync"} class:wait={l.st === "load"}>{statusOf(l)}</span>
                </li>
              {/each}
            </ul>
          {/if}
        </section>

        <p class="clock muted">
          {#if host.clock}
            Horloge de cet appareil calée à ±{Math.max(0.1, host.clock.spread).toFixed(1)}&nbsp;ms · aller-retour&nbsp;{host.clock.rtt.toFixed(0)}&nbsp;ms
          {:else}
            Synchronisation de l'horloge…
          {/if}
        </p>

        <footer class="endrow">
          <button class="danger" class:armed={confirmEnd} on:click={end} disabled={busy}>
            <Icon name="logOut" size={16} />
            {confirmEnd ? "Confirmer : tout le monde est déconnecté" : "Terminer la party"}
          </button>
        </footer>
      {/if}
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
    width: min(560px, 100%);
    max-height: calc(100dvh - 36px);
    overflow-y: auto;
    background: var(--bg-elev);
    border: 1px solid var(--bg-hover);
    border-radius: 18px;
    box-shadow: 0 30px 80px rgba(0, 0, 0, 0.55);
    padding: 20px 22px 22px;
    display: flex;
    flex-direction: column;
    gap: 18px;
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
    background: linear-gradient(135deg, var(--accent), var(--accent-2));
    box-shadow: 0 8px 24px rgba(162, 56, 255, 0.35);
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
    background: #ff3b6b;
    box-shadow: 0 0 0 0 rgba(255, 59, 107, 0.6);
    animation: pulse 1.8s ease-out infinite;
  }
  @keyframes pulse {
    70% {
      box-shadow: 0 0 0 7px rgba(255, 59, 107, 0);
    }
    100% {
      box-shadow: 0 0 0 0 rgba(255, 59, 107, 0);
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

  .intro {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .point {
    display: grid;
    grid-template-columns: 22px 1fr;
    gap: 12px;
    align-items: start;
    color: var(--accent);
  }
  .point p {
    margin: 0;
    color: var(--text);
    font-size: 0.92rem;
    line-height: 1.45;
  }
  .now {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 12px;
    border-radius: 14px;
    background: var(--bg-card);
    border: 1px solid var(--bg-hover);
  }
  .now .t,
  .now .a {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .now .t {
    font-weight: 700;
  }
  .now .a {
    font-size: 0.85rem;
  }

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
    width: 148px;
    height: 148px;
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
    gap: 10px;
    min-width: 0;
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
    border-color: var(--accent);
  }
  .url {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.8rem;
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

  .people h3 {
    margin: 0 0 10px;
    font-size: 0.78rem;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-dim);
  }
  .empty {
    margin: 0;
    font-size: 0.88rem;
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
    grid-template-columns: 32px 1fr auto;
    align-items: center;
    gap: 12px;
    padding: 8px 4px;
    border-radius: 10px;
  }
  .avatar {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    font-weight: 800;
    font-size: 0.85rem;
    color: #fff;
    background: linear-gradient(135deg, var(--accent), var(--accent-2));
  }
  .name {
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .st {
    font-size: 0.8rem;
    color: var(--text-dim);
    font-variant-numeric: tabular-nums;
  }
  .st.ok {
    color: #3ddc97;
  }
  .st.wait {
    color: #ffc857;
  }
  .clock {
    margin: 0;
    font-size: 0.78rem;
    font-variant-numeric: tabular-nums;
  }
  .note {
    display: flex;
    gap: 10px;
    align-items: flex-start;
    margin: 0;
    padding: 10px 12px;
    border-radius: 12px;
    background: var(--bg-card);
    font-size: 0.88rem;
    line-height: 1.4;
  }
  .note.warn {
    color: #ffc857;
  }

  footer {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
  }
  footer.endrow {
    justify-content: flex-start;
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
    background: linear-gradient(90deg, var(--accent), var(--accent-2));
    color: #fff;
  }
  .primary:hover:not(:disabled) {
    filter: brightness(1.1);
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
  /* Only on devices that really hover: on a phone the button appears exactly
     where "Démarrer" was just tapped, and a sticky hover would show it armed
     before anyone touched it. */
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
    border: 2px solid rgba(255, 255, 255, 0.35);
    border-top-color: #fff;
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
      padding: 18px 18px max(22px, env(safe-area-inset-bottom));
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
    }
    .actions {
      justify-content: center;
    }
    .actions button {
      flex: 1;
    }
    footer button {
      width: 100%;
    }
  }
</style>
