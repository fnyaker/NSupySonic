-- Everybody credited on a track besides its performers (composer, author,
-- producer...), one row per person, role and source (supysonic/trackcredits.py).
-- Strictly additive: the rows of existing tracks are filled in the background.
CREATE TABLE IF NOT EXISTS track_credit (
    id INTEGER NOT NULL AUTO_INCREMENT PRIMARY KEY,
    track_id CHAR(32) NOT NULL,
    source VARCHAR(16) NOT NULL,
    role VARCHAR(40) NOT NULL,
    name VARCHAR(160) NOT NULL,
    name_key VARCHAR(160) NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT track_credit_track_fk FOREIGN KEY (track_id) REFERENCES track(id) ON DELETE CASCADE,
    INDEX index_track_credit_track_source (track_id, source),
    INDEX index_track_credit_name_key (name_key)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
