-- The user's own genre vocabulary, the tracks they labelled with it, and
-- the classification head trained from those labels on top of the frozen
-- audio embeddings. See supysonic/deezer/embedding.py.
CREATE TABLE IF NOT EXISTS genre_tag (
    id INTEGER NOT NULL AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(48) NOT NULL UNIQUE,
    color VARCHAR(16),
    archetype VARCHAR(16),
    created DATETIME NOT NULL
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS track_tag (
    track_id CHAR(32) NOT NULL REFERENCES track(id),
    tag_id INTEGER NOT NULL REFERENCES genre_tag(id),
    created DATETIME NOT NULL,
    PRIMARY KEY (track_id, tag_id)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE INDEX index_track_tag_tag_id_fk ON track_tag(tag_id);
CREATE TABLE IF NOT EXISTS genre_model (
    id INTEGER NOT NULL AUTO_INCREMENT PRIMARY KEY,
    version INTEGER NOT NULL DEFAULT 1,
    created DATETIME NOT NULL,
    active BOOLEAN NOT NULL DEFAULT true,
    kind VARCHAR(16) NOT NULL DEFAULT 'linear',
    hidden INTEGER NOT NULL DEFAULT 0,
    labels TEXT NOT NULL,
    weights TEXT NOT NULL,
    metrics TEXT,
    dim INTEGER NOT NULL DEFAULT 1280
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
