# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""Facts a file carries in its own tags, read with mutagen.

Every key is optional and the function never raises: a missing, unreadable or
oddly tagged file just yields fewer facts.
"""

import logging
import re

logger = logging.getLogger(__name__)

KEYS = ("isrc", "date", "composer", "lyricist", "producer", "label", "bpm", "genre")

# Easy-style keys (FLAC / Ogg Vorbis comments, Opus) and their facts.
_VORBIS = {
    "isrc": ("isrc",),
    "date": ("date", "originaldate", "year"),
    "composer": ("composer",),
    "lyricist": ("lyricist", "author"),
    "producer": ("producer",),
    "label": ("label", "organization", "publisher"),
    "bpm": ("bpm", "tempo"),
    "genre": ("genre",),
}
_ID3 = {
    "isrc": ("TSRC",),
    "date": ("TDRC", "TDOR", "TYER"),
    "composer": ("TCOM",),
    "lyricist": ("TEXT",),
    "label": ("TPUB",),
    "bpm": ("TBPM",),
    "genre": ("TCON",),
}
_MP4 = {
    "date": ("\xa9day",),
    "composer": ("\xa9wrt",),
    "bpm": ("tmpo",),
    "genre": ("\xa9gen",),
    "label": ("----:com.apple.iTunes:LABEL",),
    "isrc": ("----:com.apple.iTunes:ISRC",),
    "producer": ("----:com.apple.iTunes:PRODUCER",),
}

_DATE = re.compile(r"^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?")


def _text(value):
    if isinstance(value, (list, tuple)):
        value = value[0] if value else None
    if value is None:
        return None
    if isinstance(value, bytes):
        value = value.decode("utf-8", "replace")
    if hasattr(value, "FrameID"):  # an ID3 frame
        return _text(list(value.text))
    text = str(value).replace("\x00", "").strip()
    return text or None


def _clean_date(raw):
    m = _DATE.match(raw or "")
    if not m:
        return None
    y, mo, d = m.groups()
    if mo and not 1 <= int(mo) <= 12:
        return y
    if d and not 1 <= int(d) <= 31:
        return f"{y}-{mo}"
    return "-".join(p for p in (y, mo, d) if p)


def _clean_bpm(raw):
    try:
        v = float(str(raw).replace(",", "."))
    except (TypeError, ValueError):
        return None
    return round(v, 2) if 20 <= v <= 400 else None


def _clean_isrc(raw):
    s = re.sub(r"[\s-]", "", raw or "").upper()
    return s if re.fullmatch(r"[A-Z]{2}[A-Z0-9]{3}\d{7}", s) else None


def read_file_facts(path):
    """``{isrc, date, composer, lyricist, producer, label, bpm, genre}`` — only
    the keys the file actually carries."""
    try:
        import mutagen

        f = mutagen.File(path)
    except Exception:
        logger.debug("filetags: cannot read %s", path, exc_info=True)
        return {}
    if f is None or f.tags is None:
        return {}
    tags = f.tags
    if hasattr(tags, "getall"):
        table, get = _ID3, lambda k: tags.get(k)
    elif type(tags).__name__ == "MP4Tags":
        table, get = _MP4, lambda k: tags.get(k)
    else:  # Vorbis comments: case-insensitive keys
        table, get = _VORBIS, lambda k: tags.get(k)
    out = {}
    for fact, keys in table.items():
        for key in keys:
            try:
                raw = _text(get(key))
            except Exception:
                raw = None
            if not raw:
                continue
            if fact == "date":
                raw = _clean_date(raw)
            elif fact == "bpm":
                raw = _clean_bpm(raw)
            elif fact == "isrc":
                raw = _clean_isrc(raw)
            if raw:
                out[fact] = raw
                break
    return out
