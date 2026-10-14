<script>
  // "Reload the app from scratch" (lib/hardreload.js), in two dresses: a plain
  // button for Réglages → Diagnostic, and — `gl` — the notice the animation
  // settings show when this document was refused WebGL, which is exactly the
  // state the button exists to get out of.
  import Icon from "./Icon.svelte";
  import { hardReload } from "../lib/hardreload.js";

  export let gl = false;

  let busy = false;
  async function go() {
    if (busy) return;
    busy = true;
    try {
      await hardReload();
    } catch {
      busy = false;
    }
  }
</script>

{#if gl}
  <div class="glwrap"><div class="gl" role="status">
    <span class="ico"><Icon name="alert" size={18} /></span>
    <div class="txt">
      <strong>Le navigateur refuse l'accélération graphique</strong>
      <span>
        Seules les barres et l'oscilloscope peuvent s'afficher. Cela arrive après un
        plantage du GPU&nbsp;: rechargez l'application, et si rien ne change,
        redémarrez le navigateur.
      </span>
    </div>
    <button class="btn" on:click={go} disabled={busy}>
      <Icon name="refresh" size={16} />
      {busy ? "Rechargement…" : "Recharger"}
    </button>
  </div></div>
{:else}
  <button class="btn plain" on:click={go} disabled={busy}>
    <Icon name="refresh" size={16} />
    {busy ? "Rechargement…" : "Recharger l'application de zéro"}
  </button>
{/if}

<style>
  /* Laid out on its own width: the settings column is phone-narrow on a
     phone and in a narrow window alike. */
  .glwrap {
    container: hardreload / inline-size;
    margin: 14px 0 4px;
  }
  .gl {
    display: grid;
    grid-template-columns: auto 1fr auto;
    align-items: center;
    column-gap: 14px;
    row-gap: 12px;
    padding: 14px 16px;
    border-radius: 12px;
    background: color-mix(in srgb, #ffb020 9%, var(--bg-elev));
    border: 1px solid color-mix(in srgb, #ffb020 30%, transparent);
  }
  .ico {
    flex: none;
    display: grid;
    place-items: center;
    width: 34px;
    height: 34px;
    border-radius: 50%;
    color: #ffb020;
    background: color-mix(in srgb, #ffb020 14%, transparent);
  }
  .txt {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
    font-size: 13px;
    line-height: 1.45;
    color: var(--text-dim);
  }
  .txt strong {
    color: var(--text);
    font-size: 14px;
    font-weight: 600;
  }
  .btn {
    flex: none;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    min-height: 40px;
    padding: 0 16px;
    border-radius: 999px;
    font-weight: 600;
    font-size: 14px;
    color: var(--text);
    background: var(--bg-hover);
    transition: background 0.15s;
  }
  .btn:hover:not(:disabled) {
    background: color-mix(in srgb, var(--text) 14%, var(--bg-hover));
  }
  .btn:disabled {
    opacity: 0.6;
  }
  .btn.plain {
    margin-top: 12px;
  }
  @container hardreload (max-width: 560px) {
    .gl {
      grid-template-columns: auto 1fr;
      align-items: start;
    }
    .gl .btn {
      grid-column: 2;
      justify-self: start;
    }
  }
</style>
