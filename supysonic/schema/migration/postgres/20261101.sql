-- Which generation of the pipeline produced each stage of a track's analysis
-- (measure = version, embedding layout, genre head), so staleness is one SQL count.
ALTER TABLE track_analysis ADD COLUMN IF NOT EXISTS embed_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE track_analysis ADD COLUMN IF NOT EXISTS decided_head VARCHAR(40);
