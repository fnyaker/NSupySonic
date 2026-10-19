# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic API server.
#
# Distributed under terms of the GNU AGPLv3 license.

"""Is this candidate the same recording as that track? (docs/multi-provider.md §4)

``match_score`` / ``closeness`` / ``_core_title`` / ``PLAUSIBLE`` were born in
the replacement sheet (``webui/availability.py``) and are moved here as they
were, so the sheet, the playlist import, the search merge and the duplicate
tool all judge a match by one rule. ``availability`` and ``playlist_import``
re-import the same names.
"""

from __future__ import annotations

import re

def _fold(text) -> str:
    """Case, accents and punctuation dropped: "Beyoncé - Halo!" → "beyonce halo"."""
    import unicodedata

    s = unicodedata.normalize("NFKD", str(text or "")).lower()
    s = "".join(ch if ch.isalnum() else " " for ch in s if not unicodedata.combining(ch))
    return " ".join(s.split())


_BRACKETS_RE = re.compile(r"[\(\[][^\)\]]*[\)\]]")
# A word that makes a recording a DIFFERENT recording of the song. A swap to one
# of those is a decision for somebody who listened, not a one-click default.
_VERSION_WORDS = frozenset(
    "remix live edit acoustic instrumental karaoke cover demo rework bootleg "
    "vip extended club dub sped slowed nightcore reprise orchestral unplugged "
    "cappella acapella".split()
)
# …of which these only name a CUT of the same recording, and a label is not
# always right about it: YouTube Music calls Stromae's 3:27 album take "Alors on
# danse (Radio Edit)". Tolerated when the length agrees to SOFT_EDIT_DELTA,
# which a remix, a live take or an extended mix never does.
_SOFT_VERSION_WORDS = frozenset("edit extended club dub".split())
SOFT_EDIT_DELTA = 3


def _title_parts(title):
    """``(core, version words)`` of a title."""
    raw = str(title or "")
    extras = " ".join(_BRACKETS_RE.findall(raw))
    core = _BRACKETS_RE.sub(" ", raw)
    if " - " in core:
        core, tail = core.split(" - ", 1)
        extras += " " + tail
    words = set(_fold(extras).split())
    # "Remastered", "Radio", "Album version"… name a pressing, not another
    # recording: only the words above count.
    versions = words & _VERSION_WORDS
    return _fold(core), versions


_CREDIT_SPLIT_RE = re.compile(r",|&|\bfeat\.?|\bft\.?|\bwith\b|\bx\b", re.IGNORECASE)


def _artist_names(c) -> set:
    """Every credited name of a candidate, one by one, folded."""
    names = {_fold(a.get("name")) for a in (c.get("artists") or []) if isinstance(a, dict)}
    if isinstance(c.get("artist"), dict):
        names.add(_fold(c["artist"].get("name")))
    for part in _CREDIT_SPLIT_RE.split(str(c.get("display_artist") or "")):
        names.add(_fold(part))
    names.discard("")
    return names


def match_score(track, c):
    """How safely ``c`` stands in for ``track``; None when it must not be offered.

    Required: the same title once versions are set aside, the same main artist,
    no version marker the dead track did not have, and a length within 15 s
    when both are known. Then closer is better, and a file on disk (which can
    never vanish again) wins a tie. A YouTube hit is judged the same way; the
    route only asks YouTube when nothing from Deezer or the disk is safe.
    """
    core, versions = _title_parts(track.title)
    c_core, c_versions = _title_parts(c.get("title"))
    d0, d1 = track.duration or 0, c.get("duration") or 0
    extra = c_versions - versions
    if extra and extra <= _SOFT_VERSION_WORDS and d0 and d1 and abs(d0 - d1) <= SOFT_EDIT_DELTA:
        extra = set()
    if not core or core != c_core or extra:
        return None
    artist = _fold(track.artist.name if track.artist else "")
    if not artist or artist not in _artist_names(c):
        return None  # another artist's take is a cover: not a one-click swap
    score = 10.0
    if versions == c_versions:
        score += 2
    if _fold(c.get("title")) == _fold(track.title):
        score += 1
    if d0 and d1:
        delta = abs(d0 - d1)
        if delta > 15:
            return None
        score += 3 - delta / 5
    if c.get("local"):
        score += 0.5
    return score



def _core_title(title) -> str:
    """The title without "(Remastered 2011)", "[Live]", " - Radio Edit" (unfolded)."""
    t = _BRACKETS_RE.sub(" ", str(title or ""))
    if " - " in t:
        t = t.split(" - ", 1)[0]
    return " ".join(t.split())


def closeness(track, c) -> float:
    """0..1: how close a candidate LOOKS to the dead track, to rank a search.

    Softer than ``match_score`` on purpose — it orders what a person will
    look at, it does not decide anything: the title's resemblance (the most
    of it), the artist, then the length.
    """
    from difflib import SequenceMatcher

    a, b = _fold(_core_title(track.title)), _fold(_core_title(c.get("title")))
    title = SequenceMatcher(None, a, b).ratio() if a and b else 0.0
    artist = _fold(track.artist.name if track.artist else "")
    credited = 1.0 if artist and artist in _artist_names(c) else 0.0
    d0, d1 = track.duration or 0, c.get("duration") or 0
    length = max(0.0, 1.0 - abs(d0 - d1) / 60.0) if d0 and d1 else 0.5
    return 0.6 * title + 0.3 * credited + 0.1 * length


# What "Deezer found something" means for asking YouTube on its own: a result
# that LOOKS like the song (its title and its artist), not any result at all —
# the artist's other songs come back for any query naming them.
PLAUSIBLE = 0.8


# --- same_recording / match_key -------------------------------------------

_ISRC_RE = re.compile(r"^[A-Z]{2}[A-Z0-9]{3}\d{7}$")
DURATION_SLACK = 3  # seconds: the same master rounds differently between providers


def _isrc(c) -> str:
    raw = c.get("isrc") if isinstance(c, dict) else getattr(c, "isrc", None)
    raw = "".join(str(raw or "").upper().split()).replace("-", "")
    return raw if _ISRC_RE.match(raw) else ""


def _get(c, key):
    return c.get(key) if isinstance(c, dict) else getattr(c, key, None)


def _main_artist(c) -> str:
    """The folded name of the first credited artist ("" when there is none)."""
    artists = _get(c, "artists")
    if isinstance(artists, (list, tuple)) and artists:
        first = artists[0]
        name = first.get("name") if isinstance(first, dict) else getattr(first, "name", first)
        if _fold(name):
            return _fold(name)
    artist = _get(c, "artist")
    if isinstance(artist, dict):
        return _fold(artist.get("name"))
    if artist is not None and not isinstance(artist, str):
        return _fold(getattr(artist, "name", ""))
    if isinstance(artist, str) and artist:
        return _fold(artist)
    shown = _get(c, "display_artist")
    return _fold(_CREDIT_SPLIT_RE.split(str(shown or ""))[0])


def same_recording(a, b) -> str:
    """``"sure"``, ``"maybe"`` or ``"no"`` for two tracks (dicts or rows).

    An equal ISRC settles it. A different one does not condemn: labels
    re-issue a recording under a new code, so it falls through to the second
    test. That test is: the same title once versions are set aside, the same main
    artist, a length within ``DURATION_SLACK`` s and the same set of version
    words is *sure*; the same but for a cut's label (edit, extended, club,
    dub) with the length agreeing, or a missing length, is *maybe*; anything
    else — a remix, a live take, another artist's version — is *no*.
    """
    ia, ib = _isrc(a), _isrc(b)
    if ia and ia == ib:
        return "sure"
    core_a, ver_a = _title_parts(_get(a, "title"))
    core_b, ver_b = _title_parts(_get(b, "title"))
    if not core_a or core_a != core_b:
        return "no"
    ma, mb = _main_artist(a), _main_artist(b)
    if not ma or not mb:
        return "no"
    names_a = _artist_names(a if isinstance(a, dict) else {"artist": _get(a, "artist")}) | {ma}
    names_b = _artist_names(b if isinstance(b, dict) else {"artist": _get(b, "artist")}) | {mb}
    if ma != mb and ma not in names_b and mb not in names_a:
        return "no"
    if ver_a != ver_b:
        diff = ver_a ^ ver_b
        d0, d1 = _get(a, "duration") or 0, _get(b, "duration") or 0
        if diff <= _SOFT_VERSION_WORDS and d0 and d1 and abs(d0 - d1) <= SOFT_EDIT_DELTA:
            return "maybe"
        return "no"
    d0, d1 = _get(a, "duration") or 0, _get(b, "duration") or 0
    if d0 and d1:
        return "sure" if abs(d0 - d1) <= DURATION_SLACK else "no"
    return "maybe"


def match_key(track) -> str:
    """A key equal for tracks that are probably the same recording, so a list
    is de-duplicated in one pass (a dict on the key) instead of n² comparisons.

    The ISRC when there is one; else core title, main artist and the version
    words. Length is left out of the key (it is a tolerance, not an equality),
    so callers confirm a collision with ``same_recording``.
    """
    isrc = _isrc(track)
    if isrc:
        return "isrc:" + isrc
    core, versions = _title_parts(_get(track, "title"))
    return "t:" + core + "|" + _main_artist(track) + "|" + ",".join(sorted(versions))
