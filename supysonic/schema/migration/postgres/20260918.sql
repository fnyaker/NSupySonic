-- Whole-track analysis: the tempo and the style, measured once per file
-- and served to the player, so its animation engine stops having to work
-- them out live from the first seconds of the intro.
CREATE TABLE IF NOT EXISTS track_analysis (
    track_id UUID NOT NULL PRIMARY KEY REFERENCES track,
    version INTEGER NOT NULL DEFAULT 0,
    analyzed TIMESTAMP NOT NULL,
    bpm DOUBLE PRECISION,
    bpm_confidence DOUBLE PRECISION NOT NULL DEFAULT 0,
    bpm_source VARCHAR(16),
    style VARCHAR(24),
    style_confidence DOUBLE PRECISION NOT NULL DEFAULT 0,
    archetype VARCHAR(16),
    data TEXT
);
