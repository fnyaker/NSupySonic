<script>
  import Router from "svelte-spa-router";
  import { wrap } from "svelte-spa-router/wrap";
  import { onMount } from "svelte";
  import { user, authChecked, nowPlayingOpen, player } from "./lib/stores.js";
  import { api } from "./lib/api.js";
  import { initConnectivity, online } from "./lib/net.js";
  import { loadOfflineIndex, loadCoverCache } from "./lib/offline.js";
  import { initPlayCache } from "./lib/playcache.js";
  import { initGainCache } from "./lib/gaincache.js";
  import { initQueueFilter } from "./lib/playfilter.js";
  import { loadFavorites } from "./lib/actions.js";
  import { initPodcastProgress } from "./lib/podcastProgress.js";
  import { initVersionWatch } from "./lib/appversion.js";
  import { initNav } from "./lib/nav.js";
  import { initDeezerHealth } from "./lib/deezerhealth.js";
  import { initVizHost } from "./lib/viz/host.js";
  import { location } from "./lib/router.js";
  import Sidebar from "./components/Sidebar.svelte";
  import BackButton from "./components/BackButton.svelte";
  import MobileNav from "./components/MobileNav.svelte";
  import Player from "./components/Player.svelte";
  import NowPlaying from "./components/NowPlaying.svelte";
  import Toasts from "./components/Toasts.svelte";
  import Notices from "./components/Notices.svelte";
  import ContextMenu from "./components/ContextMenu.svelte";
  import PlaylistPicker from "./components/PlaylistPicker.svelte";
  import ShareSheet from "./components/ShareSheet.svelte";
  import ReplaceSheet from "./components/ReplaceSheet.svelte";
  import GenreTagSheet from "./components/GenreTagSheet.svelte";
  import ExportSheet from "./components/ExportSheet.svelte";
  import NetworkIndicator from "./components/NetworkIndicator.svelte";
  import Login from "./routes/Login.svelte";
  import Home from "./routes/Home.svelte";
  import Search from "./routes/Search.svelte";
  import Artist from "./routes/Artist.svelte";
  import Album from "./routes/Album.svelte";
  import Playlist from "./routes/Playlist.svelte";
  import Mix from "./routes/Mix.svelte";
  import Library from "./routes/Library.svelte";
  import Podcasts from "./routes/Podcasts.svelte";
  import Show from "./routes/Show.svelte";

  // THE HEAVY SCREENS LOAD WHEN THEY ARE OPENED, not at launch.
  //
  // Everything else here is what you see in the first second and is worth
  // having in the main bundle. These three are not: Réglages carries the whole
  // animation catalogue (eighteen worlds, eight dedicated genre scenes, a
  // 227-row skin table), the genre studio carries a WebAssembly trainer, and
  // the projector is a screen most people never open. Together they were about
  // a third of the bundle every visitor downloaded, parsed and compiled before
  // the first note played, which is the "everything got slower" this answers.
  //
  // Offline still works: the service worker stages every file the build emits,
  // not only the ones index.html points at (see vite.config.js and public/sw.js
  // — the manifest exists for exactly this).
  const routes = {
    "/": Home,
    "/search": Search,
    "/search/:q": Search,
    "/artist/:id": Artist,
    "/album/:id": Album,
    "/playlist/:id": Playlist,
    "/mix/:id": Mix,
    "/library": Library,
    "/podcasts": Podcasts,
    "/podcast/:id": Show,
    "/settings": wrap({ asyncComponent: () => import("./routes/Settings.svelte") }),
    "/genres": wrap({ asyncComponent: () => import("./routes/Genres.svelte") }),
  };

  // The projector renders outside the router (it is a screen, not a route), so
  // it is loaded by hand when this tab turns out to be one.
  let VizScreen = null;
  $: if (isDisplay && !VizScreen)
    import("./routes/Viz.svelte").then((m) => (VizScreen = m.default));

  // The projector window is a SCREEN, not a second copy of the app: no sidebar,
  // no nav, and above all no <Player> — a second player would be a second
  // stream, a second decode and a second playhead drifting out of sync with the
  // room. It renders on its own, outside the layout, and is fed by the playing
  // tab over a BroadcastChannel.
  $: isDisplay = $location === "/viz";

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
    initNav(() => mainEl);
    // Is the server serving a newer build than the one we're running? (And, in
    // the Android shell, is there a newer APK?) Both are fire-and-forget and
    // never block the boot.
    initVersionWatch();
    // Idle until a projector window announces itself; see lib/viz/host.js.
    // Not in the projector window itself: it has no audio to analyse, so a
    // publisher there could only ever answer another display with silence.
    if (!isDisplay) initVizHost();
    // The queue filter and library views read these indexes synchronously, so
    // load them BEFORE the UI mounts — otherwise an offline launch briefly sees
    // "nothing downloaded" and filters every track out. Fast: IDB metadata only.
    await Promise.all([loadOfflineIndex(), initPlayCache(), initGainCache()]);
    loadCoverCache();

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

  // Reload favorites + pull the server-side podcast positions at login.
  $: if ($user) {
    loadFavorites();
    initPodcastProgress();
    startHealthWatch();
  }
  // Watch the Deezer account (an expired ARL is otherwise a silent, total
  // outage). Once per session, not on every $user tick.
  let healthWatching = false;
  function startHealthWatch() {
    if (healthWatching) return;
    healthWatching = true;
    initDeezerHealth();
  }

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

  // The router swaps the page INSIDE <main>, which keeps its own scrollTop — so
  // opening an album from halfway down a long library used to drop you halfway
  // down (or at the very bottom, once the browser clamped the offset to the new,
  // shorter page). lib/nav.js owns that now: a fresh navigation starts at the
  // top, and going BACK restores the offset the screen was left at, together
  // with whatever else it remembered (a search query, a selected tab).
  let mainEl;

  function onKey(e) {
    const tag = (e.target.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select" || e.target.isContentEditable)
      return;
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

{#if isDisplay}
  {#if VizScreen}
    <svelte:component this={VizScreen} />
  {:else}
    <div class="loading">…</div>
  {/if}
{:else if !$authChecked}
  <div class="loading">…</div>
{:else if !$user}
  <Login />
{:else}
  <div class="layout" class:np-open={$nowPlayingOpen}>
    <Sidebar />
    <BackButton />
    <main bind:this={mainEl}>
      <Notices />
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
<PlaylistPicker />
<ShareSheet />
<ReplaceSheet />
<GenreTagSheet />
<ExportSheet />
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
