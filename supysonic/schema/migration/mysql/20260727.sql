
CREATE TABLE IF NOT EXISTS track_artist (
    track_id CHAR(32) NOT NULL REFERENCES track(id),
    artist_id CHAR(32) NOT NULL REFERENCES artist(id),
    role VARCHAR(32) NOT NULL,
    position INTEGER NOT NULL,
    PRIMARY KEY (track_id, artist_id)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE INDEX index_track_artist_artist_id_fk ON track_artist(artist_id);
