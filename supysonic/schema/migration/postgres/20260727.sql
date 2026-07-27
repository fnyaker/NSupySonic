
CREATE TABLE IF NOT EXISTS track_artist (
    track_id UUID NOT NULL REFERENCES track,
    artist_id UUID NOT NULL REFERENCES artist,
    role VARCHAR(32) NOT NULL,
    position INTEGER NOT NULL,
    PRIMARY KEY (track_id, artist_id)
);
CREATE INDEX IF NOT EXISTS index_track_artist_artist_id_fk ON track_artist(artist_id);
