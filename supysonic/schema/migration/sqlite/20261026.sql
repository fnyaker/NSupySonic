-- A person's own listening history (supysonic/listening.py): one row per
-- track change, with how long it played and whether that was a listen or a
-- skip. Strictly additive; existing play counts are untouched.
CREATE TABLE IF NOT EXISTS listen_event (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id CHAR(36) NOT NULL REFERENCES user ON DELETE CASCADE,
    track_id CHAR(36) NOT NULL REFERENCES track ON DELETE CASCADE,
    at DATETIME NOT NULL,
    listened INTEGER NOT NULL DEFAULT 0,
    outcome INTEGER NOT NULL DEFAULT 0,
    source VARCHAR(16)
);
CREATE INDEX IF NOT EXISTS index_listen_event_user_at ON listen_event(user_id, at);
CREATE INDEX IF NOT EXISTS index_listen_event_user_track ON listen_event(user_id, track_id);
CREATE INDEX IF NOT EXISTS index_listen_event_track_id_fk ON listen_event(track_id);
