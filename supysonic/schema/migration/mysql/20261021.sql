-- The genre hierarchy: a genre may have several parents, each with a weight
-- (1 = a sub-genre outright, less = related), and genre_alias hangs the names
-- other services use on a node. Strictly additive: no existing row is touched.
CREATE TABLE IF NOT EXISTS genre_parent (
    child INTEGER NOT NULL,
    parent INTEGER NOT NULL,
    weight FLOAT NOT NULL DEFAULT 1,
    PRIMARY KEY (child, parent),
    INDEX index_genre_parent_parent_fk (parent),
    CONSTRAINT genre_parent_child_fk FOREIGN KEY (child) REFERENCES genre_tag(id) ON DELETE CASCADE,
    CONSTRAINT genre_parent_parent_fk FOREIGN KEY (parent) REFERENCES genre_tag(id) ON DELETE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS genre_alias (
    name VARCHAR(48) NOT NULL PRIMARY KEY,
    genre INTEGER NOT NULL,
    INDEX index_genre_alias_genre_fk (genre),
    CONSTRAINT genre_alias_genre_fk FOREIGN KEY (genre) REFERENCES genre_tag(id) ON DELETE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
