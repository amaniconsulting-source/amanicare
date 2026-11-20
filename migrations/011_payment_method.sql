-- The payer chooses how to pay: bank card, or mobile money (M-Pesa, Orange Money, Airtel Money)
-- from a wallet number. Payouts keep method NULL: they follow the facility's payout_method.
ALTER TABLE payments ADD COLUMN method TEXT CHECK (method IN ('card','mpesa','orange','airtel'));
ALTER TABLE payments ADD COLUMN wallet_phone TEXT;
