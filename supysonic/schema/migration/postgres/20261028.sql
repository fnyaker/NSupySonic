-- The navigation rework: a release's tracklist, kept by the releases watcher
-- so the home lists new titles without asking anyone, and a show's "archive
-- new episodes automatically" switch.
ALTER TABLE artist_release ADD COLUMN IF NOT EXISTS tracks TEXT;
ALTER TABLE podcast_channel ADD COLUMN IF NOT EXISTS auto_archive BOOLEAN NOT NULL DEFAULT false;
