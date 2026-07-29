# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Copyright (C) 2013-2022 Alban 'spl0k' Féron
#
# Distributed under terms of the GNU AGPLv3 license.

from collections import OrderedDict
from datetime import datetime
from flask import request

from ..db import Folder, Track, Artist, Album
from ..utils import like_term

from . import api_routing, get_root_folder
from .exceptions import MissingParameter

# Subsonic clients legitimately search for a single character, so only the
# multi-character LIKE wildcard is taken away here (see utils.like_term):
# "?any=%" used to return — and serialise — the whole library.
_MIN_TERM = 1


def _bounded(value, default, maximum=500):
    """A client-supplied count/offset, clamped to something serialisable.

    A non-numeric value still raises ValueError, which the blueprint's
    errorhandler turns into a proper Subsonic error — same as before.
    """
    value = int(value) if value else default
    return max(0, min(value, maximum))


@api_routing("/search")
def old_search():
    artist, album, title, anyf, count, offset, newer_than = map(
        request.values.get,
        ("artist", "album", "title", "any", "count", "offset", "newerThan"),
    )

    count = _bounded(count, 20)
    offset = _bounded(offset, 0, 10**6)
    newer_than = int(newer_than) / 1000 if newer_than else 0
    min_date = datetime.fromtimestamp(newer_than)

    # A term made only of wildcards normalises to None; treat it as "no term"
    # so it falls through to the MissingParameter below instead of matching the
    # whole library.
    artist, album, title, anyf = (
        like_term(x, _MIN_TERM) if x else None for x in (artist, album, title, anyf)
    )

    if artist:
        Child = Folder.alias()
        query = (
            Folder.select()
            .join(Child, on=Child.parent == Folder.id)
            .join(Track, on=Track.folder == Child.id)
            .where(Folder.name.contains(artist), Folder.created > min_date)
            .distinct()
        )
    elif album:
        query = (
            Folder.select()
            .join(Track, on=Track.folder)
            .where(Folder.name.contains(album), Folder.created > min_date)
            .distinct()
        )
    elif title:
        query = Track.visible(
            Track.select().where(Track.title.contains(title), Track.created > min_date),
            request.user,
        )
    elif anyf:
        folders = Folder.select().where(
            Folder.name.contains(anyf), Folder.created > min_date
        )
        tracks = Track.visible(
            Track.select().where(Track.title.contains(anyf), Track.created > min_date),
            request.user,
        )
        res = folders[offset : offset + count]
        fcount = folders.count()
        if offset + count > fcount:
            toff = max(0, offset - fcount)
            tend = offset + count - fcount
            res = res[:] + tracks[toff:tend][:]

        return request.formatter(
            "searchResult",
            {
                "totalHits": folders.count() + tracks.count(),
                "offset": offset,
                "match": [
                    (
                        r.as_subsonic_child(request.user)
                        if isinstance(r, Folder)
                        else r.as_subsonic_child(request.user, request.client)
                    )
                    for r in res
                ],
            },
        )
    else:
        raise MissingParameter("search")

    return request.formatter(
        "searchResult",
        {
            "totalHits": query.count(),
            "offset": offset,
            "match": [
                (
                    r.as_subsonic_child(request.user)
                    if isinstance(r, Folder)
                    else r.as_subsonic_child(request.user, request.client)
                )
                for r in query[offset : offset + count]
            ],
        },
    )


@api_routing("/search2")
def new_search():
    query = request.values["query"]
    (
        artist_count,
        artist_offset,
        album_count,
        album_offset,
        song_count,
        song_offset,
        mfid,
    ) = map(
        request.values.get,
        (
            "artistCount",
            "artistOffset",
            "albumCount",
            "albumOffset",
            "songCount",
            "songOffset",
            "musicFolderId",
        ),
    )

    artist_count = _bounded(artist_count, 20)
    artist_offset = _bounded(artist_offset, 0, 10**6)
    album_count = _bounded(album_count, 20)
    album_offset = _bounded(album_offset, 0, 10**6)
    song_count = _bounded(song_count, 20)
    song_offset = _bounded(song_offset, 0, 10**6)
    root = get_root_folder(mfid)
    query = like_term(query, _MIN_TERM)
    if query is None:  # wildcard-only query: nothing to match
        return request.formatter("searchResult2", {})

    Child = Folder.alias()
    artists = (
        Folder.select()
        .join(Child, on=Child.parent == Folder.id)
        .join(Track, on=Track.folder == Child.id)
        .where(Folder.name.contains(query))
        .distinct()
    )
    albums = (
        Folder.select()
        .join(Track, on=Track.folder)
        .where(Folder.name.contains(query))
        .distinct()
    )
    songs = Track.visible(
        Track.select().where(Track.title.contains(query)), request.user
    )

    if root is not None:
        artists = artists.where(Track.root_folder == root)
        albums = albums.where(Track.root_folder == root)
        songs = songs.where(Track.root_folder == root)

    artists = artists.limit(artist_count).offset(artist_offset)
    albums = albums.limit(album_count).offset(album_offset)
    songs = songs.limit(song_count).offset(song_offset)

    return request.formatter(
        "searchResult2",
        OrderedDict(
            (
                ("artist", [a.as_subsonic_artist(request.user) for a in artists]),
                ("album", [f.as_subsonic_child(request.user) for f in albums]),
                (
                    "song",
                    [
                        t.as_subsonic_child(request.user, request.client)
                        for t in Track.prime_credits(songs)
                    ],
                ),
            )
        ),
    )


@api_routing("/search3")
def search_id3():
    query = request.values["query"]
    (
        artist_count,
        artist_offset,
        album_count,
        album_offset,
        song_count,
        song_offset,
        mfid,
    ) = map(
        request.values.get,
        (
            "artistCount",
            "artistOffset",
            "albumCount",
            "albumOffset",
            "songCount",
            "songOffset",
            "musicFolderId",
        ),
    )

    artist_count = _bounded(artist_count, 20)
    artist_offset = _bounded(artist_offset, 0, 10**6)
    album_count = _bounded(album_count, 20)
    album_offset = _bounded(album_offset, 0, 10**6)
    song_count = _bounded(song_count, 20)
    song_offset = _bounded(song_offset, 0, 10**6)
    root = get_root_folder(mfid)
    query = like_term(query, _MIN_TERM)
    if query is None:  # wildcard-only query: nothing to match
        return request.formatter("searchResult3", {})

    artists = Artist.select().where(Artist.name.contains(query))
    albums = Album.select().where(Album.name.contains(query))
    songs = Track.visible(
        Track.select().where(Track.title.contains(query)), request.user
    )

    if root is not None:
        artists = artists.join(Track).where(Track.root_folder == root)
        albums = albums.join(Track).where(Track.root_folder == root)
        songs = songs.where(Track.root_folder == root)

    artists = artists.limit(artist_count).offset(artist_offset)
    albums = albums.limit(album_count).offset(album_offset)
    songs = songs.limit(song_count).offset(song_offset)

    return request.formatter(
        "searchResult3",
        OrderedDict(
            (
                ("artist", [a.as_subsonic_artist(request.user) for a in artists]),
                ("album", [a.as_subsonic_album(request.user) for a in albums]),
                (
                    "song",
                    [
                        t.as_subsonic_child(request.user, request.client)
                        for t in Track.prime_credits(songs)
                    ],
                ),
            )
        ),
    )
