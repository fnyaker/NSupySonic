<script>
  import Router from "svelte-spa-router";
  import { onMount } from "svelte";
  import { user, authChecked, nowPlayingOpen, player } from "./lib/stores.js";
  import { api } from "./lib/api.js";
  import { initConnectivity, online } from "./lib/net.js";
  import { loadOfflineIndex, loadCoverCache } from "./lib/offline.js";
  import { initPlayCache } from "./lib/playcache.js";
  import { initQueueFilter } from "./lib/playfilter.js";
  import { loadFavorites } from "./lib/actions.js";
  import Sidebar from "./components/Sidebar.svelte";
  import BackButton from "./components/BackButton.svelte";
  import MobileNav from "./components/MobileNav.svelte";
  import Player from "./components/Player.svelte";
  import NowPlaying from "./components/NowPlaying.svelte";
  import Toasts from "./components/Toasts.svelte";
  import ContextMenu from "./components/ContextMenu.svelte";
  import NetworkIndicator from "./components/NetworkIndicator.svelte";
  import Login from "./routes/Login.svelte";
  import Home from "./routes/Home.svelte";
  import Search from "./routes/Search.svelte";
  import Artist from "./routes/Artist.svelte";
  import Album from "./routes/Album.svelte";
  import Playlist from "./routes/Playlist.svelte";
  import Mix from "./routes/Mix.svelte";
  import Library from "./routes/Library.svelte";
  import Settings from "./routes/Settings.svelte";

  const routes = {
    "/": Home,
    "/search": Search,
    "/search/:q": Search,
    "/artist/:id": Artist,
    "/album/:id": Album,
    "/playlist/:id": Playlist,
    "/mix/:id": Mix,
    "/library": Library,
    "/settings": Settings,
  };

  const SAVED_USER = "auth.user";
  function savedUser() {
    try {
      return JSON.parse(localStorage.getItem(SAVED_USER) || "null");
    } catch {
      return null;
    }
  }
  // Snapshot the persisted session at module init — before any reactive block
  // could touch localStorage — so the offline boot always sees it.
  const bootSaved = savedUser();

  let bootedOffline = false;

  onMount(async () => {
    initConnectivity();
    initQueueFilter();
    loadOfflineIndex();
    loadCoverCache();
    initPlayCache();

    // Airplane-mode launch: if we're offline but have a remembered session, boot
    // straight into the (downloaded) library instead of stalling on the login
    // screen; re-validate once we're back online.
    const saved = bootSaved;
    if (saved && typeof navigator !== "undefined" && !navigator.onLine) {
      user.set(saved);
      bootedOffline = true;
      authChecked.set(true);
      return;
    }
    try {
      const r = await api.me();
      user.set(r.user);
      loadFavorites();
    } catch (e) {
      // Network failure with a known session -> stay logged in (offline); a real
      // 401/expired session clears it.
      if (e && e.offline && saved) {
        user.set(saved);
        bootedOffline = true;
      } else {
        user.set(null);
      }
    } finally {
      authChecked.set(true);
    }
  });

  // Persist / clear the session so an offline launch can trust it. Guard on
  // authChecked: this reactive block runs once at init with $user still null
  // (before onMount), and without the guard it would wipe the saved session
  // right before onMount reads it — so an offline launch fell back to the login
  // screen. Only touch storage once auth has actually been resolved.
  $: if ($authChecked) {
    try {
      if ($user) localStorage.setItem(SAVED_USER, JSON.stringify($user));
      else localStorage.removeItem(SAVED_USER);
    } catch {
      /* ignore */
    }
  }

  // Reload favorites whenever a user logs in.
  $: if ($user) loadFavorites();

  // Re-validate the session once connectivity returns after an offline boot.
  $: if (bootedOffline && $online) revalidate();
  async function revalidate() {
    bootedOffline = false;
    try {
      const r = await api.me();
      user.set(r.user);
      loadFavorites();
    } catch (e) {
      if (!(e && e.offline)) user.set(null); // genuine auth failure -> log out
    }
  }

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
<NetworkIndicator />

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
