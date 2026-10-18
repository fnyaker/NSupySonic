-- A user's own account on another streaming service, for exporting playlists
-- to it. data is the credential, encrypted with the server secret. See
-- supysonic/webui/services.py.
CREATE TABLE IF NOT EXISTS service_link (
    user_id CHAR(32) NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    service VARCHAR(16) NOT NULL,
    account VARCHAR(128),
    data TEXT NOT NULL,
    updated DATETIME NOT NULL,
    PRIMARY KEY (user_id, service)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
