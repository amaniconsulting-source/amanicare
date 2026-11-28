-- The payer came back from the card page through "approve": the card was accepted. Such a payment is never
-- given up by the app (not after 15 minutes, not by "try again"), even if the partner's status check is slow
-- to agree; only the partner's own answer ends it, or an admin after checking the partner's dashboard.
ALTER TABLE payments ADD COLUMN returned_approved INTEGER NOT NULL DEFAULT 0;
