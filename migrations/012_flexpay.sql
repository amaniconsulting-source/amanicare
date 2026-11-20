-- FlexPay (Congolese payment aggregator, licensed by the Banque Centrale du Congo): pilot / proof of concept.
-- flexpay_merchant: the hospital's own FlexPay merchant code. When set, the payer's money is collected
-- straight into the hospital's FlexPay account (AmaniCare never holds it) and no payout step is needed.
-- payout_phone: the hospital's mobile-money number, for payouts from AmaniCare's merchant account
-- when the hospital has no merchant code of its own.
ALTER TABLE clinics ADD COLUMN flexpay_merchant TEXT NOT NULL DEFAULT '';
ALTER TABLE clinics ADD COLUMN payout_phone TEXT NOT NULL DEFAULT '';
