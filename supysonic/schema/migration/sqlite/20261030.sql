-- Everybody credited on a track besides its performers (composer, author,
-- producer...), one row per person, role and source (supysonic/trackcredits.py).
-- Strictly additive: the rows of existing tracks are filled in the background.
CREATE TABLE IF NOT EXISTS track_credit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    track_id CHAR(36) NOT NULL REFERENCES track ON DELETE CASCADE,
    source VARCHAR(16) NOT NULL,
    role VARCHAR(40) NOT NULL,
    name VARCHAR(160) NOT NULL,
    name_key VARCHAR(160) NOT NULL,
    position INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS index_track_credit_track_source ON track_credit(track_id, source);
CREATE INDEX IF NOT EXISTS index_track_credit_name_key ON track_credit(name_key);
