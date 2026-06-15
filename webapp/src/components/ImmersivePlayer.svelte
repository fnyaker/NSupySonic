<script>
  // Full-screen now-playing. Mobile and desktop are deliberately two separate
  // components — the experiences are different enough that one responsive layout
  // just fought itself.
  import { onMount } from "svelte";
  import { immersiveOpen, current } from "../lib/stores.js";
  import MobileNowPlaying from "./MobileNowPlaying.svelte";
  import DesktopNowPlaying from "./DesktopNowPlaying.svelte";

  let mobile = false;
  const mq = "(max-width: 640px)";
  if (typeof window !== "undefined") mobile = window.matchMedia(mq).matches;

  onMount(() => {
    const m = window.matchMedia(mq);
    const on = () => (mobile = m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  });
</script>

{#if $immersiveOpen && $current}
  {#if mobile}
    <MobileNowPlaying />
  {:else}
    <DesktopNowPlaying />
  {/if}
{/if}
