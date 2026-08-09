CREATE TABLE IF NOT EXISTS folder (
    id INTEGER PRIMARY KEY AUTO_INCREMENT,
    root BOOLEAN NOT NULL,
    name VARCHAR(256) NOT NULL,
    path VARCHAR(4096) NOT NULL,
    path_hash BINARY(20) UNIQUE NOT NULL,
    created DATETIME NOT NULL,
    cover_art VARCHAR(256),
    last_scan INTEGER NOT NULL,
    parent_id INTEGER REFERENCES folder(id)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE INDEX index_folder_parent_id_fk ON folder(parent_id);

CREATE TABLE IF NOT EXISTS artist (
    id CHAR(32) PRIMARY KEY,
    name VARCHAR(256) NOT NULL,
    deezer_id VARCHAR(32)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS album (
    id CHAR(32) PRIMARY KEY,
    name VARCHAR(256) NOT NULL,
    artist_id CHAR(32) NOT NULL REFERENCES artist(id),
    deezer_id VARCHAR(32),
    cover_md5 VARCHAR(64)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE INDEX index_album_artist_id_fk ON album(artist_id);

CREATE TABLE IF NOT EXISTS track (
    id CHAR(32) PRIMARY KEY,
    disc INTEGER NOT NULL,
    number INTEGER NOT NULL,
    title VARCHAR(256) NOT NULL,
    year INTEGER,
    genre VARCHAR(256),
    duration INTEGER NOT NULL,
    has_art BOOLEAN NOT NULL DEFAULT false,
    deezer_id VARCHAR(32),
    album_id CHAR(32) NOT NULL REFERENCES album(id),
    artist_id CHAR(32) NOT NULL REFERENCES artist(id),
    bitrate INTEGER NOT NULL,
    gain DOUBLE,
    path VARCHAR(4096) NOT NULL,
    path_hash BINARY(20) UNIQUE NOT NULL,
    created DATETIME NOT NULL,
    last_modification INTEGER NOT NULL,
    play_count INTEGER NOT NULL,
    last_play DATETIME,
    unavailable DATETIME,
    root_folder_id INTEGER NOT NULL REFERENCES folder(id),
    folder_id INTEGER NOT NULL REFERENCES folder(id),
    owner_id CHAR(32) REFERENCES user(id)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE INDEX index_track_album_id_fk ON track(album_id);
CREATE INDEX index_track_artist_id_fk ON track(artist_id);
CREATE INDEX index_track_folder_id_fk ON track(folder_id);
CREATE INDEX index_track_root_folder_id_fk ON track(root_folder_id);

CREATE TABLE IF NOT EXISTS user (
    id CHAR(32) PRIMARY KEY,
    name VARCHAR(64) NOT NULL,
    mail VARCHAR(256),
    password VARCHAR(255) NOT NULL,
    salt CHAR(6) NOT NULL,
    password_clear VARCHAR(512),
    admin BOOLEAN NOT NULL,
    jukebox BOOLEAN NOT NULL,
    session_epoch INTEGER NOT NULL DEFAULT 0,
    listenbrainz_session CHAR(36),
    listenbrainz_status BOOLEAN NOT NULL,
    lastfm_session CHAR(32),
    lastfm_status BOOLEAN NOT NULL,
    last_play_id CHAR(32) REFERENCES track(id),
    last_play_date DATETIME
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE INDEX index_user_last_play_id_fk ON user(last_play_id);

CREATE TABLE IF NOT EXISTS client_prefs (
    user_id CHAR(32) NOT NULL REFERENCES user(id),
    client_name VARCHAR(32) NOT NULL,
    format VARCHAR(8),
    bitrate INTEGER,
    PRIMARY KEY (user_id, client_name)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE INDEX index_client_prefs_user_id_fk ON client_prefs(user_id);

CREATE TABLE IF NOT EXISTS starred_folder (
    user_id CHAR(32) NOT NULL REFERENCES user(id),
    starred_id INTEGER NOT NULL REFERENCES folder(id),
    date DATETIME NOT NULL,
    PRIMARY KEY (user_id, starred_id)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE INDEX index_starred_folder_user_id_fk ON starred_folder(user_id);
CREATE INDEX index_starred_folder_starred_id_fk ON starred_folder(starred_id);

CREATE TABLE IF NOT EXISTS starred_artist (
    user_id CHAR(32) NOT NULL REFERENCES user(id),
    starred_id CHAR(32) NOT NULL REFERENCES artist(id),
    date DATETIME NOT NULL,
    PRIMARY KEY (user_id, starred_id)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE INDEX index_starred_artist_user_id_fk ON starred_artist(user_id);
CREATE INDEX index_starred_artist_starred_id_fk ON starred_artist(starred_id);

CREATE TABLE IF NOT EXISTS starred_album (
    user_id CHAR(32) NOT NULL REFERENCES user(id),
    starred_id CHAR(32) NOT NULL REFERENCES album(id),
    date DATETIME NOT NULL,
    PRIMARY KEY (user_id, starred_id)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE INDEX index_starred_album_user_id_fk ON starred_album(user_id);
CREATE INDEX index_starred_album_starred_id_fk ON starred_album(starred_id);

CREATE TABLE IF NOT EXISTS starred_track (
    user_id CHAR(32) NOT NULL REFERENCES user(id),
    starred_id CHAR(32) NOT NULL REFERENCES track(id),
    date DATETIME NOT NULL,
    PRIMARY KEY (user_id, starred_id)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE INDEX index_starred_track_user_id_fk ON starred_track(user_id);
CREATE INDEX index_starred_track_starred_id_fk ON starred_track(starred_id);

CREATE TABLE IF NOT EXISTS rating_folder (
    user_id CHAR(32) NOT NULL REFERENCES user(id),
    rated_id INTEGER NOT NULL REFERENCES folder(id),
    rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
    PRIMARY KEY (user_id, rated_id)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE INDEX index_rating_folder_user_id_fk ON rating_folder(user_id);
CREATE INDEX index_rating_folder_rated_id_fk ON rating_folder(rated_id);

CREATE TABLE IF NOT EXISTS rating_track (
    user_id CHAR(32) NOT NULL REFERENCES user(id),
    rated_id CHAR(32) NOT NULL REFERENCES track(id),
    rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
    PRIMARY KEY (user_id, rated_id)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE INDEX index_rating_track_user_id_fk ON rating_track(user_id);
CREATE INDEX index_rating_track_rated_id_fk ON rating_track(rated_id);

CREATE TABLE IF NOT EXISTS chat_message (
    id CHAR(32) PRIMARY KEY,
    user_id CHAR(32) NOT NULL REFERENCES user(id),
    time INTEGER NOT NULL,
    message VARCHAR(512) NOT NULL
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE INDEX index_chat_message_user_id_fk ON chat_message(user_id);

CREATE TABLE IF NOT EXISTS playlist (
    id CHAR(32) PRIMARY KEY,
    user_id CHAR(32) NOT NULL REFERENCES user(id),
    name VARCHAR(256) NOT NULL,
    comment VARCHAR(256),
    public BOOLEAN NOT NULL,
    created DATETIME NOT NULL,
    deezer_id VARCHAR(32)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE INDEX index_playlist_user_id_fk ON playlist(user_id);

CREATE TABLE IF NOT EXISTS playlist_track (
    id CHAR(32) PRIMARY KEY,
    playlist_id CHAR(32) NOT NULL REFERENCES playlist(id),
    track_id CHAR(32) NOT NULL REFERENCES track(id),
    `index` INTEGER NOT NULL
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE INDEX index_playlist_track_playlist_id_fk ON playlist_track(playlist_id);
CREATE INDEX index_playlist_track_track_id_fk ON playlist_track(track_id);

CREATE TABLE meta (
    `key` VARCHAR(32) PRIMARY KEY,
    value VARCHAR(256) NOT NULL
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS radio_station (
    id CHAR(32) PRIMARY KEY,
    stream_url VARCHAR(256) NOT NULL,
    name VARCHAR(256) NOT NULL,
    homepage_url VARCHAR(256),
    created DATETIME NOT NULL
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS podcast_channel (
    id CHAR(32) PRIMARY KEY,
    user_id CHAR(32) NOT NULL REFERENCES user(id),
    deezer_id VARCHAR(32),
    url VARCHAR(4096) NOT NULL,
    title VARCHAR(256),
    description VARCHAR(4096),
    cover_art_md5 VARCHAR(64),
    created DATETIME NOT NULL,
    last_fetched DATETIME,
    error_message VARCHAR(256),
    subscribed BOOLEAN NOT NULL DEFAULT true
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE INDEX index_podcast_channel_user_id_fk ON podcast_channel(user_id);

CREATE TABLE IF NOT EXISTS podcast_episode (
    id CHAR(32) PRIMARY KEY,
    channel_id CHAR(32) NOT NULL REFERENCES podcast_channel(id),
    deezer_id VARCHAR(32),
    title VARCHAR(256) NOT NULL,
    description VARCHAR(4096),
    duration INTEGER NOT NULL,
    publish_date DATETIME,
    stream_url VARCHAR(4096),
    image_md5 VARCHAR(64),
    path VARCHAR(4096),
    bitrate INTEGER,
    status VARCHAR(16) NOT NULL,
    play_offset INTEGER NOT NULL,
    created DATETIME NOT NULL
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE INDEX index_podcast_episode_channel_id_fk ON podcast_episode(channel_id);

CREATE TABLE IF NOT EXISTS podcast_progress (
    user_id CHAR(32) NOT NULL REFERENCES user(id),
    episode_id CHAR(32) NOT NULL REFERENCES podcast_episode(id),
    position INTEGER NOT NULL,
    duration INTEGER NOT NULL,
    finished BOOLEAN NOT NULL,
    updated DATETIME NOT NULL,
    PRIMARY KEY (user_id, episode_id)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE INDEX index_podcast_progress_episode_id_fk ON podcast_progress(episode_id);

CREATE TABLE IF NOT EXISTS podcast_marker (
    id CHAR(32) PRIMARY KEY,
    user_id CHAR(32) NOT NULL REFERENCES user(id),
    episode_id CHAR(32) NOT NULL REFERENCES podcast_episode(id),
    position INTEGER NOT NULL,
    label VARCHAR(256),
    created DATETIME NOT NULL
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE INDEX index_podcast_marker_user_id_fk ON podcast_marker(user_id);
CREATE INDEX index_podcast_marker_episode_id_fk ON podcast_marker(episode_id);

CREATE TABLE IF NOT EXISTS track_artist (
    track_id CHAR(32) NOT NULL REFERENCES track(id),
    artist_id CHAR(32) NOT NULL REFERENCES artist(id),
    role VARCHAR(32) NOT NULL,
    position INTEGER NOT NULL,
    PRIMARY KEY (track_id, artist_id)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE INDEX index_track_artist_artist_id_fk ON track_artist(artist_id);
