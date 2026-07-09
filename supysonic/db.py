# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Copyright (C) 2013-2025 Alban 'spl0k' Féron
#
# Distributed under terms of the GNU AGPLv3 license.

import importlib
import importlib.resources
import mimetypes
import os.path
import time

from datetime import datetime
from hashlib import sha1
from peewee import (
    AutoField,
    BlobField,
    BooleanField,
    CharField,
    DateTimeField,
    FixedCharField,
    FloatField,
    ForeignKeyField,
    IntegerField,
    UUIDField,
)
from peewee import CompositeKey, DatabaseProxy, Model, MySQLDatabase
from peewee import PostgresqlDatabase, chunked, fn
from playhouse.db_url import parseresult_to_dict, schemes
from urllib.parse import urlparse
from uuid import UUID, uuid4

SCHEMA_VERSION = "20260709"


def now():
    return datetime.now().replace(microsecond=0)


def random():
    if isinstance(db.obj, MySQLDatabase):
        return fn.rand()
    return fn.random()


def PrimaryKeyField(**kwargs):
    return UUIDField(primary_key=True, default=uuid4, **kwargs)


db = DatabaseProxy()


class _Model(Model):
    class Meta:
        database = db
        legacy_table_names = False


class Meta(_Model):
    key = CharField(32, primary_key=True)
    value = CharField(256)


class PathMixin:
    @classmethod
    def get(cls, *args, **kwargs):
        if kwargs:
            path = kwargs.pop("path", None)
            if path:
                kwargs["_path_hash"] = sha1(path.encode("utf-8")).digest()
        return _Model.get.__func__(cls, *args, **kwargs)

    def __init__(self, *args, **kwargs):
        if "path" in kwargs:
            path = kwargs["path"]
            kwargs["_path_hash"] = sha1(path.encode("utf-8")).digest()
        _Model.__init__(self, *args, **kwargs)

    def __setattr__(self, attr, value):
        _Model.__setattr__(self, attr, value)
        if attr == "path":
            _Model.__setattr__(self, "_path_hash", sha1(value.encode("utf-8")).digest())


class Folder(PathMixin, _Model):
    id = AutoField()
    root = BooleanField()
    name = CharField()
    path = CharField(4096)  # unique
    _path_hash = BlobField(column_name="path_hash", unique=True)
    created = DateTimeField(default=now)
    cover_art = CharField(null=True)
    last_scan = IntegerField(default=0)

    parent = ForeignKeyField("self", null=True, backref="children")

    def as_subsonic_child(self, user):
        info = {
            "id": str(self.id),
            "isDir": True,
            "title": self.name,
            "album": self.name,
            "created": self.created.isoformat(),
        }
        if not self.root:
            info["parent"] = str(self.parent.id)
            info["artist"] = self.parent.name
        if self.cover_art:
            info["coverArt"] = str(self.id)
        else:
            for track in self.tracks:
                if track.has_art:
                    info["coverArt"] = str(track.id)
                    break

        try:
            starred = StarredFolder[user.id, self.id]
            info["starred"] = starred.date.isoformat()
        except StarredFolder.DoesNotExist:
            pass

        try:
            rating = RatingFolder[user.id, self.id]
            info["userRating"] = rating.rating
        except RatingFolder.DoesNotExist:
            pass

        avgRating = (
            RatingFolder.select(fn.avg(RatingFolder.rating, coerce=False))
            .where(RatingFolder.rated == self)
            .scalar()
        )
        if avgRating:
            info["averageRating"] = avgRating

        return info

    def as_subsonic_artist(self, user):  # "Artist" type in XSD
        info = {"id": str(self.id), "name": self.name}

        try:
            starred = StarredFolder[user.id, self.id]
            info["starred"] = starred.date.isoformat()
        except StarredFolder.DoesNotExist:
            pass

        return info

    def as_subsonic_directory(self, user, client):  # "Directory" type in XSD
        info = {
            "id": str(self.id),
            "name": self.name,
            "child": [
                f.as_subsonic_child(user)
                for f in self.children.order_by(fn.lower(Folder.name))
            ]
            + [
                t.as_subsonic_child(user, client)
                for t in sorted(self.tracks, key=lambda t: t.sort_key())
            ],
        }
        if not self.root:
            info["parent"] = str(self.parent.id)

        return info

    @classmethod
    def prune(cls):
        alias = cls.alias()
        query = cls.select(cls.id).where(
            ~cls.root,
            Track.select(fn.count("*")).where(Track.folder == cls.id) == 0,
            alias.select(fn.count("*")).where(alias.parent == cls.id) == 0,
        )
        total = 0
        while True:
            clone = query.clone()  # peewee caches the results, clone to force a refetch
            for f in clone:
                f.delete_instance(recursive=True)
                total += 1
            if not len(clone):
                return total

    def delete_hierarchy(self):
        if self.root:
            cond = Track.root_folder == self
        else:
            cond = Track.path.startswith(self.path)

        return self.__delete_hierarchy(cond)

    def __delete_hierarchy(self, cond):
        users = User.select(User.id).join(Track).where(cond)
        User.update(last_play=None).where(User.id.in_(users)).execute()

        tracks = Track.select(Track.id).where(cond)
        RatingTrack.delete().where(RatingTrack.rated.in_(tracks)).execute()
        StarredTrack.delete().where(StarredTrack.starred.in_(tracks)).execute()

        path_cond = Folder.path.startswith(self.path)
        folders = Folder.select(Folder.id).where(path_cond)
        RatingFolder.delete().where(RatingFolder.rated.in_(folders)).execute()
        StarredFolder.delete().where(StarredFolder.starred.in_(folders)).execute()

        deleted_tracks = Track.delete().where(cond).execute()

        query = Folder.delete().where(path_cond)
        if isinstance(db.obj, MySQLDatabase):
            # MySQL can't propery resolve deletion order when it has several to handle
            query = query.order_by(Folder.path.desc())
        query.execute()

        return deleted_tracks


class Artist(_Model):
    id = PrimaryKeyField()
    name = CharField()
    deezer_id = CharField(null=True)

    def as_subsonic_artist(self, user):
        info = {
            "id": str(self.id),
            "name": self.name,
            "albumCount": self.albums.count(),
        }

        if self.deezer_id:
            # getCoverArt fetches the artist image from Deezer on demand.
            info["coverArt"] = str(self.id)

        try:
            starred = StarredArtist[user.id, self.id]
            info["starred"] = starred.date.isoformat()
        except StarredArtist.DoesNotExist:
            pass

        return info

    @classmethod
    def prune(cls):
        album_artists = Album.select(Album.artist)
        track_artists = Track.select(Track.artist)

        StarredArtist.delete().where(
            StarredArtist.starred.not_in(album_artists),
            StarredArtist.starred.not_in(track_artists),
        ).execute()

        return (
            cls.delete()
            .where(
                cls.id.not_in(album_artists),
                cls.id.not_in(track_artists),
            )
            .execute()
        )


class Album(_Model):
    id = PrimaryKeyField()
    name = CharField()
    artist = ForeignKeyField(Artist, backref="albums")
    deezer_id = CharField(null=True)
    cover_md5 = CharField(null=True)

    def as_subsonic_album(self, user):  # "AlbumID3" type in XSD
        duration, created, year = self.tracks.select(
            fn.sum(Track.duration), fn.min(Track.created), fn.min(Track.year)
        ).scalar(as_tuple=True)

        info = {
            "id": str(self.id),
            "name": self.name,
            "artist": self.artist.name,
            "artistId": str(self.artist.id),
            "songCount": self.tracks.count(),
            "duration": duration,
            "created": created.isoformat(),
        }

        track_with_cover = (
            self.tracks.join(Folder).where(Folder.cover_art.is_null(False)).first()
        )
        if track_with_cover is not None:
            info["coverArt"] = str(track_with_cover.folder.id)
        else:
            track_with_cover = self.tracks.where(Track.has_art).first()
            if track_with_cover is not None:
                info["coverArt"] = str(track_with_cover.id)

        if "coverArt" not in info and self.cover_md5:
            # Deezer album with no local art yet: getCoverArt fetches it.
            info["coverArt"] = str(self.id)

        if year:
            info["year"] = year

        genre = ", ".join(
            g
            for (g,) in self.tracks.select(Track.genre)
            .where(Track.genre.is_null(False))
            .distinct()
            .tuples()
        )
        if genre:
            info["genre"] = genre

        try:
            starred = StarredAlbum[user.id, self.id]
            info["starred"] = starred.date.isoformat()
        except StarredAlbum.DoesNotExist:
            pass

        return info

    def sort_key(self):
        year = self.tracks.select(fn.min(Track.year)).scalar() or 9999
        return f"{year}{self.name.lower()}"

    @classmethod
    def prune(cls):
        albums = Track.select(Track.album)
        StarredAlbum.delete().where(StarredAlbum.starred.not_in(albums)).execute()
        return cls.delete().where(cls.id.not_in(albums)).execute()


class Track(PathMixin, _Model):
    id = PrimaryKeyField()
    disc = IntegerField()
    number = IntegerField()
    title = CharField()
    year = IntegerField(null=True)
    genre = CharField(null=True)
    duration = IntegerField()
    has_art = BooleanField(default=False)
    deezer_id = CharField(null=True)

    album = ForeignKeyField(Album, backref="tracks")
    artist = ForeignKeyField(Artist, backref="tracks")

    bitrate = IntegerField()
    # ReplayGain-style track loudness gain in dB (from Deezer's GAIN), used by
    # the web player for static, per-track volume normalization. Null when
    # unknown (e.g. locally uploaded files).
    gain = FloatField(null=True)

    path = CharField(4096)  # unique
    _path_hash = BlobField(column_name="path_hash", unique=True)
    created = DateTimeField(default=now)
    last_modification = IntegerField()

    play_count = IntegerField(default=0)
    last_play = DateTimeField(null=True)

    root_folder = ForeignKeyField(Folder, backref="+")
    folder = ForeignKeyField(Folder, backref="tracks")

    def as_subsonic_child(self, user, prefs):
        info = {
            "id": str(self.id),
            "parent": str(self.folder.id),
            "isDir": False,
            "title": self.title,
            "album": self.album.name,
            "artist": self.artist.name,
            "track": self.number,
            "size": os.path.getsize(self.path) if os.path.isfile(self.path) else -1,
            "contentType": self.mimetype,
            "suffix": self.suffix(),
            "duration": self.duration,
            "bitRate": self.bitrate,
            "path": self.path[len(self.root_folder.path) + 1 :],
            "isVideo": False,
            "discNumber": self.disc,
            "created": self.created.isoformat(),
            "albumId": str(self.album.id),
            "artistId": str(self.artist.id),
            "type": "music",
        }

        if self.year:
            info["year"] = self.year
        if self.genre:
            info["genre"] = self.genre
        if self.has_art:
            info["coverArt"] = str(self.id)
        elif self.folder.cover_art:
            info["coverArt"] = str(self.folder.id)
        elif self.deezer_id:
            # Deezer track not archived yet: point at the album cover, which
            # getCoverArt fetches from Deezer on demand.
            info["coverArt"] = str(self.album_id)

        try:
            starred = StarredTrack[user.id, self.id]
            info["starred"] = starred.date.isoformat()
        except StarredTrack.DoesNotExist:
            pass

        try:
            rating = RatingTrack[user.id, self.id]
            info["userRating"] = rating.rating
        except RatingTrack.DoesNotExist:
            pass

        avgRating = (
            RatingTrack.select(fn.avg(RatingTrack.rating, coerce=False))
            .where(RatingTrack.rated == self)
            .scalar()
        )
        if avgRating:
            info["averageRating"] = avgRating

        if (
            prefs is not None
            and prefs.format is not None
            and prefs.format != self.suffix()
        ):
            info["transcodedSuffix"] = prefs.format
            info["transcodedContentType"] = (
                mimetypes.guess_type("dummyname." + prefs.format, False)[0]
                or "application/octet-stream"
            )

        return info

    @property
    def mimetype(self):
        return mimetypes.guess_type(self.path, False)[0] or "application/octet-stream"

    def duration_str(self):
        m, s = divmod(self.duration, 60)
        h, m = divmod(m, 60)
        ret = f"{m:02}:{s:02}"
        if h:
            ret = f"{h:02}:{ret}"
        return ret

    def suffix(self):
        return os.path.splitext(self.path)[1][1:].lower()

    def sort_key(self):
        return f"{self.album.artist.name}{self.album.name}{self.disc:02}{self.number:02}{self.title}".lower()


class User(_Model):
    id = PrimaryKeyField()
    name = CharField(64, unique=True)
    mail = CharField(null=True)
    # argon2id hashes (~97 chars) for new/updated passwords; legacy SHA1 hashes
    # (40 chars) are transparently rehashed on the next successful login.
    password = CharField(255)
    salt = FixedCharField(6)
    # Reversibly-encrypted password, enabling Subsonic token auth (t+s).
    password_clear = CharField(null=True)

    admin = BooleanField(default=False)
    jukebox = BooleanField(default=False)

    lastfm_session = FixedCharField(32, null=True)
    lastfm_status = BooleanField(
        default=True
    )  # True: ok/unlinked, False: invalid session

    listenbrainz_session = FixedCharField(36, null=True)
    listenbrainz_status = BooleanField(
        default=True
    )  # True: ok/unlinked, False: invalid token

    last_play = ForeignKeyField(Track, null=True, backref="+")
    last_play_date = DateTimeField(null=True)

    def as_subsonic_user(self):
        return {
            "username": self.name,
            "email": self.mail or "",
            "scrobblingEnabled": self.lastfm_session is not None and self.lastfm_status,
            "adminRole": self.admin,
            "settingsRole": True,
            "downloadRole": True,
            "uploadRole": False,
            "playlistRole": True,
            "coverArtRole": False,
            "commentRole": False,
            "podcastRole": self.admin,
            "streamRole": True,
            "jukeboxRole": self.admin or self.jukebox,
            "shareRole": False,
        }


class ClientPrefs(_Model):
    user = ForeignKeyField(User, backref="clients")
    client_name = CharField(32)
    format = CharField(8, null=True)
    bitrate = IntegerField(null=True)

    class Meta:
        primary_key = CompositeKey("user", "client_name")


def _make_starred_model(target_model):
    class Starred(_Model):
        user = ForeignKeyField(User, backref="+")
        starred = ForeignKeyField(target_model, backref="+")
        date = DateTimeField(default=now)

        class Meta:
            primary_key = CompositeKey("user", "starred")
            table_name = "starred_" + target_model._meta.table_name

    return Starred


StarredFolder = _make_starred_model(Folder)
StarredArtist = _make_starred_model(Artist)
StarredAlbum = _make_starred_model(Album)
StarredTrack = _make_starred_model(Track)


def _make_rating_model(target_model):
    class Rating(_Model):
        user = ForeignKeyField(User, backref="+")
        rated = ForeignKeyField(target_model, backref="+")
        rating = IntegerField()  # min=1, max=5

        class Meta:
            primary_key = CompositeKey("user", "rated")
            table_name = "rating_" + target_model._meta.table_name

    return Rating


RatingFolder = _make_rating_model(Folder)
RatingTrack = _make_rating_model(Track)


class ChatMessage(_Model):
    id = PrimaryKeyField()
    user = ForeignKeyField(User, backref="+")
    time = IntegerField(default=lambda: int(time.time()))
    message = CharField(512)

    def responsize(self):
        return {
            "username": self.user.name,
            "time": self.time * 1000,
            "message": self.message,
        }


class Playlist(_Model):
    id = PrimaryKeyField()
    user = ForeignKeyField(User, backref="playlists")
    name = CharField()
    comment = CharField(null=True)
    public = BooleanField(default=False)
    created = DateTimeField(default=now)
    deezer_id = CharField(null=True)

    def as_subsonic_playlist(self, user):
        tracks, duration = self.__tracks_query(
            fn.count("*"), fn.sum(Track.duration)
        ).scalar(as_tuple=True)
        info = {
            "id": str(self.id),
            "name": (
                self.name
                if self.user.id == user.id
                else f"[{self.user.name}] {self.name}"
            ),
            "owner": self.user.name,
            "public": self.public,
            "songCount": tracks,
            "duration": duration or 0,
            "created": self.created.isoformat(),
        }
        if self.comment:
            info["comment"] = self.comment
        if self.deezer_id:
            info["coverArt"] = str(self.id)
        return info

    def get_tracks(self):
        return [t for t in self.__tracks_query().order_by(PlaylistTrack.index)]

    def __tracks_query(self, *fields):
        return (
            Track.select(*fields)
            .join(PlaylistTrack)
            .where(PlaylistTrack.playlist == self)
        )

    def clear(self):
        PlaylistTrack.delete().where(PlaylistTrack.playlist == self).execute()

    def add(self, track):
        if isinstance(track, UUID):
            tid = track
        elif isinstance(track, Track):
            tid = track.id
        elif isinstance(track, str):
            tid = UUID(track)

        index = (
            PlaylistTrack.select(fn.max(PlaylistTrack.index))
            .where(PlaylistTrack.playlist == self)
            .scalar()
        )
        index = 0 if index is None else index + 1
        PlaylistTrack.create(playlist=self, track=tid, index=index)

    def remove_at_indexes(self, indexes):
        max_index, count = (
            PlaylistTrack.select(fn.max(PlaylistTrack.index), fn.count("*"))
            .where(PlaylistTrack.playlist == self)
            .scalar(as_tuple=True)
        )
        should_reindex = count != max_index + 1

        if should_reindex:
            query = (
                PlaylistTrack.select(PlaylistTrack.id)
                .where(PlaylistTrack.playlist == self)
                .order_by(PlaylistTrack.index)
            )
            for i, t in zip(range(count), query):
                t.index = i
                t.save(only=(PlaylistTrack.index,))

        for i in sorted(set(indexes), reverse=True):
            if i < 0:
                continue
            PlaylistTrack.delete().where(
                PlaylistTrack.playlist == self, PlaylistTrack.index == i
            ).execute()
            PlaylistTrack.update({PlaylistTrack.index: PlaylistTrack.index - 1}).where(
                PlaylistTrack.playlist == self, PlaylistTrack.index > i
            ).execute()


class PlaylistTrack(_Model):
    id = PrimaryKeyField()
    playlist = ForeignKeyField(Playlist, backref="+")
    track = ForeignKeyField(Track, backref="+")
    index = IntegerField()


class RadioStation(_Model):
    id = PrimaryKeyField()
    stream_url = CharField()
    name = CharField()
    homepage_url = CharField(null=True)
    created = DateTimeField(default=now)

    def as_subsonic_station(self):
        info = {
            "id": str(self.id),
            "streamUrl": self.stream_url,
            "name": self.name,
            "homePageUrl": self.homepage_url,
        }
        return info


class PodcastChannel(_Model):
    id = PrimaryKeyField()
    user = ForeignKeyField(User, backref="podcast_channels")
    deezer_id = CharField(null=True)
    url = CharField(4096)
    title = CharField(null=True)
    description = CharField(4096, null=True)
    cover_art_md5 = CharField(null=True)
    created = DateTimeField(default=now)
    last_fetched = DateTimeField(null=True)
    error_message = CharField(null=True)

    def as_subsonic_channel(self, user, prefs=None, include_episodes=True):
        info = {
            "id": str(self.id),
            "url": self.url,
            "title": self.title or "",
            "status": "error" if self.error_message else "completed",
        }
        if self.description:
            info["description"] = self.description
        if self.cover_art_md5:
            info["coverArt"] = str(self.id)
        if self.error_message:
            info["errorMessage"] = self.error_message
        if include_episodes:
            info["episode"] = [
                e.as_subsonic_episode(user, prefs)
                for e in self.episodes.order_by(
                    PodcastEpisode.publish_date.desc(), PodcastEpisode.created.desc()
                )
            ]
        return info


class PodcastEpisode(_Model):
    id = PrimaryKeyField()
    channel = ForeignKeyField(PodcastChannel, backref="episodes")
    deezer_id = CharField(null=True)
    title = CharField()
    description = CharField(4096, null=True)
    duration = IntegerField(default=0)
    publish_date = DateTimeField(null=True)
    stream_url = CharField(4096, null=True)  # EPISODE_DIRECT_STREAM_URL
    image_md5 = CharField(null=True)
    path = CharField(4096, null=True)  # NULL until archived on first play/download
    bitrate = IntegerField(null=True)
    status = CharField(16, default="new")  # new|downloading|completed|error
    play_offset = IntegerField(default=0)  # seconds, mirrors Deezer bookmarks
    created = DateTimeField(default=now)

    def suffix(self):
        if self.path:
            return os.path.splitext(self.path)[1][1:].lower()
        return "mp3"

    @property
    def mimetype(self):
        if self.path:
            return (
                mimetypes.guess_type(self.path, False)[0] or "application/octet-stream"
            )
        return "audio/mpeg"

    def as_subsonic_episode(self, user, prefs=None):
        suffix = self.suffix()
        size = (
            os.path.getsize(self.path)
            if self.path and os.path.isfile(self.path)
            else -1
        )
        info = {
            "id": str(self.id),
            "streamId": str(self.id),
            "channelId": str(self.channel_id),
            "isDir": False,
            "title": self.title,
            "album": self.channel.title or "",
            "artist": self.channel.title or "",
            "status": self.status,
            "type": "podcast",
            "isVideo": False,
            "suffix": suffix,
            "contentType": self.mimetype,
            "size": size,
            "duration": self.duration,
        }
        if self.bitrate:
            info["bitRate"] = self.bitrate
        if self.description:
            info["description"] = self.description
        if self.publish_date:
            info["publishDate"] = self.publish_date.isoformat()
        if self.created:
            info["created"] = self.created.isoformat()
        if self.play_offset:
            info["bookmarkPosition"] = self.play_offset * 1000
        if self.image_md5 or self.channel.cover_art_md5:
            info["coverArt"] = str(self.id)

        if prefs is not None and prefs.format is not None and prefs.format != suffix:
            info["transcodedSuffix"] = prefs.format
            info["transcodedContentType"] = (
                mimetypes.guess_type("dummyname." + prefs.format, False)[0]
                or "application/octet-stream"
            )
        return info


def get_resource_text(respath):
    return importlib.resources.files(__package__).joinpath(respath).read_text("utf-8")


def list_migrations(provider):
    return (
        e.name
        for e in importlib.resources.files(__package__)
        .joinpath(f"schema/migration/{provider}")
        .iterdir()
    )


def execute_sql_resource_script(respath):
    sql = get_resource_text(respath)
    for statement in sql.split(";"):
        # Drop standalone comment lines first: ``split(";")`` keeps a leading
        # comment attached to the statement that follows it, and skipping the
        # whole chunk when it starts with "--" would silently drop that
        # statement (e.g. a CREATE right after a comment).
        statement = "\n".join(
            line
            for line in statement.splitlines()
            if line.strip() and not line.strip().startswith("--")
        ).strip()
        if statement:
            db.execute_sql(statement)


def _database_from_uri(database_uri):
    """Build a peewee Database instance (and its provider name) from a URI.

    Returns ``(database, provider, args)`` without binding the global proxy, so
    the same logic can serve both ``init_database`` and the SQLite->Postgres/
    MySQL migration (which needs two independent connections at once). ``args``
    is the raw connection kwargs dict, needed by the ``.py`` migrations.
    """
    uri = urlparse(database_uri)
    args = parseresult_to_dict(uri)
    if uri.scheme.startswith("mysql"):
        args.setdefault("charset", "utf8mb4")
        args.setdefault("binary_prefix", True)

    if uri.scheme.startswith("mysql"):
        provider = "mysql"
    elif uri.scheme.startswith("postgres"):
        provider = "postgres"
    elif uri.scheme.startswith("sqlite"):
        provider = "sqlite"
        # WAL + relaxed sync make writes (bulk Deezer imports) and concurrent
        # readers (web + prefetch worker) much faster while staying crash-safe.
        args["pragmas"] = {
            "foreign_keys": 1,
            "journal_mode": "wal",
            "synchronous": "normal",
            "cache_size": -16000,  # ~16 MB page cache
            "busy_timeout": 5000,  # wait up to 5s on a locked db instead of erroring
        }
    else:
        raise RuntimeError(f"Unsupported database: {uri.scheme}")

    db_class = schemes.get(uri.scheme)
    return db_class(**args), provider, args


def init_database(database_uri):
    database, provider, args = _database_from_uri(database_uri)
    db.initialize(database)
    db.connect()

    # Check if we should create the tables
    if not db.table_exists("meta"):
        with db.atomic():
            execute_sql_resource_script(f"schema/{provider}.sql")
            Meta.create(key="schema_version", value=SCHEMA_VERSION)

    # Check for schema changes
    version = Meta["schema_version"]
    if version.value < SCHEMA_VERSION:
        args.pop("pragmas", ())
        migrations = sorted(list_migrations(provider))
        for migration in migrations:
            if migration[0] in ("_", "."):
                continue

            date, ext = os.path.splitext(migration)
            if date <= version.value:
                continue

            if ext == ".sql":
                with db.atomic():
                    execute_sql_resource_script(
                        f"schema/migration/{provider}/{migration}"
                    )
            elif ext == ".py":
                m = importlib.import_module(
                    f".schema.migration.{provider}.{date}", __package__
                )
                m.apply(args.copy())

        version.value = SCHEMA_VERSION
        version.save()


def release_database():
    if db.obj is not None:
        db.close()
    db.initialize(None)


# Models in foreign-key-safe insertion order (parents before children). ``meta``
# is intentionally excluded: the destination already holds the correct
# schema_version after ``init_database`` runs its create/migrate step.
def _migration_order():
    return [
        Folder,
        Artist,
        Album,
        Track,
        User,
        ClientPrefs,
        StarredFolder,
        StarredArtist,
        StarredAlbum,
        StarredTrack,
        RatingFolder,
        RatingTrack,
        ChatMessage,
        Playlist,
        PlaylistTrack,
        RadioStation,
        PodcastChannel,
        PodcastEpisode,
    ]


def _reset_postgres_sequences():
    """After copying rows with explicit ids, advance Postgres identity columns
    so future inserts don't collide. Only ``folder.id`` is auto-generated."""
    if not isinstance(db.obj, PostgresqlDatabase):
        return
    db.execute_sql(
        "SELECT setval(pg_get_serial_sequence('folder', 'id'), "
        "COALESCE((SELECT MAX(id) FROM folder), 1))"
    )


def migrate_database(
    source_uri, dest_uri, *, progress=None, batch_size=200, skip_if_populated=False
):
    """Copy all data from one database to another (e.g. SQLite -> Postgres).

    The destination schema is created/migrated to the current version first; the
    copy then refuses to run unless the destination is still empty, so it is
    safe to invoke unconditionally. ``progress`` is an optional callable
    ``(table_name, row_count)`` invoked once per table. With
    ``skip_if_populated`` a non-empty destination returns ``None`` instead of
    raising (handy for an idempotent boot-time migration). Otherwise returns a
    dict of ``{table_name: rows_copied}``.
    """
    if urlparse(source_uri).geturl() == urlparse(dest_uri).geturl():
        raise RuntimeError("source and destination databases are identical")

    source_db, _, _ = _database_from_uri(source_uri)
    source_db.connect()

    # Bind the global proxy (and therefore every model) to the destination and
    # ensure its schema exists. Reads from the source go through bind_ctx below.
    init_database(dest_uri)

    try:
        if User.select().count() or Folder.select().count():
            if skip_if_populated:
                return None
            raise RuntimeError(
                "destination database already contains data; refusing to "
                "overwrite it (drop it first to re-run the migration)"
            )

        copied = {}
        for model in _migration_order():
            table = model._meta.table_name
            with source_db.bind_ctx([model]):
                query = model.select()
                # Self-referential FK: insert parents (lower ids) first.
                if model is Folder:
                    query = query.order_by(Folder.id)
                rows = [dict(inst.__data__) for inst in query]

            if rows:
                with db.atomic():
                    for batch in chunked(rows, batch_size):
                        model.insert_many(batch).execute()
            copied[table] = len(rows)
            if progress:
                progress(table, len(rows))

        _reset_postgres_sequences()
        return copied
    finally:
        source_db.close()


def open_connection(reuse=False):
    return db.connect(reuse)


def close_connection():
    db.close()
