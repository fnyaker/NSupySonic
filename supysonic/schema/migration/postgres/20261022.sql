-- Recommendations, the Flow's discovery level and the releases of favourite
-- artists: what the background job learnt from a provider (artist_watch,
-- artist_release, artist_link, artist_top: catalogue facts, keyed by the
-- provider's own refs, never an Artist row, which the library prunes) and what
-- a person chose (user_taste, artist_mute). Strictly additive.
CREATE TABLE IF NOT EXISTS artist_watch (
    provider VARCHAR(16) NOT NULL,
    ref VARCHAR(128) NOT NULL,
    name VARCHAR(255) NOT NULL,
    picture VARCHAR(512),
    checked TIMESTAMP,
    linked TIMESTAMP,
    added TIMESTAMP NOT NULL,
    PRIMARY KEY (provider, ref)
);
CREATE TABLE IF NOT EXISTS artist_release (
    provider VARCHAR(16) NOT NULL,
    ref VARCHAR(128) NOT NULL,
    artist_ref VARCHAR(128) NOT NULL,
    artist_name VARCHAR(255) NOT NULL,
    title VARCHAR(255) NOT NULL,
    cover VARCHAR(512),
    kind VARCHAR(12),
    released VARCHAR(10),
    nb_tracks INTEGER,
    found TIMESTAMP NOT NULL,
    PRIMARY KEY (provider, ref)
);
CREATE INDEX IF NOT EXISTS index_artist_release_artist ON artist_release(provider, artist_ref, released);
CREATE INDEX IF NOT EXISTS index_artist_release_released ON artist_release(released);
CREATE TABLE IF NOT EXISTS artist_link (
    provider VARCHAR(16) NOT NULL,
    artist_ref VARCHAR(128) NOT NULL,
    other_ref VARCHAR(128) NOT NULL,
    other_name VARCHAR(255) NOT NULL,
    other_picture VARCHAR(512),
    score REAL NOT NULL,
    pos INTEGER NOT NULL,
    fetched TIMESTAMP NOT NULL,
    PRIMARY KEY (provider, artist_ref, other_ref)
);
CREATE INDEX IF NOT EXISTS index_artist_link_other ON artist_link(provider, other_ref);
CREATE TABLE IF NOT EXISTS artist_top (
    provider VARCHAR(16) NOT NULL,
    ref VARCHAR(128) NOT NULL,
    artist_ref VARCHAR(128) NOT NULL,
    artist_name VARCHAR(255) NOT NULL,
    title VARCHAR(255) NOT NULL,
    album_ref VARCHAR(128),
    album_title VARCHAR(255),
    cover VARCHAR(512),
    duration INTEGER NOT NULL,
    pos INTEGER NOT NULL,
    fetched TIMESTAMP NOT NULL,
    PRIMARY KEY (provider, ref)
);
CREATE INDEX IF NOT EXISTS index_artist_top_artist ON artist_top(provider, artist_ref, pos);
CREATE TABLE IF NOT EXISTS user_taste (
    user_id UUID NOT NULL REFERENCES "user" ON DELETE CASCADE,
    discovery REAL NOT NULL DEFAULT 0.35,
    releases_seen TIMESTAMP,
    updated TIMESTAMP,
    PRIMARY KEY (user_id)
);
CREATE TABLE IF NOT EXISTS artist_mute (
    user_id UUID NOT NULL REFERENCES "user" ON DELETE CASCADE,
    provider VARCHAR(16) NOT NULL,
    ref VARCHAR(128) NOT NULL,
    created TIMESTAMP NOT NULL,
    PRIMARY KEY (user_id, provider, ref)
);
