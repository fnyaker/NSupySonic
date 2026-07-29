
ALTER TABLE track ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES "user";
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS session_epoch INTEGER NOT NULL DEFAULT 0;

UPDATE track
   SET owner_id = u.id
  FROM "user" u
 WHERE track.owner_id IS NULL
   AND track.path LIKE '%%/Uploads/' || u.id::text || '/%%';
