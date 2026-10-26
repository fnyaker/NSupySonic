# Providers, access, accounts

Reference notes for agents working on this area. Read [CLAUDE.md](../../CLAUDE.md) first: its process and rules apply here. Other areas: [docs/agents/](./).

**Providers (multi-provider plan, lot A)** (`supysonic/providers/`, `supysonic/sources.py`, plan `docs/multi-provider.md`).
Deezer and YouTube are meant to become two instances of one interface. Lot A lays the ground and
wires nothing to the hot paths yet:

- `providers/base.py` is the interface (`Provider`: id of at most 16 lowercase letters/digits, `role`
  main|fallback, `capabilities`, `available()` with no network, `health()`, `config_schema()`; values are plain
  dicts), `errors.py` carries the rule "a failure is never a verdict" (only `NotFound`/`Gone` may mark a
  SOURCE unavailable), `registry.py` is `app.providers` (order and switches in `Meta` `prov.order` /
  `prov.<id>.on`, third parties through the `supysonic.providers` entry points, a broken one is logged and
  skipped), `fake.py` is the test provider (real 0.2 s WAV, `gone`, outages, a per-method call counter;
  `tests/multi_helpers.py`). `app.deezer` is untouched.
- Schema `20261020`: `track_source` (PK `(provider, ref)`, index on `track`), `entity_ref` (`(kind, provider,
  ref)` to a UUID, no FK) and `provider_account`, filled from `deezer_id` / `youtube_id` by plain
  `INSERT ... SELECT` (idempotent; no existing row is touched). The legacy columns stay and are written too.
- `sources.attach` is the ONE general writer (idempotent, a ref belongs to one title, fills an empty legacy
  column); the importers use `attach_new` / `attach_entity`, one conflict-ignoring `INSERT` each and only when
  a row is CREATED (a first import costs one statement more per track, a re-sync none). **Lists never read
  `track_source`**; `for_tracks` is one statement per 500 ids.
- Identity: `ids.entity_uuid(provider, kind, ref)` gives Deezer's and YouTube's exact historical UUIDs
  (pinned by literals) and `uuid5(NS_PROVIDER, "<p>:<kind>:<ref>")` to anyone else;
  `webui/refs.resolve_ref` prefers what `track_source`/`entity_ref` know, and `resolve_tracks` accepts
  `<provider>:<ref>` beside UUIDs and Deezer ids in at most two statements.

**Providers, lot B: the three built-in adapters** (`providers/{deezer,youtube,local,builtin,http}.py`). They WRAP
what exists; nothing moved and no route reads them yet (lot E wires `/stream`).

- `DeezerAdapter(get_provider)` calls `app.deezer` through a getter on EVERY use (an admin saving a new ARL swaps the
  object; nothing is re-registered). Translation rule: transport failure (cause chain, `is_transport_failure`) is
  `ProviderUnavailable`, a dead ARL `ProviderAuth`, `TrackUnavailable` / `ShowUnavailable` (Deezer ANSWERED) `Gone`, any
  other Deezer answer a plain `ProviderError` that condemns nothing. Refs are checked numeric before any request.
  `get_album` / `get_playlist` return the FULL tracklist; `import_account` is a read-only generator (the import's own
  four calls). `offers` come from the gateway's `FILESIZE_*` and the licence. Reads: `[deezer] arl`, `DEEZER_ARL` and the
  ARL in `Meta` unchanged.
- `YoutubeAdapter` (role `fallback`) adds no request: `search` is `youtube.search`, `offers` asks nobody (Opus ~133k),
  `fetch` / `open_stream` download on a play (`download_audio`), a hold becomes `ProviderHeld`. Only
  `YoutubeUnavailable` is `Gone`. `LocalProvider` is AUDIO only, ref = the Track's UUID, path read from the database.
- **`Provider.configured()` is not `available()`**: "has what it needs" versus "reachable now". A provider nobody ever
  switched is on iff `configured()`, so an outage never reads as a provider that was never set up. **A provider's own
  switch** (`switch()` / `toggle(on)`, YouTube's `yt.enabled`) commands `enabled()` and `set_enabled()` writes it, so the
  Réglages switch and the registry cannot disagree.
- `providers/http.session(provider_id, hosts)` is the shared HTTP (timeout + per-host breaker); `reachable` / `retry_in`
  read the breaker with no request. The built-ins are registered outside tests only (`web.py`); tests call
  `register_builtin(registry, getter)`. `tests/test_detach_guard.py` has a list of allowed calls per provider and
  fails if the interface grows a write verb.

**Who may use a provider, for what (multi-provider §15, lot P1)** (`supysonic/providers/features.py`,
`supysonic/access.py`, `webui/accessapi.py`, `components/AccessSettings.svelte` + `WhoPicker.svelte`, Réglages →
*Sources*). A provider declares FEATURES (`features.CATALOGUE`: shared ones such as search, stream, browse, track_info,
artist_info…, and PERSONAL ones, my_tracks / my_artists / my_playlists…), what each needs (`none` / `account`), the
fields an info feature gives, its login modes (`auth_modes`) and whether it runs without an account. Info providers
(MusicBrainz, AcoustID, LRCLIB) are registered with role `info`. Rules: everything on disk is everybody's; a personal
feature serves the account's holder only and is never lent; a shared feature serves the holder and whoever a grant
names (`provider_grant`: `all`, `g:<group>`, `u:<user>`; feature `*` is the whole account, a per-feature row overrides
it). Groups are the admin's (`user_group`, `user_group_member`). `access.snapshot()` is read once and kept until Meta
`acc.v` moves (checked at most once a second): a check is dictionary lookups, no statement. The FIRST run on a server
(`acc.boot`) grants the server's Deezer account (a `provider_account` row of mode `server`, its ARL left where it was)
and YouTube's anonymous use to `all`, so an upgrade changes nothing. Enforcement: `webui._provider()` through the
`DEEZER_FEATURE` endpoint table (a refused person gets the route's local answer; a Deezer-only page is a 403
`X-NS-Error: deezer-denied`), `webui/youtube.allowed`, and Subsonic's stream (`api/media._may_use`). `/api/me` carries
`access` and the SPA hides what would be refused (`lib/access.js`). `tests/test_access.py`.

**Each person's own account and their library (lot P2)** (`supysonic/libraryimport.py`, `webui/myaccounts.py`,
`components/MyAccounts.svelte` + `AccountPicker.svelte`, Réglages → Sources → *Mes comptes*). A person links their own
Deezer (an ARL typed, or read off Deezer's login page by the Android app; checked by signing in, stored encrypted in
`provider_account.secret`, refused when it IS the server's account) or their YouTube Music (the export's pasted headers:
linking or unlinking one links or unlinks the other); the holder of the server account imports from that one. What the
account lists — followed artists, loved tracks, saved albums, playlists — is read through `library(kind)` and made into
THEIR rows: artists starred (so followed for Nouveautés; a YouTube channel matched by name to an existing artist and its
ref kept in `entity_ref`, which `youtube._artist_row` then reuses), tracks starred, albums with their tracklist,
playlists merged (one of the same id that is somebody else's is never touched). Rules: each item is imported ONCE
(`library_item`), so the local library counts after that; one unticked in the picker (`excluded`) is never imported and
an artist's or album's star comes off; nothing is written to the account and nothing is downloaded. Runs on linking,
from the button, and daily (`start_watcher`; an hour after an outage; stopped by a refused credential until relinked;
never under test unless `LIBRARY_IMPORT_INLINE`). Options and the last report live in `provider_account.options` (schema
`20261027`). Every route is the holder's own and `NEVER` for a remote session. `tests/test_library_import.py`.

**Which Deezer serves a person (lot P3)** (`supysonic/deezer/accounts.py`, `access.Snapshot.serving`,
`webui._provider`, `api/media._deezer_for`). Per request and per feature, the first account that can: the person's
OWN, then the server's (held or granted), then a personal one lent to them, then the ANONYMOUS use — the public API
alone (`accounts.public_api`, signed in as nobody), only for a feature the provider declares `auth: none`. An
account whose status is `auth`, or that Deezer refused at its last sign-in, is passed over. The SOUND only goes
through an account that may stream FLAC (`can_stream_lossless`, recorded at linking in `provider_account.options`,
asked once for older rows): a Free account serves search and pages, the archive stays FLAC. The anonymous Deezer use
is granted to `all` ONCE (`access.LATER_ANONYMOUS`, Meta `acc.anon.deezer`) so an admin's closing it sticks. With
no account the album, playlist and discography pages are built from the public API (`_public_album_page`, paged by
`next`); what needs the gateway is a 403 `deezer-denied`, never an outage. Deezer switched off on the server is no
public API either. `tests/test_multi_p3.py`.
