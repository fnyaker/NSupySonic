-- The genre hierarchy: a genre may have several parents, each with a weight
-- (1 = a sub-genre outright, less = related), and genre_alias hangs the names
-- other services use on a node. Strictly additive: no existing row is touched.
CREATE TABLE IF NOT EXISTS genre_parent (
    child INTEGER NOT NULL REFERENCES genre_tag ON DELETE CASCADE,
    parent INTEGER NOT NULL REFERENCES genre_tag ON DELETE CASCADE,
    weight FLOAT NOT NULL DEFAULT 1,
    PRIMARY KEY (child, parent)
);
CREATE INDEX IF NOT EXISTS index_genre_parent_parent_fk ON genre_parent(parent);
CREATE TABLE IF NOT EXISTS genre_alias (
    name VARCHAR(48) NOT NULL PRIMARY KEY,
    genre INTEGER NOT NULL REFERENCES genre_tag ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS index_genre_alias_genre_fk ON genre_alias(genre);
