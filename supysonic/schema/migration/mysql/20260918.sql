-- Whole-track analysis: the tempo and the style, measured once per file
-- and served to the player, so its animation engine stops having to work
-- them out live from the first seconds of the intro.
CREATE TABLE IF NOT EXISTS track_analysis (
    track_id CHAR(32) NOT NULL PRIMARY KEY REFERENCES track(id),
    version INTEGER NOT NULL DEFAULT 0,
    analyzed DATETIME NOT NULL,
    bpm DOUBLE,
    bpm_confidence DOUBLE NOT NULL DEFAULT 0,
    bpm_source VARCHAR(16),
    style VARCHAR(24),
    style_confidence DOUBLE NOT NULL DEFAULT 0,
    archetype VARCHAR(16),
    data TEXT
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
