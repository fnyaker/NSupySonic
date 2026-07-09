# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""Tagging of archived Deezer files (FLAC / MP3) with mutagen.

Adapted from the DeeSync ``deezer_gateway`` helper: builds a tag dict from a
raw ``song.getData`` gateway response and writes it (plus embedded cover) into
the downloaded file.
"""

from __future__ import annotations

from pathlib import Path

from mutagen.flac import FLAC, Picture
from mutagen.id3 import (
    APIC,
    ID3,
    TALB,
    TDRC,
    TIT2,
    TPE1,
    TPE2,
    TPOS,
    TRCK,
    TSRC,
    TXXX,
)
from mutagen.id3 import error as ID3Error


def meta_from_gw(info: dict) -> dict:
    """Build a tagging dict from a ``song.getData`` gateway response."""
    artists = [a["ART_NAME"] for a in (info.get("ARTISTS") or []) if a.get("ART_NAME")]
    if not artists:
        artists = [info.get("ART_NAME", "")]
    title = info.get("SNG_TITLE", "")
    version = info.get("VERSION") or ""
    if version and version not in title:
        title = f"{title} {version}".strip()
    date = info.get("PHYSICAL_RELEASE_DATE") or info.get("DIGITAL_RELEASE_DATE") or None
    return {
        "title": title,
        "artists": artists,
        "album": info.get("ALB_TITLE", ""),
        "albumartist": info.get("ART_NAME", ""),
        "tracknumber": info.get("TRACK_NUMBER"),
        "discnumber": info.get("DISK_NUMBER"),
        "date": date,
        "isrc": info.get("ISRC"),
        "md5_image": info.get("ALB_PICTURE", ""),
        "gain": info.get("GAIN"),
    }


def _replaygain_tag(raw) -> str | None:
    """Format Deezer's ``GAIN`` (dB) as a standard ReplayGain tag value, e.g.
    ``"-8.40 dB"``. Returns None when absent/unparseable."""
    if raw in (None, ""):
        return None
    try:
        return f"{float(raw):.2f} dB"
    except (TypeError, ValueError):
        return None


def tag_file(path: Path, meta: dict, cover: bytes | None) -> None:
    """Write tags + embedded cover into a FLAC or MP3 file."""
    path = Path(path)
    if path.suffix.lower() == ".flac":
        audio = FLAC(path)
        audio.delete()
        audio["title"] = meta["title"]
        audio["artist"] = meta["artists"]
        audio["album"] = meta["album"]
        audio["albumartist"] = meta["albumartist"]
        if meta.get("tracknumber"):
            audio["tracknumber"] = str(meta["tracknumber"])
        if meta.get("discnumber"):
            audio["discnumber"] = str(meta["discnumber"])
        if meta.get("date"):
            audio["date"] = meta["date"]
        if meta.get("isrc"):
            audio["isrc"] = meta["isrc"]
        rg = _replaygain_tag(meta.get("gain"))
        if rg:
            audio["replaygain_track_gain"] = rg
        if cover:
            pic = Picture()
            pic.type = 3  # front cover
            pic.mime = "image/jpeg"
            pic.data = cover
            audio.clear_pictures()
            audio.add_picture(pic)
        audio.save()
        return

    # MP3 / ID3
    try:
        audio = ID3(path)
    except ID3Error:
        audio = ID3()
    audio.delete()
    audio.add(TIT2(encoding=3, text=meta["title"]))
    audio.add(TPE1(encoding=3, text=meta["artists"]))
    audio.add(TALB(encoding=3, text=meta["album"]))
    audio.add(TPE2(encoding=3, text=meta["albumartist"]))
    if meta.get("tracknumber"):
        audio.add(TRCK(encoding=3, text=str(meta["tracknumber"])))
    if meta.get("discnumber"):
        audio.add(TPOS(encoding=3, text=str(meta["discnumber"])))
    if meta.get("date"):
        audio.add(TDRC(encoding=3, text=str(meta["date"])))
    if meta.get("isrc"):
        audio.add(TSRC(encoding=3, text=meta["isrc"]))
    rg = _replaygain_tag(meta.get("gain"))
    if rg:
        audio.add(TXXX(encoding=3, desc="REPLAYGAIN_TRACK_GAIN", text=rg))
    if cover:
        audio.add(APIC(encoding=3, mime="image/jpeg", type=3, desc="Cover", data=cover))
    audio.save(path)
