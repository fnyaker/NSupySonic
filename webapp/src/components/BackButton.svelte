<script>
  // Floating "back" button for detail pages (album / artist / playlist / search…)
  // so you can always return to where you came from. Hash routing keeps real
  // browser history, so history.back() does the right thing; if there's nothing
  // to go back to (deep link / first load), fall back to Home.
  import { push } from "svelte-spa-router";
  import { location } from "../lib/router.js";
  import Icon from "./Icon.svelte";

  function back() {
    if (window.history.length > 1) window.history.back();
    else push("/");
  }

  // Only on detail pages (the ones you reach by tapping into something and from
  // which there's no nav entry to get back). Top-level routes (home / search /
  // library) stay clean — they're one tap away in the nav.
  const DETAIL = ["/album/", "/artist/", "/playlist/", "/mix/"];
  $: show = DETAIL.some((p) => $location.startsWith(p));
</script>

{#if show}
  <button class="back" on:click={back} aria-label="Retour" title="Retour">
    <Icon name="chevronLeft" size={22} />
  </button>
{/if}

<style>
  .back {
    position: fixed;
    top: 14px;
    left: calc(var(--sidebar-w) + 14px);
    z-index: 60;
    width: 38px;
    height: 38px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    color: var(--text);
    background: rgba(15, 13, 19, 0.55);
    backdrop-filter: blur(8px);
    box-shadow: 0 2px 10px rgba(0, 0, 0, 0.35);
  }
  .back:hover {
    background: rgba(15, 13, 19, 0.8);
  }
  @media (max-width: 640px) {
    .back {
      top: 10px;
      left: 12px;
      background: rgba(15, 13, 19, 0.45);
    }
  }
</style>
