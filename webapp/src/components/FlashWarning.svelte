<script>
  // The photosensitivity warning in front of "Débridé".
  //
  // It is the only flash level that goes past the WCAG general-flash threshold
  // (three a second), so it is the only one that asks first — and asks for a
  // deliberate act, not a click-through: the button stays disabled until the
  // box is ticked. Written to be READ: what the mode does, who it is dangerous
  // for (including people who do not know it), what to do if it goes wrong,
  // and the room — a projector's audience accepted nothing.
  import { createEventDispatcher, onMount, tick } from "svelte";
  import { fade, scale } from "svelte/transition";
  import Icon from "./Icon.svelte";

  export let reduced = false;

  const dispatch = createEventDispatcher();
  let agreed = false;
  let box;

  // Mounted on <body>: the settings page scrolls under a sticky preview, and
  // a fixed overlay inside anything with a transform is fixed to THAT, not to
  // the screen.
  function toBody(node) {
    document.body.appendChild(node);
    return {
      destroy() {
        node.parentNode?.removeChild(node);
      },
    };
  }

  function onKey(e) {
    if (e.key === "Escape") dispatch("cancel");
  }

  onMount(async () => {
    await tick();
    // Without preventScroll a phone opens the sheet scrolled down to the box,
    // past the explanation it is there to be read after.
    box?.focus({ preventScroll: true });
  });
</script>

<svelte:window on:keydown={onKey} />

<!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
<div class="overlay" use:toBody transition:fade={{ duration: 150 }} on:click|self={() => dispatch("cancel")}>
  <div
    class="sheet"
    role="alertdialog"
    aria-modal="true"
    aria-labelledby="fw-title"
    aria-describedby="fw-body"
    transition:scale={{ duration: 160, start: 0.97 }}
  >
    <header>
      <span class="badge"><Icon name="zap" size={20} /></span>
      <div class="ttl">
        <h2 id="fw-title">Flashs débridés</h2>
        <p class="muted">Un stroboscope, calé sur la musique.</p>
      </div>
      <button class="close" on:click={() => dispatch("cancel")} aria-label="Fermer"><Icon name="close" size={20} /></button>
    </header>

    <div class="body" id="fw-body">
      <p>
        Chaque frappe principale d'un drop devient un éclair, les grosses frappes plus fort
        encore, et les caisses claires d'une montée accélèrent jusqu'au drop — jusqu'à dix
        éclairs par seconde, plus intenses qu'en « Plein ». C'est au-delà du seuil de trois
        par seconde que les règles d'accessibilité fixent aux lumières clignotantes.
      </p>

      <div class="warn">
        <Icon name="alert" size={18} />
        <div>
          <strong>Risque pour les personnes photosensibles.</strong>
          Des flashs répétés peuvent déclencher une crise d'épilepsie, y compris chez
          quelqu'un qui n'en a jamais fait et ne se sait pas concerné. Arrêtez tout de
          suite en cas de vertige, de vision troublée, de secousses musculaires ou de
          perte de repères.
        </div>
      </div>

      <ul class="points">
        <li>
          <Icon name="cast" size={15} />
          <span>Sur l'écran séparé, pensez aux personnes présentes : elles n'ont rien accepté.</span>
        </li>
        <li>
          <Icon name="settings" size={15} />
          <span>Réversible à tout moment ici, et coupé d'office si l'appareil demande de réduire les animations.</span>
        </li>
      </ul>

      {#if reduced}
        <p class="reduced">
          <Icon name="info" size={15} />
          Votre appareil demande actuellement de réduire les animations : tant que ce réglage
          système est actif, aucun flash ne sera affiché.
        </p>
      {/if}

      <label class="agree">
        <input type="checkbox" bind:checked={agreed} bind:this={box} />
        <span>Je ne suis pas photosensible, et j'accepte ce risque pour cet appareil.</span>
      </label>
    </div>

    <footer>
      <button class="ghost" on:click={() => dispatch("cancel")}>Annuler</button>
      <button class="pill" disabled={!agreed} on:click={() => dispatch("accept")}>
        <Icon name="zap" size={16} />
        Activer
      </button>
    </footer>
  </div>
</div>

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.66);
    display: grid;
    place-items: center;
    z-index: 400;
    padding: 20px;
  }
  .sheet {
    background: var(--bg-elev);
    border-radius: 18px;
    width: min(480px, 100%);
    max-height: calc(100dvh - 40px);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    box-shadow: 0 30px 80px rgba(0, 0, 0, 0.55);
  }
  header {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 20px 20px 6px;
  }
  .badge {
    flex: none;
    display: grid;
    place-items: center;
    width: 42px;
    height: 42px;
    border-radius: 12px;
    color: #ffb547;
    background: rgba(255, 181, 71, 0.13);
    box-shadow: inset 0 0 0 1px rgba(255, 181, 71, 0.28);
  }
  .ttl {
    flex: 1;
    min-width: 0;
  }
  .ttl h2 {
    margin: 0;
    font-size: 1.15rem;
  }
  .ttl p {
    margin: 3px 0 0;
    font-size: 0.85rem;
  }
  .close {
    flex: none;
    align-self: flex-start;
    color: var(--text-dim);
  }
  .close:hover {
    color: var(--text);
  }
  .body {
    padding: 10px 20px 4px;
    overflow-y: auto;
    font-size: 0.9rem;
    line-height: 1.55;
  }
  .body > p {
    margin: 6px 0 14px;
    color: var(--text-dim);
  }
  .warn {
    display: flex;
    gap: 12px;
    padding: 13px 14px;
    border-radius: 12px;
    background: rgba(255, 92, 92, 0.1);
    box-shadow: inset 0 0 0 1px rgba(255, 92, 92, 0.3);
    color: var(--text);
    font-size: 0.86rem;
  }
  .warn :global(svg) {
    flex: none;
    margin-top: 2px;
    color: #ff6b6b;
  }
  .warn strong {
    display: block;
    margin-bottom: 2px;
  }
  .points {
    list-style: none;
    margin: 14px 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 9px;
    font-size: 0.84rem;
    color: var(--text-dim);
  }
  .points li {
    display: flex;
    gap: 10px;
  }
  .points :global(svg) {
    flex: none;
    margin-top: 3px;
  }
  .reduced {
    display: flex;
    gap: 10px;
    margin: 14px 0 0;
    font-size: 0.84rem;
    color: var(--text);
  }
  .reduced :global(svg) {
    flex: none;
    margin-top: 3px;
    color: var(--accent);
  }
  .agree {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    margin: 18px 0 8px;
    padding: 13px 14px;
    border-radius: 12px;
    background: var(--bg);
    cursor: pointer;
    font-size: 0.88rem;
    line-height: 1.45;
  }
  .agree input {
    flex: none;
    width: 18px;
    height: 18px;
    margin: 1px 0 0;
    accent-color: var(--accent);
    cursor: pointer;
  }
  footer {
    display: flex;
    justify-content: flex-end;
    align-items: center;
    gap: 10px;
    padding: 14px 20px 18px;
    border-top: 1px solid var(--bg-hover);
  }
  .ghost {
    color: var(--text-dim);
    padding: 10px 14px;
  }
  .ghost:hover {
    color: var(--text);
  }
  .pill {
    gap: 8px;
    min-height: 40px;
  }
  .pill:disabled {
    opacity: 0.45;
    cursor: default;
    transform: none;
  }
</style>
