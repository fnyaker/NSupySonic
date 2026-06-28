<script>
  import { contextMenu, closeMenu } from "../lib/stores.js";
  import { tick } from "svelte";
  import Icon from "./Icon.svelte";

  let el;
  let pos = { x: 0, y: 0 };
  let openSub = null;

  // Clamp the menu inside the viewport once it's rendered (desktop floating
  // menu only — on mobile it's a bottom-anchored sheet).
  $: if ($contextMenu) place($contextMenu);

  async function place(menu) {
    openSub = null;
    pos = { x: menu.x, y: menu.y };
    await tick();
    if (!el) return;
    if (window.matchMedia("(max-width: 640px)").matches) return; // sheet: no clamp
    const r = el.getBoundingClientRect();
    const pad = 8;
    let x = menu.x;
    let y = menu.y;
    if (x + r.width + pad > window.innerWidth) x = window.innerWidth - r.width - pad;
    if (y + r.height + pad > window.innerHeight) y = window.innerHeight - r.height - pad;
    pos = { x: Math.max(pad, x), y: Math.max(pad, y) };
  }

  function toggleSub(item) {
    openSub = openSub === item ? null : item;
  }

  // A submenu opens on tap/click (works on touch, unlike the old hover); leaf
  // items run their action and close the menu.
  function run(item) {
    if (item.sub) {
      toggleSub(item);
      return;
    }
    closeMenu();
    item.action?.();
  }
</script>

<svelte:window on:keydown={(e) => e.key === "Escape" && closeMenu()} />

{#if $contextMenu}
  <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
  <div
    class="backdrop"
    on:click={closeMenu}
    on:contextmenu|preventDefault|stopPropagation={closeMenu}
  ></div>
  <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
  <div
    class="menu"
    role="menu"
    tabindex="-1"
    bind:this={el}
    style="left:{pos.x}px; top:{pos.y}px"
    on:click|stopPropagation
    on:contextmenu|preventDefault|stopPropagation
  >
    {#each $contextMenu.items as item}
      {#if item === "divider"}
        <div class="divider"></div>
      {:else if item.sub}
        <button
          type="button"
          class="item has-sub"
          class:expanded={openSub === item}
          role="menuitem"
          on:click|stopPropagation={() => toggleSub(item)}
        >
          <span class="ic"><Icon name={item.icon} size={17} /></span>
          <span class="lbl">{item.label}</span>
          <span class="chev"><Icon name="chevronRight" size={15} /></span>
        </button>
        {#if openSub === item}
          <div class="submenu" role="menu">
            {#if item.sub.length}
              {#each item.sub as sit}
                <button type="button" class="item sub" role="menuitem" on:click={() => run(sit)}>
                  <span class="ic"><Icon name={sit.icon} size={17} /></span>
                  <span class="lbl">{sit.label}</span>
                </button>
              {/each}
            {:else}
              <div class="item sub empty">Aucune playlist</div>
            {/if}
          </div>
        {/if}
      {:else}
        <button type="button" class="item" role="menuitem" class:danger={item.danger} on:click={() => run(item)}>
          <span class="ic"><Icon name={item.icon} size={17} /></span>
          <span class="lbl">{item.label}</span>
        </button>
      {/if}
    {/each}
  </div>
{/if}

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 290;
  }
  .menu {
    position: fixed;
    z-index: 300;
    min-width: 220px;
    max-height: 70vh;
    overflow-y: auto;
    background: #282433;
    border: 1px solid #3a3448;
    border-radius: 10px;
    padding: 6px;
    box-shadow: 0 16px 50px rgba(0, 0, 0, 0.55);
    font-size: 0.9rem;
  }
  .item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 9px 10px;
    border-radius: 7px;
    cursor: pointer;
    position: relative;
    white-space: nowrap;
    width: 100%;
    text-align: left;
    font: inherit;
    color: inherit;
  }
  .item:hover {
    background: var(--bg-hover);
  }
  .item.danger {
    color: var(--accent-2);
  }
  .item.empty {
    color: var(--text-dim);
    cursor: default;
  }
  .item.empty:hover {
    background: none;
  }
  .has-sub .chev {
    margin-left: auto;
    color: var(--text-dim);
    transition: transform 0.15s ease;
  }
  .has-sub.expanded .chev {
    transform: rotate(90deg);
  }
  .ic {
    width: 18px;
    text-align: center;
    opacity: 0.85;
  }
  .lbl {
    flex: 1;
  }
  .divider {
    height: 1px;
    background: #3a3448;
    margin: 5px 8px;
  }
  /* Submenu expands inline (accordion) so it works the same with a mouse or a
     finger — the old side-positioned, hover-only flyout was unusable on touch. */
  .submenu {
    max-height: 40vh;
    overflow-y: auto;
  }
  .item.sub {
    padding-left: 34px;
  }

  /* Phone: render as a bottom sheet with large tap targets. */
  @media (max-width: 640px) {
    .backdrop {
      background: rgba(0, 0, 0, 0.5);
    }
    .menu {
      left: 0 !important;
      right: 0;
      top: auto !important;
      bottom: 0;
      width: 100%;
      min-width: 0;
      max-height: 78vh;
      border-radius: 16px 16px 0 0;
      padding: 8px 8px calc(10px + env(safe-area-inset-bottom));
      animation: sheet-up 0.18s ease;
    }
    .item {
      padding: 14px 14px;
      font-size: 1rem;
      border-radius: 10px;
    }
    .item.sub {
      padding-left: 40px;
    }
    .submenu {
      max-height: 42vh;
    }
  }
  @keyframes sheet-up {
    from {
      transform: translateY(100%);
    }
    to {
      transform: none;
    }
  }
</style>
