-- The titles a person does not want to hear (supysonic/dislikes.py), and the
-- Flow's starting energy. Strictly additive.
ALTER TABLE user_taste ADD COLUMN IF NOT EXISTS energy REAL;
CREATE TABLE IF NOT EXISTS track_dislike (
    user_id UUID NOT NULL REFERENCES "user" ON DELETE CASCADE,
    track_id UUID NOT NULL REFERENCES track ON DELETE CASCADE,
    created TIMESTAMP NOT NULL,
    PRIMARY KEY (user_id, track_id)
);
CREATE INDEX IF NOT EXISTS index_track_dislike_track_id_fk ON track_dislike(track_id);
