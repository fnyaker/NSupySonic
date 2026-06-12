<script>
  import { contextMenu, closeMenu } from "../lib/stores.js";
  import { tick } from "svelte";
  import Icon from "./Icon.svelte";

  let el;
  let pos = { x: 0, y: 0 };
  let openSub = null;

  // Clamp the menu inside the viewport once it's rendered.
  $: if ($contextMenu) place($contextMenu);

  async function place(menu) {
    openSub = null;
    pos = { x: menu.x, y: menu.y };
    await tick();
    if (!el) return;
    const r = el.getBoundingClientRect();
    const pad = 8;
    let x = menu.x;
    let y = menu.y;
    if (x + r.width + pad > window.innerWidth) x = window.innerWidth - r.width - pad;
    if (y + r.height + pad > window.innerHeight) y = window.innerHeight - r.height - pad;
    pos = { x: Math.max(pad, x), y: Math.max(pad, y) };
  }

  function run(item) {
    if (item.sub) return;
    closeMenu();
    item.action?.();
  }
</script>

<svelte:window
  on:click={() => $contextMenu && closeMenu()}
  on:keydown={(e) => e.key === "Escape" && closeMenu()}
  on:contextmenu={(e) => {
    // Allow our own openMenu calls (they stopPropagation); close otherwise.
    if ($contextMenu) closeMenu();
  }}
/>

{#if $contextMenu}
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
        <div
          class="item has-sub"
          role="menuitem"
          tabindex="0"
          on:mouseenter={() => (openSub = item)}
          on:focus={() => (openSub = item)}
        >
          <span class="ic"><Icon name={item.icon} size={17} /></span>
          <span class="lbl">{item.label}</span>
          <span class="chev"><Icon name="chevronRight" size={15} /></span>
          {#if openSub === item}
            <div class="submenu" role="menu">
              {#if item.sub.length}
                {#each item.sub as sit}
                  <button type="button" class="item" role="menuitem" on:click={() => run(sit)}>
                    <span class="ic"><Icon name={sit.icon} size={17} /></span>
                    <span class="lbl">{sit.label}</span>
                  </button>
                {/each}
              {:else}
                <div class="item empty">Aucune playlist</div>
              {/if}
            </div>
          {/if}
        </div>
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
  .menu {
    position: fixed;
    z-index: 300;
    min-width: 220px;
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
  .ic {
    width: 18px;
    text-align: center;
    opacity: 0.85;
  }
  .lbl {
    flex: 1;
  }
  .chev {
    color: var(--text-dim);
  }
  .divider {
    height: 1px;
    background: #3a3448;
    margin: 5px 8px;
  }
  .submenu {
    position: absolute;
    left: 100%;
    top: -6px;
    margin-left: 2px;
    min-width: 200px;
    max-height: 320px;
    overflow-y: auto;
    background: #282433;
    border: 1px solid #3a3448;
    border-radius: 10px;
    padding: 6px;
    box-shadow: 0 16px 50px rgba(0, 0, 0, 0.55);
  }
</style>
