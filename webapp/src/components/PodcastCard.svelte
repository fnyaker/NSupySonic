<script>
  import { push } from "svelte-spa-router";
  import { subscribeToPodcast } from "../lib/actions.js";
  import Cover from "./Cover.svelte";
  import Icon from "./Icon.svelte";

  // item: a podcast search result {deezer_id, title, cover, description}
  export let item;

  let busy = false;

  async function add() {
    if (busy) return;
    busy = true;
    try {
      const c = await subscribeToPodcast(item.deezer_id);
      if (c?.id) push("/podcast/" + c.id);
    } finally {
      busy = false;
    }
  }
</script>

<div
  class="card"
  role="button"
  tabindex="0"
  title={item.title}
  on:click={add}
  on:keydown={(e) => e.key === "Enter" && add()}
>
  <div class="cv">
    <Cover src={item.cover} alt={item.title} kind="podcast" />
    <button
      class="add"
      class:spin={busy}
      on:click|stopPropagation={add}
      disabled={busy}
      aria-label="S'abonner"
    >
      <Icon name={busy ? "refresh" : "plus"} size={18} />
    </button>
  </div>
  <div class="meta">
    <div class="title">{item.title}</div>
    <div class="sub muted">Podcast</div>
  </div>
</div>

<style>
  .card {
    display: block;
    text-align: left;
    padding: 12px;
    border-radius: var(--radius);
    background: var(--bg-card);
    transition: background 0.12s ease;
    width: 100%;
    cursor: pointer;
  }
  .card:hover {
    background: var(--bg-hover);
  }
  .cv {
    position: relative;
  }
  .add {
    position: absolute;
    right: 8px;
    bottom: 8px;
    width: 44px;
    height: 44px;
    border-radius: 50%;
    background: linear-gradient(90deg, var(--accent), var(--accent-2));
    color: #fff;
    display: grid;
    place-items: center;
    box-shadow: 0 8px 20px rgba(0, 0, 0, 0.4);
    opacity: 0;
    transform: translateY(8px);
  }
  .card:hover .add,
  .add:focus {
    opacity: 1;
    transform: none;
  }
  .add:hover {
    transform: scale(1.07);
  }
  .add.spin :global(svg) {
    animation: spin 1s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  .meta {
    margin-top: 12px;
  }
  .title {
    font-weight: 700;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .sub {
    font-size: 0.85rem;
    margin-top: 2px;
  }
</style>
