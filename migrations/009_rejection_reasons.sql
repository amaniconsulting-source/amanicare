-- Why a bill was rejected, so the family and payer know what to fix.
-- rejected_by: 'hospital' (the facility) or 'review' (AmaniCare's manual review).
ALTER TABLE bills ADD COLUMN rejected_by TEXT CHECK (rejected_by IN ('hospital', 'review'));
ALTER TABLE bills ADD COLUMN reject_reason TEXT;
ALTER TABLE bills ADD COLUMN reject_note TEXT NOT NULL DEFAULT '';
