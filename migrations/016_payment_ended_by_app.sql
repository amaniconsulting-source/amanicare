-- A collection the app gave up on itself (payer came back through Cancel, chose "try again", or nothing
-- happened for 15 minutes), as opposed to one the payment partner reported as failed. Before the payer pays
-- again, these are checked with the partner once more, so a payment that went through after all is never
-- followed by a second charge.
ALTER TABLE payments ADD COLUMN ended_by_app INTEGER NOT NULL DEFAULT 0;
