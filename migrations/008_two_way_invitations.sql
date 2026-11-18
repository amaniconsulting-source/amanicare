-- Invitations can come from either side: a payer abroad invites a relative in the DRC, or a relative
-- in the DRC invites someone abroad to help pay. The invite records who sent it; the other side accepts.
ALTER TABLE invites ALTER COLUMN payer_id DROP NOT NULL;
ALTER TABLE invites ADD COLUMN family_id TEXT REFERENCES users(id);
ALTER TABLE invites ADD COLUMN inviter_role TEXT NOT NULL DEFAULT 'payer' CHECK (inviter_role IN ('payer', 'family'));
ALTER TABLE invites ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE invites ADD CONSTRAINT invites_inviter CHECK (
  (inviter_role = 'payer' AND payer_id IS NOT NULL) OR (inviter_role = 'family' AND family_id IS NOT NULL));
CREATE INDEX invites_payer ON invites(payer_id) WHERE used_by IS NULL;
CREATE INDEX invites_family ON invites(family_id) WHERE used_by IS NULL;
