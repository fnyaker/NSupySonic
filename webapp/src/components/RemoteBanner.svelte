<script>
  // On a remote control: whose player this page drives, whether it can reach
  // it, and the way out. Always on screen — the app looks exactly like one's
  // own, so this is the one thing that says it is not, and a tap on play here
  // makes sound somewhere else.
  //
  // When the grant ends (the owner cut it, it expired) it becomes a full-screen
  // notice with the account this browser had before, if it had one.
  import { fly, fade } from "svelte/transition";
  import { immersiveOpen } from "../lib/stores.js";
  import { remoteStatus, leaveRemote, reloadHome } from "../lib/remote/controller.js";
  import { LEVEL_INFO } from "../lib/remote/mode.js";
  import Icon from "./Icon.svelte";

  let leaving = false;
  $: st = $remoteStatus;
  $: info = LEVEL_INFO[st.level] || LEVEL_INFO.queue;
  $: state =
    st.phase === "reconnecting"
      ? { cls: "wait", text: "Reconnexion…" }
      : st.phase === "connecting"
        ? { cls: "wait", text: "Connexion…" }
        : !st.online
          ? { cls: "off", text: "Lecteur hors ligne" }
          : { cls: "ok", text: "En direct" };

  async function leave() {
    if (leaving) return;
    leaving = true;
    await leaveRemote();
  }
</script>

{#if st.phase === "ended"}
  <div class="ended" transition:fade={{ duration: 160 }} role="alertdialog" aria-label="Contrôle terminé">
    <div class="card">
      <span class="badge"><Icon name="remote" size={26} /></span>
      <h2>Le contrôle est terminé</h2>
      <p class="muted">
        {st.owner ? `${st.owner} a coupé ce lien, ou il a expiré.` : "Ce lien a été coupé, ou il a expiré."}
        Rien n'a été gardé sur cet appareil.
      </p>
      <button class="primary" on:click={() => reloadHome()}>
        {#if st.restored}<Icon name="user" size={17} /> Revenir à mon compte ({st.restored.name}){:else}<Icon name="home" size={17} /> Ouvrir l'app{/if}
      </button>
    </div>
  </div>
{:else}
  <div class="pill" class:top={$immersiveOpen} transition:fly={{ y: 12, duration: 180 }} role="status">
    <span class="who">
      <span class="dot {state.cls}" aria-hidden="true"></span>
      <Icon name="remote" size={15} />
      <span class="txt">
        <span class="l1">Lecteur de {st.owner || "…"}{#if st.device}<span class="dev">· {st.device}</span>{/if}</span>
        <span class="l2">{state.text} · {info.short}</span>
      </span>
    </span>
    <button class="quit" on:click={leave} disabled={leaving} aria-label="Quitter le contrôle à distance">
      <Icon name="logOut" size={15} />
      <span>Quitter</span>
    </button>
  </div>
{/if}

<style>
  .pill {
    position: fixed;
    left: 50%;
    transform: translateX(-50%);
    bottom: calc(var(--player-h, 88px) + 12px);
    z-index: 260;
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px;
    border-radius: 999px;
    background: rgba(18, 16, 24, 0.92);
    border: 1px solid rgba(31, 163, 255, 0.35);
    box-shadow: 0 12px 34px rgba(0, 0, 0, 0.45);
    backdrop-filter: blur(10px);
    max-width: calc(100vw - 24px);
    color: #fff;
  }
  .pill.top {
    bottom: auto;
    top: calc(env(safe-area-inset-top, 0px) + 64px);
  }
  .who {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 0 10px 0 12px;
    min-width: 0;
    min-height: 40px;
    color: #eaf6ff;
  }
  .dot {
    width: 8px;
    height: 8px;
    flex: none;
    border-radius: 50%;
    background: #8a8595;
  }
  .dot.ok {
    background: #2bd4a4;
    animation: pulse 1.8s ease-out infinite;
  }
  .dot.wait {
    background: #ffc857;
    animation: blink 1s ease-in-out infinite;
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
  @keyframes blink {
    50% {
      opacity: 0.35;
    }
  }
  .txt {
    display: flex;
    flex-direction: column;
    line-height: 1.15;
    min-width: 0;
  }
  .l1 {
    font-size: 0.84rem;
    font-weight: 700;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .dev {
    margin-left: 0.35em;
    font-weight: 500;
    color: rgba(234, 246, 255, 0.62);
  }
  .l2 {
    font-size: 0.72rem;
    color: rgba(234, 246, 255, 0.62);
  }
  .quit {
    flex: none;
    display: inline-flex;
    align-items: center;
    gap: 7px;
    min-height: 40px;
    padding: 0 14px 0 12px;
    border-radius: 999px;
    font-weight: 800;
    font-size: 0.84rem;
    color: #fff;
    background: rgba(255, 255, 255, 0.08);
  }
  .quit:hover:not(:disabled) {
    background: rgba(255, 255, 255, 0.14);
  }
  .quit:disabled {
    opacity: 0.6;
  }
  @media (max-width: 640px) {
    .pill:not(.top) {
      bottom: calc(60px + 56px + 10px + env(safe-area-inset-bottom, 0px));
    }
  }

  .ended {
    position: fixed;
    inset: 0;
    z-index: 400;
    display: grid;
    place-items: center;
    padding: 24px;
    background: rgba(8, 6, 12, 0.82);
    backdrop-filter: blur(10px);
  }
  .card {
    width: min(420px, 100%);
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    gap: 14px;
    padding: 28px 24px 24px;
    border-radius: 20px;
    background: var(--bg-elev);
    border: 1px solid var(--bg-hover);
    box-shadow: 0 30px 80px rgba(0, 0, 0, 0.55);
  }
  .badge {
    width: 56px;
    height: 56px;
    border-radius: 18px;
    display: grid;
    place-items: center;
    color: #fff;
    background: linear-gradient(135deg, #2bd4a4, #1fa3ff);
  }
  h2 {
    margin: 4px 0 0;
    font-size: 1.2rem;
    font-weight: 800;
  }
  p {
    margin: 0;
    font-size: 0.92rem;
    line-height: 1.5;
  }
  .primary {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    margin-top: 6px;
    min-height: 44px;
    padding: 10px 20px;
    border-radius: 999px;
    font-weight: 750;
    color: #06140f;
    background: linear-gradient(90deg, #2bd4a4, #1fa3ff);
    width: 100%;
  }
</style>
