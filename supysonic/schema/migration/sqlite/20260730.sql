
ALTER TABLE track ADD COLUMN owner_id CHAR(36) REFERENCES user;
ALTER TABLE user ADD COLUMN session_epoch INTEGER NOT NULL DEFAULT 0;

-- Backfill the owner of already-uploaded files. Uploads have always been
-- written to "<archive>/Uploads/<user-id>/<file>", so the owner is recoverable
-- from the path; everything else stays NULL (shared library).
UPDATE track
   SET owner_id = (
        SELECT u.id FROM user u
         WHERE track.path LIKE '%/Uploads/' || u.id || '/%'
   )
 WHERE owner_id IS NULL AND path LIKE '%/Uploads/%';
