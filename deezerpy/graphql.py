"""Minimal client for Deezer's GraphQL endpoint (pipe.deezer.com).

Used for features the private gateway doesn't expose — notably the customizable
**Flow** (genre/style clusters you can enable/disable). Authenticates with the
existing ARL session: it first tries a short-lived JWT minted from the ARL
(``auth.deezer.com``) as a Bearer token, and otherwise falls back to the session
cookies. All calls are best-effort; callers should handle failures gracefully.
"""

from __future__ import annotations

from deezerpy._throttle import limiter

PIPE_URL = "https://pipe.deezer.com/api"
# The web app mints a short-lived JWT from the ARL session. Both endpoints are
# **POST** (``/login/arl`` answers 405 to GET) and return the raw JWT as a
# text/plain body (not a JSON wrapper). ``/login/arl`` bootstraps from the
# ``arl`` cookie and also drops a ``refresh-token`` cookie; ``/login/renew``
# then reuses that cookie (it 400s with "no refresh-token cookie found" if it
# was never bootstrapped), so we always try ``/login/arl`` first.
ARL_URL = "https://auth.deezer.com/login/arl"
RENEW_URL = "https://auth.deezer.com/login/renew"
AUTH_PARAMS = {"jo": "p", "rto": "c", "i": "c"}
# pipe.deezer.com / auth.deezer.com validate the browser origin.
ORIGIN = "https://www.deezer.com"
REFERER = "https://www.deezer.com/"

# Exact operations captured from the Deezer web app.
Q_CUSTOMIZABLE = """query CustomizableFlowConfig($flowConfigId: String!) {
  flowConfig(flowConfigId: $flowConfigId) {
    id
    hasCustomizableClusterConfigurations
    __typename
  }
}"""

Q_FLOW_CONFIG = """query FlowConfig($flowConfigId: String!, $filter: FlowConfigClusterFilter = ALL, $first: Int!, $cursor: String) {
  flowConfig(flowConfigId: $flowConfigId) {
    id
    title
    clusterConfigurations(filter: $filter, after: $cursor, first: $first) {
      pageInfo { endCursor hasNextPage __typename }
      edges { node { ...FlowConfigClusterConfiguration __typename } __typename }
      __typename
    }
    __typename
  }
}

fragment FlowConfigClusterConfiguration on FlowConfigClusterConfiguration {
  id
  isEnabled
  isEditedByUser
  cluster {
    id
    title
    artists {
      id
      name
      picture { ...PictureMedium __typename }
      __typename
    }
    __typename
  }
  __typename
}

fragment PictureMedium on Picture {
  id
  medium: urls(pictureRequest: {width: 264, height: 264})
  explicitStatus
  __typename
}"""

M_UPDATE_FLOW = """mutation UpdateFlowConfig($flowConfigId: String!, $clusters: [UpdateFlowConfigClusterConfigurationInput!]!) {
  updateFlowConfigClusters(input: {flowConfigId: $flowConfigId, clusters: $clusters}) {
    ... on UpdateFlowConfigClustersError { isInvalidFlowConfigId __typename }
    __typename
  }
}"""

# -- batch metadata by id ------------------------------------------------
# pipe.deezer.com returns typed, ready-to-use objects for many ids in ONE call,
# which the gateway can only do for tracks (song.getListData). Handy for
# enriching rows already in the local library in a single round trip.

Q_ALBUMS_BY_ID = """query AlbumsById($ids: [String!]!) {
  albumsByIds(ids: $ids) {
    ...AlbumThumbnail
    __typename
  }
}

fragment AlbumThumbnail on Album {
  id
  displayTitle
  cover {
    ...PictureLarge
    __typename
  }
  contributors {
    edges {
      node {
        ... on Artist {
          id
          name
          __typename
        }
        __typename
      }
      __typename
    }
    __typename
  }
  isExplicit
  releaseDate
  __typename
}

fragment PictureLarge on Picture {
  id
  large: urls(pictureRequest: {width: 500, height: 500})
  explicitStatus
  __typename
}"""

Q_ARTISTS_BY_ID = """query ArtistById($ids: [String!]!) {
  artistsByIds(ids: $ids) {
    ...ArtistThumbnail
    __typename
  }
}

fragment ArtistThumbnail on Artist {
  id
  name
  fansCount
  picture {
    ...PictureLarge
    explicitStatus
    __typename
  }
  fansCount
  __typename
}

fragment PictureLarge on Picture {
  id
  large: urls(pictureRequest: {width: 500, height: 500})
  explicitStatus
  __typename
}"""

Q_PLAYLISTS_BY_ID = """query PlaylistById($ids: [String!]!) {
  playlistsByIds(ids: $ids) {
    ...ProfilePlaylist
    __typename
  }
}

fragment ProfilePlaylist on Playlist {
  id
  description
  picture {
    ...PictureLarge
    __typename
  }
  title
  estimatedTracksCount
  fansCount
  isPrivate
  isCollaborative
  lastModificationDate
  creationDate
  owner {
    id
    name
    __typename
  }
  __typename
}

fragment PictureLarge on Picture {
  id
  large: urls(pictureRequest: {width: 500, height: 500})
  explicitStatus
  __typename
}"""

# -- artist pages --------------------------------------------------------

Q_ARTIST_FULL = """query ArtistFull($artistId: String!, $relatedArtistFirst: Int!, $liveEventsFirst: Int!) {
  artist(artistId: $artistId) {
    ...ArtistMasthead
    relatedArtists: relatedArtist(first: $relatedArtistFirst) {
      edges {
        cursor
        node {
          ...ArtistBase
          __typename
        }
        __typename
      }
      pageInfo {
        hasNextPage
        hasPreviousPage
        startCursor
        endCursor
        __typename
      }
      __typename
    }
    liveEvents(
      first: $liveEventsFirst
      types: [CONCERT, FESTIVAL]
      statuses: [PENDING]
    ) {
      edges {
        node {
          id
          __typename
        }
        __typename
      }
      pageInfo {
        endCursor
        hasNextPage
        __typename
      }
      __typename
    }
    __typename
  }
  me {
    userFavorites {
      byArtist(artistId: $artistId) {
        estimatedTracksCount
        __typename
      }
      __typename
    }
    __typename
  }
}

fragment ArtistMasthead on Artist {
  ...ArtistBase
  ...ArtistBio
  ...ArtistSocial
  onTour
  status
  __typename
}

fragment ArtistBase on Artist {
  id
  name
  fansCount
  hasSmartRadio
  isFavorite
  picture {
    ...PictureSmall
    ...PictureMedium
    ...PictureLarge
    __typename
  }
  __typename
}

fragment PictureSmall on Picture {
  id
  small: urls(pictureRequest: {height: 100, width: 100})
  explicitStatus
  __typename
}

fragment PictureMedium on Picture {
  id
  medium: urls(pictureRequest: {width: 264, height: 264})
  explicitStatus
  __typename
}

fragment PictureLarge on Picture {
  id
  large: urls(pictureRequest: {width: 500, height: 500})
  explicitStatus
  __typename
}

fragment ArtistBio on Artist {
  bio {
    full
    __typename
  }
  __typename
}

fragment ArtistSocial on Artist {
  social {
    twitter
    facebook
    website
    __typename
  }
  __typename
}"""

Q_ARTIST_DISCOGRAPHY = """query ArtistDiscographyByType($artistId: String!, $nb: Int!, $roles: [ContributorRoles!]!, $types: [AlbumTypeInput!]!, $subType: AlbumSubTypeInput, $mode: DiscographyMode, $cursor: String, $order: AlbumOrder) {
  artist(artistId: $artistId) {
    id
    albums(
      after: $cursor
      first: $nb
      onlyCanonical: true
      roles: $roles
      types: $types
      subType: $subType
      mode: $mode
      order: $order
    ) {
      edges {
        cursor
        node {
          ...AlbumBase
          ...AlbumContributors
          __typename
        }
        __typename
      }
      pageInfo {
        hasNextPage
        hasPreviousPage
        startCursor
        endCursor
        __typename
      }
      __typename
    }
    __typename
  }
}

fragment AlbumBase on Album {
  id
  displayTitle
  cover {
    ...PictureSmall
    ...PictureMedium
    ...PictureLarge
    __typename
  }
  releaseDate
  isFavorite
  isExplicit
  __typename
}

fragment PictureSmall on Picture {
  id
  small: urls(pictureRequest: {height: 100, width: 100})
  explicitStatus
  __typename
}

fragment PictureMedium on Picture {
  id
  medium: urls(pictureRequest: {width: 264, height: 264})
  explicitStatus
  __typename
}

fragment PictureLarge on Picture {
  id
  large: urls(pictureRequest: {width: 500, height: 500})
  explicitStatus
  __typename
}

fragment AlbumContributors on Album {
  contributors {
    edges {
      cursor
      roles
      node {
        ... on Artist {
          id
          name
          picture {
            ...PictureSmall
            ...PictureMedium
            ...PictureLarge
            __typename
          }
          isFavorite
          fansCount
          __typename
        }
        __typename
      }
      __typename
    }
    __typename
  }
  __typename
}"""

Q_ARTIST_RELATED_PLAYLISTS = """query ArtistRelatedPlaylists($artistId: String!, $relatedPlaylistFirst: Int!, $cursor: String) {
  artist(artistId: $artistId) {
    id
    playlists {
      relatedPlaylists(first: $relatedPlaylistFirst, after: $cursor) {
        edges {
          cursor
          node {
            ...PlaylistThumbnail
            __typename
          }
          __typename
        }
        pageInfo {
          hasNextPage
          endCursor
          __typename
        }
        __typename
      }
      __typename
    }
    __typename
  }
}

fragment PlaylistThumbnail on Playlist {
  id
  title
  fansCount
  picture {
    ...PictureLarge
    __typename
  }
  owner {
    id
    name
    __typename
  }
  isPrivate
  isCollaborative
  isFavorite
  isFromFavoriteTracks
  isSponsored
  estimatedTracksCount
  __typename
}

fragment PictureLarge on Picture {
  id
  large: urls(pictureRequest: {width: 500, height: 500})
  explicitStatus
  __typename
}"""

Q_ARTIST_CURATED_PLAYLISTS = """query ArtistCuratedPlaylists($artistId: String!, $curatedPlaylistFirst: Int!) {
  artist(artistId: $artistId) {
    id
    playlists {
      curatedPlaylists(first: $curatedPlaylistFirst) {
        edges {
          node {
            ...PlaylistBase
            fansCount
            owner {
              id
              name
              __typename
            }
            estimatedTracksCount
            isPrivate
            isCollaborative
            __typename
          }
          __typename
        }
        __typename
      }
      __typename
    }
    __typename
  }
}

fragment PlaylistBase on Playlist {
  id
  picture {
    ...PictureSmall
    ...PictureMedium
    ...PictureLarge
    __typename
  }
  title
  __typename
}

fragment PictureSmall on Picture {
  id
  small: urls(pictureRequest: {height: 100, width: 100})
  explicitStatus
  __typename
}

fragment PictureMedium on Picture {
  id
  medium: urls(pictureRequest: {width: 264, height: 264})
  explicitStatus
  __typename
}

fragment PictureLarge on Picture {
  id
  large: urls(pictureRequest: {width: 500, height: 500})
  explicitStatus
  __typename
}"""

# -- playlists -----------------------------------------------------------

Q_PLAYLIST_MASTHEAD = """query PlaylistMasthead($playlistId: String!) {
  playlist(playlistId: $playlistId) {
    ...PlaylistBase
    description
    isCharts
    isCollaborative
    isPrivate
    isFromFavoriteTracks
    __typename
  }
}

fragment PlaylistBase on Playlist {
  id
  picture {
    ...PictureSmall
    ...PictureMedium
    ...PictureLarge
    __typename
  }
  title
  __typename
}

fragment PictureSmall on Picture {
  id
  small: urls(pictureRequest: {height: 100, width: 100})
  explicitStatus
  __typename
}

fragment PictureMedium on Picture {
  id
  medium: urls(pictureRequest: {width: 264, height: 264})
  explicitStatus
  __typename
}

fragment PictureLarge on Picture {
  id
  large: urls(pictureRequest: {width: 500, height: 500})
  explicitStatus
  __typename
}"""

# -- Flow tuner ----------------------------------------------------------

Q_FLOW_TUNER_HEADER = """query FlowTunerHeader($flowConfigId: String!) {
  flowConfig(flowConfigId: $flowConfigId) {
    id
    title
    visuals {
      dynamicPageIcon {
        id
        urls(uiAssetRequest: {height: 100, width: 100})
        __typename
      }
      __typename
    }
    __typename
  }
}"""

# -- the signed-in user's raw library ------------------------------------
# These return bare ids (with timestamps) instead of full objects — the fastest
# way to learn what changed in the account's playlists/favourites. The web app
# uses them to reconcile its sidebar; the ids feed the normal metadata calls.

Q_MY_PLAYLISTS_RAW = """query PersonalPlaylistsRaw($includesPlayedAt: Boolean = false) {
  me {
    id
    rawPlaylists {
      id
      playedAt @include(if: $includesPlayedAt)
      __typename
    }
    __typename
  }
}"""

Q_MY_FAVORITE_PLAYLISTS_RAW = """query PrivateUserFavoritePlaylistRaw($includesPlayedAt: Boolean = false) {
  me {
    id
    userFavorites {
      rawPlaylists {
        id
        playedAt @include(if: $includesPlayedAt)
        favoritedAt
        __typename
      }
      __typename
    }
    __typename
  }
}"""

Q_MY_FAVORITE_ALBUMS_RAW = """query PrivateUserAlbumsRaw($includesPlayedAt: Boolean = false) {
  me {
    id
    userFavorites {
      rawAlbums {
        id
        favoritedAt
        playedAt @include(if: $includesPlayedAt)
        __typename
      }
      __typename
    }
    __typename
  }
}"""

Q_MY_FAVORITE_ARTISTS_RAW = """query PrivateUserArtistsRaw($includesPlayedAt: Boolean = false) {
  me {
    id
    userFavorites {
      rawArtists {
        id
        favoritedAt
        playedAt @include(if: $includesPlayedAt)
        __typename
      }
      __typename
    }
    __typename
  }
}"""


class GraphQLError(Exception):
    pass


class GraphQL:
    def __init__(self, session, headers):
        self.session = session
        self.headers = headers
        self._jwt = None

    def _auth_headers(self):
        headers = dict(self.headers)
        headers["Origin"] = ORIGIN
        headers["Referer"] = REFERER
        return headers

    @staticmethod
    def _extract_jwt(resp):
        """Pull the JWT out of an auth.deezer.com response.

        The endpoints return the bare token as ``text/plain``; some deployments
        wrap it in JSON instead, so handle both.
        """
        body = (resp.text or "").strip()
        if not body:
            return None
        if body[:1] in "{[":
            try:
                obj = resp.json()
            except Exception:
                return None
            if isinstance(obj, dict):
                tok = (
                    obj.get("jwt")
                    or obj.get("jwtToken")
                    or (obj.get("results") or {}).get("jwt")
                )
                return tok.strip() if tok else None
            return None
        body = body.strip('"')
        # A JWT is three dot-separated base64url segments starting with "ey".
        if body.startswith("ey") and body.count(".") == 2:
            return body
        return None

    def _jwt_token(self):
        if self._jwt:
            return self._jwt
        headers = self._auth_headers()
        # Bootstrap from the ARL cookie first; fall back to the renew endpoint.
        # Both are POST (a GET to /login/arl is rejected with HTTP 405).
        for url in (ARL_URL, RENEW_URL):
            try:
                resp = self.session.post(
                    url, params=AUTH_PARAMS, headers=headers, timeout=(5, 10)
                )
            except Exception:
                continue
            token = self._extract_jwt(resp)
            if token:
                self._jwt = token
                return token
        return None

    @staticmethod
    def _is_jwt_error(errors):
        for err in errors or []:
            t = str(err.get("type") or "")
            xt = str((err.get("extensions") or {}).get("type") or "")
            if "jwt" in t.lower() or "jwt" in xt.lower():
                return True
        return False

    def call(self, operation_name, query, variables=None, _retry=True):
        limiter.acquire()
        headers = self._auth_headers()
        headers["Content-Type"] = "application/json"
        token = self._jwt_token()
        if token:
            headers["Authorization"] = "Bearer " + token
        body = {
            "operationName": operation_name,
            "query": query,
            "variables": variables or {},
        }
        resp = self.session.post(PIPE_URL, json=body, headers=headers, timeout=(5, 15))
        if resp.status_code in (401, 403) and _retry:
            self._jwt = None  # force a fresh token and retry once
            return self.call(operation_name, query, variables, _retry=False)
        resp.raise_for_status()
        payload = resp.json()
        if payload.get("errors"):
            # The token endpoint answers HTTP 200, so an expired/missing JWT
            # surfaces as a GraphQL error — re-mint and retry once.
            if _retry and self._is_jwt_error(payload["errors"]):
                self._jwt = None
                return self.call(operation_name, query, variables, _retry=False)
            raise GraphQLError(str(payload["errors"])[:300])
        return payload.get("data") or {}

    # -- Flow customization ----------------------------------------------

    def is_flow_customizable(self, flow_config_id="default") -> bool:
        data = self.call(
            "CustomizableFlowConfig", Q_CUSTOMIZABLE, {"flowConfigId": flow_config_id}
        )
        cfg = (data or {}).get("flowConfig") or {}
        return bool(cfg.get("hasCustomizableClusterConfigurations"))

    def get_flow_clusters(self, flow_config_id="default") -> list:
        """All genre/style clusters with their enabled state."""
        out = []
        cursor = None
        for _ in range(10):  # safety bound on pagination
            data = self.call(
                "FlowConfig",
                Q_FLOW_CONFIG,
                {
                    "flowConfigId": flow_config_id,
                    "filter": "ALL",
                    "first": 50,
                    "cursor": cursor,
                },
            )
            cfg = (data or {}).get("flowConfig") or {}
            conns = cfg.get("clusterConfigurations") or {}
            for edge in conns.get("edges") or []:
                node = edge.get("node") or {}
                if node:
                    out.append(node)
            page = conns.get("pageInfo") or {}
            if not page.get("hasNextPage"):
                break
            cursor = page.get("endCursor")
        return out

    def update_flow_clusters(self, clusters, flow_config_id="default"):
        """`clusters` = [{clusterId, isEnabled, isEditedByUser}]."""
        return self.call(
            "UpdateFlowConfig",
            M_UPDATE_FLOW,
            {"flowConfigId": flow_config_id, "clusters": clusters},
        )

    def get_flow_tuner_header(self, flow_config_id="default"):
        """Title + icon of a flow configuration (the Flow tuner's masthead)."""
        data = self.call(
            "FlowTunerHeader", Q_FLOW_TUNER_HEADER, {"flowConfigId": flow_config_id}
        )
        return (data or {}).get("flowConfig") or {}

    # -- batch metadata by id --------------------------------------------

    def get_albums_by_ids(self, ids):
        data = self.call("AlbumsById", Q_ALBUMS_BY_ID, {"ids": [str(i) for i in ids]})
        return (data or {}).get("albumsByIds") or []

    def get_artists_by_ids(self, ids):
        data = self.call("ArtistById", Q_ARTISTS_BY_ID, {"ids": [str(i) for i in ids]})
        return (data or {}).get("artistsByIds") or []

    def get_playlists_by_ids(self, ids):
        data = self.call(
            "PlaylistById", Q_PLAYLISTS_BY_ID, {"ids": [str(i) for i in ids]}
        )
        return (data or {}).get("playlistsByIds") or []

    # -- artist pages ----------------------------------------------------

    def get_artist_full(self, artist_id, related_first=6, live_events_first=6):
        data = self.call(
            "ArtistFull",
            Q_ARTIST_FULL,
            {
                "artistId": str(artist_id),
                "relatedArtistFirst": related_first,
                "liveEventsFirst": live_events_first,
            },
        )
        return (data or {}).get("artist") or {}

    def get_artist_discography(
        self,
        artist_id,
        nb=30,
        roles=("MAIN",),
        types=("ALBUM",),
        sub_type=None,
        mode="OFFICIAL",
        cursor=None,
        order="RANK",
    ):
        """One page of an artist's releases by type. Returns ``(nodes, page_info)``."""
        data = self.call(
            "ArtistDiscographyByType",
            Q_ARTIST_DISCOGRAPHY,
            {
                "artistId": str(artist_id),
                "nb": nb,
                "roles": list(roles),
                "types": list(types),
                "subType": sub_type,
                "mode": mode,
                "cursor": cursor,
                "order": order,
            },
        )
        albums = ((data or {}).get("artist") or {}).get("albums") or {}
        nodes = [e.get("node") for e in albums.get("edges") or [] if e.get("node")]
        return nodes, (albums.get("pageInfo") or {})

    def get_artist_related_playlists(self, artist_id, first=3, cursor=None):
        """Playlists containing the artist. Returns ``(nodes, page_info)``."""
        data = self.call(
            "ArtistRelatedPlaylists",
            Q_ARTIST_RELATED_PLAYLISTS,
            {"artistId": str(artist_id), "relatedPlaylistFirst": first, "cursor": cursor},
        )
        conn = (
            (((data or {}).get("artist") or {}).get("playlists") or {}).get(
                "relatedPlaylists"
            )
            or {}
        )
        nodes = [e.get("node") for e in conn.get("edges") or [] if e.get("node")]
        return nodes, (conn.get("pageInfo") or {})

    def get_artist_curated_playlists(self, artist_id, first=10):
        """Playlists curated by the artist."""
        data = self.call(
            "ArtistCuratedPlaylists",
            Q_ARTIST_CURATED_PLAYLISTS,
            {"artistId": str(artist_id), "curatedPlaylistFirst": first},
        )
        conn = (
            (((data or {}).get("artist") or {}).get("playlists") or {}).get(
                "curatedPlaylists"
            )
            or {}
        )
        return [e.get("node") for e in conn.get("edges") or [] if e.get("node")]

    # -- playlists -------------------------------------------------------

    def get_playlist_masthead(self, playlist_id):
        data = self.call(
            "PlaylistMasthead", Q_PLAYLIST_MASTHEAD, {"playlistId": str(playlist_id)}
        )
        return (data or {}).get("playlist") or {}

    # -- the signed-in user's raw library --------------------------------

    def get_my_playlists(self, includes_played_at=True):
        data = self.call(
            "PersonalPlaylistsRaw",
            Q_MY_PLAYLISTS_RAW,
            {"includesPlayedAt": includes_played_at},
        )
        return ((data or {}).get("me") or {}).get("rawPlaylists") or []

    def get_my_favorite_albums(self, includes_played_at=True):
        data = self.call(
            "PrivateUserAlbumsRaw",
            Q_MY_FAVORITE_ALBUMS_RAW,
            {"includesPlayedAt": includes_played_at},
        )
        return (((data or {}).get("me") or {}).get("userFavorites") or {}).get(
            "rawAlbums"
        ) or []

    def get_my_favorite_artists(self, includes_played_at=True):
        data = self.call(
            "PrivateUserArtistsRaw",
            Q_MY_FAVORITE_ARTISTS_RAW,
            {"includesPlayedAt": includes_played_at},
        )
        return (((data or {}).get("me") or {}).get("userFavorites") or {}).get(
            "rawArtists"
        ) or []

    def get_my_favorite_playlists(self, includes_played_at=True):
        data = self.call(
            "PrivateUserFavoritePlaylistRaw",
            Q_MY_FAVORITE_PLAYLISTS_RAW,
            {"includesPlayedAt": includes_played_at},
        )
        return (((data or {}).get("me") or {}).get("userFavorites") or {}).get(
            "rawPlaylists"
        ) or []
