-- Links that let whoever holds one drive one of the owner's players (the web
-- app's remote control). The row names the capability, and the token itself is
-- an HMAC of the id under the app's secret, never stored. See
-- supysonic/webui/remote.py.
CREATE TABLE IF NOT EXISTS remote_link (
    id VARCHAR(24) PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES "user" ON DELETE CASCADE,
    level VARCHAR(8) NOT NULL,
    device VARCHAR(40) NOT NULL,
    device_name VARCHAR(64),
    label VARCHAR(64),
    created TIMESTAMP NOT NULL,
    expires TIMESTAMP,
    revoked TIMESTAMP,
    last_used TIMESTAMP
);
CREATE INDEX IF NOT EXISTS index_remote_link_user_id_fk ON remote_link(user_id);
