-- Tracks the background explorer found on Deezer and verified, kept un-archived (deezer/explorer.py).
CREATE TABLE IF NOT EXISTS discovery (
    id INTEGER NOT NULL AUTO_INCREMENT PRIMARY KEY,
    deezer_id VARCHAR(20) NOT NULL UNIQUE,
    state VARCHAR(10) NOT NULL DEFAULT 'new',
    target VARCHAR(48) NOT NULL,
    style VARCHAR(48),
    confidence DOUBLE NOT NULL DEFAULT 0,
    bpm DOUBLE,
    found DATETIME NOT NULL,
    payload TEXT
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE INDEX index_discovery_state ON discovery(state);
