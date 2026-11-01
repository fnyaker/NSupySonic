# Remote control

> Part of the project docs split out of CLAUDE.md (index: `CLAUDE.md`). Read when: touching remote.py, lib/remote/, RemoteSheet, POLICY table, or adding any /api route (it must be classified).

**Remote control** (`supysonic/webui/remote.py`, `webapp/src/lib/remote/`, `components/RemoteSheet.svelte`,
`RemoteHostChip.svelte`, `RemoteBanner.svelte`, `routes/RemoteClaim.svelte`). The owner makes a
link on the device that PLAYS (the remote button next to the party's, in every player view) and
hands it over as a URL or a QR code; whoever opens it drives that player from their own phone,
**in the same app** — the same screens, the same components, pointed at another player. There is no
second interface to keep in step with the first, and that is the whole design:

- **A command is a player-store method said over the wire** (`commands.js`). On a controller the
  player store's methods are rebound (`controller.js#rebindPlayer`) to send `commandFor(name, args)`
  AND do it locally at once, so a tap answers instantly; on the controlled device `runCommand` calls
  the very same method on its own store, so the engine, the crossfade, the queue top-ups and the
  lock screen follow as if the owner had tapped. Seeking goes through `seekTo`, the engine's inbox,
  on both sides — which is why the player bar was split out of `Player.svelte` into
  `PlayerBar.svelte`: a controller mounts the bar and the full-screen views and **no audio engine
  at all** (`App.svelte`). Anything waiting on "this track can play" (`ladder.js`: the lyrics) is
  released by the controller per track, since no element will ever say so.
- **Four levels, each a superset of the last** (`LEVELS`): `queue` (transport, volume, the queue —
  opens straight onto the full-screen player with nothing behind it), `read` (the whole app
  read-only: browse, search, add to the queue, choose the animations), `full` (everything but
  administration, genre tagging included), `admin`. The UI hides what a level cannot do
  (`mode.js#CAN_BROWSE/CAN_KEEP/CAN_ADMIN`), but **the server's `POLICY` is the enforcement**: one
  table naming the lowest level for EVERY `/api` endpoint (by method where it splits), closed by
  default — an unlisted endpoint is refused to every remote session and a test fails until the new
  route is classified. What no level gets, because it takes the owner's hand off their own player:
  making or cutting links, the host's side of the channel, hosting a party, reporting plays.
- **The token is the capability**: `<id>.<HMAC(secret, id)[:24]>`. The row (`RemoteLink`) names the
  grant; only this process can mint or check a token, and a copy of the table opens nothing.
  Claiming is rate-limited. A claimed session IS the owner's (`uid`, `epoch`) plus `rc`, so what the
  holder sees is what the owner sees, narrowed by level on every request (`_remote_scope`); the
  browser's own account is kept aside (`rc_prev`) and handed back on leave, on a cut and on
  `/logout` — logging out of a borrowed session ends the loan, not the holder's own login. The
  legacy admin pages read another session key, so a remote session is never a login to them.
- **The owner keeps the hand.** A chip over their player ("Contrôlé par 1 appareil", `Couper`) for
  as long as anybody drives it, every link listed in the sheet with its own cut, "Tout couper", and
  the owner's own buttons work as they always did (last action wins). A cut ends the sessions it
  opened on their very next request; so do an expiry and a new password (the epoch).
- **Polling, never a held connection** — the listen party's rule, for the same reason. The host
  (`host.js`, fetched only once a live link points at this device — `hoststate.js` is all a launch
  carries) publishes its state on change plus a heartbeat and asks for commands every 0.7 s while a
  controller is there, 1.5 s otherwise, and stops when the server says no link is left. The
  controller reads the state about once a second (0.3 s right after a tap, 5 s hidden) and
  extrapolates the position from `{p, t}` on the server clock; `ack` (the last command the player
  ran) is what keeps a tap from flickering back. Measured end to end (`test/remote/run.mjs`): a tap
  lands on the owner's player in 0.55-0.7 s, a cut ends the controller in ~0.3 s.
- **It resumes on its own.** Both loops back off to a few seconds and ask at once on `online` /
  `visibilitychange`; a server restart is repaired by the host (a new channel `boot` id → it
  publishes everything again, its cursor kept in sessionStorage across a reload), and a command
  sent while it reconnects still lands. Commands are NOT queued across an outage — a pause pressed a
  minute ago is not what anyone wants — so one older than `CMD_TTL` (8 s) is dropped and a tap while
  offline says so. Measured: the controller is live again 60 ms after the network comes back.
- **The device's settings are mirrored, not shared** (`settings.js#MIRRORED`, from the persisted
  stores `stores.js` registers). A controller keeps its own under a `remote:` namespace so driving a
  friend's player never rewrites yours, and changes there are sent back as `set` commands (the
  animations at `read`, the rest at `full`, each value checked against the shape it holds). Never
  lent: `viz.flash.ack` — unleashed flashing is accepted on the device, by whoever is in front of it
  — and the output latency. A controller also restores no playback session, keeps no offline
  cache of the owner's library, records no history and draws no animation.
- **Links**: 1 h / 1 day / 7 days / unlimited, an optional name ("Salon"), at most 24 live per
  owner. `/rc/<token>` is the short link the QR carries (`spa.py`: a preview for link unfurlers,
  then `/app/#/rc/<token>`, relative so a path prefix survives), 404 for a malformed token. Both
  short links are built from the app's ROOT (`lib/applink.js#shortLink`: whatever precedes its
  `/app/` segment), never as `../rc/` from the page: a page whose path was not exactly `/app/`
  handed out `/app/rc/<token>`, which the SPA's file route took for a missing file (the token has
  a dot) and answered 404. Those links still open — the server serves both pages under `/app/`
  too, and where the service worker answers the navigation, `lib/linkrescue.js` (main.js's FIRST
  import, before the router reads the location) turns the path back into its hash route.
