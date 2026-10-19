-- A user's own account on another streaming service, for exporting playlists
-- to it. data is the credential, encrypted with the server secret. See
-- supysonic/webui/services.py.
CREATE TABLE IF NOT EXISTS service_link (
    user_id UUID NOT NULL REFERENCES "user" ON DELETE CASCADE,
    service VARCHAR(16) NOT NULL,
    account VARCHAR(128),
    data TEXT NOT NULL,
    updated TIMESTAMP NOT NULL,
    PRIMARY KEY (user_id, service)
);
