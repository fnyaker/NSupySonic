-- A person's own listening history (supysonic/listening.py): one row per
-- track change, with how long it played and whether that was a listen or a
-- skip. Strictly additive; existing play counts are untouched.
CREATE TABLE IF NOT EXISTS listen_event (
    id INTEGER NOT NULL AUTO_INCREMENT PRIMARY KEY,
    user_id CHAR(32) NOT NULL,
    track_id CHAR(32) NOT NULL,
    at DATETIME NOT NULL,
    listened INTEGER NOT NULL DEFAULT 0,
    outcome INTEGER NOT NULL DEFAULT 0,
    source VARCHAR(16),
    CONSTRAINT listen_event_user_fk FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE CASCADE,
    CONSTRAINT listen_event_track_fk FOREIGN KEY (track_id) REFERENCES track(id) ON DELETE CASCADE,
    INDEX index_listen_event_user_at (user_id, at),
    INDEX index_listen_event_user_track (user_id, track_id)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
