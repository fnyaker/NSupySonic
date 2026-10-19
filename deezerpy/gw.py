import requests
from time import monotonic, sleep

import json
from deezerpy.utils import map_artist_album, map_user_track, map_user_playlist
from deezerpy.errors import GWAPIError, DeezerUnavailable
from deezerpy._throttle import limiter

# Wall-clock budget for ONE logical gateway call, retries included — see the
# same constant in deezerpy.api for why a retry count alone was not enough.
NET_BUDGET = 20.0
NET_RETRY_DELAY = 1.5
# How many times a single call may be replayed for a *non-network* reason (a
# refreshed CSRF token, a gateway FALLBACK). Bounded: these used to recurse with
# a fresh retry budget each time, so a gateway stuck on "invalid api token"
# looped until the stack (or the worker) gave out.
MAX_REPLAYS = 3


class PlaylistStatus():
    PUBLIC = 0
    PRIVATE = 1
    COLLABORATIVE = 2

EMPTY_TRACK_OBJ = {
    'SNG_ID': 0,
    'SNG_TITLE': '',
    'DURATION': 0,
    'MD5_ORIGIN': 0,
    'MEDIA_VERSION': 0,
    'FILESIZE': 0,
    'ALB_TITLE': "",
    'ALB_PICTURE': "",
    'ART_ID': 0,
    'ART_NAME': ""
}


class GW:
    def __init__(self, session, headers):
        self.http_headers = headers
        self.session = session
        self.api_token = None

    def api_call(self, method, args=None, params=None, _net_retries=2, _replays=MAX_REPLAYS):
        if args is None: args = {}
        if params is None: params = {}
        if not self.api_token and method != 'deezer.getUserData': self.api_token = self._get_token()
        deadline = monotonic() + NET_BUDGET
        while True:
            p = {'api_version': "1.0",
                 'api_token': 'null' if method == 'deezer.getUserData' else self.api_token,
                 'input': '3',
                 'method': method}
            p.update(params)
            limiter.acquire()
            try:
                # No explicit timeout: the session's default applies, so this
                # call can never outlive it (see deezerpy.DEFAULT_TIMEOUT).
                result_json = self.session.post(
                    "https://www.deezer.com/ajax/gw-light.php",
                    params=p,
                    json=args,
                    headers=self.http_headers
                ).json()
                if not isinstance(result_json, dict) or 'error' not in result_json:
                    raise ValueError("not a gateway response")
            except DeezerUnavailable:
                raise  # host known down: retrying is pure waiting
            except (requests.ConnectionError, requests.Timeout):
                # Bounded retry so a network outage surfaces instead of hanging forever.
                if _net_retries <= 0 or monotonic() + NET_RETRY_DELAY >= deadline:
                    raise
                _net_retries -= 1
                sleep(NET_RETRY_DELAY)
                continue
            except ValueError as exc:
                # An HTML error page, a captcha wall or a truncated body: the
                # gateway did not answer us. Unreachable, not a data verdict —
                # nothing may be declared missing on the strength of this.
                raise DeezerUnavailable(
                    f"gw-light.php returned an unusable body for {method}"
                ) from exc
            if not len(result_json['error']):
                break
            if _replays <= 0:
                raise GWAPIError(json.dumps(result_json['error']))
            if method != 'deezer.getUserData' and (
                result_json['error'] == {"GATEWAY_ERROR": "invalid api token"} or
                result_json['error'] == {"VALID_TOKEN_REQUIRED": "Invalid CSRF token"}
            ):
                # Excluding getUserData is what makes this terminate: refreshing
                # the token IS a getUserData call, so a gateway stuck on
                # "invalid api token" would otherwise refresh to fetch the token
                # to refresh the token, for ever.
                _replays -= 1
                self.api_token = self._get_token()
                continue
            if result_json.get('payload', {}) and result_json['payload'].get('FALLBACK', {}):
                _replays -= 1
                for key in result_json['payload']['FALLBACK'].keys():
                    args[key] = result_json['payload']['FALLBACK'][key]
                continue
            raise GWAPIError(json.dumps(result_json['error']))
        if not self.api_token and method == 'deezer.getUserData': self.api_token = result_json['results']['checkForm']
        return result_json['results']

    def _get_token(self):
        token_data = self.get_user_data()
        return token_data['checkForm']

    def get_user_data(self):
        return self.api_call('deezer.getUserData')

    def get_user_profile_page(self, user_id, tab, limit=10):
        return self.api_call('deezer.pageProfile', {'USER_ID': user_id, 'tab': tab, 'nb': limit})

    def get_user_favorite_ids(self, checksum = None, limit = 10000, start = 0):
        return self.api_call('song.getFavoriteIds', {'nb': limit, 'start': start, 'checksum': checksum})

    def get_user_menu(self, checksum=True, checksums=None):
        """The account menu in one call (``deezer.userMenu``).

        Returns ``PLAYLISTS``, ``EPISODE_BOOKMARKS`` and the favourite sections
        (``FAVORITES_ALBUMS`` / ``_ARTISTS`` / ``_PLAYLISTS`` / ``_SHOWS`` /
        ``_SONGS``) plus their friends/dislikes counterparts. Each section
        carries a ``checksum`` so passing it back skips an unchanged section.
        This is the call the current web app uses instead of ``pageProfile``
        tabs. Confirmed from a web-player HAR capture.
        """
        return self.api_call('deezer.userMenu', {
            'checksum': bool(checksum),
            'checksums': checksums or {},
        })

    def get_all_feedbacks(self, checksums=None):
        """Favourites/dislikes sets with per-section checksums
        (``user.getAllFeedbacks``). A section whose checksum still matches
        answers the string ``"Not modified"`` instead of its data."""
        return self.api_call('user.getAllFeedbacks', {'checksums': checksums or {}})

    def set_user_settings(self, settings):
        """Persist a slice of user settings (``user.setSettings``), e.g.
        ``{'site': {'player_repeat': 2}}``."""
        return self.api_call('user.setSettings', {'settings': settings})

    def get_child_accounts(self):
        return self.api_call('deezer.getChildAccounts')

    def get_track(self, sng_id):
        return self.api_call('song.getData', {'SNG_ID': sng_id})

    def get_track_page(self, sng_id):
        return self.api_call('deezer.pageTrack', {'SNG_ID': sng_id})

    def get_track_lyrics(self, sng_id):
        return self.api_call('song.getLyrics', {'SNG_ID': sng_id})

    def get_tracks(self, sng_ids):
        tracks_array = []
        body = self.api_call('song.getListData', {'SNG_IDS': sng_ids})
        data = [t for t in ((body or {}).get('data') or []) if isinstance(t, dict)]
        wanted = [i for i in sng_ids if i != 0]
        if len(data) == len(wanted):
            # Every id answered: the rows come back in the order asked.
            rows = iter(data)
            for i in sng_ids:
                tracks_array.append(next(rows) if i != 0 else dict(EMPTY_TRACK_OBJ))
            return tracks_array
        # Deezer leaves out a track it no longer has. Mapped by position, every
        # row after the hole belonged to the next id and the last one walked off
        # the end of the list: one dead favourite was an IndexError that took
        # the whole favourites list (and the nightly favourites sync) down.
        by_id = {}
        for t in data:
            by_id.setdefault(str(t.get('SNG_ID')), t)
        for i in sng_ids:
            row = by_id.get(str(i)) if i != 0 else None
            tracks_array.append(row if row is not None else dict(EMPTY_TRACK_OBJ))
        return tracks_array

    def get_tracks_data(self, sng_ids):
        """Several tracks in ONE call, matched by SNG_ID instead of position.

        ``get_tracks`` above maps the answer back onto the requested ids
        positionally and walks off the end of the list the moment Deezer
        returns fewer rows than were asked for — a single dead id does it.
        Callers that can match on SNG_ID themselves want this one.
        """
        body = self.api_call('song.getListData', {'SNG_IDS': [str(i) for i in sng_ids]})
        data = (body or {}).get('data') or []
        return [t for t in data if isinstance(t, dict)]

    def get_album(self, alb_id):
        return self.api_call('album.getData', {'ALB_ID': alb_id})

    def get_album_page(self, alb_id):
        return self.api_call('deezer.pageAlbum', {
            'ALB_ID': alb_id,
            'lang': 'en',
            'header': True,
            'tab': 0
        })

    def get_album_tracks(self, alb_id):
        tracks_array = []
        body = self.api_call('song.getListByAlbum', {'ALB_ID': alb_id, 'nb': -1})
        # enumerate, not list.index(): that compared every dict against all
        # the ones before it, quadratic in the length of the list.
        for position, track in enumerate(body['data']):
            track['POSITION'] = position
            tracks_array.append(track)
        return tracks_array

    def get_artist(self, art_id):
        return self.api_call('artist.getData', {'ART_ID': art_id})

    def get_artist_page(self, art_id):
        return self.api_call('deezer.pageArtist', {
            'ART_ID': art_id,
            'lang': 'en',
            'header': True,
            'tab': 0
        })

    def get_artist_top_tracks(self, art_id, limit=100):
        tracks_array = []
        body = self.api_call('artist.getTopTrack', {'ART_ID': art_id, 'nb': limit})
        # enumerate, not list.index(): that compared every dict against all
        # the ones before it, quadratic in the length of the list.
        for position, track in enumerate(body['data']):
            track['POSITION'] = position
            tracks_array.append(track)
        return tracks_array

    def get_artist_discography(self, art_id, index=0, limit=25):
        return self.api_call('album.getDiscography', {
            'ART_ID': art_id,
            "discography_mode":"all",
            'nb': limit,
            'nb_songs': 0,
            'start': index
        })

    def get_playlist(self, playlist_id):
        return self.get_playlist_page(playlist_id)

    def get_playlist_page(self, playlist_id):
        return self.api_call('deezer.pagePlaylist', {
            'PLAYLIST_ID': playlist_id,
            'lang': 'en',
            'header': True,
            'tags': True,
            'tab': 0
        })

    def set_playlist_seen(self, playlist_id):
        """Clear a playlist's "new tracks" badge (``playlist.setSeen``)."""
        return self.api_call('playlist.setSeen', {'playlist_id': playlist_id})

    def get_playlist_tracks(self, playlist_id):
        tracks_array = []
        body = self.api_call('playlist.getSongs', {'PLAYLIST_ID': playlist_id, 'nb': -1})
        # enumerate, not list.index(): that compared every dict against all
        # the ones before it, quadratic in the length of the list.
        for position, track in enumerate(body['data']):
            track['POSITION'] = position
            tracks_array.append(track)
        return tracks_array

    def get_page(self, page):
        params = {
            'gateway_input': json.dumps({
                'PAGE': page,
                'VERSION': '2.3',
                'SUPPORT': {
                    'grid': [
                        'channel',
                        'album'
                    ],
                    'horizontal-grid': [
                        'album'
                    ],
                },
                'LANG': 'en'
            })
        }
        return self.api_call('page.get', params=params)

    def search(self, query, index=0, limit=10, suggest=True, artist_suggest=True, top_tracks=True):
        return self.api_call('deezer.pageSearch', {
            "query": query,
            "start": index,
            "nb": limit,
            "suggest": suggest,
            "artist_suggest": artist_suggest,
            "top_tracks": top_tracks
        })

    def search_music(self, query, type, index=0, limit=10):
        return self.api_call('search.music', {
            "query": query,
            "filter": "ALL",
            "output": type,
            "start": index,
            "nb": limit
        })

    # Extra calls

    def get_artist_discography_tabs(self, art_id, limit=100):
        index = 0
        releases = []
        result = {'all': []}
        ids = []

        # Get all releases
        while True:
            response = self.get_artist_discography(art_id, index=index, limit=limit)
            releases += response['data']
            index += limit
            if index > response['total']:
                break

        for release in releases:
            if release['ALB_ID'] not in ids:
                ids.append(release['ALB_ID'])
                obj = map_artist_album(release)
                if (release['ART_ID'] == art_id or release['ART_ID'] != art_id and release['ROLE_ID'] == 0) and release['ARTISTS_ALBUMS_IS_OFFICIAL']:
                    # Handle all base record types
                    if not obj['record_type'] in result:
                        result[obj['record_type']] = []
                    result[obj['record_type']].append(obj)
                    result['all'].append(obj)
                else:
                    # Handle albums where the artist is featured
                    if release['ROLE_ID'] == 5:
                        if not 'featured' in result:
                            result['featured'] = []
                        result['featured'].append(obj)
                    # Handle "more" albums
                    elif release['ROLE_ID'] == 0:
                        if not 'more' in result:
                            result['more'] = []
                        result['more'].append(obj)
                        result['all'].append(obj)
        return result

    def get_track_with_fallback(self, sng_id):
        body = None
        if int(sng_id) > 0:
            try:
                body = self.get_track_page(sng_id)
            except:
                pass
        if body:
            if 'LYRICS' in body:
                body['DATA']['LYRICS'] = body['LYRICS']
            if 'ISRC' in body:
                body['DATA']['ALBUM_FALLBACK'] = body['ISRC']
            body = body['DATA']
        else:
            body = self.get_track(sng_id)
        return body

    def get_user_playlists(self, user_id, limit=25):
        user_profile_page = self.get_user_profile_page(user_id, 'playlists', limit=limit)
        blog_name = user_profile_page['DATA']['USER'].get('BLOG_NAME', "Unknown")
        data = user_profile_page['TAB']['playlists']['data']
        result = []
        for playlist in data:
            result.append(map_user_playlist(playlist, blog_name))
        return result

    def get_user_tracks(self, user_id, limit=25):
        user_data = self.get_user_data()
        if user_data['USER']['USER_ID'] == user_id: return self.get_my_favorite_tracks()
        data = self.get_user_profile_page(user_id, 'loved', limit=limit)['TAB']['loved']['data']
        result = []
        for track in data:
            result.append(map_user_track(track))
        return result

    # -- Flow / radio / mixes --------------------------------------------

    def get_track_mix(self, sng_id, start_with_input_track=True):
        """A radio/mix seeded from a single track (endless queue). ``data`` = tracks."""
        return self.api_call('song.getSearchTrackMix', {
            'sng_id': sng_id,
            'start_with_input_track': start_with_input_track,
        })

    def get_artist_radio(self, art_id, limit=25):
        """A radio/mix seeded from an artist. ``data`` holds tracks."""
        return self.api_call('smart.getSmartRadio', {'ART_ID': art_id, 'nb': limit})

    # -- Channels / genres ------------------------------------------------

    def get_channels(self):
        """The "channels" landing page (genres, moods, charts entry points)."""
        return self.get_page('channels')

    def get_channel(self, channel_name):
        """A specific channel page, e.g. ``channels/rock``."""
        return self.get_page(channel_name)

    # -- podcasts (Deezer calls them "shows") ----------------------------

    def get_show_page(self, show_id, nb=40, start=0):
        """A podcast (show) page: ``DATA`` (show), ``EPISODES.data`` (paginated),
        ``FAVORITE_STATUS``. Confirmed method/args from a web-player HAR capture.

        Each episode carries its own ``EPISODE_DIRECT_STREAM_URL`` (a plain MP3
        served by the podcast host), so no separate per-episode call is needed.
        """
        return self.api_call('deezer.pageShow', {
            'show_id': show_id,
            'lang': 'en',
            'nb': nb,
            'start': start,
        })

    def get_show_episodes(self, show_id, page_size=200):
        """Every episode of a show, paging through ``EPISODES`` until ``total``."""
        first = self.get_show_page(show_id, nb=page_size, start=0)
        episodes = list(first.get('EPISODES', {}).get('data', []))
        total = first.get('EPISODES', {}).get('total', len(episodes))
        start = len(episodes)
        while start < total:
            page = self.get_show_page(show_id, nb=page_size, start=start)
            data = page.get('EPISODES', {}).get('data', [])
            if not data:
                break
            episodes.extend(data)
            start += len(data)
        return episodes

    def get_episodes(self, episode_ids):
        """Several podcast episodes in one call (``episode.getListData``),
        the episode counterpart of :meth:`get_tracks`."""
        ids = [str(e) for e in episode_ids if e and str(e) != '0']
        if not ids:
            return []
        body = self.api_call('episode.getListData', {'episode_ids': ids})
        return body.get('data', []) if isinstance(body, dict) else []
