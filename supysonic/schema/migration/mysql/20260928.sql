-- Links that let whoever holds one drive one of the owner's players (the web
-- app's remote control). The row names the capability, and the token itself is
-- an HMAC of the id under the app's secret, never stored. See
-- supysonic/webui/remote.py.
CREATE TABLE IF NOT EXISTS remote_link (
    id VARCHAR(24) PRIMARY KEY,
    user_id CHAR(32) NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    level VARCHAR(8) NOT NULL,
    device VARCHAR(40) NOT NULL,
    device_name VARCHAR(64),
    label VARCHAR(64),
    created DATETIME NOT NULL,
    expires DATETIME,
    revoked DATETIME,
    last_used DATETIME
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE INDEX index_remote_link_user_id_fk ON remote_link(user_id);
