-- The user's own genre vocabulary, the tracks they labelled with it, and
-- the classification head trained from those labels on top of the frozen
-- audio embeddings. See supysonic/deezer/embedding.py.
CREATE TABLE IF NOT EXISTS genre_tag (
    id SERIAL PRIMARY KEY,
    name VARCHAR(48) NOT NULL UNIQUE,
    color VARCHAR(16),
    archetype VARCHAR(16),
    created TIMESTAMP NOT NULL
);
CREATE TABLE IF NOT EXISTS track_tag (
    track_id UUID NOT NULL REFERENCES track,
    tag_id INTEGER NOT NULL REFERENCES genre_tag,
    created TIMESTAMP NOT NULL,
    PRIMARY KEY (track_id, tag_id)
);
CREATE INDEX IF NOT EXISTS index_track_tag_tag_id_fk ON track_tag(tag_id);
CREATE TABLE IF NOT EXISTS genre_model (
    id SERIAL PRIMARY KEY,
    version INTEGER NOT NULL DEFAULT 1,
    created TIMESTAMP NOT NULL,
    active BOOLEAN NOT NULL DEFAULT true,
    kind VARCHAR(16) NOT NULL DEFAULT 'linear',
    hidden INTEGER NOT NULL DEFAULT 0,
    labels TEXT NOT NULL,
    weights TEXT NOT NULL,
    metrics TEXT,
    dim INTEGER NOT NULL DEFAULT 1280
);
