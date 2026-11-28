-- Pilot: the payer can pay with a transfer app (Taptap Send, Sendwave, WorldRemit) straight to the hospital's
-- mobile-money wallet; the hospital confirms receipt in AmaniCare, which completes the payment.
-- transfer_name: the name registered on the hospital's wallet (transfer apps show and check it).
ALTER TABLE clinics ADD COLUMN transfer_name TEXT NOT NULL DEFAULT '';
-- When the payer said "I sent it", and what they added (the app's transfer number).
ALTER TABLE payments ADD COLUMN transfer_sent_at TIMESTAMPTZ;
ALTER TABLE payments ADD COLUMN transfer_note TEXT NOT NULL DEFAULT '';
-- The method check (migration 011) gains the transfer apps.
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_method_check;
ALTER TABLE payments ADD CONSTRAINT payments_method_check
  CHECK (method IN ('card','mpesa','orange','airtel','taptap','sendwave','worldremit'));
