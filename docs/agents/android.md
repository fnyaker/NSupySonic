# Android app

Reference notes for agents working on this area. Read [CLAUDE.md](../../CLAUDE.md) first: its process and rules apply here. Other areas: [docs/agents/](./).


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

**Trust boundaries** (audit NS-19). "Verify SSL" unticked is **trust on first use**, never
trust-all (`Ssl.kt`): the setup screen learns the certificate with a handshake it refuses (nothing is
sent), shows its SHA-256 and pins it (`Prefs.pinFor`, per origin); the WebView pins on its first
`onReceivedSslError` if setup could not; afterwards a chain the system accepts OR that exact leaf
passes, a different one is "le certificat a changé", and re-saving the settings re-pins. Another
host is never relaxed. `Prefs.originOf` is the ONE definition of "our server" (scheme, host, port)
for the navigation guard, the shim, the bridge, the pin and the native fetches. `NSNative` answers
only while the top frame is the server's (`onServerPage`, raised by `loadServer` before the page
exists — the shim calls it at document start, before `onPageStarted` arrives). The manifest must
allow cleartext (a LAN server's host is unknown at build time), so http is narrowed in code to the
configured server: `shouldInterceptRequest` for the page, `Net.get` for native fetches — which also
follows redirects by hand so the session cookie only ever goes to the server. Mixed content is
never allowed; backup and device transfer exclude everything (`data_extraction_rules.xml`).

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

**Updating itself from the server** (`Updater.kt`, `supysonic/webui/androidapk.py`, `lib/appversion.js`). The app
fetches its update from ITS server, never from a page it sends the user to: `GET /api/android/apk` (login) serves
`[webapp] android_apk` (an operator's own build) or the GitHub release asset `nsupysonic.apk` of the declared
`android_version` on the repository `android_url` points at, downloaded once into `<cache_dir>/android/` (only
https to GitHub's hosts, a zip or nothing, 200 MB cap). `/api/version`'s `android.apk` says it can. The native side
checks the APK BEFORE asking Android — same package, higher versionCode, signed with the installed key (lineage
included) — so the page can say "signature différente" (a CI build without the signing secrets has a throwaway key)
instead of an installer error; then the "install unknown apps" permission (settings opened, resumed on return) and
the system installer (ACTION_VIEW on a FileProvider uri). `NSNative.bridgeVersion()` (2) is what the page may ask of
an APK: an older one answers nothing and keeps the "Télécharger" link. Progress: `window.__nsUpdate({state,…})`.
This is the delivery channel for the native audio work (study: `/mnt/project-files/natif/etude-rust-natif.md`).

**The native audio core** (`android/nscore`, Rust, `NsCore.kt`; lot N2 of the native-audio plan). The `rhythm`
crate — the analyser the web app runs in its AudioWorklet — compiled for the device, plus `dsp.rs`: the output chain
graph.js builds from Web Audio nodes (ReplayGain ramped, the equal-power fade on its quarter circle, the ten peaking
bands at Q 1.1 and the 120 Hz low shelf, the BiquadFilterNode formulas, and the bass lift's two DynamicsCompressorNodes — its compressor and the limiter after it — on Web Audio's soft-knee curve with its makeup gain, linked across channels; a chain with nothing on multiplies by the gain and nothing else).
Reached over JNI written against the C ABI (`jni.rs`: NewStringUTF and NewDirectByteBuffer at their jni.h slots, every
other argument a primitive); each object is a handle whose buffers are handed to Kotlin ONCE as direct ByteBuffers, and
0 is a no-op everywhere. `node test/compare.mjs` (after `cargo build --release`) drives the host build through those
very entry points from a desktop JVM (`NsCoreCheck.java`) and holds it to rhythm.wasm on six arranged records: no event
on a different frame, every field within 1e-3 of its value (measured: under 1.2e-5 — libm rounds differently in the last
bit, so equality is not the contract). `nscore/build-android.sh` builds arm64-v8a, armeabi-v7a and x86_64 with the
NDK's clang (16 KB pages) into `app/src/main/jniLibs/` (git-ignored; android.yaml runs it before Gradle). Optional:
an APK without it has `NsCore.available` false. `NSNative.nativeCore()` reports it (bridge version 3).

**The native player** (`NativeAudio.kt`, `lib/audio/nativeplayer.js`; lot N3). Réglages → Audio → *Lecteur de
l'application* (`audio.native.choice`, offered from bridge version 4; ON by default from bridge 6, where the app's player carries
the EQ, the bass lift and the animations too; `null` = the app decides, an old `audio.native` true carries over) makes the page's audio elements
Media3/ExoPlayer players in the app's process. Player.svelte is unchanged in logic: `makeEl` gets a
`NativeAudioElement`, the HTMLMediaElement subset it uses (src/load/play/pause/currentTime/volume/playbackRate/
buffered/the events), so the queue, the crossfade on the volumes, the party host and the timekeeper all read it as an
element; the setting changing hands the elements over like leaving Web Audio does (`stale` in Player.svelte), and the
plan is direct with `why: "native"`. The wire is `NSNative.naCreate(pageToken)` / `naCmd(id, json)` and
`window.__nsAudio(id, state)`; every command carries a sequence number the state echoes, and a field is adopted only from
a state that has seen the last command that could change it (a tick in flight must not undo a pause or a seek).
`currentTime` is interpolated between the 250 ms ticks and never steps back by less than 50 ms. Sources are the server's
URLs only, fetched by `ServerDataSource` through `Net` (Range, cookie, pin); one audio focus request for every player (a
crossfade plays two); players belong to the document that made them (a new token releases the old document's,
`pagehide` and the WebView's death release them). A `blob:` source (an IndexedDB download, until N4) plays on a real
`<audio>` inside the element.

**Effects and animations on the native player** (`NativeAnalysis.kt`, lot N5, bridge version 6). Each player's PCM
goes through `NsProcessor`, a Media3 `BaseAudioProcessor` in its `DefaultAudioSink` (16-bit, before Sonic): the Rust
chain with the EQ and the bass lift (`NSNative.naFx`, sent by `nativeplayer.js#sendFx` on every change of the three
stores), then a copy to ONE rhythm analyser — the player told to play last. Its frames go to the page in batches
(≤ 16 or 40 ms, base64) through `window.__nsFrames`, each stamped with the MEDIA time its audio starts at;
`engine.js` (`startNative`, `rh.native`) drives it with the worklet's own messages through `NSNative.naAnalysis` and
holds each frame until the element's `currentTime` (minus the trim) reaches it — ExoPlayer's position already counts
the output path. A frame 3 s ahead of the clock or 1 s behind it is a seek's leftover and dropped. Nothing passes
through the chain while there is no effect and no view (a copy, bit for bit). The normalization still rides on the
element's volume; the oscilloscope has no waveform on this path. `test/nativeanalysis.test.mjs` plays the app with
the shipped rhythm.wasm on an arranged record.

**When the app's player fails** (lot N6, `nativeplayer.js#noteNativeFault`, `Player.svelte#fallBackToPage`): a player
error (MEDIA_ERR_DECODE, i.e. ExoPlayer's decoder or audio-track codes, or `naCreate` refusing) is recorded in
`audio.native.fault` BEFORE the element's error fires, so `nativeAudioWanted` is already false and the playing track moves
to a page `<audio>` at the position it reached instead of being retried on the same player. A network error is not a fault.
It holds for a day and for that app version only (an update tries again); Réglages says so under the switch, which still
shows the setting, with *Réessayer maintenant*. `node test/native/run.mjs` drives both (bridge 6 default, a code 3 fault).

**Downloads in the app's storage** (`OfflineStore.kt`, `lib/nativeoffline.js`, `lib/offline.js`; lot N4, bridge
version 5). On an APK that has it, a download's AUDIO is a file in `filesDir/offline`, fetched by the app itself
(`Net`: cookie, pin, `Accept-Encoding: identity`), named by a hash of the page's key — no key names a path — and
published only once the whole body is there (an empty or short body is an error, the `.part` dropped). The page keeps
what it LISTS (the `meta` record, now `native: true`, and the cover) in IndexedDB and plays the file from
`<origin>/__nsoffline/<key>`, which `MainActivity.intercept` answers from disk with byte ranges — for the WebView and
for the requests the service worker passes on (`ServiceWorkerController`) — and which the native player reads straight
off the disk (`NativeAudio`'s `localFile`). The WebView applies a request's `Range` ITSELF to what
`shouldInterceptRequest` returns (it reads `available()` as the whole size and skips the start), so the
body is the file from byte 0, cut at the range's end (`RangeBody`, `RangeBodyTest` models Chromium's
loader): a stream already positioned at the start was skipped twice, and every read past the first
broke a download on the page's own `<audio>`. The Blobs an older APK left in IndexedDB move over ONCE at launch
(`offline.js#moveDownloadsToApp`): 768 KiB pieces as base64 through `offPut` (each must start where the last ended),
`offCommit` checked against the Blob's size, and only then the IndexedDB copy is deleted; a refusal leaves the page's
copy exactly as it was, and nothing moves with less than the Blob + 64 MB free. At launch a file no record lists is
dropped and a record whose file is gone is forgotten. `test/nativeoffline.test.mjs` (the logic) and
`node test/offline/run.mjs` (Chromium: the move byte for byte, the play off `/__nsoffline/`, a new download, the
Réglages list at two widths) pin it.

**Naming the audio output** (`AudioRoute`): a fault measured on the processed path sends ONE
CONNECTION of an output direct (see *Where the sound goes* in [playback.md](playback.md)), and a WebView cannot see what it
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
