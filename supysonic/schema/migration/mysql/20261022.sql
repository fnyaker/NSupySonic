-- Recommendations, the Flow's discovery level and the releases of favourite
-- artists: what the background job learnt from a provider (artist_watch,
-- artist_release, artist_link, artist_top: catalogue facts, keyed by the
-- provider's own refs, never an Artist row, which the library prunes) and what
-- a person chose (user_taste, artist_mute). Strictly additive.
CREATE TABLE IF NOT EXISTS artist_watch (
    provider VARCHAR(16) NOT NULL,
    ref VARCHAR(128) NOT NULL,
    name VARCHAR(255) NOT NULL,
    picture VARCHAR(512),
    checked DATETIME,
    linked DATETIME,
    added DATETIME NOT NULL,
    PRIMARY KEY (provider, ref)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS artist_release (
    provider VARCHAR(16) NOT NULL,
    ref VARCHAR(128) NOT NULL,
    artist_ref VARCHAR(128) NOT NULL,
    artist_name VARCHAR(255) NOT NULL,
    title VARCHAR(255) NOT NULL,
    cover VARCHAR(512),
    kind VARCHAR(12),
    released VARCHAR(10),
    nb_tracks INTEGER,
    found DATETIME NOT NULL,
    PRIMARY KEY (provider, ref),
    INDEX index_artist_release_artist (provider, artist_ref, released),
    INDEX index_artist_release_released (released)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS artist_link (
    provider VARCHAR(16) NOT NULL,
    artist_ref VARCHAR(128) NOT NULL,
    other_ref VARCHAR(128) NOT NULL,
    other_name VARCHAR(255) NOT NULL,
    other_picture VARCHAR(512),
    score FLOAT NOT NULL,
    pos INTEGER NOT NULL,
    fetched DATETIME NOT NULL,
    PRIMARY KEY (provider, artist_ref, other_ref),
    INDEX index_artist_link_other (provider, other_ref)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS artist_top (
    provider VARCHAR(16) NOT NULL,
    ref VARCHAR(128) NOT NULL,
    artist_ref VARCHAR(128) NOT NULL,
    artist_name VARCHAR(255) NOT NULL,
    title VARCHAR(255) NOT NULL,
    album_ref VARCHAR(128),
    album_title VARCHAR(255),
    cover VARCHAR(512),
    duration INTEGER NOT NULL,
    pos INTEGER NOT NULL,
    fetched DATETIME NOT NULL,
    PRIMARY KEY (provider, ref),
    INDEX index_artist_top_artist (provider, artist_ref, pos)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS user_taste (
    user_id CHAR(32) NOT NULL,
    discovery FLOAT NOT NULL DEFAULT 0.35,
    releases_seen DATETIME,
    updated DATETIME,
    CONSTRAINT user_taste_user_fk FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS artist_mute (
    user_id CHAR(32) NOT NULL,
    provider VARCHAR(16) NOT NULL,
    ref VARCHAR(128) NOT NULL,
    created DATETIME NOT NULL,
    CONSTRAINT artist_mute_user_fk FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, provider, ref)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
