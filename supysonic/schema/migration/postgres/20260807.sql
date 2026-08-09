-- When Deezer stopped serving a whole show. The channel becomes local: every
-- archived episode stays listed and playable, served from disk, and the sync
-- stops asking Deezer about it. A timestamp, so the verdict expires and is
-- re-tested — a show can come back.
ALTER TABLE podcast_channel ADD COLUMN gone TIMESTAMP;
