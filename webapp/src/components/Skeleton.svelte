<script>
  export let kind = "shelf"; // shelf | list | header
  export let count = 6;
</script>

{#if kind === "header"}
  <div class="sk-header">
    <div class="sk sq"></div>
    <div class="lines">
      <div class="sk l sm"></div>
      <div class="sk l lg"></div>
      <div class="sk l md"></div>
    </div>
  </div>
{:else if kind === "list"}
  <div class="sk-list">
    {#each Array(count) as _}
      <div class="sk-row">
        <div class="sk sq sm"></div>
        <div class="sk l grow"></div>
        <div class="sk l tiny"></div>
      </div>
    {/each}
  </div>
{:else}
  <div class="shelf">
    {#each Array(count) as _}
      <div class="sk-card">
        <div class="sk sq"></div>
        <div class="sk l"></div>
        <div class="sk l sm"></div>
      </div>
    {/each}
  </div>
{/if}

<style>
  .sk {
    background: linear-gradient(90deg, #221e2c 25%, #2c2738 37%, #221e2c 63%);
    background-size: 400% 100%;
    animation: shimmer 1.4s ease infinite;
    border-radius: 8px;
  }
  @keyframes shimmer {
    0% {
      background-position: 100% 0;
    }
    100% {
      background-position: -100% 0;
    }
  }
  .sq {
    aspect-ratio: 1/1;
    width: 100%;
    border-radius: var(--radius);
  }
  .l {
    height: 12px;
    margin-top: 8px;
  }
  .l.sm {
    width: 60%;
  }
  .sk-card .l:last-child {
    width: 70%;
  }
  .sk-header {
    display: flex;
    gap: 28px;
    align-items: flex-end;
    margin-bottom: 16px;
  }
  .sk-header .sq {
    width: 200px;
    height: 200px;
    flex: none;
  }
  .lines {
    flex: 1;
    max-width: 360px;
  }
  .lines .lg {
    height: 36px;
  }
  .lines .md {
    width: 50%;
  }
  .sk-list {
    display: flex;
    flex-direction: column;
    gap: 12px;
    margin-top: 12px;
  }
  .sk-row {
    display: grid;
    grid-template-columns: 40px 1fr 50px;
    gap: 12px;
    align-items: center;
  }
  .sk-row .sq.sm {
    width: 40px;
    height: 40px;
  }
  .l.grow {
    margin: 0;
  }
  .l.tiny {
    margin: 0;
    width: 100%;
  }
</style>
