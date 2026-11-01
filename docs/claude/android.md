# Android app

> Part of the project docs split out of CLAUDE.md (index: `CLAUDE.md`). Read when: touching android/, nsshim.js, the WebView shell, AudioRoute or the in-app Deezer login.

## Android app

`android/` is a native Kotlin app: a fullscreen WebView hosts the SPA (`<server>/app/`,
configured at first launch: URL + optional port + SSL-verify toggle for self-signed certs)
while `PlayerService` (foreground service + MediaSessionCompat) keeps the process alive in
the background and owns the media notification / lockscreen / Bluetooth controls. Audio
stays in the WebView — the native side is only a remote control + keep-alive. The bridge is
`android/app/src/main/assets/nsshim.js`, injected at document start: it REPLACES
`navigator.mediaSession` and forwards the metadata/playbackState/positionState/action-handlers
that `Player.svelte` already maintains to `window.NSNative.publish()`, and routes transport
commands back via `window.__nsNativeCmd()`. No webapp-side code is involved, so the app works
against any deployed SPA version. Build: `gradle -p android assembleRelease` (JDK 17, SDK 34 —
CI does this; no wrapper is committed).

**Surviving a long background stay.** Everything the app *is* — the audio, the queue, the UI —
lives in the WebView's renderer process, which Android may kill whenever nobody is looking at it;
the app process itself is only safe while the foreground service is up (it isn't, once playback
wound down or the paused notification was swiped away). A killed renderer leaves a WebView that
can only ever show a blank page again, which is why "paused in the background too long" used to
mean "restart the app". So MainActivity **rebuilds** the WebView (`rebuildWebView`, on the screen
`doUpdateVisitedHistory` last saw) instead of restarting the activity, and does it **when the user
comes back**, never in the background — a background reload can fail (off the home LAN) and park
the app on an error screen, and the renderer it builds is just as killable. `onRenderProcessGone`
therefore only flags `pendingRebuild` (and drops the now-dead media notification); `onResume`
rebuilds it, retries a load that failed while we were away, and — after a long absence, and only
while nothing is playing — pings the page and rebuilds it if it doesn't answer, which is the one
thing that catches a renderer wedged rather than killed. The SPA persists its session, so a
rebuilt page comes back on the same track at the same position. Having actually caught Android
doing it is also the only moment the app offers the battery-optimization exemption
(`offerBatteryExemptionOnce`, once ever) — the setup screen keeps the same button.

**Naming the audio output** (`AudioRoute`): a fault measured on the processed path sends ONE
CONNECTION of an output direct (see *Where the sound goes* below), and a WebView cannot see what it
plays to, so the activity lists AudioManager's output devices (no permission needed; a Bluetooth
device's product name is its advertised name), ranks them the way Android routes media — Bluetooth
(A2DP, LE, hearing aid), USB, wired, HDMI, speaker — and pushes `{kind, name, conn}` to
`window.__nsAudioRoute` on every change (`registerAudioDeviceCallback`); the page reads the first one
through `NSNative.audioRoute()`. `conn` changes whenever the chosen device does (the radio gone and
back is two changes), prefixed with the process's start time so a stored verdict never matches a
later process's connection by accident. The name is reduced to printable characters before it
reaches a page. An older APK reports nothing: verdicts are then per page's own guess of the output
(the latency its context reports) and live until their retry.

**Linking the Deezer account from the app** (`DeezerLoginActivity`): there is no email/password
endpoint left that a server could call — Deezer's web one (`ajax/action.php` + reCAPTCHA) answers
403 since 2024, and the mobile gateway (`mobile_userAuth`, which *does* return an ARL) needs keys
extracted from Deezer's own binaries. So the only remaining path to an ARL is a real browser
session, and the app provides one: a throwaway WebView loads **Deezer's own login page**, the user
signs in there, and the `arl` cookie Deezer sets is read out of the jar and handed back through
`window.__nsDeezerArl` to `Réglages → Compte Deezer`, which saves it via `/api/settings` (already
validating + probing it). **The password never reaches the app or the server**; only the ARL
crosses back, and only to a page served by the configured server (`MainActivity.deliverArl` checks
the origin). That WebView gets **no `NSNative` bridge**. The Deezer jar is wiped on entry (so the
ARL is always the account just typed) and again on success (no second copy left on the device) —
scoped to `deezer.com`, never `removeAllCookies()`, which would log the user out of their own
server. Cookie arrival is polled (~600 ms, only while the screen is up): Deezer's login is an XHR,
so no navigation fires and there is no cookie-change callback to hook. Google/Apple SSO is refused
inside any WebView — email + password is the supported route. SPA side: `lib/nativeDeezer.js`.
