-- Detaching from the Deezer account: release dates and Deezer's tempo on their
-- own columns, starred playlists, the nearest-tracks index and the enrichment
-- ledger.
ALTER TABLE track ADD COLUMN IF NOT EXISTS release_date VARCHAR(10);
ALTER TABLE track ADD COLUMN IF NOT EXISTS deezer_bpm DOUBLE PRECISION;
ALTER TABLE album ADD COLUMN IF NOT EXISTS release_date VARCHAR(10);
CREATE TABLE IF NOT EXISTS starred_playlist (
    user_id UUID NOT NULL REFERENCES "user",
    starred_id UUID NOT NULL REFERENCES playlist,
    date TIMESTAMP NOT NULL,
    PRIMARY KEY (user_id, starred_id)
);
CREATE INDEX IF NOT EXISTS index_starred_playlist_user_id_fk ON starred_playlist(user_id);
CREATE INDEX IF NOT EXISTS index_starred_playlist_starred_id_fk ON starred_playlist(starred_id);

CREATE TABLE IF NOT EXISTS track_neighbor (
    track_id UUID NOT NULL REFERENCES track ON DELETE CASCADE,
    neighbor_id UUID NOT NULL REFERENCES track ON DELETE CASCADE,
    score DOUBLE PRECISION NOT NULL,
    rank INTEGER NOT NULL,
    PRIMARY KEY (track_id, neighbor_id)
);
CREATE INDEX IF NOT EXISTS index_track_neighbor_track_id_rank ON track_neighbor(track_id, rank);
CREATE INDEX IF NOT EXISTS index_track_neighbor_neighbor_id_fk ON track_neighbor(neighbor_id);

CREATE TABLE IF NOT EXISTS track_enrichment (
    track_id UUID NOT NULL PRIMARY KEY REFERENCES track ON DELETE CASCADE,
    status VARCHAR(16) NOT NULL,
    method VARCHAR(16) NOT NULL,
    mbid VARCHAR(36),
    tried TIMESTAMP NOT NULL,
    error VARCHAR(255)
);
