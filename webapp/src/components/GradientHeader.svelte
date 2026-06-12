<script>
  import { dominantColor, rgb, darken } from "../lib/color.js";

  export let cover = null;

  let bg = "linear-gradient(180deg, #3a2a55, var(--bg) 70%)";

  $: updateColor(cover);

  async function updateColor(url) {
    const c = await dominantColor(url);
    bg = `linear-gradient(180deg, ${rgb(c, 0.9)} 0%, ${rgb(darken(c, 0.55), 1)} 55%, var(--bg) 100%)`;
  }
</script>

<div class="gh" style="background:{bg}">
  <div class="gh-inner">
    <slot />
  </div>
</div>

<style>
  .gh {
    margin: -28px -32px 8px;
    padding: 56px 32px 24px;
    transition: background 0.4s ease;
  }
  .gh-inner {
    display: flex;
    gap: 28px;
    align-items: flex-end;
  }
  @media (max-width: 640px) {
    .gh {
      margin: -20px -20px 8px;
      padding: 40px 20px 18px;
    }
    .gh-inner {
      flex-direction: column;
      align-items: flex-start;
      gap: 16px;
    }
  }
</style>
