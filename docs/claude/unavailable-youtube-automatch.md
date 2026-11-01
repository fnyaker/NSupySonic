# Unavailable tracks, YouTube fallback, audio auto-match

> Part of the project docs split out of CLAUDE.md (index: `CLAUDE.md`). Read when: touching Track.unavailable, /api/replace, the Indisponibles list, YouTube search/archive, or audiomatch/automatch.

**Unavailable tracks** (`supysonic/webui/availability.py`): Deezer drops tracks from its catalogue,
and `Track.unavailable` (a timestamp, so a verdict expires and is re-tested) records the ones we
have confirmed dead. The verdict is only ever set from `TrackUnavailable` — the dedicated exception
`provider._resolve_once` raises when Deezer *answers* that there is no source — never from a network
error, and never before a re-login has confirmed it (an expired media licence token looks exactly the
same). **Archiving clears it**: once the FLAC is on disk the track plays forever, whatever Deezer
does, which is why the probe checks the file before asking anyone. `/api/track/<id>/probe` is what the
player calls the moment playback errors (the `<audio>` element can't tell a dead track from a dropped
packet), so a dead track is skipped at once instead of after four reloads. `/api/replace` swaps a
track for another one — same position in every playlist, plus favourites — in a worker thread, and
mirrors it to Deezer for the admin's own playlists. It then **retires the source**
(`_retire_replaced`): a row that is flagged unavailable, has no file, and is referenced by no
playlist and no favourite is deleted — otherwise the corpse stayed listed under "Indisponibles" for
ever with nothing left to replace. Narrow on purpose, since `/api/replace` accepts any source. The
SPA mirrors that timing: the work is a worker thread, so the list is dropped optimistically
(`resolvedUnavailable`) and refetched only once the job reports done (`unavailableVersion`) —
refetching on sheet-close re-read the old state and the row flickered back.

**YouTube is a FALLBACK, never a second catalogue** (`supysonic/deezer/youtube.py`,
`supysonic/webui/youtube.py`, `webapp/src/lib/youtube.js`; optional extra `supysonic[youtube]`:
`ytmusicapi` + `yt-dlp` + `yt-dlp-ejs`, with Deno in the image for yt-dlp's challenge solver). It
is reached in exactly two ways, both a person asking: the search screen's **YouTube** box (unticked
by default, asked on Enter or when ticked — never per keystroke) and the replacement sheet's
*Chercher aussi sur YouTube*. Every rule is about calling YouTube as little as possible:
- **Search is ONE request** to YouTube Music's API (`ytmusicapi`, `filter="songs"`: title, artists,
  album, duration, square art; ~0.9 s), kept a day per query, empty answers too. yt-dlp never
  searches.
- **A hit costs nothing until it is played.** It is served under the UUID its row WILL have
  (`ids.youtube_track_uuid(video_id)`) and its metadata is remembered (`remember`/`recall`: memory
  + the disk cache), so starring it, adding it to a playlist or choosing it as a replacement
  creates the row from the search's own answer (`webui/youtube.materialize`, reached from
  `/stream`, `/favorite`, `_resolve_tracks`, `availability._resolve_local`) — no second request.
  An id whose hit is forgotten is simply unknown.
- **The audio is fetched once, on the first PLAY** (`ensure_archived`: one extraction + one
  download, ~2 s for five minutes, serialized per video, two at a time), staged in
  `archive_dir/.youtube-staging` (the local scanner skips dot-directories) and published under
  `archive_dir/YouTube/<artist>/<album>/<title> [<id>].opus` with tags, cover and a `.json`
  sidecar. A prefetch (`X-NS-Background`) never fetches; nothing bulk-archives it; the cleanup
  never deletes it (it only considers `deezer_id` rows). Subsonic's `stream` goes through the same
  call (`api/media._ensure_youtube_archived`).
- **The original stream is kept, never re-encoded**: Opus ~130-160 kbit/s (format 251) remuxed to
  Ogg with `-c copy` (AAC/m4a only when YouTube has no Opus). `/stream` serves the file as is unless
  the client asks for LESS than it holds (`TRANSCODE_MARGIN`), and the player shows the real rate
  (`SourceBadge.svelte`: "YT 133k" beside a FLAC or Opus 320 chip; read once from `/probe`).
- A row is `deezer_id NULL` + `youtube_id` set, so it is NOT an upload: `scan_local` never prunes
  it, `/me/local` and the local search skip it until it is archived, the probe answers "unknown"
  without asking anyone, and `verify_gone` only accepts YouTube's own verdict. Its artist/album
  carry no id in the API (no page to open: empty ids are "not a link" to the SPA).
- **Failing is not a verdict, and a refusal is left alone**: only YouTube answering that a video is
  gone (`YoutubeUnavailable`) marks a track unavailable; a network failure holds YouTube off for a
  minute and a refusal (429, "confirm you're not a bot") for fifteen (`held`), during which nothing
  is asked. The admin switch (Réglages → *Source de secours : YouTube*, `Meta yt.enabled`) turns
  it off for everyone; what is archived keeps playing. `tests/test_youtube.py` counts the requests.

**Unavailable means BOTH sources are gone** — not "Deezer dropped it". `DELETE /api/track/<id>` is
the third answer next to replace-and-upload, and `availability.verify_gone` re-checks *at the moment
of deletion*: a file on disk → refuse (and clear the verdict); Deezer still resolves → refuse; an
inconclusive network answer → refuse. Only `TrackUnavailable` with no file, or a local upload whose
file is gone, authorises it. Scoped like a replacement (own playlists/favourites; an admin also drops
the row, `recursive=True`) and mirrored to Deezer for the admin, fail-soft.

**The "Indisponibles" list is built for clearing out** (`components/UnavailableList.svelte`,
`lib/replace.js`). Tick several (shift-click for a range) and `POST /api/tracks/delete` (≤ 200 ids)
deletes them in ONE job that runs `verify_gone` per track in the worker (a Deezer call each, never
in the request thread) and reports `deleted` / `kept: [{id, reason}]`: a selection is no way round
the re-check. On a desktop each row also shows up to two ONE-CLICK stand-ins,
`/replace/candidates/<id>?best=2` → `match_score`: same title once brackets and " - …" are set
aside, the same main artist, no version word the dead track did not have (remix, live, edit,
acoustic…), a length within 15 s; never YouTube. Anything less sure stays behind "Autres choix" (the
sheet, where it can be auditioned). Fetched only for rows near the viewport, two at a time. The
candidates also search the local library by TITLE (artist checked): the `"<artist> <title>"` query
is one LIKE per field and never found the copy you already had. The query drops "(Remastered…)" /
" - Radio Edit" (`_core_title`), the sheet has a search box (`q`, ≤ 200 chars), and **YouTube is
asked on its own when Deezer finds nothing** (`youtube_auto`) — "nothing" meaning nothing that LOOKS
like the song (`closeness` ≥ `PLAUSIBLE`: the artist's other songs come back for any query naming
them, and used to block it), and for a typed query nothing at all. Five songs: ranked by
`closeness` to the dead track, or in YouTube's own order for a typed query (what was typed is what
they must be close to). The inline `?best=` falls back to YouTube the same way, through
`match_score` — which tolerates a CUT's label (edit, extended, club, dub) when the length agrees to
3 s: YouTube Music calls Stromae's 3:27 album take "Alors on danse (Radio Edit)". Checked against the
real YouTube Music on five real dead-track shapes; the two it still refuses are other cuts.

**The audio auto-match** (`deezer/audiomatch.py` = the ears, `deezer/automatch.py` = which
candidates and in what order, `webui/automatch.py` = when, and applying it). A dead track has no audio
left anywhere but the 30 s preview Deezer's public API may still serve for it, so that is the ONLY
reference (the user's choice: no ISRC shortcut; no preview → left for a person). Candidates pass a
metadata gate first (same core title, same main artist, ±20 s), then: files on disk; Deezer (its
preview, then — if that did not overlap — its whole stream, decrypted straight into ffmpeg, never
archived); YouTube only when Deezer had nothing, at most 2 downloads, staged and deleted unless the
candidate wins (then `ensure_archived(produced=)` publishes that very file). ≥ `THRESHOLD` (0.99)
replaces everywhere with the admin's scope (`availability.replace_everywhere`, the same code as a
person's replacement) WITHOUT asking — so the panel always lists what it replaced, with the score.
What 0.99 means is measured on real ffmpeg (`tests/test_audiomatch.py`): the same master as FLAC,
Opus 128 or −6 dB reads 0.9991-0.9999, a remaster 0.992 (same performance: accepted), the same
arrangement re-performed with 10 ms of timing drift 0.981, the instrumental 0.74. Two things made
those numbers: aligning to the SAMPLE after the hop-grid search (0.984 → 0.9999 on the same master)
and a 40 dB floor (at 60, Opus's noise fill in near-empty bands read 0.985). No BLAS (band means by
cumulative sum): its threads would escape the worker's `renice`. Runs on the EVENT
(`library.UNAVAILABLE_HOOKS`, first verdict only — a weekly re-confirmation is not news; one worker,
bounded queue; under `app.testing` nothing starts, tests call `drain`) and on the admin's button
(`/api/automatch/run`, progress, causes tallied, stopped — not failed — when Deezer is unreachable).
Switch `Meta dz.automatch`, ON by default; nothing runs without numpy + ffmpeg.
