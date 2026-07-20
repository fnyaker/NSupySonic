CREATE TABLE IF NOT EXISTS podcast_progress (
    user_id UUID NOT NULL REFERENCES "user",
    episode_id UUID NOT NULL REFERENCES podcast_episode,
    position INTEGER NOT NULL,
    duration INTEGER NOT NULL,
    finished BOOLEAN NOT NULL,
    updated TIMESTAMP NOT NULL,
    PRIMARY KEY (user_id, episode_id)
);
CREATE INDEX IF NOT EXISTS index_podcast_progress_episode_id_fk ON podcast_progress(episode_id);

CREATE TABLE IF NOT EXISTS podcast_marker (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES "user",
    episode_id UUID NOT NULL REFERENCES podcast_episode,
    position INTEGER NOT NULL,
    label VARCHAR(256),
    created TIMESTAMP NOT NULL
);
CREATE INDEX IF NOT EXISTS index_podcast_marker_user_id_fk ON podcast_marker(user_id);
CREATE INDEX IF NOT EXISTS index_podcast_marker_episode_id_fk ON podcast_marker(episode_id);
