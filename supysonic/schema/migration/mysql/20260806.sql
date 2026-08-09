-- A track we have confirmed cannot be played at all (Deezer dropped the source,
-- or the local file is gone). NULL = playable as far as we know. A timestamp,
-- not a flag: availability comes back, so an old verdict is re-tested rather
-- than condemning the track for good.
ALTER TABLE track ADD COLUMN unavailable DATETIME;
