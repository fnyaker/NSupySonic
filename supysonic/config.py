# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Copyright (C) 2013-2020 Alban 'spl0k' Féron
#                    2017 Óscar García Amor
#
# Distributed under terms of the GNU AGPLv3 license.

import os
import sys
import tempfile

from configparser import RawConfigParser

current_config = None


def get_current_config():
    return current_config or DefaultConfig()


class DefaultConfig:
    DEBUG = False

    tempdir = os.path.join(tempfile.gettempdir(), "supysonic")
    BASE = {
        "database_uri": "sqlite:///" + os.path.join(tempdir, "supysonic.db"),
        "scanner_extensions": None,
        "follow_symlinks": False,
    }
    WEBAPP = {
        "cache_dir": tempdir,
        "cache_size": 1024,
        "transcode_cache_size": 512,
        "log_file": None,
        "log_level": "WARNING",
        "log_rotate": True,
        "mount_webui": True,
        "mount_api": True,
        "mount_spa": True,
        "session_cookie_secure": False,
        # Number of trusted reverse proxies in front of the app. 0 = none (the
        # app is reached directly); when > 0, X-Forwarded-* headers from that
        # many hops are trusted (ProxyFix). NEVER set this unless a proxy you
        # control really sits in front, or clients could spoof their IP/proto.
        "proxy_fix_hops": 0,
        "index_ignored_prefixes": "El La Le Las Les Los The",
        "online_lyrics": False,
    }
    DAEMON = {
        "socket": (
            r"\\.\pipe\supysonic"
            if sys.platform == "win32"
            else os.path.join(tempdir, "supysonic.sock")
        ),
        "run_watcher": True,
        "wait_delay": 5,
        "jukebox_command": None,
        "log_file": None,
        "log_level": "WARNING",
        "log_rotate": True,
    }
    LASTFM = {"api_key": None, "secret": None}
    LISTENBRAINZ = {"api_url": "https://api.listenbrainz.org"}
    TRANSCODING = {}
    MIMETYPES = {}
    DEEZER = {
        "enabled": False,
        "arl": None,
        "archive_dir": None,
        "default_quality": "FLAC",  # FLAC | MP3_320 | MP3_128
        "sync_user": None,  # supysonic user owning imported playlists/favorites
        "sync_playlists": True,
        "sync_favorites": True,
        "import_new_releases": True,  # import the smart tracklists below
        "import_flow": True,
        # Smart tracklists to expose as "Deezer · ..." playlists (None = default
        # set: new-releases, discovery, monthly-top, inspired-by-1..5).
        "smart_tracklists": None,
        "push_to_deezer": True,  # mirror Subsonic playlist/favorite changes to Deezer
        # Import user-dropped audio files in archive_dir as local library tracks
        # (deezer_id NULL). They're searchable/playlistable like Deezer tracks but
        # the Deezer sync never touches them. Scanned on each sync run.
        "scan_local": True,
        # Report played tracks to Deezer (log.listen) so your recommendations and
        # Flow keep learning from what you play here. Off by default (opt-in).
        "report_listens": False,
        "preload": True,
        "preload_count": 2,
        # Auto-sync: on by default once a sync_user is set. Daily at sync_at
        # (default 04:00) unless sync_interval (minutes) is set, plus a run on
        # startup. The web app drives this; no cron/manual step needed.
        "sync_on_start": True,
        "sync_at": "04:00",  # daily auto-sync time "HH:MM"
        "sync_interval": 0,  # minutes; >0 overrides sync_at
    }

    def __init__(self):
        current_config = self


class IniConfig(DefaultConfig):
    common_paths = [
        "/etc/supysonic",
        os.path.expanduser("~/.supysonic"),
        os.path.expanduser("~/.config/supysonic/supysonic.conf"),
        "supysonic.conf",
    ]

    def __init__(self, paths):
        super().__init__()

        parser = RawConfigParser()
        parser.read(paths)

        for section in parser.sections():
            options = {k: self.__try_parse(v) for k, v in parser.items(section)}
            section = section.upper()

            if hasattr(self, section):
                getattr(self, section).update(options)
            else:
                setattr(self, section, options)

    @staticmethod
    def __try_parse(value):
        try:
            return int(value)
        except ValueError:
            try:
                return float(value)
            except ValueError:
                lv = value.lower()
                if lv in ("yes", "true", "on"):
                    return True
                if lv in ("no", "false", "off"):
                    return False
                return value

    @classmethod
    def from_common_locations(cls):
        return IniConfig(cls.common_paths)
