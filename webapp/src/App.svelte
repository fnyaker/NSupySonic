<script>
  import Router from "svelte-spa-router";
  import { onMount } from "svelte";
  import { user, authChecked, nowPlayingOpen, player } from "./lib/stores.js";
  import { api } from "./lib/api.js";
  import { loadFavorites } from "./lib/actions.js";
  import Sidebar from "./components/Sidebar.svelte";
  import BackButton from "./components/BackButton.svelte";
  import MobileNav from "./components/MobileNav.svelte";
  import Player from "./components/Player.svelte";
  import NowPlaying from "./components/NowPlaying.svelte";
  import Toasts from "./components/Toasts.svelte";
  import ContextMenu from "./components/ContextMenu.svelte";
  import Login from "./routes/Login.svelte";
  import Home from "./routes/Home.svelte";
  import Search from "./routes/Search.svelte";
  import Artist from "./routes/Artist.svelte";
  import Album from "./routes/Album.svelte";
  import Playlist from "./routes/Playlist.svelte";
  import Mix from "./routes/Mix.svelte";
  import Library from "./routes/Library.svelte";

  const routes = {
    "/": Home,
    "/search": Search,
    "/search/:q": Search,
    "/artist/:id": Artist,
    "/album/:id": Album,
    "/playlist/:id": Playlist,
    "/mix/:id": Mix,
    "/library": Library,
  };

  onMount(async () => {
    try {
      const r = await api.me();
      user.set(r.user);
      loadFavorites();
    } catch {
      user.set(null);
    } finally {
      authChecked.set(true);
    }
  });

  // Reload favorites whenever a user logs in.
  $: if ($user) loadFavorites();

  function onKey(e) {
    const tag = (e.target.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || e.target.isContentEditable) return;
    if (!$user) return;
    switch (e.key) {
      case " ":
        e.preventDefault();
        player.toggle();
        break;
      case "ArrowRight":
        if (e.ctrlKey || e.metaKey) player.next();
        break;
      case "ArrowLeft":
        if (e.ctrlKey || e.metaKey) player.prev();
        break;
      case "m":
        player.toggleMute();
        break;
      case "s":
        player.toggleShuffle();
        break;
      case "r":
        player.cycleRepeat();
        break;
    }
  }
</script>

<svelte:window on:keydown={onKey} />

{#if !$authChecked}
  <div class="loading">…</div>
{:else if !$user}
  <Login />
{:else}
  <div class="layout" class:np-open={$nowPlayingOpen}>
    <Sidebar />
    <BackButton />
    <main>
      <Router {routes} />
    </main>
    {#if $nowPlayingOpen}
      <NowPlaying />
    {/if}
  </div>
  <MobileNav />
  <Player />
{/if}

<Toasts />
<ContextMenu />

<style>
  .layout {
    display: grid;
    grid-template-columns: var(--sidebar-w) 1fr;
    height: 100vh;
    padding-bottom: var(--player-h);
  }
  /* The Now-Playing panel is a real third column only on wide screens. On
     narrower (but still desktop) windows it floats as an overlay instead, so
     the main content keeps a usable width — see NowPlaying.svelte. */
  @media (min-width: 1025px) {
    .layout.np-open {
      grid-template-columns: var(--sidebar-w) 1fr var(--np-w);
    }
  }
  /* Phone-sized only: collapse to a single column with the mini player +
     bottom nav. Above this the desktop shell (sidebar + full player) stays,
     so narrow PC windows look like the full desktop UI rather than a hybrid. */
  @media (max-width: 640px) {
    .layout,
    .layout.np-open {
      grid-template-columns: 1fr;
      padding-bottom: calc(60px + 56px); /* mini player + mobile nav */
    }
  }
</style>
