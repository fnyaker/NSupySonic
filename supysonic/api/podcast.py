# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""Subsonic podcast endpoints, backed by Deezer shows/episodes.

Podcasts are materialized as ``PodcastChannel`` / ``PodcastEpisode`` rows (the
local DB is the source of truth for subscriptions). Episode audio is fetched and
archived on first stream/download exactly like Deezer tracks, then transcoded on
demand through the normal media pipeline.
"""

import logging
import os

from flask import current_app, request

from ..db import PodcastChannel, PodcastEpisode

from . import get_entity, api_routing
from .exceptions import Forbidden, GenericError, MissingParameter, NotFound

logger = logging.getLogger(__name__)


def _provider():
    provider = getattr(current_app, "deezer", None)
    if provider is None:
        raise GenericError("Deezer proxy is not enabled")
    return provider


def _cfg():
    return current_app.config["DEEZER"]


def _podcast_owner():
    """User that owns imported podcast channels: the configured sync_user if any,
    else the requesting user."""
    from ..db import User

    sync_user = _cfg().get("sync_user")
    if sync_user:
        try:
            return User.get(name=sync_user)
        except User.DoesNotExist:
            pass
    return request.user


def _require_admin():
    if not request.user.admin:
        raise Forbidden()


@api_routing("/getPodcasts")
def get_podcasts():
    include_episodes = request.values.get("includeEpisodes", "true") != "false"
    pid = request.values.get("id")

    if pid is not None:
        channel = get_entity(PodcastChannel)
        channels = [channel]
    else:
        channels = list(PodcastChannel.select().order_by(PodcastChannel.title))

    return request.formatter(
        "podcasts",
        {
            "channel": [
                c.as_subsonic_channel(request.user, request.client, include_episodes)
                for c in channels
            ]
        },
    )


@api_routing("/getNewestPodcasts")
def get_newest_podcasts():
    count = min(int(request.values.get("count", 20) or 20), 100)
    episodes = (
        PodcastEpisode.select()
        .order_by(
            PodcastEpisode.publish_date.desc(), PodcastEpisode.created.desc()
        )
        .limit(count)
    )
    return request.formatter(
        "newestPodcasts",
        {
            "episode": [
                e.as_subsonic_episode(request.user, request.client) for e in episodes
            ]
        },
    )


@api_routing("/refreshPodcasts")
def refresh_podcasts():
    _require_admin()
    provider = _provider()
    from ..deezer.importer import DeezerImporter

    owner = _podcast_owner()
    importer = DeezerImporter(provider, owner.name)
    importer.sync_podcasts(int(_cfg().get("podcast_episodes") or 30))
    return request.formatter.empty


@api_routing("/createPodcastChannel")
def create_podcast_channel():
    _require_admin()
    url = request.values.get("url")
    if not url:
        raise MissingParameter("url")

    provider = _provider()
    from ..deezer.archive import parse_deezer_ref, import_show

    try:
        kind, did = parse_deezer_ref(url)
    except ValueError as e:
        raise GenericError(f"Unsupported podcast URL: {url}") from e

    if kind not in ("show", "episode"):
        raise GenericError("Only Deezer podcast (show) URLs are supported")

    show_id = did
    if kind == "episode":
        info = provider.dz.api.get_episode(did)
        show_id = (info.get("podcast") or {}).get("id") or info.get("podcast_id")
        if not show_id:
            raise GenericError(f"Could not resolve show for episode {did}")

    if _cfg().get("push_to_deezer", True):
        try:
            provider.add_favorite_show(show_id)
        except Exception:
            logger.debug("show.addFavorite failed for %s", show_id, exc_info=True)

    import_show(
        provider, _podcast_owner(), show_id,
        episode_limit=int(_cfg().get("podcast_episodes") or 30),
    )
    return request.formatter.empty


def _delete_episode_file(episode):
    if episode.path and os.path.isfile(episode.path):
        try:
            os.remove(episode.path)
        except OSError:
            logger.warning("Could not delete episode file %s", episode.path)


@api_routing("/deletePodcastChannel")
def delete_podcast_channel():
    _require_admin()
    channel = get_entity(PodcastChannel)

    provider = getattr(current_app, "deezer", None)
    if provider is not None and channel.deezer_id and _cfg().get("push_to_deezer", True):
        try:
            provider.remove_favorite_show(channel.deezer_id)
        except Exception:
            logger.debug(
                "show.deleteFavorite failed for %s", channel.deezer_id, exc_info=True
            )

    for episode in channel.episodes:
        _delete_episode_file(episode)
    channel.delete_instance(recursive=True)
    return request.formatter.empty


@api_routing("/deletePodcastEpisode")
def delete_podcast_episode():
    _require_admin()
    episode = get_entity(PodcastEpisode)
    _delete_episode_file(episode)
    episode.path = None
    episode.bitrate = None
    episode.status = "deleted"
    episode.save()
    return request.formatter.empty


@api_routing("/downloadPodcastEpisode")
def download_podcast_episode():
    provider = _provider()
    episode = get_entity(PodcastEpisode)
    from ..deezer.archive import ensure_episode_archived

    if episode.path and os.path.isfile(episode.path):
        return request.formatter.empty
    try:
        ensure_episode_archived(provider, episode)
    except Exception as e:
        logger.warning("Podcast download failed for episode %s: %s", episode.id, e)
        raise GenericError("Could not fetch episode from Deezer")
    return request.formatter.empty
