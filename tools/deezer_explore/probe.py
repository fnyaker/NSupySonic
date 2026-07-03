#!/usr/bin/env python3
# This file is part of Supysonic.
# Distributed under terms of the GNU AGPLv3 license.

"""Actively probe Deezer gateway methods with your ARL (read-only).

    ARL=xxxx python tools/deezer_explore/probe.py
    # or: python tools/deezer_explore/probe.py --arl xxxx [--artist 27] [--album 302127]

Calls a curated list of *read* gateway methods (no mutations) and records, for
each, whether it succeeded and the top-level shape of the response. Writes
probe.json / probe.md next to this script. The HAR catalog is more exhaustive;
this is a quick complement to confirm method names and shapes.
"""

from __future__ import annotations

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from deezerpy import Deezer  # noqa: E402


def shape(obj, depth=0):
    if depth > 2:
        return "…"
    if isinstance(obj, dict):
        return {k: shape(v, depth + 1) for k, v in list(obj.items())[:30]}
    if isinstance(obj, list):
        return [shape(obj[0], depth + 1)] if obj else []
    return type(obj).__name__


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--arl", default=os.environ.get("ARL") or os.environ.get("DEEZER_ARL"))
    ap.add_argument("--artist", default="27")  # Daft Punk
    ap.add_argument("--album", default="302127")
    ap.add_argument("--track", default="3135556")
    ap.add_argument("--playlist", default="908622995")
    ap.add_argument("--show", default="436902", help="Deezer podcast (show) id")
    ap.add_argument("--episode", default=None, help="episode id; auto-extracted from the show page if omitted")
    args = ap.parse_args()
    if not args.arl:
        ap.error("provide --arl or set ARL env var")

    dz = Deezer()
    if not dz.login_via_arl(args.arl):
        print("ARL login failed", file=sys.stderr)
        sys.exit(1)
    uid = dz.current_user.get("id")
    A, AL, T, PL, SH = args.artist, args.album, args.track, args.playlist, args.show

    # Podcasts: Deezer calls them "shows" internally. Method names/args below are
    # confirmed from a HAR capture of the web player (see docs/plan-podcasts.md).
    # If --episode isn't given, pull one from the show page when it answers.
    EP = args.episode
    if not EP:
        try:
            page = dz.gw.api_call("deezer.pageShow", {"show_id": SH, "lang": "en", "nb": 1, "start": 0})
            EP = page["EPISODES"]["data"][0]["EPISODE_ID"]
        except Exception:
            EP = "0"

    # (label, gw method, args)  -- READ-ONLY methods only.
    probes = [
        ("user data", "deezer.getUserData", {}),
        ("track", "song.getData", {"SNG_ID": T}),
        ("track page", "deezer.pageTrack", {"SNG_ID": T}),
        ("track lyrics", "song.getLyrics", {"SNG_ID": T}),
        ("album", "album.getData", {"ALB_ID": AL}),
        ("album page", "deezer.pageAlbum", {"ALB_ID": AL, "lang": "en", "tab": 0}),
        ("artist", "artist.getData", {"ART_ID": A}),
        ("artist page", "deezer.pageArtist", {"ART_ID": A, "lang": "en", "tab": 0}),
        ("artist top", "artist.getTopTrack", {"ART_ID": A, "nb": 10}),
        ("artist related", "artist.getRelatedArtists", {"ART_ID": A}),
        ("artist discography", "album.getDiscography", {"ART_ID": A, "nb": 10, "nb_songs": 0, "start": 0, "discography_mode": "all"}),
        ("playlist page", "deezer.pagePlaylist", {"PLAYLIST_ID": PL, "lang": "en", "tab": 0}),
        ("playlist songs", "playlist.getSongs", {"PLAYLIST_ID": PL, "nb": 20}),
        ("search", "deezer.pageSearch", {"query": "daft punk", "nb": 10, "start": 0}),
        ("user profile playlists", "deezer.pageProfile", {"USER_ID": uid, "tab": "playlists", "nb": 10}),
        ("user profile loved", "deezer.pageProfile", {"USER_ID": uid, "tab": "loved", "nb": 10}),
        ("favorite ids", "song.getFavoriteIds", {"nb": 10, "start": 0, "checksum": None}),
        ("smart: new-releases", "deezer.pageSmartTracklist", {"SMARTTRACKLIST_ID": "new-releases"}),
        ("smart: discovery", "deezer.pageSmartTracklist", {"SMARTTRACKLIST_ID": "discovery"}),
        ("smart: flow", "deezer.pageSmartTracklist", {"SMARTTRACKLIST_ID": "flow"}),
        ("radio user", "radio.getUserRadio", {}),
        ("mix from track", "song.getSearchTrackMix", {"sng_id": T, "start_with_input_track": True}),
        ("user recommended albums", "album.getRecommendedAlbums", {"nb": 10}),
        ("user recommended artists", "artist.getRecommendedArtists", {"nb": 10}),
        ("user recommended tracks", "song.getRecommendedSongs", {"nb": 10}),
        ("genres", "deezer.pageGenres", {}),
        # Podcasts (confirmed method names/args). pageShow returns the show DATA
        # plus a paginated EPISODES list (each with EPISODE_DIRECT_STREAM_URL).
        ("show page + episodes", "deezer.pageShow", {"show_id": SH, "lang": "en", "nb": 5, "start": 0}),
        # Still-unconfirmed: how to list the user's subscribed shows (§1.5).
        ("profile podcasts tab?", "deezer.pageProfile", {"USER_ID": uid, "tab": "podcasts", "nb": 10}),
        ("search shows?", "search.music", {"query": "tech", "filter": "ALL", "output": "SHOW", "start": 0, "nb": 5}),
        ("search episodes?", "search.music", {"query": "tech", "filter": "ALL", "output": "EPISODE", "start": 0, "nb": 5}),
        ("home page.get", "page.get", {"gateway_input": json.dumps({"PAGE": "home", "VERSION": "2.5", "SUPPORT": {}, "LANG": "en"})}),
    ]

    results = []
    for label, method, params in probes:
        try:
            res = dz.gw.api_call(method, params)
            ok, summary = True, shape(res)
        except Exception as exc:
            ok, summary = False, str(exc)[:200]
        results.append({"label": label, "method": method, "ok": ok, "result": summary})
        print(("OK   " if ok else "FAIL ") + f"{label}  ({method})")

    here = os.path.dirname(os.path.abspath(__file__))
    with open(os.path.join(here, "probe.json"), "w", encoding="utf-8") as fh:
        json.dump(results, fh, indent=2, ensure_ascii=False)
    with open(os.path.join(here, "probe.md"), "w", encoding="utf-8") as fh:
        fh.write("# Deezer gateway probe\n\n")
        for r in results:
            fh.write(f"## {'✅' if r['ok'] else '❌'} {r['label']} — `{r['method']}`\n\n")
            fh.write("```json\n" + json.dumps(r["result"], indent=2, ensure_ascii=False)[:1500] + "\n```\n\n")
    print(f"\nWrote probe.json / probe.md in {here}")


if __name__ == "__main__":
    main()
