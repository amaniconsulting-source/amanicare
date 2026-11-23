-- Admins can remove another admin's or hospital staff member's access without deleting history:
-- a user with active = 0 can no longer receive a login code or use an open session.
ALTER TABLE users ADD COLUMN active INTEGER NOT NULL DEFAULT 1;
