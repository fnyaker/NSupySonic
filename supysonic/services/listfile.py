# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""A playlist as a LIST file: the route to every service we cannot write to.

Apple Music, Tidal, Amazon Music, Qobuz… each needs either a paid developer
membership (Apple: MusicKit, $99 a year) or a partner agreement before a
third-party server may create a playlist there. The transfer services
(TuneMyMusic, Soundiiz, FreeYourMusic) already have those, and all of them
read a CSV of title / artist / album — with the ISRC, the one column that
makes their match exact. So the file is the honest answer for those services.

- ``csv``  — Title, Artist, Album, ISRC, Duration (seconds); UTF-8 with a BOM
  so a spreadsheet opens accents right.
- ``xspf`` — the XML playlist format VLC, foobar2000 and most desktop players
  open (title, creator, album, duration in ms).
- ``txt``  — one "Artist - Title" a line: what a text box on a transfer site
  takes when it takes nothing else.
"""

from __future__ import annotations

import csv
import io
import re
from html import escape as _html_escape

FORMATS = {
    "csv": ("text/csv; charset=utf-8", "csv", "CSV (TuneMyMusic, Soundiiz…)"),
    "xspf": ("application/xspf+xml; charset=utf-8", "xspf", "XSPF (VLC, lecteurs)"),
    "txt": ("text/plain; charset=utf-8", "txt", "Texte « Artiste - Titre »"),
}


def _csv(name: str, rows: list) -> str:
    out = io.StringIO()
    w = csv.writer(out, lineterminator="\r\n")
    w.writerow(["Title", "Artist", "Album", "ISRC", "Duration"])
    for r in rows:
        w.writerow(
            [_cell(r["title"]), _cell(r["artist"]), _cell(r["album"]), r.get("isrc") or "", r["duration"] or ""]
        )
    return "﻿" + out.getvalue()


def _cell(text) -> str:
    """A spreadsheet runs a cell that starts with = + - @ as a formula: a title
    like "=HYPERLINK(…)" is data, so it is kept as text."""
    s = str(text or "")
    return "'" + s if s[:1] in ("=", "+", "-", "@", "\t", "\r") else s


# XML 1.0 has no way to write these, even escaped: a title carrying one would
# make the whole file unreadable.
_XML_BAD = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]")


def escape(text) -> str:
    # &, < and > are all XML text needs (what xml.sax.saxutils.escape does).
    return _html_escape(_XML_BAD.sub("", str(text or "")), quote=False)


def _xspf(name: str, rows: list) -> str:
    parts = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<playlist version="1" xmlns="http://xspf.org/ns/0/">',
        f"  <title>{escape(name)}</title>",
        "  <trackList>",
    ]
    for r in rows:
        parts.append("    <track>")
        parts.append(f"      <title>{escape(r['title'])}</title>")
        if r["artist"]:
            parts.append(f"      <creator>{escape(r['artist'])}</creator>")
        if r["album"]:
            parts.append(f"      <album>{escape(r['album'])}</album>")
        if r["duration"]:
            parts.append(f"      <duration>{int(r['duration']) * 1000}</duration>")
        parts.append("    </track>")
    parts += ["  </trackList>", "</playlist>", ""]
    return "\n".join(parts)


def _txt(name: str, rows: list) -> str:
    lines = [" - ".join(x for x in (r["artist"], r["title"]) if x) for r in rows]
    return "\n".join(lines) + "\n"


def render(fmt: str, name: str, rows: list) -> str:
    """``rows`` are ``match.wanted`` dicts."""
    return {"csv": _csv, "xspf": _xspf, "txt": _txt}[fmt](name, rows)
