-- Several sources for one title: track_source (which provider can deliver
-- which record), entity_ref (provider ids of albums, artists, playlists and
-- shows) and provider_account (credentials). The existing deezer_id and
-- youtube_id columns stay, and the two tables are filled from them.
CREATE TABLE IF NOT EXISTS track_source (
    track_id CHAR(36) NOT NULL REFERENCES track ON DELETE CASCADE,
    provider VARCHAR(16) NOT NULL,
    ref VARCHAR(128) NOT NULL,
    quality SMALLINT,
    fmt VARCHAR(8),
    bitrate INTEGER,
    added DATETIME NOT NULL,
    seen DATETIME,
    unavailable DATETIME,
    PRIMARY KEY (provider, ref)
);
CREATE INDEX IF NOT EXISTS index_track_source_track_id_fk ON track_source(track_id);
CREATE TABLE IF NOT EXISTS entity_ref (
    kind VARCHAR(8) NOT NULL,
    provider VARCHAR(16) NOT NULL,
    ref VARCHAR(128) NOT NULL,
    entity CHAR(36) NOT NULL,
    PRIMARY KEY (kind, provider, ref)
);
CREATE INDEX IF NOT EXISTS index_entity_ref_kind_entity ON entity_ref(kind, entity);
CREATE TABLE IF NOT EXISTS provider_account (
    id CHAR(36) PRIMARY KEY,
    provider VARCHAR(16) NOT NULL,
    user_id CHAR(36) REFERENCES user ON DELETE CASCADE,
    label VARCHAR(64),
    secret TEXT,
    status VARCHAR(12) NOT NULL,
    checked DATETIME,
    created DATETIME NOT NULL,
    UNIQUE (provider, user_id)
);
CREATE INDEX IF NOT EXISTS index_provider_account_user_id_fk ON provider_account(user_id);

INSERT OR IGNORE INTO track_source (track_id, provider, ref, added)
SELECT id, 'deezer', deezer_id, created FROM track
WHERE deezer_id IS NOT NULL AND deezer_id <> '';
INSERT OR IGNORE INTO track_source (track_id, provider, ref, added)
SELECT id, 'youtube', youtube_id, created FROM track
WHERE youtube_id IS NOT NULL AND youtube_id <> '';
INSERT OR IGNORE INTO entity_ref (kind, provider, ref, entity)
SELECT 'album', 'deezer', deezer_id, id FROM album
WHERE deezer_id IS NOT NULL AND deezer_id <> '';
INSERT OR IGNORE INTO entity_ref (kind, provider, ref, entity)
SELECT 'artist', 'deezer', deezer_id, id FROM artist
WHERE deezer_id IS NOT NULL AND deezer_id <> '';
INSERT OR IGNORE INTO entity_ref (kind, provider, ref, entity)
SELECT 'playlist', 'deezer', deezer_id, id FROM playlist
WHERE deezer_id IS NOT NULL AND deezer_id <> '';
INSERT OR IGNORE INTO entity_ref (kind, provider, ref, entity)
SELECT 'show', 'deezer', deezer_id, id FROM podcast_channel
WHERE deezer_id IS NOT NULL AND deezer_id <> '';
