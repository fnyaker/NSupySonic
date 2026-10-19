# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""MusicBrainz: a recording by ISRC (or by id), its first release date and credits.

Everything that comes back is someone else's text: ids are validated before
they go into a URL, strings are bounded, and a hostile answer is a missing fact.
"""

import re

BASE = "https://musicbrainz.org/ws/2"

_ISRC = re.compile(r"^[A-Z]{2}[A-Z0-9]{3}[0-9]{7}$")
_MBID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
_DATE = re.compile(r"^\d{4}(-\d{2}-\d{2})?$")
#: An ISRC names one recording, but remasters share it: a length this far off is
#: another recording.
ISRC_LENGTH_SLACK = 10.0
STRING_MAX = 160
NAMES_MAX = 20

#: relation type -> fact key
_WORK_ROLES = {"composer": "composer", "lyricist": "lyricist", "writer": "composer"}
_RECORDING_ROLES = {"producer": "producer"}


def clean_isrc(raw):
    isrc = str(raw or "").replace("-", "").strip().upper()
    return isrc if _ISRC.match(isrc) else None


def valid_mbid(raw):
    raw = str(raw or "").strip().lower()
    return raw if _MBID.match(raw) else None


def _text(value):
    return str(value or "").strip()[:STRING_MAX]


def _date(raw):
    """``AAAA-MM-JJ`` or ``AAAA``: a month with no day is only its year."""
    raw = _text(raw)
    if _DATE.match(raw):
        return raw
    if re.match(r"^\d{4}-\d{2}$", raw):
        return raw[:4]
    return None


def _length_ok(rec, duration, slack):
    length = rec.get("length")
    if not duration or not isinstance(length, (int, float)):
        return True  # nothing to compare is not a disagreement
    return abs(length / 1000.0 - duration) <= slack


def lookup_isrc(http, isrc, duration=None):
    """The recording MusicBrainz holds for this ISRC, or None.

    Returns ``{"mbid", "date", "release"}`` (``release`` is the first release's
    id, for the Cover Art Archive). Several recordings: the closest in length.
    """
    isrc = clean_isrc(isrc)
    if not isrc:
        return None
    data = http.get_json(
        f"{BASE}/isrc/{isrc}", {"inc": "artist-credits+releases", "fmt": "json"}
    )
    recs = [r for r in (data or {}).get("recordings") or [] if isinstance(r, dict)]
    recs = [r for r in recs if valid_mbid(r.get("id")) and _length_ok(r, duration, ISRC_LENGTH_SLACK)]
    if not recs:
        return None
    if duration:
        recs.sort(key=lambda r: abs((r.get("length") or 0) / 1000.0 - duration))
    return summarize(recs[0])


def summarize(rec):
    """``{"mbid", "date", "release"}`` out of a recording as the API returns it."""
    release = None
    for rel in rec.get("releases") or []:
        if isinstance(rel, dict) and valid_mbid(rel.get("id")):
            release = valid_mbid(rel["id"])
            break
    return {
        "mbid": valid_mbid(rec.get("id")),
        "date": _date(rec.get("first-release-date")),
        "release": release,
    }


def credits(http, mbid):
    """``{composer, lyricist, producer}`` (comma-joined names) from the
    recording's own relations and those of the works it performs."""
    mbid = valid_mbid(mbid)
    if not mbid:
        return {}
    data = http.get_json(
        f"{BASE}/recording/{mbid}",
        {"inc": "artist-rels+work-rels+work-level-rels", "fmt": "json"},
    )
    names = {}

    def add(key, rel):
        who = (rel.get("artist") or {}).get("name")
        who = _text(who)
        if who and who not in names.setdefault(key, []) and len(names[key]) < NAMES_MAX:
            names[key].append(who)

    for rel in (data or {}).get("relations") or []:
        if not isinstance(rel, dict):
            continue
        kind = rel.get("type")
        if kind in _RECORDING_ROLES and rel.get("artist"):
            add(_RECORDING_ROLES[kind], rel)
        elif kind == "performance":
            work = rel.get("work") or {}
            for wrel in work.get("relations") or []:
                if isinstance(wrel, dict) and wrel.get("type") in _WORK_ROLES and wrel.get("artist"):
                    add(_WORK_ROLES[wrel["type"]], wrel)
    return {k: ", ".join(v) for k, v in names.items() if v}


def facts_of(summary, extra=None):
    """What goes into the sidecar's ``facts`` block."""
    facts = {"mbid": summary.get("mbid"), "release_date": summary.get("date")}
    facts.update(extra or {})
    return {k: v for k, v in facts.items() if v}
