<script>
  import { link, location } from "svelte-spa-router";
  import Icon from "./Icon.svelte";

  $: active = (prefix) =>
    $location === prefix || (prefix !== "/" && $location.startsWith(prefix))
      ? "active"
      : "";
</script>

<nav class="mobilenav">
  <a use:link href="/" class={active("/")}>
    <Icon name="home" size={22} /><span class="l">Accueil</span>
  </a>
  <a use:link href="/search" class={active("/search")}>
    <Icon name="search" size={22} /><span class="l">Rechercher</span>
  </a>
  <a use:link href="/library" class={active("/library")}>
    <Icon name="library" size={22} /><span class="l">Biblio</span>
  </a>
</nav>

<style>
  .mobilenav {
    display: none;
  }
  @media (max-width: 820px) {
    .mobilenav {
      position: fixed;
      left: 0;
      right: 0;
      bottom: 60px; /* above the mini player */
      height: 56px;
      display: flex;
      background: var(--bg-elev);
      border-top: 1px solid var(--bg-hover);
      z-index: 40;
    }
    .mobilenav a {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 2px;
      color: var(--text-dim);
      font-size: 0.7rem;
    }
    .mobilenav a.active {
      color: var(--text);
    }
    .i {
      font-size: 1.1rem;
    }
  }
</style>
