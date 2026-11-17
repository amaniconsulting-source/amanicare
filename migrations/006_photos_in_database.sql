-- Bill photos are stored in the database (hosting services wipe their disks on every deploy).
-- bill_drafts.photo_path / bills.photo_path then hold "db:<photo id>". Older rows keep their file path.
CREATE TABLE photos (
  id         TEXT PRIMARY KEY,
  media_type TEXT NOT NULL,
  data       BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
