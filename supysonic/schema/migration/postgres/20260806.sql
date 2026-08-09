-- A track we have confirmed cannot be played at all (Deezer dropped the source,
-- or the local file is gone). NULL = playable as far as we know. A timestamp,
-- not a flag: availability comes back, so an old verdict is re-tested rather
-- than condemning the track for good.
ALTER TABLE track ADD COLUMN unavailable TIMESTAMP;

-- Unsubscribing from a podcast must never destroy episodes you have already
-- archived: the channel is kept and flagged instead, so the audio stays yours
-- and stays playable even if the show disappears from Deezer entirely.
ALTER TABLE podcast_channel ADD COLUMN subscribed BOOLEAN NOT NULL DEFAULT true;
