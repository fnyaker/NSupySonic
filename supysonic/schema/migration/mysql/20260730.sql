
ALTER TABLE track ADD COLUMN owner_id CHAR(32) REFERENCES user(id);
ALTER TABLE user ADD COLUMN session_epoch INTEGER NOT NULL DEFAULT 0;

UPDATE track JOIN user u ON track.path LIKE CONCAT('%/Uploads/', u.id, '/%')
   SET track.owner_id = u.id
 WHERE track.owner_id IS NULL;
