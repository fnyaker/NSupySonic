# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic API server.
#
# Distributed under terms of the GNU AGPLv3 license.

"""One quality scale for every provider and every format (docs/multi-provider.md §3).

A ``Quality`` is ``(cls, effective_kbps)``, compared in that order. The class
is the coarse step a person hears; the effective rate breaks ties inside it
after correcting for the codec, so Opus 133k from YouTube (worth ~200 kbit/s
of MP3) lands in ``high`` rather than ``medium``.

Written against plain dicts (an *offer*: what a provider COULD deliver) and
against files (what is really on disk), so it needs nothing from the provider
interface. Pure and cheap: reading a file touches its header only.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field
from typing import Iterable, Optional, TypedDict

logger = logging.getLogger(__name__)

HIRES, LOSSLESS, HIGH, MEDIUM, LOW = 50, 40, 30, 20, 10

# Lossy classes by EFFECTIVE bitrate: HIGH from 192, MEDIUM from 96.
HIGH_FROM = 192
MEDIUM_FROM = 96

# Kbit/s of MP3 that one kbit/s of the codec is worth (the same listening
# quality at a lower rate). Measured by the codecs' own published listening
# tests, rounded: Opus is transparent at about two thirds of MP3's rate, AAC-LC
# at about three quarters, Vorbis a little better than MP3.
CODEC_FACTOR = {"opus": 1.5, "aac": 1.3, "vorbis": 1.2, "mp3": 1.0}

# Lossless above the CD: more than 16 bits or more than 48 kHz.
CD_DEPTH = 16
CD_RATE = 48000

_LOSSLESS_FMTS = frozenset({"flac", "alac", "wav", "wavpack", "ape", "aiff", "pcm"})
_CODEC_OF_FMT = {
    "opus": "opus",
    "ogg": "vorbis",
    "oga": "vorbis",
    "vorbis": "vorbis",
    "m4a": "aac",
    "mp4": "aac",
    "aac": "aac",
    "mp3": "mp3",
    "mp2": "mp3",
}
_LABEL = {"flac": "FLAC", "alac": "ALAC", "wav": "WAV", "wavpack": "WavPack", "ape": "APE", "aiff": "AIFF"}


class OfferDict(TypedDict, total=False):
    quality: object
    fmt: str
    bitrate: int
    lossless: bool
    bit_depth: int
    sample_rate: int


@dataclass(frozen=True, order=True)
class Quality:
    """Comparable by ``(cls, effective_kbps)`` only; the rest is for the label."""

    cls: int
    effective_kbps: int
    fmt: str = field(default="", compare=False)
    bitrate: int = field(default=0, compare=False)
    bit_depth: int = field(default=0, compare=False)
    sample_rate: int = field(default=0, compare=False)

    @property
    def lossless(self) -> bool:
        return self.cls >= LOSSLESS


def _int(value) -> int:
    try:
        return max(0, int(float(value)))
    except (TypeError, ValueError, OverflowError):
        return 0


def _norm_fmt(fmt) -> str:
    return str(fmt or "").strip().lower().lstrip(".")


def classify(fmt, bitrate=0, lossless=None, bit_depth=0, sample_rate=0) -> Quality:
    """The note of something delivered as ``fmt`` at ``bitrate`` kbit/s."""
    fmt = _norm_fmt(fmt)
    bitrate, bit_depth, sample_rate = _int(bitrate), _int(bit_depth), _int(sample_rate)
    if lossless is None:
        lossless = fmt in _LOSSLESS_FMTS
    if lossless:
        hires = bit_depth > CD_DEPTH or sample_rate > CD_RATE
        return Quality(HIRES if hires else LOSSLESS, bitrate, fmt, bitrate, bit_depth, sample_rate)
    effective = int(round(bitrate * CODEC_FACTOR.get(_CODEC_OF_FMT.get(fmt, "mp3"), 1.0)))
    if effective >= HIGH_FROM:
        cls = HIGH
    elif effective >= MEDIUM_FROM:
        cls = MEDIUM
    else:
        cls = LOW
    return Quality(cls, effective, fmt, bitrate, bit_depth, sample_rate)


def from_offer(offer: Optional[OfferDict]) -> Quality:
    """The note of an offer. A malformed or empty one is the lowest note."""
    if not isinstance(offer, dict):
        return Quality(LOW, 0)
    return classify(
        offer.get("fmt"),
        offer.get("bitrate"),
        offer.get("lossless") if offer.get("lossless") is not None else None,
        offer.get("bit_depth"),
        offer.get("sample_rate"),
    )


def rank(offers: Iterable[OfferDict]) -> list:
    """Offers best first. Stable: equal notes keep the order they came in
    (the caller's provider order is the tie-break)."""
    return sorted(offers, key=from_offer, reverse=True)


def best(offers: Iterable[OfferDict]) -> Optional[OfferDict]:
    """The best offer, the first of the equals; None for an empty list."""
    top, top_q = None, None
    for offer in offers:
        q = from_offer(offer)
        if top_q is None or q > top_q:
            top, top_q = offer, q
    return top


def _fmt_of(audio) -> str:
    name = type(audio).__name__.lower()
    if "flac" in name:
        return "flac"
    if "opus" in name:
        return "opus"
    if "vorbis" in name:
        return "vorbis"
    if "mp3" in name or "mpeg" in name or "mp2" in name:
        return "mp3"
    if "wavpack" in name:
        return "wavpack"
    if "monkeys" in name:
        return "ape"
    if "aiff" in name:
        return "aiff"
    if "wave" in name:
        return "wav"
    if "mp4" in name:
        codec = str(getattr(audio.info, "codec", "") or "").lower()
        return "alac" if codec.startswith("alac") else "m4a"
    return ""


def from_file(path) -> Optional[Quality]:
    """The note of an archived file, from its header (nothing is decoded).

    None when the file is missing or is not audio mutagen understands.
    """
    try:
        import mutagen

        audio = mutagen.File(path)
        if audio is None or audio.info is None:
            return None
        info = audio.info
        fmt = _fmt_of(audio)
        bitrate = _int(getattr(info, "bitrate", 0)) // 1000
        if not bitrate:
            # Opus and some Ogg streams do not say: size over length does.
            length = float(getattr(info, "length", 0) or 0)
            if length > 0:
                bitrate = int(os.path.getsize(path) * 8 / length / 1000)
        return classify(
            fmt,
            bitrate,
            None,
            getattr(info, "bits_per_sample", 0),
            getattr(info, "sample_rate", 0),
        )
    except Exception:  # unreadable header: no note, never a failure
        logger.debug("quality: cannot read %s", path, exc_info=True)
        return None


def label(q: Optional[Quality]) -> str:
    """What the player shows: "FLAC", "FLAC 24/96", "Opus 133k"."""
    if q is None:
        return ""
    name = _LABEL.get(q.fmt)
    if q.lossless:
        name = name or (q.fmt.upper() or "Lossless")
        if q.cls >= HIRES and q.bit_depth and q.sample_rate:
            rate = q.sample_rate / 1000
            return f"{name} {q.bit_depth}/{rate:g}"
        return name
    names = {"opus": "Opus", "vorbis": "Vorbis", "m4a": "AAC", "mp4": "AAC", "aac": "AAC", "mp3": "MP3", "ogg": "Vorbis"}
    base = names.get(q.fmt, q.fmt.upper())
    return f"{base} {q.bitrate}k" if q.bitrate and base else (base or "")
