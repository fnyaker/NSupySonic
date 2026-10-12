-- The YouTube video a fallback track was fetched from (deezer/youtube.py).
ALTER TABLE track ADD COLUMN IF NOT EXISTS youtube_id VARCHAR(16);
