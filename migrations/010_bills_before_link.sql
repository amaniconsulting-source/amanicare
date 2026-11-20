-- A relative in the DRC can send a bill as soon as they have invited someone abroad,
-- without waiting for the invitation to be accepted. Such a bill has no payer yet;
-- it keeps the invitation code and gets its payer when the invitation is accepted.
-- ON UPDATE CASCADE: renewing an invitation changes its code.
ALTER TABLE bills ALTER COLUMN payer_id DROP NOT NULL;
ALTER TABLE bills ADD COLUMN invite_code TEXT REFERENCES invites(code) ON UPDATE CASCADE ON DELETE SET NULL;
ALTER TABLE bills ADD CONSTRAINT bills_payer_or_invite CHECK (payer_id IS NOT NULL OR invite_code IS NOT NULL);
CREATE INDEX bills_waiting_invite ON bills(invite_code) WHERE payer_id IS NULL;
