CREATE TABLE IF NOT EXISTS podcast_channel (
    id CHAR(36) PRIMARY KEY,
    user_id CHAR(36) NOT NULL REFERENCES user,
    deezer_id VARCHAR(32),
    url VARCHAR(4096) NOT NULL,
    title VARCHAR(256),
    description VARCHAR(4096),
    cover_art_md5 VARCHAR(64),
    created DATETIME NOT NULL,
    last_fetched DATETIME,
    error_message VARCHAR(256)
);
CREATE INDEX IF NOT EXISTS index_podcast_channel_user_id_fk ON podcast_channel(user_id);

CREATE TABLE IF NOT EXISTS podcast_episode (
    id CHAR(36) PRIMARY KEY,
    channel_id CHAR(36) NOT NULL REFERENCES podcast_channel,
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
);
CREATE INDEX IF NOT EXISTS index_podcast_episode_channel_id_fk ON podcast_episode(channel_id);
