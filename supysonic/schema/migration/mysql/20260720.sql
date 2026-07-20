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
