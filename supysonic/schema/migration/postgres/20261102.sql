-- Tracks the background explorer found on Deezer and verified, kept un-archived (deezer/explorer.py).
CREATE TABLE IF NOT EXISTS discovery (
    id SERIAL PRIMARY KEY,
    deezer_id VARCHAR(20) NOT NULL UNIQUE,
    state VARCHAR(10) NOT NULL DEFAULT 'new',
    target VARCHAR(48) NOT NULL,
    style VARCHAR(48),
    confidence DOUBLE PRECISION NOT NULL DEFAULT 0,
    bpm DOUBLE PRECISION,
    found TIMESTAMP NOT NULL,
    payload TEXT
);
CREATE INDEX IF NOT EXISTS index_discovery_state ON discovery(state);
