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
  import { maybeResumeHosting } from "./lib/party/hostbridge.js";
  import { partySheet, genreBulkSheet, remoteSheet, immersiveOpen, current } from "./lib/stores.js";
  import { REMOTE, atLeast, claimToken, rememberRemote, forgetRemote, reloadHome } from "./lib/remote/mode.js";
  import { initRemoteHost, remoteHost } from "./lib/remote/hoststate.js";
  import PlayerBar from "./components/PlayerBar.svelte";
  // The "controlled by… / Couper" chip, fetched the moment this player is lent.
  let RemoteHostChip = null;
  $: if ($remoteHost.active && !RemoteHostChip)
    import("./components/RemoteHostChip.svelte").then((m) => (RemoteHostChip = m.default));
  // What only a REMOTE CONTROL runs (the controller loop, its banner) and what
  // only opening a link shows are fetched when this page turns out to be one:
  // everybody else's first screen does not pay for them.
  let RemoteBanner = null;
  let RemoteClaim = null;
  // Tagging a whole album is an admin's occasional act: its sheet is fetched
  // the first time one is opened, then stays mounted.
  let GenreBulkSheet = null;
  $: if ($genreBulkSheet && !GenreBulkSheet)
    import("./components/GenreBulkSheet.svelte").then((m) => (GenreBulkSheet = m.default)).catch(() => {});
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

  // A listen party GUEST is the same kind of screen: whoever opened the link
  // may have no account here at all, so it renders before (and without) the
  // login, the layout and the player — it plays through its own engine.
  $: partyId = $location.startsWith("/party/") ? $location.slice(7).split("/")[0] : null;
  let PartyScreen = null;
  $: if (partyId && !PartyScreen)
    import("./routes/Party.svelte").then((m) => (PartyScreen = m.default));
  // The host's sheet is loaded the first time it is opened (it carries the QR
  // encoder), then kept.
  let PartySheet = null;
  $: if ($partySheet && !PartySheet)
    import("./components/PartySheet.svelte").then((m) => (PartySheet = m.default));
  // The remote-control sheet, the same way (it carries the QR encoder too).
  let RemoteSheet = null;
  $: if ($remoteSheet && !RemoteSheet)
    import("./components/RemoteSheet.svelte").then((m) => (RemoteSheet = m.default));

  // Opening a remote-control link (#/rc/<token>): like a party guest, whoever
  // holds it may have no account here, so it renders before the login.
  $: rcToken = $location.startsWith("/rc/") ? claimToken("#" + $location) : null;
  $: if (rcToken && !RemoteClaim)
    import("./routes/RemoteClaim.svelte").then((m) => (RemoteClaim = m.default));
  // A remote control on the "queue" level lends the transport and the queue
  // and nothing else: the full-screen player IS the app, with nothing behind.
  const queueOnly = !!REMOTE && !atLeast("read");
  $: if (queueOnly && $current && !$immersiveOpen) immersiveOpen.set(true);

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
    // A party guest needs none of the app's own machinery (the library, the
    // offline indexes, the version watch): it is a page, not an install.
    if (partyId || rcToken) {
      authChecked.set(true);
      return;
    }
    if (REMOTE) {
      await bootRemote();
      return;
    }
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
      if (r.remote) {
        // This browser's session is a remote control now (claimed in another
        // tab): the page has to be rebuilt as one, from the first store up.
        rememberRemote(r.remote);
        reloadHome();
        return;
      }
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
  $: if ($authChecked && !REMOTE) {
    try {
      if ($user) localStorage.setItem(SAVED_USER, JSON.stringify($user));
      else localStorage.removeItem(SAVED_USER);
    } catch {
      /* ignore */
    }
  }

  // Reload favorites + pull the server-side podcast positions at login.
  $: if ($user && !REMOTE) {
    loadFavorites();
    initPodcastProgress();
    startHealthWatch();
    startPartyResume();
    startRemoteHosting();
  }
  // This device may have been lent (a remote-control link made on it): answer
  // whoever drives it. Once per session, only in the tab that plays.
  let remoteHosting = false;
  function startRemoteHosting() {
    if (remoteHosting || isDisplay || partyId) return;
    remoteHosting = true;
    initRemoteHost();
  }

  // A remote control's boot: nothing of this device's own (no offline index,
  // no play cache, no saved account — those are this browser's, not the
  // owner's), the controller loop first so an ended grant is caught by the
  // very first request, then the server's word on who we are.
  async function bootRemote() {
    initConnectivity();
    initNav(() => mainEl);
    initVersionWatch();
    const [ctl, banner] = await Promise.all([
      import("./lib/remote/controller.js"),
      import("./components/RemoteBanner.svelte"),
    ]);
    ctl.startController();
    RemoteBanner = banner.default;
    user.set({ name: REMOTE.owner, admin: REMOTE.level === "admin" });
    authChecked.set(true);
    try {
      const r = await api.me();
      if (!r.remote) {
        // The server no longer calls this session a remote control.
        forgetRemote();
        reloadHome();
        return;
      }
      rememberRemote(r.remote);
      user.set(r.user);
      if (atLeast("read")) loadFavorites();
    } catch {
      /* offline: the controller keeps trying and says so; an ended grant is
         its hook's business (lib/api.js#onRemoteEnded) */
    }
  }
  // A listen party this user was hosting outlives a reload: its guests are
  // still on the link. Once per session, and only in the tab that plays.
  let partyResumed = false;
  function startPartyResume() {
    if (partyResumed || isDisplay || partyId) return;
    partyResumed = true;
    maybeResumeHosting();
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
{:else if partyId}
  {#if PartyScreen}
    <svelte:component this={PartyScreen} id={partyId} />
  {:else}
    <div class="loading">…</div>
  {/if}
{:else if rcToken}
  {#if RemoteClaim}
    <svelte:component this={RemoteClaim} token={rcToken} />
  {:else}
    <div class="loading">…</div>
  {/if}
{:else if !$authChecked}
  <div class="loading">…</div>
{:else if !$user}
  <Login />
{:else if queueOnly}
  <!-- Remote control, "queue" level: the player and its queue, full screen.
       Until the controlled player has a track, a quiet wait. -->
  {#if !$current}
    <div class="rq-wait">
      <span class="muted">En attente du lecteur de {REMOTE.owner}…</span>
    </div>
  {/if}
  <PlayerBar />
  {#if RemoteBanner}<svelte:component this={RemoteBanner} />{/if}
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
  {#if REMOTE}
    <!-- The same bar and full-screen views, over somebody else's player: the
         engine is the one that stays home (lib/remote/controller.js). -->
    <PlayerBar />
    {#if RemoteBanner}<svelte:component this={RemoteBanner} />{/if}
  {:else}
    <Player />
    {#if RemoteHostChip}<svelte:component this={RemoteHostChip} />{/if}
  {/if}
{/if}

<Toasts />
<ContextMenu />
<PlaylistPicker />
<ShareSheet />
<ReplaceSheet />
<GenreTagSheet />
{#if GenreBulkSheet}<svelte:component this={GenreBulkSheet} />{/if}
<ExportSheet />
{#if !partyId}
  {#if PartySheet}<svelte:component this={PartySheet} />{/if}
  {#if RemoteSheet && !REMOTE}<svelte:component this={RemoteSheet} />{/if}
  <NetworkIndicator />
{/if}

<style>
  .rq-wait {
    min-height: 100dvh;
    display: grid;
    place-items: center;
    padding: 24px;
    padding-bottom: calc(var(--player-h) + 80px);
    font-size: 0.95rem;
  }
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
